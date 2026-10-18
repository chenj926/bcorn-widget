//! Foreground-only Calendar providers. Credentials and ownership journals never cross IPC.
//! CalendarStore is reused solely as a DPAPI/atomic-file primitive, under distinct directories.
mod model;
mod oauth;
mod store;
mod sync;
#[cfg(test)]
mod tests;
mod transport;
use crate::grade_sync_store::random_id;
use model::*;
pub use model::{Series, Status, SyncResult, Target};
use oauth::PendingAuthorization;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use store::CalendarStore;
use transport::*;
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Microsoft,
}
impl Provider {
    fn scope(self) -> &'static str {
        match self {
            Self::Google => "openid email https://www.googleapis.com/auth/calendar.app.created",
            Self::Microsoft => "openid profile offline_access User.Read Calendars.ReadWrite",
        }
    }
    fn authorize(self) -> &'static str {
        match self {
            Self::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            Self::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }
    }
    fn token(self) -> &'static str {
        match self {
            Self::Google => "https://oauth2.googleapis.com/token",
            Self::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }
}
#[derive(Clone)]
struct Config {
    provider: Provider,
    client_id: String,
    client_secret: String,
}
impl Config {
    fn build(provider: Provider) -> Self {
        let (id, secret) = match provider {
            Provider::Google => (
                option_env!("BCORN_GOOGLE_CALENDAR_CLIENT_ID").unwrap_or(""),
                option_env!("BCORN_GOOGLE_CALENDAR_CLIENT_SECRET").unwrap_or(""),
            ),
            Provider::Microsoft => (
                option_env!("BCORN_MICROSOFT_CALENDAR_CLIENT_ID").unwrap_or(""),
                "",
            ),
        };
        Self {
            provider,
            client_id: id.into(),
            client_secret: secret.into(),
        }
    }
    fn configured(&self) -> bool {
        let s = &self.client_id;
        match self.provider {
            Provider::Google => {
                s.ends_with(".apps.googleusercontent.com")
                    && s.len() < 250
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            }
            Provider::Microsoft => {
                s.len() == 36
                    && s.bytes().enumerate().all(|(i, b)| {
                        if [8, 13, 18, 23].contains(&i) {
                            b == b'-'
                        } else {
                            b.is_ascii_hexdigit()
                        }
                    })
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct Tokens {
    access: String,
    refresh: String,
    expires_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vault {
    version: u8,
    owner: String,
    tokens: Option<Tokens>,
    account: Option<String>,
    label: String,
    enabled: bool,
    revoked: bool,
    accounts: BTreeMap<String, Account>,
}
impl Vault {
    fn empty() -> Self {
        Self {
            version: 1,
            owner: random_id(),
            tokens: None,
            account: None,
            label: String::new(),
            enabled: false,
            revoked: false,
            accounts: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Account {
    selected: Option<String>,
    calendars: BTreeMap<String, Calendar>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Calendar {
    target: Target,
    entries: BTreeMap<String, Entry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    #[serde(default)]
    generation: u32,
    #[serde(default)]
    deleted: bool,
    remote: Option<String>,
    fingerprint: String,
    pending: bool,
}
struct Connection {
    config: Config,
    store: CalendarStore,
    vault: Mutex<Vault>,
    operation: Mutex<()>,
    gate: Arc<OperationGate>,
    foreground: AtomicBool,
    rate_until: AtomicU64,
}
pub struct CloudCalendar {
    google: Connection,
    microsoft: Connection,
    transport: Arc<dyn Transport>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16384 && !s.bytes().any(|b| b < 32 || b == 127)
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
impl Connection {
    fn open(config: Config, store: CalendarStore) -> Result<Self, String> {
        let vault = match store.load_vault()? {
            Some(b) => {
                serde_json::from_slice::<Vault>(&b).map_err(|_| "invalid-calendar-storage")?
            }
            None => Vault::empty(),
        };
        if vault.version != 1 || vault.owner.is_empty() {
            return Err("invalid-calendar-storage".into());
        }
        Ok(Self {
            config,
            store,
            vault: Mutex::new(vault),
            operation: Mutex::new(()),
            gate: Arc::new(OperationGate::new(true, "background-or-cancelled")),
            foreground: AtomicBool::new(true),
            rate_until: AtomicU64::new(0),
        })
    }
    fn begin(&self) -> Result<(), String> {
        // Enable before checking foreground: a simultaneous hide must never be
        // overwritten by enabling the gate after the foreground observation.
        self.gate.set(true);
        if !self.foreground.load(Ordering::SeqCst) {
            self.gate.set(false);
            return Err("background-paused".into());
        }
        Ok(())
    }
    fn current(&self) -> Result<Vault, String> {
        self.vault
            .lock()
            .map(|v| v.clone())
            .map_err(|_| "calendar-busy".into())
    }
    fn commit(&self, v: Vault) -> Result<(), String> {
        let b = Zeroizing::new(serde_json::to_vec(&v).map_err(|_| "calendar-storage-error")?);
        self.store.save_vault(&b)?;
        *self.vault.lock().map_err(|_| "calendar-busy")? = v;
        Ok(())
    }
}
impl CloudCalendar {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        Ok(Self {
            google: Connection::open(
                Config::build(Provider::Google),
                CalendarStore::new(directory.join("calendar-google-v1")),
            )?,
            microsoft: Connection::open(
                Config::build(Provider::Microsoft),
                CalendarStore::new(directory.join("calendar-microsoft-v1")),
            )?,
            transport: Arc::new(CalendarTransport::new()?),
        })
    }
    fn connection(&self, p: Provider) -> &Connection {
        match p {
            Provider::Google => &self.google,
            Provider::Microsoft => &self.microsoft,
        }
    }
    pub fn set_foreground(&self, foreground: bool) {
        for c in [&self.google, &self.microsoft] {
            c.foreground.store(foreground, Ordering::SeqCst);
            if !foreground {
                c.gate.set(false);
            }
        }
    }
    pub fn cancel(&self, p: Provider) {
        self.connection(p).gate.set(false);
    }
    pub fn status(&self, p: Provider) -> Result<Status, String> {
        let c = self.connection(p);
        let v = c.current()?;
        let cal = selected(&v).ok();
        Ok(Status {
            provider: p,
            state: if !c.config.configured() {
                "not-configured"
            } else if v.revoked {
                "revoked"
            } else if v.tokens.is_none() {
                "authorization-required"
            } else if v.enabled {
                "ready"
            } else {
                "target-required"
            }
            .into(),
            account_label: v.label.clone(),
            target: cal.map(|c| c.target.clone()),
            enabled: c.config.configured() && v.enabled && v.tokens.is_some(),
            owned_count: cal
                .map(|c| c.entries.values().filter(|e| !e.deleted).count())
                .unwrap_or(0),
        })
    }
    pub fn connect<F>(&self, p: Provider, open_browser: F) -> Result<Status, String>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        let c = self.connection(p);
        if !c.config.configured() {
            return Err("not-configured".into());
        }
        let _op = c.operation.try_lock().map_err(|_| "calendar-busy")?;
        c.begin()?;
        // Switching accounts immediately stops the previous account's sync.
        // A cancelled/failed browser flow cannot silently resume the old grant.
        let mut previous = c.current()?;
        previous.enabled = false;
        previous.tokens = None;
        c.commit(previous)?;
        let pending = PendingAuthorization::bind(&c.config)?;
        open_browser(&pending.authorization_url).map_err(|_| "system-browser-unavailable")?;
        let code = pending.receive(|| c.gate.check(), Duration::from_secs(180))?;
        let mut form = vec![
            (
                "client_id".into(),
                Zeroizing::new(c.config.client_id.clone()),
            ),
            (
                "grant_type".into(),
                Zeroizing::new("authorization_code".into()),
            ),
            ("code".into(), code),
            ("code_verifier".into(), pending.verifier.clone()),
            (
                "redirect_uri".into(),
                Zeroizing::new(pending.redirect_uri.clone()),
            ),
        ];
        if !c.config.client_secret.is_empty() {
            form.push((
                "client_secret".into(),
                Zeroizing::new(c.config.client_secret.clone()),
            ))
        }
        let tokens = self.token_exchange(c, form, None)?;
        let identity = self.send(
            c,
            "GET",
            match p {
                Provider::Google => "https://openidconnect.googleapis.com/v1/userinfo".into(),
                Provider::Microsoft => {
                    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName"
                        .into()
                }
            },
            Some(&tokens.access),
            None,
            None,
        )?;
        let body = success(identity)?;
        let id = body[if p == Provider::Google { "sub" } else { "id" }]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or("invalid-account-response")?
            .to_string();
        let label = body[if p == Provider::Google {
            "email"
        } else {
            "userPrincipalName"
        }]
        .as_str()
        .filter(|s| s.len() <= 320)
        .unwrap_or("Connected account")
        .to_string();
        c.gate.check()?;
        let mut v = c.current()?;
        v.account = Some(id.clone());
        v.label = label;
        v.accounts.entry(id).or_default();
        v.tokens = Some(tokens);
        v.revoked = false;
        v.enabled = false;
        c.commit(v)?;
        self.status(p)
    }
    fn token_exchange(
        &self,
        c: &Connection,
        form: Vec<(String, Zeroizing<String>)>,
        old: Option<&Tokens>,
    ) -> Result<Tokens, String> {
        let response = self.send(
            c,
            "POST",
            c.config.provider.token().into(),
            None,
            Some(form),
            None,
        )?;
        let body: Value =
            serde_json::from_slice(&response.body).map_err(|_| "invalid-token-response")?;
        if response.status != 200 {
            return Err(if body["error"] == "invalid_grant" {
                "authorization-revoked"
            } else {
                "authorization-failed"
            }
            .into());
        }
        if let Some(scopes) = body["scope"].as_str() {
            let granted: Vec<_> = scopes.split_whitespace().collect();
            let required = if c.config.provider == Provider::Google {
                "https://www.googleapis.com/auth/calendar.app.created"
            } else {
                "Calendars.ReadWrite"
            };
            if !granted.iter().any(|s| s.eq_ignore_ascii_case(required)) {
                return Err("calendar-scope-not-granted".into());
            }
        }
        let access = body["access_token"]
            .as_str()
            .filter(|s| valid_token(s))
            .ok_or("invalid-token-response")?
            .to_string();
        let refresh = body["refresh_token"]
            .as_str()
            .filter(|s| valid_token(s))
            .map(str::to_owned)
            .or_else(|| old.map(|t| t.refresh.clone()))
            .ok_or("offline-access-not-granted")?;
        let lifetime = body["expires_in"]
            .as_u64()
            .filter(|x| *x > 60 && *x <= 86400)
            .ok_or("invalid-token-response")?;
        Ok(Tokens {
            access,
            refresh,
            expires_at: now() + lifetime - 30,
        })
    }
    fn access(&self, c: &Connection) -> Result<Zeroizing<String>, String> {
        if !c.config.configured() {
            return Err("not-configured".into());
        }
        let mut v = c.current()?;
        let old = v.tokens.as_ref().ok_or("authorization-required")?;
        if old.expires_at > now() {
            return Ok(Zeroizing::new(old.access.clone()));
        }
        let mut form = vec![
            (
                "client_id".into(),
                Zeroizing::new(c.config.client_id.clone()),
            ),
            ("grant_type".into(), Zeroizing::new("refresh_token".into())),
            ("refresh_token".into(), Zeroizing::new(old.refresh.clone())),
        ];
        if !c.config.client_secret.is_empty() {
            form.push((
                "client_secret".into(),
                Zeroizing::new(c.config.client_secret.clone()),
            ))
        }
        let result = self.token_exchange(c, form, Some(old));
        match result {
            Ok(t) => {
                let access = Zeroizing::new(t.access.clone());
                v.tokens = Some(t);
                c.commit(v)?;
                Ok(access)
            }
            Err(e) => {
                if e == "authorization-revoked" {
                    v.tokens = None;
                    v.enabled = false;
                    v.revoked = true;
                    c.commit(v)?;
                }
                Err(e)
            }
        }
    }
    fn send(
        &self,
        c: &Connection,
        method: &'static str,
        url: String,
        token: Option<&str>,
        form: Option<Vec<(String, Zeroizing<String>)>>,
        body: Option<Value>,
    ) -> Result<NativeResponse, String> {
        self.send_conditional(c, method, url, token, form, body, None)
    }
    fn send_conditional(
        &self,
        c: &Connection,
        method: &'static str,
        url: String,
        token: Option<&str>,
        form: Option<Vec<(String, Zeroizing<String>)>>,
        body: Option<Value>,
        etag: Option<String>,
    ) -> Result<NativeResponse, String> {
        c.gate
            .check()
            .map_err(|_| "request-not-sent-background-or-cancelled")?;
        if c.rate_until.load(Ordering::SeqCst) > now() {
            return Err("rate-limited".into());
        }
        let r = self.transport.send(NativeRequest {
            method,
            url,
            if_match: etag,
            bearer: token.map(|s| Zeroizing::new(s.into())),
            form,
            json: body,
            cancellation: Some(c.gate.clone()),
        })?;
        if r.status == 429 || (r.status == 403 && is_rate_limit(&r.body)) {
            c.rate_until.store(
                now() + r.retry_after_ms.unwrap_or(60000).div_ceil(1000),
                Ordering::SeqCst,
            );
            return Err("rate-limited".into());
        }
        if r.status == 401 && token.is_some() {
            let mut v = c.current()?;
            v.tokens = None;
            v.enabled = false;
            v.revoked = true;
            c.commit(v)?;
            return Err("authorization-revoked".into());
        }
        Ok(r)
    }
    pub fn targets(&self, p: Provider) -> Result<Vec<Target>, String> {
        let c = self.connection(p);
        let _op = c.operation.try_lock().map_err(|_| "calendar-busy")?;
        c.begin()?;
        let token = self.access(c)?;
        let v = c.current()?;
        if p == Provider::Google {
            return Ok(account(&v)?
                .calendars
                .values()
                .map(|c| c.target.clone())
                .collect());
        }
        let response = self.send(
            c,
            "GET",
            "https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,canEdit&$top=100".into(),
            Some(&token),
            None,
            None,
        )?;
        let b = success(response)?;
        if b.get("@odata.nextLink").is_some() {
            return Err("calendar-list-too-large".into());
        }
        b["value"]
            .as_array()
            .ok_or("invalid-calendar-response")?
            .iter()
            .filter(|t| t["canEdit"] == true)
            .map(parse_target)
            .collect()
    }
    pub fn create_target(&self, p: Provider, name: String) -> Result<Target, String> {
        if p != Provider::Google {
            return Err("select-existing-microsoft-calendar".into());
        }
        if name.trim().is_empty() || name.len() > 100 {
            return Err("invalid-calendar-name".into());
        }
        let c = self.connection(p);
        let _op = c.operation.try_lock().map_err(|_| "calendar-busy")?;
        c.begin()?;
        let token = self.access(c)?;
        // Calendar creation has no idempotency key. Never automatically retry it.
        let b=success(self.send(c,"POST","https://www.googleapis.com/calendar/v3/calendars".into(),Some(&token),None,Some(json!({"summary":name,"description":"Timetable events created by bcorn. Changes are managed only while bcorn is open."}))).map_err(|_|"calendar-creation-uncertain-check-provider-before-retrying")?)?;
        let target = Target {
            id: b["id"]
                .as_str()
                .filter(|s| valid_id(s))
                .ok_or("invalid-calendar-response")?
                .into(),
            name: b["summary"].as_str().unwrap_or(&name).into(),
        };
        let mut v = c.current()?;
        account_mut(&mut v)?.calendars.insert(
            target.id.clone(),
            Calendar {
                target: target.clone(),
                entries: BTreeMap::new(),
            },
        );
        c.commit(v)
            .map_err(|_| "calendar-created-storage-failed-check-provider-before-retrying")?;
        Ok(target)
    }
    pub fn bind(
        &self,
        p: Provider,
        calendar_id: String,
        confirmed: bool,
    ) -> Result<Status, String> {
        if !confirmed {
            return Err("calendar-target-confirmation-required".into());
        }
        let expected_account = self.connection(p).current()?.account;
        let targets = self.targets(p)?;
        let target = targets
            .into_iter()
            .find(|t| t.id == calendar_id)
            .ok_or("calendar-not-writable-or-not-owned")?;
        let c = self.connection(p);
        let _op = c.operation.try_lock().map_err(|_| "calendar-busy")?;
        let mut v = c.current()?;
        if v.account != expected_account {
            return Err("account-changed".into());
        }
        let a = account_mut(&mut v)?;
        a.calendars.entry(calendar_id.clone()).or_insert(Calendar {
            target,
            entries: BTreeMap::new(),
        });
        a.selected = Some(calendar_id);
        v.enabled = true;
        c.commit(v)?;
        self.status(p)
    }
    pub fn disconnect(&self, p: Provider) -> Result<Status, String> {
        let c = self.connection(p);
        c.gate.set(false);
        let _op = c.operation.lock().map_err(|_| "calendar-busy")?;
        let mut v = c.current()?;
        v.tokens = None;
        v.enabled = false;
        c.commit(v)?;
        self.status(p)
    }
}
fn account(v: &Vault) -> Result<&Account, String> {
    v.account
        .as_ref()
        .and_then(|id| v.accounts.get(id))
        .ok_or("account-required".into())
}
fn account_mut(v: &mut Vault) -> Result<&mut Account, String> {
    let id = v.account.clone().ok_or("account-required")?;
    v.accounts.get_mut(&id).ok_or("account-required".into())
}
fn selected(v: &Vault) -> Result<&Calendar, String> {
    let a = account(v)?;
    a.selected
        .as_ref()
        .and_then(|id| a.calendars.get(id))
        .ok_or("calendar-target-required".into())
}
fn selected_mut(v: &mut Vault) -> Result<&mut Calendar, String> {
    let a = account_mut(v)?;
    let id = a.selected.clone().ok_or("calendar-target-required")?;
    a.calendars
        .get_mut(&id)
        .ok_or("calendar-target-required".into())
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && s.len() <= 1024 && !s.chars().any(char::is_control)
}
fn parse_target(v: &Value) -> Result<Target, String> {
    Ok(Target {
        id: v["id"]
            .as_str()
            .filter(|s| valid_id(s))
            .ok_or("invalid-calendar-response")?
            .into(),
        name: v["name"]
            .as_str()
            .filter(|s| s.len() <= 1024)
            .ok_or("invalid-calendar-response")?
            .into(),
    })
}
fn success(r: NativeResponse) -> Result<Value, String> {
    if !(200..300).contains(&r.status) {
        return Err(match r.status {
            403 => "calendar-permission-denied",
            404 => "calendar-not-found",
            409 => "calendar-conflict",
            412 => "calendar-changed",
            500..=599 => "provider-unavailable",
            _ => "calendar-request-failed",
        }
        .into());
    }
    if r.status == 204 {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&r.body).map_err(|_| "invalid-calendar-response".into())
}
fn is_rate_limit(bytes: &[u8]) -> bool {
    let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    v["error"]["errors"].as_array().is_some_and(|a| {
        a.iter().any(|x| {
            matches!(
                x["reason"].as_str(),
                Some("rateLimitExceeded" | "userRateLimitExceeded" | "quotaExceeded")
            )
        })
    })
}
