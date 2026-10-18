//! A deliberately narrow native boundary: browser OAuth, DPAPI credentials, and
//! only the bound assessment tab's exact Sheets values routes. No IPC token API.
use crate::grade_sync_store::{random_id, valid_id, PrivateStore};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const AUTHORIZE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN: &str = "https://oauth2.googleapis.com/token";
const REVOKE: &str = "https://oauth2.googleapis.com/revoke";
const SHEETS: &str = "https://sheets.googleapis.com";
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MAX_WRITE: usize = 128 * 1024;
const OAUTH_TIMEOUT: Duration = Duration::from_secs(180);
const HEADERS: [&str; 14] = [
    "recordId",
    "type",
    "courseId",
    "courseTitle",
    "term",
    "assessmentId",
    "assessment",
    "weight",
    "status",
    "scoreMode",
    "ratio",
    "earned",
    "possible",
    "rule",
];

#[derive(Clone)]
struct Config {
    client_id: String,
    client_secret: String,
}
impl Config {
    fn build() -> Self {
        Self {
            client_id: option_env!("BCORN_GOOGLE_DESKTOP_CLIENT_ID")
                .unwrap_or("")
                .into(),
            client_secret: option_env!("BCORN_GOOGLE_DESKTOP_CLIENT_SECRET")
                .unwrap_or("")
                .into(),
        }
    }
    fn configured(&self) -> bool {
        self.client_id.ends_with(".apps.googleusercontent.com")
            && self.client_id.len() < 250
            && self
                .client_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub spreadsheet_id: String,
    pub tab: String,
    pub confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}
struct StagedCandidate {
    selection_id: String,
    spreadsheet_id: String,
    tokens: Tokens,
    tabs: Vec<Value>,
    generation: u64,
}
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct Tokens {
    access: String,
    refresh: String,
    expires_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Vault {
    schema_version: u8,
    device_id: String,
    state: String,
    connection_id: Option<String>,
    binding: Option<Binding>,
    tokens: Option<Tokens>,
}
impl Vault {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            device_id: random_id(),
            state: "authorization-required".into(),
            connection_id: None,
            binding: None,
            tokens: None,
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || !valid_id(&self.device_id)
            || !matches!(
                self.state.as_str(),
                "authorization-required" | "ready" | "revoked"
            )
            || self.connection_id.as_ref().is_some_and(|s| !valid_id(s))
        {
            return Err("invalid-native-authorization-storage".into());
        }
        if let Some(b) = &self.binding {
            if let Some(mapping) = &b.mapping {
                validate_mapping(mapping)?;
                if mapping["tab"] != b.tab || b.kind.as_deref() != Some("mapped") {
                    return Err("invalid-native-authorization-storage".into());
                }
            } else if b.kind.is_some() {
                return Err("invalid-native-authorization-storage".into());
            }
            if !valid_sheet_id(&b.spreadsheet_id)
                || !valid_tab(&b.tab)
                || !b.confirmed
                || self.connection_id.is_none()
            {
                return Err("invalid-native-authorization-storage".into());
            }
        }
        if self.state == "ready" && (self.tokens.is_none() || self.binding.is_none()) {
            return Err("invalid-native-authorization-storage".into());
        }
        if self
            .tokens
            .as_ref()
            .is_some_and(|t| !valid_token(&t.access) || !valid_token(&t.refresh))
        {
            return Err("invalid-native-authorization-storage".into());
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeSyncStatus {
    pub state: String,
    pub binding: Option<Binding>,
    pub connection_id: Option<String>,
    pub device_id: String,
    pub automatic_inbound: bool,
    pub automatic_inbound_mode: &'static str,
    pub foreground_sync_available: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetsRequest {
    pub method: String,
    pub path: String,
    pub body: Option<Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetsResponse {
    pub status: u16,
    pub body: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResult {
    pub ok: bool,
    pub google_revocation_confirmed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetVersion {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_time: Option<String>,
}

// Private transport types are not deserializable from IPC. Renderer routes never
// become arbitrary URLs; fixed OAuth endpoints are reachable only by native code.
struct NativeRequest {
    method: &'static str,
    url: String,
    bearer: Option<Zeroizing<String>>,
    form: Option<Vec<(String, Zeroizing<String>)>>,
    json: Option<Value>,
    cancellation: Option<Arc<OperationGate>>,
}
struct NativeResponse {
    status: u16,
    body: Zeroizing<Vec<u8>>,
    retry_after_ms: Option<u64>,
}
trait Transport: Send + Sync {
    fn send(&self, request: NativeRequest) -> Result<NativeResponse, String>;
}
/// A watch signal exists only while an operation is running: no idle polling.
/// Disabling a gate drops the HTTP future, stopping queued and in-flight work.
struct OperationGate {
    enabled: AtomicBool,
    changed: tokio::sync::watch::Sender<u64>,
    reason: &'static str,
}
impl OperationGate {
    fn new(enabled: bool, reason: &'static str) -> Self {
        let (changed, _) = tokio::sync::watch::channel(0);
        Self {
            enabled: AtomicBool::new(enabled),
            changed,
            reason,
        }
    }
    fn set(&self, enabled: bool) {
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            self.changed
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
    }
    fn check(&self) -> Result<(), String> {
        if self.enabled.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(self.reason.into())
        }
    }
}
struct AuthorizationReset<'a> {
    gate: &'a OperationGate,
    keep_open: bool,
}
impl Drop for AuthorizationReset<'_> {
    fn drop(&mut self) {
        if !self.keep_open {
            self.gate.set(false);
        }
    }
}
async fn cancellable<T>(
    gate: Option<&OperationGate>,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let Some(gate) = gate else {
        return work.await;
    };
    let mut changed = gate.changed.subscribe();
    gate.check()?;
    tokio::select! {
        biased;
        _ = changed.changed() => Err(gate.reason.into()),
        value = work => value,
    }
}
struct GoogleTransport {
    client: reqwest::Client,
    runtime: Option<tokio::runtime::Runtime>,
}
impl Drop for GoogleTransport {
    fn drop(&mut self) {
        // Tauri may drop app state inside an async shutdown callback.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
impl GoogleTransport {
    fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("bcorn-grade-sync/1")
            .build()
            .map_err(|_| "native-http-unavailable")?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| "native-http-unavailable")?;
        Ok(Self {
            client,
            runtime: Some(runtime),
        })
    }
}
impl Transport for GoogleTransport {
    fn send(&self, request: NativeRequest) -> Result<NativeResponse, String> {
        let url = Url::parse(&request.url).map_err(|_| "invalid-native-endpoint")?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid-native-endpoint".into());
        }
        let allowed = match url.host_str() {
            Some("oauth2.googleapis.com") => {
                request.method == "POST"
                    && ["/token", "/revoke"].contains(&url.path())
                    && url.query().is_none()
                    && request.bearer.is_none()
                    && request.json.is_none()
            }
            Some("www.googleapis.com") => {
                request.method == "GET"
                    && url
                        .path()
                        .strip_prefix("/drive/v3/files/")
                        .is_some_and(valid_sheet_id)
                    && url.query() == Some("fields=version%2CmodifiedTime")
                    && request.form.is_none()
                    && request.json.is_none()
            }
            Some("sheets.googleapis.com") => {
                url.path().starts_with("/v4/spreadsheets")
                    && ["GET", "PUT", "POST"].contains(&request.method)
                    && request.form.is_none()
            }
            _ => false,
        };
        if !allowed {
            return Err("invalid-native-endpoint".into());
        }
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "invalid-native-method")?;
        let mut call = self.client.request(method, url);
        if let Some(token) = request.bearer.as_ref() {
            call = call.bearer_auth(token.as_str());
        }
        if let Some(form) = request.form.as_ref() {
            let pairs: Vec<_> = form.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            call = call.form(&pairs);
        }
        if let Some(body) = request.json.as_ref() {
            call = call.json(body);
        }
        // Never return reqwest errors, URLs, headers or provider messages to JS.
        let work = async {
            let mut response = call.send().await.map_err(|_| "network-error")?;
            let status = response.status().as_u16();
            let retry_after_ms = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .map(|s| s.saturating_mul(1000).clamp(1000, 3600000));
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESPONSE as u64)
            {
                return Err("response-limit".into());
            }
            let mut body = Zeroizing::new(Vec::new());
            while let Some(chunk) = response.chunk().await.map_err(|_| "network-error")? {
                if body.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                    return Err("response-limit".into());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(NativeResponse {
                status,
                body,
                retry_after_ms,
            })
        };
        self.runtime
            .as_ref()
            .ok_or("native-http-unavailable")?
            .block_on(cancellable(request.cancellation.as_deref(), work))
    }
}

pub struct GradeAuth {
    config: Config,
    private: PrivateStore,
    transport: Arc<dyn Transport>,
    vault: Mutex<Vault>,
    operation: Mutex<()>,
    authorization_generation: AtomicU64,
    foreground: Arc<OperationGate>,
    authorization: Arc<OperationGate>,
    rate_limit_until_ms: AtomicU64,
    candidate: Mutex<Option<StagedCandidate>>,
}
impl GradeAuth {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        Self::open(
            Config::build(),
            PrivateStore::new(directory.join("grade-native")),
            Arc::new(GoogleTransport::new()?),
        )
    }
    fn open(
        config: Config,
        private: PrivateStore,
        transport: Arc<dyn Transport>,
    ) -> Result<Self, String> {
        let vault = match private.load_vault()? {
            Some(bytes) => serde_json::from_slice::<Vault>(&bytes)
                .map_err(|_| "invalid-native-authorization-storage")?,
            None => {
                let v = Vault::empty();
                private.save_vault(&Zeroizing::new(
                    serde_json::to_vec(&v).map_err(|_| "native-storage-error")?,
                ))?;
                v
            }
        };
        vault.validate()?;
        Ok(Self {
            config,
            private,
            transport,
            vault: Mutex::new(vault),
            operation: Mutex::new(()),
            authorization_generation: AtomicU64::new(0),
            foreground: Arc::new(OperationGate::new(true, "background-paused")),
            authorization: Arc::new(OperationGate::new(false, "authorization-cancelled")),
            rate_limit_until_ms: AtomicU64::new(0),
            candidate: Mutex::new(None),
        })
    }
    fn current(&self) -> Result<Vault, String> {
        self.vault
            .lock()
            .map(|v| v.clone())
            .map_err(|_| "native-authorization-busy".into())
    }
    fn commit(&self, vault: Vault) -> Result<(), String> {
        vault.validate()?;
        let bytes = Zeroizing::new(serde_json::to_vec(&vault).map_err(|_| "native-storage-error")?);
        self.private.save_vault(&bytes)?;
        *self.vault.lock().map_err(|_| "native-authorization-busy")? = vault;
        Ok(())
    }
    pub fn status(&self) -> Result<GradeSyncStatus, String> {
        let v = self.current()?;
        let state = if self.config.configured() {
            v.state
        } else {
            "not-configured".into()
        };
        Ok(GradeSyncStatus {
            foreground_sync_available: state == "ready",
            state,
            binding: v.binding,
            connection_id: v.connection_id,
            device_id: v.device_id,
            automatic_inbound: false,
            automatic_inbound_mode: "none",
        })
    }
    pub fn validate_connection(&self, connection_id: &str) -> Result<(), String> {
        if !valid_id(connection_id)
            || self.current()?.connection_id.as_deref() != Some(connection_id)
        {
            return Err("connection-changed".into());
        }
        Ok(())
    }
    pub fn set_foreground(&self, foreground: bool) {
        self.foreground.set(foreground);
    }
    pub fn cancel_authorization(&self) {
        self.authorization.set(false);
        self.authorization_generation.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut candidate) = self.candidate.lock() {
            *candidate = None;
        }
    }
    fn ensure_generation(&self, generation: u64) -> Result<(), String> {
        if self.authorization_generation.load(Ordering::SeqCst) == generation {
            Ok(())
        } else {
            Err("authorization-cancelled".into())
        }
    }

    /// Call only for the user's explicit Connect/Create action. The opener must
    /// use the OS browser, never an embedded WebView. No live flow runs at startup.
    pub fn connect_new_sheet<F>(
        &self,
        title: String,
        tab: String,
        open_system_browser: F,
    ) -> Result<GradeSyncStatus, String>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        if !self.config.configured() {
            return Err("not-configured: Windows Desktop OAuth client ID is missing".into());
        }
        if !valid_title(&title) || !valid_tab(&tab) {
            return Err("invalid-sheet-title-or-tab".into());
        }
        // A repeated click cannot create a second listener, grant, or workbook.
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "authorization-or-request-in-progress")?;
        let generation = self.authorization_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.authorization.set(true);
        let _reset = AuthorizationReset {
            gate: &self.authorization,
            keep_open: false,
        };
        let pending = PendingAuthorization::bind(&self.config)?;
        open_system_browser(&pending.authorization_url)
            .map_err(|_| "system-browser-unavailable")?;
        let code = pending.receive(|| self.ensure_generation(generation), OAUTH_TIMEOUT)?;
        self.ensure_generation(generation)?;
        let tokens = self.exchange(&code, &pending.verifier, &pending.redirect_uri)?;
        self.ensure_generation(generation)?;
        let response = self
            .transport
            .send(NativeRequest {
                method: "POST",
                url: format!("{SHEETS}/v4/spreadsheets"),
                bearer: Some(Zeroizing::new(tokens.access.clone())),
                form: None,
                json: Some(template(&title, &tab)),
                cancellation: Some(self.authorization.clone()),
            })
            .map_err(|error| {
                if error == "authorization-cancelled" {
                    "authorization-cancelled: a new Sheet may have been created".into()
                } else {
                    error
                }
            })?;
        let response = self.api_response(response);
        if !(200..300).contains(&response.status) {
            return Err(api_error(response.status).into());
        }
        let body: Value = serde_json::from_slice(&response.body)
            .map_err(|_| "invalid-sheet-creation-response")?;
        let sheet_id = body["spreadsheetId"]
            .as_str()
            .filter(|id| valid_sheet_id(id))
            .ok_or("invalid-sheet-creation-response")?;
        if !body["sheets"]
            .as_array()
            .is_some_and(|a| a.iter().any(|s| s["properties"]["title"] == tab))
        {
            return Err("invalid-sheet-creation-response".into());
        }
        self.ensure_generation(generation)
            .map_err(|_| "authorization-cancelled: a new Sheet may have been created")?;
        let binding = Binding {
            spreadsheet_id: sheet_id.into(),
            tab,
            confirmed: true,
            mapping: None,
            kind: None,
        };
        // Read back the actual header row before reporting success. Never trust a
        // POST response alone or claim a guessed/placeholder file is configured.
        let read = SheetsRequest {
            method: "GET".into(),
            path: read_path(&binding),
            body: None,
        };
        let checked = self.perform(&tokens.access, &binding, read, self.authorization.clone())?;
        if checked.status != 200
            || checked.body["values"].as_array().and_then(|v| v.first()) != Some(&json!(HEADERS))
        {
            return Err("created-sheet-verification-failed".into());
        }
        self.ensure_generation(generation)
            .map_err(|_| "authorization-cancelled: a new Sheet may have been created")?;
        let mut vault = self.current()?;
        vault.state = "ready".into();
        vault.tokens = Some(tokens);
        vault.binding = Some(binding);
        // A fresh unpredictable identifier per grant + newly-created sheet/tab.
        // Switching Google accounts can never reuse an earlier outbox.
        vault.connection_id = Some(random_id());
        self.commit(vault)?;
        self.rate_limit_until_ms.store(0, Ordering::SeqCst);
        self.status()
    }
    /// Creates a separate human-readable workbook for one explicitly chosen course.
    /// The renderer supplies course data, never Google API bodies, scopes or formulas.
    pub fn create_mapped_grade_sheet<F>(
        &self,
        course: Value,
        open_system_browser: F,
    ) -> Result<GradeSyncStatus, String>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        if !self.config.configured() {
            return Err("not-configured".into());
        }
        let (template, mapping) = mapped_template(&course)?;
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "authorization-or-request-in-progress")?;
        self.foreground.set(false);
        let mut paused = self.current()?;
        paused.state = "authorization-required".into();
        self.commit(paused)?;
        *self
            .candidate
            .lock()
            .map_err(|_| "native-authorization-busy")? = None;
        let generation = self.authorization_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.authorization.set(true);
        let _reset = AuthorizationReset {
            gate: &self.authorization,
            keep_open: false,
        };
        let pending = PendingAuthorization::bind(&self.config)?;
        open_system_browser(&pending.authorization_url)
            .map_err(|_| "system-browser-unavailable")?;
        let code = pending.receive(|| self.ensure_generation(generation), OAUTH_TIMEOUT)?;
        self.ensure_generation(generation)?;
        let tokens = self.exchange(&code, &pending.verifier, &pending.redirect_uri)?;
        self.ensure_generation(generation)?;
        let created = self.native_json(
            &tokens.access,
            "POST",
            format!("{SHEETS}/v4/spreadsheets"),
            Some(template),
            self.authorization.clone(),
        )?;
        let id = created["spreadsheetId"]
            .as_str()
            .filter(|id| valid_sheet_id(id))
            .ok_or("invalid-sheet-creation-response")?;
        self.ensure_generation(generation)
            .map_err(|_| "authorization-cancelled: a new Sheet may have been created")?;
        let snapshot =
            self.snapshot(&tokens.access, id, 0, "Grades", self.authorization.clone())?;
        check_mapping_snapshot(&mapping, &snapshot)?;
        for (i, assessment) in course["assessments"].as_array().unwrap().iter().enumerate() {
            let row = i + 2;
            if !same_scalar(
                &snapshot["cells"][format!("B{row}")]["value"],
                &assessment["weight"],
            ) {
                return Err("created-sheet-verification-failed".into());
            }
            let grade = course_grade(assessment)?;
            let actual = &snapshot["cells"][format!("C{row}")]["value"];
            if !same_scalar(actual, &grade) && !(grade == "" && actual.is_null()) {
                return Err("created-sheet-verification-failed".into());
            }
        }
        self.ensure_generation(generation)
            .map_err(|_| "authorization-cancelled: a new Sheet may have been created")?;
        let mut vault = self.current()?;
        vault.state = "ready".into();
        vault.tokens = Some(tokens);
        vault.binding = Some(Binding {
            spreadsheet_id: id.into(),
            tab: "Grades".into(),
            confirmed: true,
            mapping: Some(mapping),
            kind: Some("mapped".into()),
        });
        vault.connection_id = Some(random_id());
        self.commit(vault)?;
        self.rate_limit_until_ms.store(0, Ordering::SeqCst);
        self.foreground.set(true);
        self.status()
    }

    /// Official desktop Picker OAuth: only drive.file; selected IDs and tokens stay native.
    pub fn pick_grade_sheet<F>(&self, open_system_browser: F) -> Result<Value, String>
    where
        F: FnOnce(&str) -> Result<(), String>,
    {
        if !self.config.configured() {
            return Err("not-configured".into());
        }
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| "authorization-or-request-in-progress")?;
        self.foreground.set(false);
        let mut paused = self.current()?;
        paused.state = "authorization-required".into();
        self.commit(paused)?;
        *self
            .candidate
            .lock()
            .map_err(|_| "native-authorization-busy")? = None;
        let generation = self.authorization_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.authorization.set(true);
        let mut reset = AuthorizationReset {
            gate: &self.authorization,
            keep_open: false,
        };
        let pending = PendingAuthorization::bind_picker(&self.config)?;
        open_system_browser(&pending.authorization_url)
            .map_err(|_| "system-browser-unavailable")?;
        let code = pending.receive(|| self.ensure_generation(generation), OAUTH_TIMEOUT)?;
        self.ensure_generation(generation)?;
        let tokens = self.exchange(&code, &pending.verifier, &pending.redirect_uri)?;
        let id = pending
            .picked
            .lock()
            .map_err(|_| "invalid-oauth-callback")?
            .clone()
            .ok_or("invalid-oauth-callback")?;
        let body = self.native_json(&tokens.access, "GET", format!("{SHEETS}/v4/spreadsheets/{id}?fields=spreadsheetId,properties(title),sheets(properties)"), None, self.authorization.clone())?;
        let title = body["properties"]["title"]
            .as_str()
            .filter(|s| valid_title(s))
            .ok_or("invalid-sheet-response")?;
        if body["spreadsheetId"] != id {
            return Err("invalid-sheet-response".into());
        }
        let tabs = body["sheets"].as_array().filter(|a| !a.is_empty() && a.len() <= 100).ok_or("sheet-preview-limit")?.iter().map(|sheet| {
            let p = &sheet["properties"];
            let sheet_id = p["sheetId"].as_u64().filter(|n| *n <= i32::MAX as u64).ok_or("invalid-sheet-response")?;
            let tab = p["title"].as_str().filter(|s| valid_tab(s)).ok_or("invalid-sheet-response")?;
            if p["sheetType"].as_str().unwrap_or("GRID") != "GRID" { return Err("unsupported-sheet-type"); }
            Ok(json!({"sheetId":sheet_id,"title":tab,"tab":tab,"rowCount":p["gridProperties"]["rowCount"],"columnCount":p["gridProperties"]["columnCount"]}))
        }).collect::<Result<Vec<_>, &str>>()?;
        let selection_id = random_id();
        let public = json!({"selectionId":selection_id,"title":title,"tabs":tabs});
        self.ensure_generation(generation)?;
        *self
            .candidate
            .lock()
            .map_err(|_| "native-authorization-busy")? = Some(StagedCandidate {
            selection_id,
            spreadsheet_id: id,
            tokens,
            tabs,
            generation,
        });
        reset.keep_open = true;
        Ok(public)
    }
    pub fn preview_grade_sheet(
        &self,
        selection_id: String,
        sheet_id: u32,
    ) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        let staged = self
            .candidate
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        let candidate = staged
            .as_ref()
            .filter(|s| s.selection_id == selection_id)
            .ok_or("selection-expired")?;
        self.ensure_generation(candidate.generation)?;
        if candidate.tokens.expires_at <= epoch_seconds().saturating_add(60) {
            return Err("selection-expired".into());
        }
        let tab = candidate
            .tabs
            .iter()
            .find(|t| t["sheetId"] == sheet_id)
            .and_then(|t| t["tab"].as_str())
            .ok_or("invalid-sheet-mapping")?;
        self.snapshot(
            &candidate.tokens.access,
            &candidate.spreadsheet_id,
            sheet_id,
            tab,
            self.authorization.clone(),
        )
    }
    pub fn confirm_grade_sheet_mapping(
        &self,
        selection_id: String,
        mapping: Value,
    ) -> Result<GradeSyncStatus, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        validate_mapping(&mapping)?;
        let mut staged = self
            .candidate
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        let candidate = staged
            .as_ref()
            .filter(|s| s.selection_id == selection_id)
            .ok_or("selection-expired")?;
        self.ensure_generation(candidate.generation)?;
        if candidate.tokens.expires_at <= epoch_seconds().saturating_add(60) {
            return Err("selection-expired".into());
        }
        let sheet_id = mapping["sheetId"].as_u64().ok_or("invalid-sheet-mapping")? as u32;
        let tab = mapping["tab"].as_str().ok_or("invalid-sheet-mapping")?;
        if !candidate
            .tabs
            .iter()
            .any(|t| t["sheetId"] == sheet_id && t["tab"] == tab)
        {
            return Err("invalid-sheet-mapping".into());
        }
        let snapshot = self.snapshot(
            &candidate.tokens.access,
            &candidate.spreadsheet_id,
            sheet_id,
            tab,
            self.authorization.clone(),
        )?;
        check_mapping_snapshot(&mapping, &snapshot)?;
        self.ensure_generation(candidate.generation)?;
        if candidate.tokens.expires_at <= epoch_seconds().saturating_add(60) {
            return Err("selection-expired".into());
        }
        let mut vault = self.current()?;
        vault.tokens = Some(candidate.tokens.clone());
        vault.binding = Some(Binding {
            spreadsheet_id: candidate.spreadsheet_id.clone(),
            tab: tab.into(),
            confirmed: true,
            mapping: Some(mapping),
            kind: Some("mapped".into()),
        });
        vault.connection_id = Some(random_id());
        vault.state = "ready".into();
        self.commit(vault)?;
        *staged = None;
        self.rate_limit_until_ms.store(0, Ordering::SeqCst);
        self.foreground.set(true);
        self.status()
    }
    fn native_json(
        &self,
        token: &str,
        method: &'static str,
        url: String,
        body: Option<Value>,
        gate: Arc<OperationGate>,
    ) -> Result<Value, String> {
        gate.check()?;
        if epoch_millis() < self.rate_limit_until_ms.load(Ordering::SeqCst) {
            return Err("rate-limited".into());
        }
        let response = self.api_response(self.transport.send(NativeRequest {
            method,
            url,
            bearer: Some(Zeroizing::new(token.into())),
            form: None,
            json: body,
            cancellation: Some(gate.clone()),
        })?);
        gate.check()?;
        if !(200..300).contains(&response.status) {
            return Err(if response.status == 401 {
                "access-token-expired"
            } else {
                api_error(response.status)
            }
            .into());
        }
        if response.body.len() > MAX_RESPONSE {
            return Err("response-limit".into());
        }
        serde_json::from_slice(&response.body).map_err(|_| "invalid-sheet-response".into())
    }
    fn snapshot(
        &self,
        token: &str,
        id: &str,
        sheet_id: u32,
        tab: &str,
        gate: Arc<OperationGate>,
    ) -> Result<Value, String> {
        let range = format!("'{}'!A1:Z200", tab.replace('\'', "''"));
        let body = self.native_json(token, "GET", format!("{SHEETS}/v4/spreadsheets/{id}?ranges={}&includeGridData=true&fields=sheets(properties(sheetId,title,gridProperties),merges,protectedRanges,data(startRow,startColumn,rowData(values(userEnteredValue,effectiveValue,effectiveFormat(numberFormat)))))", encode_component(&range)), None, gate)?;
        sanitize_snapshot(body, sheet_id, tab)
    }
    fn with_current_token(
        &self,
        mut call: impl FnMut(&str) -> Result<Value, String>,
    ) -> Result<Value, String> {
        let token = self.access_token(false)?;
        let mut result = call(&token);
        if result
            .as_ref()
            .err()
            .is_some_and(|e| e == "access-token-expired")
        {
            result = call(&self.access_token(true)?);
        }
        if let Err(error) = &result {
            if error == "access-token-expired" || error == "authorization-required" {
                let mut vault = self.current()?;
                if error == "access-token-expired" {
                    vault.tokens = None;
                }
                vault.state = "authorization-required".into();
                self.commit(vault)?;
                return Err("authorization-required".into());
            }
        }
        result
    }
    pub fn read_mapped_grade_snapshot(&self, connection_id: String) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        self.validate_connection(&connection_id)?;
        let vault = self.current()?;
        let binding = vault.binding.ok_or("authorization-required")?;
        let mapping = binding.mapping.as_ref().ok_or("mapping-required")?;
        let sheet_id = mapping["sheetId"].as_u64().ok_or("invalid-sheet-mapping")? as u32;
        self.with_current_token(|token| {
            self.snapshot(
                token,
                &binding.spreadsheet_id,
                sheet_id,
                &binding.tab,
                self.foreground.clone(),
            )
        })
    }
    pub fn commit_mapped_grade_cells(
        &self,
        connection_id: String,
        expected_snapshot: Value,
        writes: Value,
    ) -> Result<Value, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        self.validate_connection(&connection_id)?;
        let vault = self.current()?;
        let binding = vault.binding.ok_or("authorization-required")?;
        let mapping = binding.mapping.as_ref().ok_or("mapping-required")?;
        let allowed = validate_mapping(mapping)?;
        let writes = writes
            .as_array()
            .filter(|w| !w.is_empty() && w.len() <= 1000)
            .ok_or("sheet-write-limit")?;
        let mut seen = std::collections::HashSet::new();
        for write in writes {
            let cell = write["cell"].as_str().ok_or("sheet-route-not-allowed")?;
            if write.as_object().map(|o| o.len()) != Some(2)
                || !allowed.contains(&cell.to_owned())
                || !seen.insert(cell)
                || !valid_mapped_write(mapping, cell, &write["value"])
            {
                return Err("sheet-route-not-allowed".into());
            }
        }
        let sheet_id = mapping["sheetId"].as_u64().ok_or("invalid-sheet-mapping")? as u32;
        let before = self.with_current_token(|token| {
            self.snapshot(
                token,
                &binding.spreadsheet_id,
                sheet_id,
                &binding.tab,
                self.foreground.clone(),
            )
        })?;
        check_mapping_snapshot(&mapping, &before)?;
        if before != expected_snapshot {
            return Err("sheet-conflict".into());
        }
        let data = writes.iter().map(|w| json!({"range":format!("{}!{}", a1_tab(&binding),w["cell"].as_str().unwrap()),"majorDimension":"ROWS","values":[[if w["value"].is_null() { json!("") } else { w["value"].clone() }]]})).collect::<Vec<_>>();
        let body = json!({"valueInputOption":"RAW","data":data});
        if serde_json::to_vec(&body)
            .map_err(|_| "sheet-write-limit")?
            .len()
            > MAX_WRITE
        {
            return Err("sheet-write-limit".into());
        }
        self.with_current_token(|token| {
            self.native_json(
                token,
                "POST",
                format!(
                    "{SHEETS}/v4/spreadsheets/{}/values:batchUpdate",
                    binding.spreadsheet_id
                ),
                Some(body.clone()),
                self.foreground.clone(),
            )
        })?;
        let after = self.with_current_token(|token| {
            self.snapshot(
                token,
                &binding.spreadsheet_id,
                sheet_id,
                &binding.tab,
                self.foreground.clone(),
            )
        })?;
        check_mapping_snapshot(&mapping, &after)?;
        for write in writes {
            let actual = &after["cells"][write["cell"].as_str().unwrap()]["value"];
            if !same_scalar(actual, &write["value"])
                && !((write["value"].is_null() || write["value"] == "")
                    && (actual.is_null() || actual == ""))
            {
                return Err("write-verification-failed".into());
            }
        }
        Ok(after)
    }

    fn token_form(&self) -> Vec<(String, Zeroizing<String>)> {
        let mut form = vec![(
            "client_id".into(),
            Zeroizing::new(self.config.client_id.clone()),
        )];
        if !self.config.client_secret.is_empty() {
            form.push((
                "client_secret".into(),
                Zeroizing::new(self.config.client_secret.clone()),
            ));
        }
        form
    }
    fn exchange(&self, code: &str, verifier: &str, redirect: &str) -> Result<Tokens, String> {
        let mut form = self.token_form();
        for (k, v) in [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect),
        ] {
            form.push((k.into(), Zeroizing::new(v.into())));
        }
        let response = self.transport.send(NativeRequest {
            method: "POST",
            url: TOKEN.into(),
            bearer: None,
            form: Some(form),
            json: None,
            cancellation: Some(self.authorization.clone()),
        })?;
        parse_tokens(response, None)
    }
    fn access_token(&self, force: bool) -> Result<Zeroizing<String>, String> {
        self.foreground.check()?;
        if epoch_millis() < self.rate_limit_until_ms.load(Ordering::SeqCst) {
            return Err("rate-limited".into());
        }
        let mut vault = self.current()?;
        if vault.state != "ready" {
            return Err(vault.state);
        }
        let tokens = vault.tokens.as_ref().ok_or("authorization-required")?;
        if !force && tokens.expires_at > epoch_seconds().saturating_add(60) {
            return Ok(Zeroizing::new(tokens.access.clone()));
        }
        let mut form = self.token_form();
        form.push(("grant_type".into(), Zeroizing::new("refresh_token".into())));
        form.push((
            "refresh_token".into(),
            Zeroizing::new(tokens.refresh.clone()),
        ));
        let response = self.transport.send(NativeRequest {
            method: "POST",
            url: TOKEN.into(),
            bearer: None,
            form: Some(form),
            json: None,
            cancellation: Some(self.foreground.clone()),
        })?;
        let refreshed = match parse_tokens(response, Some(&tokens.refresh)) {
            Ok(tokens) => tokens,
            Err(e) if e == "revoked" => {
                vault.tokens = None;
                vault.state = "revoked".into();
                self.commit(vault)?;
                return Err(e);
            }
            Err(e) => return Err(e),
        };
        let access = Zeroizing::new(refreshed.access.clone());
        vault.tokens = Some(refreshed);
        self.commit(vault)?;
        Ok(access)
    }
    pub fn request(&self, request: SheetsRequest) -> Result<SheetsResponse, String> {
        if !self.config.configured() {
            return Err("not-configured".into());
        }
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        let vault = self.current()?;
        if vault.state != "ready" {
            return Err(vault.state);
        }
        let binding = vault.binding.ok_or("authorization-required")?;
        validate_request(&binding, &request)?; // Validate before token refresh/network.
        let token = self.access_token(false)?;
        let retry_request = SheetsRequest {
            method: request.method.clone(),
            path: request.path.clone(),
            body: request.body.clone(),
        };
        let mut response = self.perform(&token, &binding, request, self.foreground.clone())?;
        // Exactly one refresh/retry on expired access. Serialized with all other
        // requests, so simultaneous clients cannot race refresh-token rotation.
        if response.status == 401 {
            let token = self.access_token(true)?;
            response = self.perform(&token, &binding, retry_request, self.foreground.clone())?;
        }
        if [401, 403].contains(&response.status) {
            let mut vault = self.current()?;
            // A permission denial is not proof that the OAuth grant was revoked.
            // Keep refresh credentials for an explicit recovery/disconnect action.
            if response.status == 401 {
                vault.tokens = None;
            }
            vault.state = "authorization-required".into();
            self.commit(vault)?;
        }
        Ok(response)
    }
    /// Small native-only revision probe. The renderer chooses no file ID, URL,
    /// fields or scopes; only the current bound app-created workbook is checked.
    pub fn sheet_version(&self) -> Result<SheetVersion, String> {
        if !self.config.configured() {
            return Err("not-configured".into());
        }
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        let vault = self.current()?;
        if vault.state != "ready" {
            return Err(vault.state);
        }
        let binding = vault.binding.ok_or("authorization-required")?;
        let probe = |token: &str| {
            self.transport
                .send(NativeRequest {
                    method: "GET",
                    url: format!(
                    "https://www.googleapis.com/drive/v3/files/{}?fields=version%2CmodifiedTime",
                    binding.spreadsheet_id
                ),
                    bearer: Some(Zeroizing::new(token.into())),
                    form: None,
                    json: None,
                    cancellation: Some(self.foreground.clone()),
                })
                .map(|response| self.api_response(response))
        };
        let token = self.access_token(false)?;
        let mut response = probe(&token)?;
        if response.status == 401 {
            response = probe(&self.access_token(true)?)?;
        }
        if [401, 403].contains(&response.status) {
            let mut vault = self.current()?;
            // A permission denial is not proof that the OAuth grant was revoked.
            // Keep refresh credentials for an explicit recovery/disconnect action.
            if response.status == 401 {
                vault.tokens = None;
            }
            vault.state = "authorization-required".into();
            self.commit(vault)?;
        }
        if response.status != 200 {
            return Err(api_error(response.status).into());
        }
        let value: Value =
            serde_json::from_slice(&response.body).map_err(|_| "invalid-version-response")?;
        // Drive serializes the int64 version as a decimal string. Do not convert
        // it to a JS number and lose precision for large revisions.
        let version = value["version"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_digit()))
            .ok_or("invalid-version-response")?;
        let modified_time = value
            .get("modifiedTime")
            .and_then(Value::as_str)
            .filter(|s| {
                s.len() <= 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || b"-:.TZ+".contains(&b))
            })
            .map(str::to_owned);
        Ok(SheetVersion {
            version: version.into(),
            modified_time,
        })
    }
    fn api_response(&self, mut response: NativeResponse) -> NativeResponse {
        if response.status == 403 {
            if let Ok(value) = serde_json::from_slice::<Value>(&response.body) {
                let quota = value["error"]["errors"].as_array().is_some_and(|errors| {
                    errors.iter().any(|error| {
                        matches!(
                            error["reason"].as_str(),
                            Some(
                                "rateLimitExceeded"
                                    | "userRateLimitExceeded"
                                    | "dailyLimitExceeded"
                                    | "quotaExceeded"
                                    | "sharingRateLimitExceeded"
                                    | "downloadQuotaExceeded"
                            )
                        )
                    })
                });
                if quota {
                    response.status = 429;
                }
            }
        }
        if response.status == 429 {
            let wait = response
                .retry_after_ms
                .unwrap_or(60000)
                .clamp(1000, 3600000);
            response.retry_after_ms = Some(wait);
            self.rate_limit_until_ms
                .store(epoch_millis().saturating_add(wait), Ordering::SeqCst);
        }
        response
    }
    fn perform(
        &self,
        token: &str,
        binding: &Binding,
        request: SheetsRequest,
        cancellation: Arc<OperationGate>,
    ) -> Result<SheetsResponse, String> {
        let method = validate_request(binding, &request)?;
        let response = self.transport.send(NativeRequest {
            method,
            url: format!("{SHEETS}{}", request.path),
            bearer: Some(Zeroizing::new(token.into())),
            form: None,
            json: request.body,
            cancellation: Some(cancellation),
        })?;
        let response = self.api_response(response);
        // Error response text can contain identifiers or echoed request material.
        // Return only stable codes. Success fields are explicitly whitelisted.
        let body = if (200..300).contains(&response.status) {
            let value: Value =
                serde_json::from_slice(&response.body).map_err(|_| "invalid-sheet-response")?;
            sanitize_values_response(method, value)?
        } else {
            json!({"error":{"code":api_error(response.status)}})
        };
        Ok(SheetsResponse {
            status: response.status,
            body,
            retry_after_ms: response.retry_after_ms,
        })
    }
    /// Always removes local credentials. A failed remote revocation is explicit;
    /// callers should show the Google account permissions link if false.
    pub fn disconnect(&self, revoke_google: bool) -> Result<DisconnectResult, String> {
        self.cancel_authorization();
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "native-authorization-busy")?;
        let mut vault = self.current()?;
        let token = vault
            .tokens
            .as_ref()
            .map(|t| Zeroizing::new(t.refresh.clone()));
        vault.tokens = None;
        vault.state = "revoked".into();
        self.commit(vault)?;
        let confirmed = if let Some(token) = token {
            if revoke_google {
                self.transport
                    .send(NativeRequest {
                        method: "POST",
                        url: REVOKE.into(),
                        bearer: None,
                        form: Some(vec![("token".into(), token)]),
                        json: None,
                        cancellation: None,
                    })
                    .map(|r| r.status == 200)
                    .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };
        Ok(DisconnectResult {
            ok: true,
            google_revocation_confirmed: confirmed,
        })
    }
}

fn same_scalar(left: &Value, right: &Value) -> bool {
    left == right || (left.is_number() && right.is_number() && left.as_f64() == right.as_f64())
}
fn course_grade(assessment: &Value) -> Result<Value, String> {
    match assessment["status"].as_str() {
        Some("ungraded") => Ok(json!("")),
        Some("graded") => {
            let score = &assessment["score"];
            match score["mode"].as_str() {
                Some("ratio") => Ok(score["value"].clone()),
                Some("points") => {
                    let earned = score["earned"]
                        .as_f64()
                        .filter(|v| v.is_finite() && *v >= 0.0)
                        .ok_or("invalid-course")?;
                    let possible = score["possible"]
                        .as_f64()
                        .filter(|v| v.is_finite() && *v > 0.0 && earned <= *v)
                        .ok_or("invalid-course")?;
                    Ok(json!(format!("{earned}/{possible}")))
                }
                _ => Err("invalid-course".into()),
            }
        }
        _ => Err("unsupported-assessment-status".into()),
    }
}
fn mapped_template(course: &Value) -> Result<(Value, Value), String> {
    let title = course["title"]
        .as_str()
        .filter(|s| valid_title(s))
        .ok_or("invalid-course")?;
    let assessments = course["assessments"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 190)
        .ok_or("sheet-preview-limit")?;
    let mapping = json!({"schemaVersion":1,"confirmed":true,"sheetId":0,"tab":"Grades","courses":[{"id":course["id"],"title":title,"termId":course["termId"],"rules":course["rules"],"assessments":assessments.iter().enumerate().map(|(i,a)| json!({"id":a["id"],"title":a["title"],"gradeCell":format!("C{}",i+2),"weightCell":format!("B{}",i+2),"gradeMode":"ratio","weightMode":"ratio","anchor":{"cell":format!("A{}",i+2),"text":a["title"]}})).collect::<Vec<_>>()}]});
    validate_mapping(&mapping)?;
    let mut rows = vec![
        json!({"values":(["Assessment","Weight","Grade","Contribution"].iter().map(|s|json!({"userEnteredValue":{"stringValue":s},"userEnteredFormat":{"textFormat":{"bold":true},"backgroundColor":{"red":0.88,"green":0.94,"blue":0.90}}})).collect::<Vec<_>>())}),
    ];
    for (i, assessment) in assessments.iter().enumerate() {
        let row = i + 2;
        let grade = course_grade(assessment)?;
        if !valid_mapped_write(&mapping, &format!("B{row}"), &assessment["weight"])
            || !valid_mapped_write(&mapping, &format!("C{row}"), &grade)
        {
            return Err("invalid-course".into());
        }
        let grade_value = if grade.is_number() {
            json!({"numberValue":grade})
        } else {
            json!({"stringValue":grade})
        };
        let contribution = format!("=IF(C{row}=\"\",\"\",B{row}*IF(ISNUMBER(C{row}),C{row},VALUE(INDEX(SPLIT(C{row},\"/\"),1,1))/VALUE(INDEX(SPLIT(C{row},\"/\"),1,2))))");
        rows.push(json!({"values":[{"userEnteredValue":{"stringValue":assessment["title"]}},{"userEnteredValue":{"numberValue":assessment["weight"]},"userEnteredFormat":{"numberFormat":{"type":"PERCENT","pattern":"0.##%"}}},{"userEnteredValue":grade_value,"userEnteredFormat":{"numberFormat":{"type":"PERCENT","pattern":"0.##%"}}},{"userEnteredValue":{"formulaValue":contribution},"userEnteredFormat":{"numberFormat":{"type":"PERCENT","pattern":"0.##%"}}}]}));
    }
    let end = assessments.len() + 1;
    rows.push(json!({}));
    for (label,formula) in [
        ("Total weight",format!("=SUM(B2:B{end})")),
        ("Earned contribution",format!("=SUM(D2:D{end})")),
        ("Graded weight",format!("=SUMIF(C2:C{end},\"<>\",B2:B{end})")),
        ("Current average",format!("=IF(SUMIF(C2:C{end},\"<>\",B2:B{end})=0,\"\",SUM(D2:D{end})/SUMIF(C2:C{end},\"<>\",B2:B{end}))")),
    ] {
        rows.push(json!({"values":[{"userEnteredValue":{"stringValue":label}},{},{},{"userEnteredValue":{"formulaValue":formula},"userEnteredFormat":{"numberFormat":{"type":"PERCENT","pattern":"0.##%"}}}]}));
    }
    let body = json!({"properties":{"title":title},"sheets":[{"properties":{"sheetId":0,"title":"Grades","gridProperties":{"rowCount":200,"columnCount":26,"frozenRowCount":1}},"data":[{"rowData":rows}]}]});
    if serde_json::to_vec(&body)
        .map_err(|_| "sheet-write-limit")?
        .len()
        > 512 * 1024
    {
        return Err("sheet-write-limit".into());
    }
    Ok((body, mapping))
}

fn cell_position(cell: &str) -> Option<(usize, usize)> {
    let bytes = cell.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_uppercase() {
        return None;
    }
    let row = cell[1..].parse::<usize>().ok()?;
    if !(1..=200).contains(&row) || cell[1..] != row.to_string() || bytes[0] > b'Z' {
        return None;
    }
    Some((row - 1, (bytes[0] - b'A') as usize))
}
fn validate_mapping(mapping: &Value) -> Result<Vec<String>, String> {
    let bad = || "invalid-sheet-mapping".to_owned();
    if serde_json::to_vec(mapping).map_err(|_| bad())?.len() > MAX_WRITE
        || mapping["schemaVersion"] != 1
        || mapping["confirmed"] != true
        || !mapping["sheetId"]
            .as_u64()
            .is_some_and(|n| n <= i32::MAX as u64)
        || !mapping["tab"].as_str().is_some_and(valid_tab)
    {
        return Err(bad());
    }
    let courses = mapping["courses"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 100)
        .ok_or_else(bad)?;
    let mut destinations = Vec::new();
    let mut anchors = Vec::new();
    let mut ids = std::collections::HashSet::new();
    let mut count = 0;
    for course in courses {
        for key in ["id", "title"] {
            if !course[key]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
            {
                return Err(bad());
            }
        }
        if !course["termId"].as_str().is_some_and(|s| s.len() <= 1000) {
            return Err(bad());
        }
        if !ids.insert(course["id"].as_str().unwrap().to_owned())
            || !matches!(
                course["rules"]["kind"].as_str(),
                Some("weighted" | "unconfirmed")
            )
        {
            return Err(bad());
        }
        let mut assessment_ids = std::collections::HashSet::new();
        for assessment in course["assessments"]
            .as_array()
            .filter(|a| !a.is_empty())
            .ok_or_else(bad)?
        {
            count += 1;
            if count > 1000 {
                return Err(bad());
            }
            for key in ["id", "title"] {
                if !assessment[key]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
                {
                    return Err(bad());
                }
            }
            if !assessment_ids.insert(assessment["id"].as_str().unwrap().to_owned())
                || !matches!(
                    assessment["gradeMode"].as_str(),
                    Some("ratio" | "percentage" | "fraction")
                )
                || !matches!(
                    assessment["weightMode"].as_str(),
                    Some("ratio" | "percentage")
                )
            {
                return Err(bad());
            }
            let grade = assessment["gradeCell"]
                .as_str()
                .filter(|s| cell_position(s).is_some())
                .ok_or_else(bad)?;
            let weight = assessment["weightCell"]
                .as_str()
                .filter(|s| cell_position(s).is_some())
                .ok_or_else(bad)?;
            if grade == weight || destinations.iter().any(|s| s == grade || s == weight) {
                return Err(bad());
            }
            destinations.push(grade.to_owned());
            destinations.push(weight.to_owned());
            let anchor = assessment["anchor"]["cell"]
                .as_str()
                .filter(|s| cell_position(s).is_some())
                .ok_or_else(bad)?;
            if !assessment["anchor"]["text"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty() && s.len() <= 1000)
            {
                return Err(bad());
            }
            anchors.push(anchor.to_owned());
        }
    }
    if destinations.iter().any(|d| anchors.contains(d)) {
        return Err(bad());
    }
    Ok(destinations)
}
fn valid_mapped_write(mapping: &Value, cell: &str, value: &Value) -> bool {
    for course in mapping["courses"].as_array().into_iter().flatten() {
        for assessment in course["assessments"].as_array().into_iter().flatten() {
            let grade = assessment["gradeCell"] == cell;
            let weight = assessment["weightCell"] == cell;
            if !grade && !weight {
                continue;
            }
            let mode = if grade {
                &assessment["gradeMode"]
            } else {
                &assessment["weightMode"]
            };
            if let Some(number) = value.as_f64() {
                return number.is_finite()
                    && number >= 0.0
                    && number <= if mode == "percentage" { 100.0 } else { 1.0 };
            }
            if !grade {
                return false;
            }
            if value == "" {
                return true;
            }
            if let Some(fraction) = value.as_str().filter(|s| s.len() <= 100) {
                if let Some((earned, possible)) = fraction.split_once('/') {
                    let decimal = |s: &str| {
                        !s.is_empty()
                            && s.bytes().all(|b| b.is_ascii_digit() || b == b'.')
                            && s.bytes().filter(|b| *b == b'.').count() <= 1
                            && s.as_bytes()[0].is_ascii_digit()
                            && s.as_bytes()[s.len() - 1].is_ascii_digit()
                    };
                    if decimal(earned) && decimal(possible) {
                        if let (Ok(e), Ok(p)) = (earned.parse::<f64>(), possible.parse::<f64>()) {
                            return e.is_finite() && p.is_finite() && e >= 0.0 && p > 0.0 && e <= p;
                        }
                    }
                }
            }
            return false;
        }
    }
    false
}
fn check_mapping_snapshot(mapping: &Value, snapshot: &Value) -> Result<(), String> {
    validate_mapping(mapping)?;
    if snapshot["complete"] != true
        || snapshot["sheetId"] != mapping["sheetId"]
        || snapshot["tab"] != mapping["tab"]
    {
        return Err("incomplete-sheet-preview".into());
    }
    for course in mapping["courses"].as_array().unwrap() {
        for assessment in course["assessments"].as_array().unwrap() {
            let grade = &snapshot["cells"][assessment["gradeCell"].as_str().unwrap()];
            if grade["formula"] != false || grade["protected"] != false {
                return Err("formula-or-protected-cell".into());
            }
            let anchor =
                &snapshot["cells"][assessment["anchor"]["cell"].as_str().unwrap()]["value"];
            if anchor.as_str() != assessment["anchor"]["text"].as_str() {
                return Err("mapping-anchor-changed".into());
            }
            let weight_cell = &snapshot["cells"][assessment["weightCell"].as_str().unwrap()];
            if weight_cell["formula"] != false || weight_cell["protected"] != false {
                return Err("formula-or-protected-cell".into());
            }
            let weight = &weight_cell["value"];
            if !valid_mapped_write(mapping, assessment["weightCell"].as_str().unwrap(), weight) {
                return Err("invalid-mapped-weight".into());
            }
        }
    }
    Ok(())
}
fn sanitize_snapshot(body: Value, sheet_id: u32, tab: &str) -> Result<Value, String> {
    let sheets = body["sheets"]
        .as_array()
        .filter(|s| s.len() == 1)
        .ok_or("invalid-sheet-response")?;
    let sheet = &sheets[0];
    if sheet["properties"]["sheetId"] != sheet_id || sheet["properties"]["title"] != tab {
        return Err("invalid-sheet-response".into());
    }
    let rows = sheet["properties"]["gridProperties"]["rowCount"]
        .as_u64()
        .ok_or("invalid-sheet-response")?;
    let cols = sheet["properties"]["gridProperties"]["columnCount"]
        .as_u64()
        .ok_or("invalid-sheet-response")?;
    if rows == 0 || cols == 0 {
        return Err("sheet-preview-limit".into());
    }
    let mut cells = serde_json::Map::new();
    for row in 0..200 {
        for col in 0..26 {
            cells.insert(format!("{}{}", (b'A' + col as u8) as char, row + 1),json!({"value":"","formula":false,"protected":row as u64 >= rows || col as u64 >= cols}));
        }
    }
    let mut protected = Vec::new();
    if let Some(merges) = sheet["merges"].as_array() {
        protected.extend(merges.iter().cloned());
    }
    if let Some(ranges) = sheet["protectedRanges"].as_array() {
        for range in ranges {
            // Named-range protection cannot be resolved from this bounded response.
            // Fail closed by protecting the whole selected tab.
            protected.push(
                range
                    .get("range")
                    .cloned()
                    .unwrap_or(json!({"sheetId":sheet_id})),
            );
        }
    }
    for range in protected {
        if range["sheetId"].as_u64().unwrap_or(sheet_id as u64) != sheet_id as u64 {
            continue;
        }
        let sr = range["startRowIndex"].as_u64().unwrap_or(0).min(200) as usize;
        let er = range["endRowIndex"].as_u64().unwrap_or(200).min(200) as usize;
        let sc = range["startColumnIndex"].as_u64().unwrap_or(0).min(26) as usize;
        let ec = range["endColumnIndex"].as_u64().unwrap_or(26).min(26) as usize;
        for row in sr..er {
            for col in sc..ec {
                cells
                    .get_mut(&format!("{}{}", (b'A' + col as u8) as char, row + 1))
                    .unwrap()["protected"] = json!(true);
            }
        }
    }
    let grids = sheet["data"].as_array().ok_or("invalid-sheet-response")?;
    if grids.len() > 1 {
        return Err("invalid-sheet-response".into());
    }
    for grid in grids {
        if grid["startRow"].as_u64().unwrap_or(0) != 0
            || grid["startColumn"].as_u64().unwrap_or(0) != 0
        {
            return Err("invalid-sheet-response".into());
        }
        if let Some(data) = grid["rowData"].as_array() {
            if data.len() > 200 {
                return Err("sheet-preview-limit".into());
            }
            for (row, values) in data.iter().enumerate() {
                if let Some(values) = values["values"].as_array() {
                    if values.len() > 26 {
                        return Err("sheet-preview-limit".into());
                    }
                    for (col, value) in values.iter().enumerate() {
                        let effective = &value["effectiveValue"];
                        let entered = &value["userEnteredValue"];
                        if row >= 200 {
                            if !effective.is_null() || !entered.is_null() {
                                return Err("sheet-preview-limit".into());
                            }
                            continue;
                        }
                        let target = cells
                            .get_mut(&format!("{}{}", (b'A' + col as u8) as char, row + 1))
                            .unwrap();
                        target["formula"] = json!(entered.get("formulaValue").is_some());
                        let mut scalar = effective
                            .get("numberValue")
                            .or_else(|| effective.get("stringValue"))
                            .or_else(|| effective.get("boolValue"))
                            .cloned()
                            .unwrap_or(json!(""));
                        if let Some(n) = scalar.as_f64() {
                            if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9007199254740991.0 {
                                scalar = json!(n as i64);
                            }
                        }
                        if scalar.as_str().is_some_and(|s| s.len() > 16000) {
                            return Err("sheet-preview-limit".into());
                        }
                        target["value"] = scalar;
                        if effective.get("errorValue").is_some() {
                            target["protected"] = json!(true);
                        }
                        if let Some(format) = value["effectiveFormat"]["numberFormat"].as_object() {
                            let kind = format.get("type").and_then(Value::as_str).unwrap_or("");
                            if kind.len() > 40 {
                                return Err("invalid-sheet-response".into());
                            }
                            target["numberFormat"] = json!(kind);
                        }
                    }
                }
            }
        }
    }
    Ok(json!({"sheetId":sheet_id,"tab":tab,"complete":true,"previewRange":"A1:Z200","cells":cells}))
}

fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16384 && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
}
fn valid_sheet_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn valid_title(title: &str) -> bool {
    !title.trim().is_empty() && title.chars().count() <= 200 && !title.chars().any(char::is_control)
}
fn valid_tab(tab: &str) -> bool {
    !tab.trim().is_empty()
        && tab.chars().count() <= 100
        && !tab
            .chars()
            .any(|c| c.is_control() || "[]:*?/\\".contains(c))
}
fn a1_tab(binding: &Binding) -> String {
    format!("'{}'", binding.tab.replace('\'', "''"))
}
fn encode_component(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
        .replace("%7E", "~")
}
fn read_path(binding: &Binding) -> String {
    format!(
        "/v4/spreadsheets/{}/values/{}?valueRenderOption=UNFORMATTED_VALUE",
        binding.spreadsheet_id,
        encode_component(&format!("{}!A1:N1002", a1_tab(binding)))
    )
}
fn api_error(status: u16) -> &'static str {
    match status {
        401 => "authorization-required",
        403 => "authorization-required",
        404 => "relink-required",
        429 => "rate-limited",
        500..=599 => "network-error",
        _ => "request-failed",
    }
}
fn template(title: &str, tab: &str) -> Value {
    json!({"properties":{"title":title},"sheets":[{"properties":{"title":tab,"gridProperties":{"rowCount":1002,"columnCount":14,"frozenRowCount":1}},"data":[{"rowData":[{"values":HEADERS.iter().map(|h| json!({"userEnteredValue":{"stringValue":h}})).collect::<Vec<_>>()}]}]}]})
}
fn parse_tokens(response: NativeResponse, old_refresh: Option<&str>) -> Result<Tokens, String> {
    let value: Value =
        serde_json::from_slice(&response.body).map_err(|_| "invalid-oauth-response")?;
    if response.status != 200 {
        return Err(if value["error"] == "invalid_grant" {
            "revoked"
        } else if response.status >= 500 || response.status == 429 {
            "network-error"
        } else {
            "authorization-required"
        }
        .into());
    }
    if !value["token_type"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("Bearer"))
    {
        return Err("invalid-oauth-response".into());
    }
    // Never reuse broader consent as an implicit permission to read other files.
    // Google may omit scope on refresh, in which case the original scope applies.
    if let Some(scope) = value.get("scope") {
        if scope
            .as_str()
            .map(|s| s.split_ascii_whitespace().collect::<Vec<_>>())
            != Some(vec![SCOPE])
        {
            return Err("unexpected-oauth-scope".into());
        }
    }
    let access = value["access_token"]
        .as_str()
        .filter(|s| valid_token(s))
        .ok_or("invalid-oauth-response")?;
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .or(old_refresh)
        .filter(|s| valid_token(s))
        .ok_or("offline-authorization-required")?;
    let expires = value["expires_in"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 86400)
        .ok_or("invalid-oauth-response")?;
    Ok(Tokens {
        access: access.into(),
        refresh: refresh.into(),
        expires_at: epoch_seconds().saturating_add(expires),
    })
}

fn validate_request(binding: &Binding, request: &SheetsRequest) -> Result<&'static str, String> {
    let deny = || "sheet-route-not-allowed".to_owned();
    if binding.mapping.is_some() {
        return Err(deny());
    }
    if request.path.len() > 2000
        || !request.path.starts_with('/')
        || request.path.starts_with("//")
        || request.path.contains('#')
        || request.path.contains('\\')
        || request.path.chars().any(char::is_control)
    {
        return Err(deny());
    }
    let url = Url::parse(&format!("{SHEETS}{}", request.path)).map_err(|_| deny())?;
    let prefix = format!("/v4/spreadsheets/{}/values/", binding.spreadsheet_id);
    let encoded = url.path().strip_prefix(&prefix).ok_or_else(deny)?;
    if encoded.is_empty() || encoded.contains('/') {
        return Err(deny());
    }
    // Decode exactly once; reject malformed escapes, double encoding, and routes
    // outside the exact bound tab. No batchUpdate, append, clear or metadata API.
    let decoded = percent_decode(encoded).ok_or_else(deny)?;
    let query: Vec<_> = url.query_pairs().collect();
    if query.len() != 1 {
        return Err(deny());
    }
    let a1 = a1_tab(binding);
    match request.method.as_str() {
        "GET"
            if request.body.as_ref().map_or(true, Value::is_null)
                && query[0].0 == "valueRenderOption"
                && query[0].1 == "UNFORMATTED_VALUE"
                && decoded == format!("{a1}!A1:N1002") =>
        {
            Ok("GET")
        }
        "PUT" if query[0].0 == "valueInputOption" && query[0].1 == "RAW" => {
            let range = decoded.strip_prefix(&format!("{a1}!A")).ok_or_else(deny)?;
            let (left, right) = range.split_once(":N").ok_or_else(deny)?;
            let row = left.parse::<u16>().map_err(|_| deny())?;
            if !(2..=1001).contains(&row) || right != left || left != row.to_string() {
                return Err(deny());
            }
            let body = request.body.as_ref().ok_or_else(deny)?;
            let object = body.as_object().ok_or_else(deny)?;
            if object.len() != 3 || body["range"] != decoded || body["majorDimension"] != "ROWS" {
                return Err(deny());
            }
            let rows = body["values"].as_array().ok_or_else(deny)?;
            if rows.len() != 1
                || !rows[0].as_array().is_some_and(|r| {
                    r.len() == 14
                        && r.iter().all(|v| {
                            v.is_null()
                                || v.is_number()
                                || v.as_str().is_some_and(|s| s.len() <= 16000)
                        })
                })
            {
                return Err(deny());
            }
            if serde_json::to_vec(body).map_err(|_| deny())?.len() > MAX_WRITE {
                return Err("sheet-write-limit".into());
            }
            Ok("PUT")
        }
        _ => Err(deny()),
    }
}
fn percent_decode(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let a = (bytes.next()? as char).to_digit(16)?;
            let b = (bytes.next()? as char).to_digit(16)?;
            out.push((a * 16 + b) as u8);
        } else {
            out.push(b);
        }
    }
    String::from_utf8(out).ok()
}
fn sanitize_values_response(method: &str, value: Value) -> Result<Value, String> {
    if method == "GET" {
        let rows = value["values"].as_array().ok_or("invalid-sheet-response")?;
        if rows.len() > 1002
            || rows.iter().any(|r| {
                !r.as_array().is_some_and(|cells| {
                    cells.len() <= 14
                        && cells.iter().all(|v| {
                            v.is_null()
                                || v.is_number()
                                || v.is_boolean()
                                || v.as_str().is_some_and(|s| s.len() <= 16000)
                        })
                })
            })
        {
            return Err("invalid-sheet-response".into());
        }
        Ok(json!({"values":rows}))
    } else {
        // Adapter verifies with an independent read; do not expose arbitrary API
        // response objects/headers (or accidentally echoed credentials) to JS.
        Ok(
            json!({"updatedRows":value["updatedRows"].as_u64().unwrap_or(0),"updatedColumns":value["updatedColumns"].as_u64().unwrap_or(0),"updatedCells":value["updatedCells"].as_u64().unwrap_or(0)}),
        )
    }
}

struct PendingAuthorization {
    listener: TcpListener,
    authorization_url: String,
    redirect_uri: String,
    state: Zeroizing<String>,
    verifier: Zeroizing<String>,
    picker: bool,
    picked: Mutex<Option<String>>,
}
impl PendingAuthorization {
    fn bind(config: &Config) -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "oauth-loopback-unavailable")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "oauth-loopback-unavailable")?;
        let redirect_uri = format!(
            "http://127.0.0.1:{}/oauth/callback",
            listener
                .local_addr()
                .map_err(|_| "oauth-loopback-unavailable")?
                .port()
        );
        let mut random = [0u8; 32];
        OsRng.fill_bytes(&mut random);
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(random));
        OsRng.fill_bytes(&mut random);
        let state = Zeroizing::new(URL_SAFE_NO_PAD.encode(random));
        random.zeroize();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = Url::parse(AUTHORIZE).map_err(|_| "invalid-native-endpoint")?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("state", state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "consent select_account"),
        ]);
        Ok(Self {
            listener,
            authorization_url: url.into(),
            redirect_uri,
            state,
            verifier,
            picker: false,
            picked: Mutex::new(None),
        })
    }
    fn bind_picker(config: &Config) -> Result<Self, String> {
        let mut pending = Self::bind(config)?;
        let mut url =
            Url::parse(&pending.authorization_url).map_err(|_| "invalid-native-endpoint")?;
        url.query_pairs_mut().extend_pairs([
            ("trigger_onepick", "true"),
            ("allow_multiple", "false"),
            ("mimetypes", "application/vnd.google-apps.spreadsheet"),
            ("include_granted_scopes", "false"),
        ]);
        pending.authorization_url = url.into();
        pending.picker = true;
        Ok(pending)
    }
    fn receive<F>(&self, cancelled: F, timeout: Duration) -> Result<Zeroizing<String>, String>
    where
        F: Fn() -> Result<(), String>,
    {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            cancelled()?;
            match self.listener.accept() {
                Ok((mut stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let outcome = self.read_callback(&mut stream);
                    if Instant::now() >= deadline {
                        return Err("authorization-timeout".into());
                    }
                    let accepted = matches!(outcome, Ok(Some(_)));
                    let text = if accepted {
                        "Authorization received. Return to bcorn to finish connecting your grade sheet."
                    } else {
                        "This authorization response was not accepted. Return to bcorn."
                    };
                    let response = format!("HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nPragma: no-cache\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n{}", if accepted { "200 OK" } else { "400 Bad Request" }, text.len(), text);
                    let _ = stream.write_all(response.as_bytes());
                    match outcome {
                        Ok(Some(code)) => return Ok(code),
                        Err(error) if error == "authorization-denied" => return Err(error),
                        _ => {}
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40))
                }
                Err(_) => return Err("oauth-loopback-unavailable".into()),
            }
        }
        Err("authorization-timeout".into())
    }
    fn read_callback(&self, stream: &mut TcpStream) -> Result<Option<Zeroizing<String>>, String> {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| "invalid-oauth-callback")?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| "invalid-oauth-callback")?;
        let mut request = Zeroizing::new(Vec::new());
        let mut byte = [0];
        let deadline = Instant::now() + Duration::from_secs(2);
        while request.len() <= 8192 {
            if Instant::now() >= deadline {
                return Err("invalid-oauth-callback".into());
            }
            if stream
                .read(&mut byte)
                .map_err(|_| "invalid-oauth-callback")?
                == 0
            {
                return Err("invalid-oauth-callback".into());
            }
            request.push(byte[0]);
            if request.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        if request.len() > 8192 {
            return Err("invalid-oauth-callback".into());
        }
        let text = std::str::from_utf8(&request).map_err(|_| "invalid-oauth-callback")?;
        self.parse_callback(text)
    }
    fn parse_callback(&self, request: &str) -> Result<Option<Zeroizing<String>>, String> {
        let invalid = || "invalid-oauth-callback".to_owned();
        let mut lines = request.split("\r\n");
        let parts: Vec<_> = lines.next().ok_or_else(invalid)?.split(' ').collect();
        if parts.len() != 3
            || parts[0] != "GET"
            || parts[2] != "HTTP/1.1"
            || !parts[1].starts_with("/oauth/callback?")
            || parts[1].contains('#')
        {
            return Err(invalid());
        }
        let expected_host = self
            .redirect_uri
            .strip_prefix("http://")
            .and_then(|s| s.split('/').next())
            .ok_or_else(invalid)?;
        let mut hosts = Vec::new();
        for line in lines.filter(|l| !l.is_empty()) {
            let (name, value) = line.split_once(':').ok_or_else(invalid)?;
            if name.eq_ignore_ascii_case("host") {
                hosts.push(value.trim());
            }
        }
        if hosts != [expected_host] {
            return Err(invalid());
        }
        let target =
            Url::parse(&format!("http://{expected_host}{}", parts[1])).map_err(|_| invalid())?;
        if target.path() != "/oauth/callback" {
            return Err(invalid());
        }
        let mut params = HashMap::new();
        for (key, value) in target.query_pairs() {
            if params
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return Err(invalid());
            }
        }
        let state = params.get("state").ok_or_else(invalid)?;
        if !bool::from(state.as_bytes().ct_eq(self.state.as_bytes())) {
            return Err(invalid());
        }
        if let Some(error) = params.get("error") {
            if params.contains_key("code") {
                return Err(invalid());
            }
            return Err(if error == "access_denied" {
                "authorization-denied"
            } else {
                "invalid-oauth-callback"
            }
            .into());
        }
        let code = params
            .get("code")
            .filter(|s| valid_token(s))
            .ok_or_else(invalid)?;
        if self.picker {
            let id = params
                .get("picked_file_ids")
                .filter(|s| valid_sheet_id(s))
                .ok_or_else(invalid)?;
            *self.picked.lock().map_err(|_| invalid())? = Some(id.clone());
        }
        Ok(Some(Zeroizing::new(code.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grade_sync_store::tests::TestProtection;
    use std::{collections::VecDeque, fs};
    #[derive(Clone)]
    struct Recorded {
        method: String,
        url: String,
        bearer: bool,
        form_keys: Vec<String>,
        body: Option<Value>,
    }
    struct MockTransport {
        replies: Mutex<VecDeque<Result<NativeResponse, String>>>,
        calls: Mutex<Vec<Recorded>>,
    }
    impl MockTransport {
        fn new(replies: Vec<Result<NativeResponse, String>>) -> Arc<Self> {
            Arc::new(Self {
                replies: Mutex::new(replies.into()),
                calls: Mutex::new(vec![]),
            })
        }
        fn count(&self) -> usize {
            self.calls.lock().unwrap().len()
        }
    }
    impl Transport for MockTransport {
        fn send(&self, request: NativeRequest) -> Result<NativeResponse, String> {
            if let Some(gate) = &request.cancellation {
                gate.check()?;
            }
            self.calls.lock().unwrap().push(Recorded {
                method: request.method.into(),
                url: request.url,
                bearer: request.bearer.is_some(),
                form_keys: request
                    .form
                    .as_ref()
                    .map(|f| f.iter().map(|(k, _)| k.clone()).collect())
                    .unwrap_or_default(),
                body: request.json,
            });
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected native HTTP request")
        }
    }
    fn reply(status: u16, body: Value) -> Result<NativeResponse, String> {
        Ok(NativeResponse {
            status,
            body: Zeroizing::new(serde_json::to_vec(&body).unwrap()),
            retry_after_ms: None,
        })
    }
    fn token_reply() -> Result<NativeResponse, String> {
        reply(
            200,
            json!({"access_token":"synthetic-access","refresh_token":"synthetic-refresh","expires_in":3600,"token_type":"Bearer","scope":SCOPE}),
        )
    }
    fn headers_reply() -> Result<NativeResponse, String> {
        reply(200, json!({"values":[HEADERS]}))
    }
    fn config() -> Config {
        Config {
            client_id: "synthetic.apps.googleusercontent.com".into(),
            client_secret: "".into(),
        }
    }
    fn binding() -> Binding {
        Binding {
            spreadsheet_id: "synthetic_file".into(),
            tab: "bcorn assessments".into(),
            confirmed: true,
            mapping: None,
            kind: None,
        }
    }
    fn auth(mock: Arc<MockTransport>) -> (Arc<GradeAuth>, PathBuf) {
        let root = std::env::temp_dir().join(format!("bcorn-native-test-{}", random_id()));
        let private = PrivateStore::testing(root.clone(), Arc::new(TestProtection));
        (
            Arc::new(GradeAuth::open(config(), private, mock).unwrap()),
            root,
        )
    }
    fn ready(auth: &GradeAuth, expired: bool) {
        let mut v = auth.current().unwrap();
        v.state = "ready".into();
        v.connection_id = Some(random_id());
        v.binding = Some(binding());
        v.tokens = Some(Tokens {
            access: "synthetic-access".into(),
            refresh: "synthetic-refresh".into(),
            expires_at: if expired { 0 } else { epoch_seconds() + 3600 },
        });
        auth.commit(v).unwrap();
    }
    fn get() -> SheetsRequest {
        SheetsRequest {
            method: "GET".into(),
            path: read_path(&binding()),
            body: None,
        }
    }
    fn deliver(url: &str) {
        let url = Url::parse(url).unwrap();
        let params: HashMap<_, _> = url.query_pairs().collect();
        let redirect = Url::parse(&params["redirect_uri"]).unwrap();
        let state = params["state"].to_string();
        thread::spawn(move || {
            let host = format!("127.0.0.1:{}", redirect.port().unwrap());
            let mut stream = TcpStream::connect(&host).unwrap();
            let request = format!(
                "GET {}?code=synthetic-code&state={} HTTP/1.1\r\nHost: {}\r\n\r\n",
                redirect.path(),
                state,
                host
            );
            stream.write_all(request.as_bytes()).unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).unwrap();
            assert!(reply.contains("200 OK"));
            assert!(!reply.contains("synthetic-code"));
        });
    }
    #[test]
    fn pkce_uses_s256_unique_state_and_only_drive_file() {
        let known = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(known.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let first = PendingAuthorization::bind(&config()).unwrap();
        let second = PendingAuthorization::bind(&config()).unwrap();
        assert_ne!(*first.state, *second.state);
        assert_ne!(*first.verifier, *second.verifier);
        let url = Url::parse(&first.authorization_url).unwrap();
        let params: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params["scope"], SCOPE);
        assert_eq!(params["code_challenge_method"], "S256");
        assert!(!params.contains_key("code_verifier"));
        assert_eq!(params["access_type"], "offline");
        assert!(first.listener.local_addr().unwrap().ip().is_loopback());
        assert!(first.verifier.len() >= 43);
    }
    #[test]
    fn callback_requires_state_unique_params_exact_host_path_and_get() {
        let pending = PendingAuthorization::bind(&config()).unwrap();
        let url = Url::parse(&pending.redirect_uri).unwrap();
        let host = format!("127.0.0.1:{}", url.port().unwrap());
        let good = format!(
            "GET /oauth/callback?code=synthetic-code&state={} HTTP/1.1\r\nHost: {host}\r\n\r\n",
            *pending.state
        );
        assert_eq!(
            pending.parse_callback(&good).unwrap().unwrap().as_str(),
            "synthetic-code"
        );
        for bad in [
            good.replace(pending.state.as_str(), "attacker"),
            good.replace("code=", "state=duplicate&code="),
            good.replace("/oauth/callback?", "/other?"),
            good.replace("GET ", "POST "),
            good.replace(&format!("Host: {host}"), "Host: attacker.example"),
            good.replace("\r\n\r\n", &format!("\r\nHost: {host}\r\n\r\n")),
        ] {
            assert!(pending.parse_callback(&bad).is_err());
        }
        let denial = good.replace("code=synthetic-code", "error=access_denied");
        assert_eq!(
            pending.parse_callback(&denial).unwrap_err(),
            "authorization-denied"
        );
    }
    #[test]
    fn callback_has_bounded_timeout_and_cancellation() {
        let pending = PendingAuthorization::bind(&config()).unwrap();
        assert_eq!(
            pending
                .receive(|| Ok(()), Duration::from_millis(20))
                .unwrap_err(),
            "authorization-timeout"
        );
        assert_eq!(
            pending
                .receive(
                    || Err("authorization-cancelled".into()),
                    Duration::from_secs(5)
                )
                .unwrap_err(),
            "authorization-cancelled"
        );
    }
    #[test]
    fn successful_connect_creates_and_reads_new_template_before_ready() {
        let mock = MockTransport::new(vec![
            token_reply(),
            reply(
                200,
                json!({"spreadsheetId":"brand_new","sheets":[{"properties":{"title":"bcorn assessments"}}]}),
            ),
            headers_reply(),
        ]);
        let (auth, root) = auth(mock.clone());
        let result = auth
            .connect_new_sheet(
                "Synthetic grades".into(),
                "bcorn assessments".into(),
                |url| {
                    deliver(url);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(result.state, "ready");
        assert!(result.foreground_sync_available);
        assert!(!result.automatic_inbound);
        assert_eq!(result.binding.unwrap().spreadsheet_id, "brand_new");
        assert!(valid_id(&result.connection_id.unwrap()));
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].url, TOKEN);
        assert!(!calls[0].bearer);
        assert!(calls[0].form_keys.contains(&"code_verifier".into()));
        assert_eq!(calls[1].url, format!("{SHEETS}/v4/spreadsheets"));
        assert_eq!(calls[1].method, "POST");
        assert!(calls[1].bearer);
        assert_eq!(
            calls[1].body.as_ref().unwrap(),
            &template("Synthetic grades", "bcorn assessments")
        );
        assert!(calls[2].url.contains("/brand_new/values/"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_or_repeated_connect_never_grants_or_creates() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock.clone());
        let result = auth.connect_new_sheet("Grades".into(), "bcorn".into(), |_| {
            let repeat = auth.connect_new_sheet("Grades".into(), "bcorn".into(), |_| {
                panic!("second browser")
            });
            assert!(repeat.is_err());
            auth.cancel_authorization();
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(mock.count(), 0);
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_header_verification_cannot_replace_existing_binding() {
        let mock = MockTransport::new(vec![
            token_reply(),
            reply(
                200,
                json!({"spreadsheetId":"brand_new","sheets":[{"properties":{"title":"bcorn"}}]}),
            ),
            reply(200, json!({"values":[["wrong"]]})),
        ]);
        let (auth, root) = auth(mock);
        ready(&auth, false);
        let old = auth.status().unwrap().connection_id;
        assert!(auth
            .connect_new_sheet("Grades".into(), "bcorn".into(), |url| {
                deliver(url);
                Ok(())
            })
            .is_err());
        assert_eq!(auth.status().unwrap().connection_id, old);
        assert_eq!(
            auth.status().unwrap().binding.unwrap().spreadsheet_id,
            "synthetic_file"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_configuration_never_opens_browser_or_reports_ready() {
        let mock = MockTransport::new(vec![]);
        let root = std::env::temp_dir().join(random_id());
        let auth = GradeAuth::open(
            Config {
                client_id: "".into(),
                client_secret: "".into(),
            },
            PrivateStore::testing(root.clone(), Arc::new(TestProtection)),
            mock.clone(),
        )
        .unwrap();
        assert_eq!(auth.status().unwrap().state, "not-configured");
        assert!(auth
            .connect_new_sheet("Grades".into(), "bcorn".into(), |_| panic!(
                "must not open browser"
            ))
            .is_err());
        assert_eq!(mock.count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn allowlist_rejects_other_files_tabs_routes_formulas_and_header_writes() {
        let b = binding();
        assert!(validate_request(&b, &get()).is_ok());
        let row = format!("{}!A2:N2", a1_tab(&b));
        let write = || SheetsRequest {
            method: "PUT".into(),
            path: format!(
                "/v4/spreadsheets/{}/values/{}?valueInputOption=RAW",
                b.spreadsheet_id,
                encode_component(&row)
            ),
            body: Some(
                json!({"range":row,"majorDimension":"ROWS","values":[["id","deleted","","","","","","","","","","","",""]]}),
            ),
        };
        assert!(validate_request(&b, &write()).is_ok());
        for path in [
            "https://attacker.example/".into(),
            "//attacker.example/".into(),
            get().path.replace("synthetic_file", "other_file"),
            get().path.replace("A1%3AN1002", "A1%3AZ9999"),
            get().path.replace("%3A", "%253A"),
            get().path.replace("UNFORMATTED_VALUE", "FORMULA"),
            format!("{}&alt=media", get().path),
            "/v4/spreadsheets/synthetic_file:batchUpdate".into(),
            "/v4/spreadsheets".into(),
        ] {
            assert!(validate_request(
                &b,
                &SheetsRequest {
                    method: "GET".into(),
                    path,
                    body: None
                }
            )
            .is_err());
        }
        let mut bad = write();
        bad.path = bad.path.replace("RAW", "USER_ENTERED");
        assert!(validate_request(&b, &bad).is_err());
        let mut bad = write();
        bad.path = bad.path.replace("A2%3AN2", "A1%3AN1");
        assert!(validate_request(&b, &bad).is_err());
        let mut bad = write();
        bad.body.as_mut().unwrap()["includeValuesInResponse"] = json!(true);
        assert!(validate_request(&b, &bad).is_err());
    }
    #[test]
    fn route_validation_happens_before_token_refresh_or_network() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, true);
        assert!(auth
            .request(SheetsRequest {
                method: "POST".into(),
                path: "/v4/spreadsheets".into(),
                body: Some(json!({}))
            })
            .is_err());
        assert_eq!(mock.count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_expired_token_requests_refresh_exactly_once() {
        let mock = MockTransport::new(vec![token_reply(), headers_reply(), headers_reply()]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, true);
        let first = auth.clone();
        let second = auth.clone();
        let a = thread::spawn(move || first.request(get()).unwrap().status);
        let b = thread::spawn(move || second.request(get()).unwrap().status);
        assert_eq!(a.join().unwrap(), 200);
        assert_eq!(b.join().unwrap(), 200);
        assert_eq!(
            mock.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.url == TOKEN)
                .count(),
            1
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unauthorized_response_refreshes_and_retries_once_then_blocks() {
        let mock = MockTransport::new(vec![
            reply(401, json!({"secret":"synthetic-access"})),
            token_reply(),
            reply(401, json!({"secret":"synthetic-refresh"})),
        ]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let response = auth.request(get()).unwrap();
        assert_eq!(response.status, 401);
        assert_eq!(mock.count(), 3);
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        let serialized = serde_json::to_string(&response).unwrap();
        assert!(!serialized.contains("synthetic-"));
        assert!(auth.request(get()).is_err());
        assert_eq!(mock.count(), 3);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_grant_marks_revoked_and_removes_credentials() {
        let mock = MockTransport::new(vec![reply(
            400,
            json!({"error":"invalid_grant","error_description":"synthetic-refresh"}),
        )]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, true);
        assert_eq!(auth.request(get()).err().unwrap(), "revoked");
        assert_eq!(auth.status().unwrap().state, "revoked");
        assert!(auth.current().unwrap().tokens.is_none());
        assert_eq!(mock.count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn disconnect_is_local_even_when_google_revocation_is_offline() {
        let mock = MockTransport::new(vec![Err("network-error".into())]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let status = auth.disconnect(true).unwrap();
        assert!(status.ok);
        assert!(!status.google_revocation_confirmed);
        assert_eq!(auth.status().unwrap().state, "revoked");
        assert!(auth.current().unwrap().tokens.is_none());
        assert!(auth.request(get()).is_err());
        assert_eq!(mock.calls.lock().unwrap()[0].url, REVOKE);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn tokens_never_enter_status_success_errors_or_plain_files() {
        let mock = MockTransport::new(vec![reply(
            200,
            json!({"values":[HEADERS],"access_token":"synthetic-access","refresh_token":"synthetic-refresh"}),
        )]);
        let (auth, root) = auth(mock);
        ready(&auth, false);
        let status = serde_json::to_string(&auth.status().unwrap()).unwrap();
        let response = serde_json::to_string(&auth.request(get()).unwrap()).unwrap();
        for s in [
            status,
            response,
            String::from_utf8_lossy(&fs::read(root.join("grade-authorization-v1.bin")).unwrap())
                .into_owned(),
        ] {
            assert!(!s.contains("synthetic-access"));
            assert!(!s.contains("synthetic-refresh"));
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oauth_scope_expiry_and_missing_refresh_are_fail_closed() {
        for body in [
            json!({"access_token":"synthetic","expires_in":3600,"token_type":"Bearer","scope":SCOPE}),
            json!({"access_token":"synthetic","refresh_token":"synthetic","expires_in":0,"token_type":"Bearer","scope":SCOPE}),
            json!({"access_token":"synthetic","refresh_token":"synthetic","expires_in":3600,"token_type":"Bearer","scope":"openid https://www.googleapis.com/auth/drive.file"}),
        ] {
            assert!(parse_tokens(reply(200, body).unwrap(), None).is_err());
        }
        assert!(parse_tokens(
            reply(
                200,
                json!({"access_token":"synthetic","expires_in":3600,"token_type":"Bearer"})
            )
            .unwrap(),
            Some("synthetic-refresh")
        )
        .is_ok());
    }
    #[test]
    fn version_probe_uses_only_bound_file_and_whitelisted_fields() {
        let mock = MockTransport::new(vec![reply(
            200,
            json!({"version":"9007199254740993","modifiedTime":"2026-10-18T08:00:00Z","access_token":"synthetic-access"}),
        )]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let result = auth.sheet_version().unwrap();
        assert_eq!(result.version, "9007199254740993");
        assert_eq!(
            result.modified_time.as_deref(),
            Some("2026-10-18T08:00:00Z")
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("synthetic-access"));
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].url,"https://www.googleapis.com/drive/v3/files/synthetic_file?fields=version%2CmodifiedTime");
        assert!(calls[0].bearer);
        assert!(calls[0].body.is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn version_probe_permission_denial_pauses_without_claiming_revocation() {
        let mock = MockTransport::new(vec![reply(
            403,
            json!({"error":{"message":"private provider details"}}),
        )]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        assert_eq!(
            auth.sheet_version().err().unwrap(),
            "authorization-required"
        );
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        assert!(auth.current().unwrap().tokens.is_some());
        assert!(auth.sheet_version().is_err());
        assert_eq!(mock.count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn quota_403_preserves_grant_binding_and_enforces_request_cooldown() {
        for reason in [
            "rateLimitExceeded",
            "userRateLimitExceeded",
            "quotaExceeded",
        ] {
            for metadata in [false, true] {
                let mock = MockTransport::new(vec![reply(
                    403,
                    json!({"error":{"errors":[{"reason":reason,"message":"private provider detail"}]}}),
                )]);
                let (auth, root) = auth(mock.clone());
                ready(&auth, false);
                let id = auth.status().unwrap().connection_id;
                if metadata {
                    assert_eq!(auth.sheet_version().err().unwrap(), "rate-limited");
                } else {
                    let response = auth.request(get()).unwrap();
                    assert_eq!(response.status, 429);
                    assert_eq!(response.retry_after_ms, Some(60000));
                    assert!(!serde_json::to_string(&response)
                        .unwrap()
                        .contains("private provider"));
                }
                assert_eq!(auth.status().unwrap().state, "ready");
                assert_eq!(auth.status().unwrap().connection_id, id);
                assert!(auth.current().unwrap().tokens.is_some());
                assert_eq!(auth.request(get()).err().unwrap(), "rate-limited");
                assert_eq!(auth.sheet_version().err().unwrap(), "rate-limited");
                assert_eq!(mock.count(), 1);
                fs::remove_dir_all(root).unwrap();
            }
        }
    }
    #[test]
    fn sheets_permission_403_pauses_and_returns_authorization_required() {
        let mock = MockTransport::new(vec![reply(
            403,
            json!({"error":{"errors":[{"reason":"appNotAuthorizedToFile"}]}}),
        )]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let response = auth.request(get()).unwrap();
        assert_eq!(response.status, 403);
        assert_eq!(response.body["error"]["code"], "authorization-required");
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        assert!(auth.current().unwrap().tokens.is_some());
        assert!(auth.request(get()).is_err());
        assert_eq!(mock.count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hidden_calls_make_no_http_and_resume_restores_access() {
        let mock = MockTransport::new(vec![headers_reply()]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        auth.set_foreground(false);
        assert_eq!(auth.request(get()).err().unwrap(), "background-paused");
        assert_eq!(auth.sheet_version().err().unwrap(), "background-paused");
        assert_eq!(mock.count(), 0);
        auth.set_foreground(true);
        assert_eq!(auth.request(get()).unwrap().status, 200);
        assert_eq!(mock.count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hiding_drops_inflight_future_and_does_not_start_hidden_work() {
        struct DropSignal(Arc<AtomicBool>);
        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let gate = Arc::new(OperationGate::new(true, "background-paused"));
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = dropped.clone();
        let change = gate.clone();
        let sender = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            change.set(false);
        });
        let result: Result<(), String> = runtime.block_on(cancellable(Some(&gate), async move {
            let _signal = DropSignal(flag);
            std::future::pending().await
        }));
        sender.join().unwrap();
        assert_eq!(result.unwrap_err(), "background-paused");
        assert!(dropped.load(Ordering::SeqCst));
        let started = AtomicBool::new(false);
        let result = runtime.block_on(cancellable(Some(&gate), async {
            started.store(true, Ordering::SeqCst);
            Ok(())
        }));
        assert!(result.is_err());
        assert!(!started.load(Ordering::SeqCst));
    }
    #[test]
    fn oauth_cancel_and_foreground_pause_are_separate() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock);
        auth.authorization.set(true);
        auth.set_foreground(false);
        assert!(auth.authorization.check().is_ok());
        auth.cancel_authorization();
        assert_eq!(
            auth.authorization.check().unwrap_err(),
            "authorization-cancelled"
        );
        auth.set_foreground(true);
        assert!(auth.authorization.check().is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn real_transport_rejects_non_google_or_insecure_destinations_before_io() {
        let transport = GoogleTransport::new().unwrap();
        for url in [
            "http://sheets.googleapis.com/v4/spreadsheets",
            "https://sheets.googleapis.com.attacker.invalid/v4/spreadsheets",
            "https://sheets.googleapis.com:8443/v4/spreadsheets",
            "https://oauth2.googleapis.com/token#redirect",
            "https://www.googleapis.com/drive/v3/files/id?alt=media",
        ] {
            let request = NativeRequest {
                method: "GET",
                url: url.into(),
                bearer: None,
                form: None,
                json: None,
                cancellation: None,
            };
            assert!(transport.send(request).is_err());
        }
    }
    #[test]
    fn reopening_preserves_device_connection_and_private_tokens() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let before = auth.status().unwrap();
        let reopened = GradeAuth::open(
            config(),
            PrivateStore::testing(root.clone(), Arc::new(TestProtection)),
            mock,
        )
        .unwrap();
        assert_eq!(reopened.status().unwrap().device_id, before.device_id);
        assert_eq!(
            reopened.status().unwrap().connection_id,
            before.connection_id
        );
        assert!(reopened
            .validate_connection(before.connection_id.as_ref().unwrap())
            .is_ok());
        assert!(reopened.validate_connection(&random_id()).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    fn mapped_fixture() -> Value {
        json!({"schemaVersion":1,"confirmed":true,"sheetId":7,"tab":"Course grades","courses":[{"id":"course-1","title":"Synthetic math","termId":"term-1","rules":{"kind":"weighted"},"assessments":[{"id":"exam-1","title":"Test","gradeCell":"C2","weightCell":"B2","gradeMode":"ratio","weightMode":"ratio","anchor":{"cell":"A2","text":"Test"}}]}]})
    }
    fn grid_fixture(score: f64) -> Value {
        json!({"sheets":[{"properties":{"sheetId":7,"title":"Course grades","gridProperties":{"rowCount":200,"columnCount":26}},"data":[{"rowData":[{}, {"values":[{"effectiveValue":{"stringValue":"Test"},"userEnteredValue":{"stringValue":"Test"}},{"effectiveValue":{"numberValue":0.3},"userEnteredValue":{"numberValue":0.3}},{"effectiveValue":{"numberValue":score},"userEnteredValue":{"numberValue":score}}]}]}]}]})
    }
    fn ready_mapped(auth: &GradeAuth) -> String {
        ready(auth, false);
        let mut vault = auth.current().unwrap();
        let binding = vault.binding.as_mut().unwrap();
        binding.tab = "Course grades".into();
        binding.mapping = Some(mapped_fixture());
        binding.kind = Some("mapped".into());
        let connection = vault.connection_id.clone().unwrap();
        auth.commit(vault).unwrap();
        connection
    }
    #[test]
    fn official_picker_requests_only_drive_file_and_accepts_one_verified_selection() {
        let pending = PendingAuthorization::bind_picker(&config()).unwrap();
        let url = Url::parse(&pending.authorization_url).unwrap();
        let params: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params["scope"], SCOPE);
        assert_eq!(params["trigger_onepick"], "true");
        assert_eq!(params["include_granted_scopes"], "false");
        assert_eq!(
            params["mimetypes"],
            "application/vnd.google-apps.spreadsheet"
        );
        let host = format!(
            "127.0.0.1:{}",
            pending.listener.local_addr().unwrap().port()
        );
        let good = format!("GET /oauth/callback?code=synthetic-code&state={}&picked_file_ids=synthetic_selected HTTP/1.1\r\nHost: {host}\r\n\r\n", pending.state.as_str());
        for bad in [
            good.replace("synthetic_selected", "first,second"),
            good.replace("&picked_file_ids=synthetic_selected", ""),
            good.replace(pending.state.as_str(), "wrong"),
            good.replace("synthetic_selected", "https://evil.invalid"),
        ] {
            assert!(pending.parse_callback(&bad).is_err());
            assert!(pending.picked.lock().unwrap().is_none());
        }
        assert!(pending.parse_callback(&good).is_ok());
        assert_eq!(
            pending.picked.lock().unwrap().as_deref(),
            Some("synthetic_selected")
        );
    }
    #[test]
    fn picker_stages_then_confirms_without_mutating_selected_workbook() {
        let mock = MockTransport::new(vec![
            token_reply(),
            reply(
                200,
                json!({"spreadsheetId":"synthetic_selected","properties":{"title":"Synthetic workbook"},"sheets":[{"properties":{"sheetId":7,"title":"Course grades","gridProperties":{"rowCount":200,"columnCount":26}}}]}),
            ),
            reply(200, grid_fixture(0.8)),
            reply(200, grid_fixture(0.8)),
        ]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let old = auth.status().unwrap().connection_id;
        let selected = auth
            .pick_grade_sheet(|url| {
                // Reuse the real loopback callback fixture, adding the picked ID.
                let mut url = Url::parse(url).unwrap();
                let params: HashMap<_, _> = url
                    .query_pairs()
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                let state = format!("{}&picked_file_ids=synthetic_selected", params["state"]);
                url.query_pairs_mut()
                    .clear()
                    .extend_pairs(
                        params
                            .iter()
                            .filter(|(k, _)| k.as_str() != "state")
                            .map(|(k, v)| (k.as_str(), v.as_str())),
                    )
                    .append_pair("state", &state);
                deliver(url.as_str());
                Ok(())
            })
            .unwrap();
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        assert_eq!(auth.status().unwrap().connection_id, old);
        let selection = selected["selectionId"].as_str().unwrap().to_owned();
        let preview = auth.preview_grade_sheet(selection.clone(), 7).unwrap();
        assert_eq!(preview["cells"]["C2"]["value"], 0.8);
        let confirmed = auth
            .confirm_grade_sheet_mapping(selection.clone(), mapped_fixture())
            .unwrap();
        assert_eq!(confirmed.state, "ready");
        assert_ne!(confirmed.connection_id, old);
        assert_eq!(confirmed.binding.unwrap().kind.as_deref(), Some("mapped"));
        assert!(auth.preview_grade_sheet(selection, 7).is_err());
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.len(), 4);
        assert!(calls[1..]
            .iter()
            .all(|c| c.method == "GET" && c.body.is_none()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_picker_pauses_old_binding_and_preserves_local_account_scope() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock.clone());
        ready(&auth, false);
        let old = auth.status().unwrap().connection_id;
        assert!(auth
            .pick_grade_sheet(|_| {
                auth.cancel_authorization();
                Ok(())
            })
            .is_err());
        assert_eq!(auth.status().unwrap().connection_id, old);
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        assert!(auth.request(get()).is_err());
        assert_eq!(mock.count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn mapped_write_is_exact_raw_cells_and_independently_verified() {
        let mock = MockTransport::new(vec![
            reply(200, grid_fixture(0.8)),
            reply(200, json!({})),
            reply(200, grid_fixture(0.9)),
        ]);
        let (auth, root) = auth(mock.clone());
        let id = ready_mapped(&auth);
        let before = sanitize_snapshot(grid_fixture(0.8), 7, "Course grades").unwrap();
        let after = auth
            .commit_mapped_grade_cells(id, before, json!([{"cell":"C2","value":0.9}]))
            .unwrap();
        assert_eq!(after["cells"]["C2"]["value"], 0.9);
        let calls = mock.calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(
            calls[1].url,
            format!("{SHEETS}/v4/spreadsheets/synthetic_file/values:batchUpdate")
        );
        assert_eq!(
            calls[1].body,
            Some(
                json!({"valueInputOption":"RAW","data":[{"range":"'Course grades'!C2","majorDimension":"ROWS","values":[[0.9]]}]})
            )
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_mapped_cells_and_stale_connections_make_no_network_calls() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock.clone());
        let id = ready_mapped(&auth);
        for writes in [
            json!([{"cell":"A2","value":1}]),
            json!([{"cell":"Z200","value":1}]),
            json!([{"cell":"C2","value":"=IMPORTXML(\"https://invalid\")"}]),
            json!([{"cell":"C2","value":1},{"cell":"C2","value":2}]),
        ] {
            assert!(auth
                .commit_mapped_grade_cells(id.clone(), json!({}), writes)
                .is_err());
        }
        assert!(auth.read_mapped_grade_snapshot(random_id()).is_err());
        assert!(auth
            .commit_mapped_grade_cells(random_id(), json!({}), json!([{"cell":"C2","value":1}]))
            .is_err());
        assert!(auth.request(get()).is_err());
        assert_eq!(mock.count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn formula_protection_anchor_and_conflict_preflight_never_writes() {
        for kind in [
            "formula",
            "protected",
            "anchor",
            "conflict",
            "weight-formula",
        ] {
            let mut grid = grid_fixture(0.8);
            match kind {
                "formula" => {
                    grid["sheets"][0]["data"][0]["rowData"][1]["values"][2]["userEnteredValue"] =
                        json!({"formulaValue":"=1+1"})
                }
                "weight-formula" => {
                    grid["sheets"][0]["data"][0]["rowData"][1]["values"][1]["userEnteredValue"] =
                        json!({"formulaValue":"=0.3"})
                }
                "protected" => {
                    grid["sheets"][0]["protectedRanges"] = json!([{"range":{"sheetId":7,"startRowIndex":1,"endRowIndex":2,"startColumnIndex":2,"endColumnIndex":3}}])
                }
                "anchor" => {
                    grid["sheets"][0]["data"][0]["rowData"][1]["values"][0]["effectiveValue"] =
                        json!({"stringValue":"Different"})
                }
                _ => {}
            }
            let mock = MockTransport::new(vec![reply(200, grid)]);
            let (auth, root) = auth(mock.clone());
            let id = ready_mapped(&auth);
            assert!(auth
                .commit_mapped_grade_cells(id, json!({}), json!([{"cell":"C2","value":1}]))
                .is_err());
            assert_eq!(mock.count(), 1);
            assert_eq!(mock.calls.lock().unwrap()[0].method, "GET");
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn mapping_is_bounded_unique_and_anchors_are_never_write_targets() {
        assert_eq!(
            validate_mapping(&mapped_fixture()).unwrap(),
            vec!["C2", "B2"]
        );
        for cell in ["C201", "AA2", "c2", "C02", "C0", "C2:C3", "A2", "B2"] {
            let mut mapping = mapped_fixture();
            mapping["courses"][0]["assessments"][0]["gradeCell"] = json!(cell);
            assert!(validate_mapping(&mapping).is_err(), "{cell}");
        }
        let mut mapping = mapped_fixture();
        mapping["confirmed"] = json!(false);
        assert!(validate_mapping(&mapping).is_err());
    }
    #[test]
    fn snapshot_preserves_formula_visibility_and_marks_merges_readonly() {
        let mut grid = grid_fixture(0.8);
        grid["sheets"][0]["merges"] = json!([{"sheetId":7,"startRowIndex":1,"endRowIndex":2,"startColumnIndex":2,"endColumnIndex":4}]);
        grid["sheets"][0]["data"][0]["rowData"][1]["values"][2]["userEnteredValue"] =
            json!({"formulaValue":"=secret_formula()"});
        let snapshot = sanitize_snapshot(grid, 7, "Course grades").unwrap();
        assert_eq!(snapshot["cells"]["C2"]["formula"], true);
        assert_eq!(snapshot["cells"]["D2"]["protected"], true);
        assert!(!snapshot.to_string().contains("secret_formula"));
        assert_eq!(snapshot["cells"].as_object().unwrap().len(), 5200);
    }

    fn course_fixture() -> Value {
        json!({"id":"course-1","title":"Synthetic course","termId":"","rules":{"kind":"weighted"},"assessments":[{"id":"a1","title":"Test","weight":0.3,"status":"graded","score":{"mode":"ratio","value":0}}]})
    }
    #[test]
    fn human_template_keeps_zero_blank_points_and_owned_formulas_distinct() {
        let mut course = course_fixture();
        course["assessments"].as_array_mut().unwrap().extend([
            json!({"id":"a2","title":"Pending","weight":0.4,"status":"ungraded","score":null}),
            json!({"id":"a3","title":"=Untrusted label","weight":0.3,"status":"graded","score":{"mode":"points","earned":3,"possible":4}})
        ]);
        let (template, mapping) = mapped_template(&course).unwrap();
        let rows = &template["sheets"][0]["data"][0]["rowData"];
        assert_eq!(rows[1]["values"][2]["userEnteredValue"]["numberValue"], 0);
        assert_eq!(rows[2]["values"][2]["userEnteredValue"]["stringValue"], "");
        assert_eq!(
            rows[3]["values"][2]["userEnteredValue"]["stringValue"],
            "3/4"
        );
        assert_eq!(
            rows[3]["values"][0]["userEnteredValue"]["stringValue"],
            "=Untrusted label"
        );
        let formula = rows[1]["values"][3]["userEnteredValue"]["formulaValue"]
            .as_str()
            .unwrap();
        assert!(formula.starts_with("=IF(C2=\"\",\"\",B2*IF(ISNUMBER(C2)"));
        assert!(formula.contains("SPLIT(C2"));
        assert_eq!(
            rows[6]["values"][3]["userEnteredValue"]["formulaValue"],
            "=SUM(D2:D4)"
        );
        assert_eq!(
            validate_mapping(&mapping).unwrap(),
            vec!["C2", "B2", "C3", "B3", "C4", "B4"]
        );
    }
    #[test]
    fn human_template_creation_verifies_before_binding_and_keeps_legacy_route() {
        let mut grid = grid_fixture(0.0);
        grid["sheets"][0]["properties"]["sheetId"] = json!(0);
        grid["sheets"][0]["properties"]["title"] = json!("Grades");
        let mock = MockTransport::new(vec![
            token_reply(),
            reply(200, json!({"spreadsheetId":"synthetic_created"})),
            reply(200, grid),
        ]);
        let (auth, root) = auth(mock.clone());
        let result = auth
            .create_mapped_grade_sheet(course_fixture(), |url| {
                deliver(url);
                Ok(())
            })
            .unwrap();
        assert_eq!(result.state, "ready");
        assert_eq!(result.binding.unwrap().kind.as_deref(), Some("mapped"));
        assert_eq!(mock.count(), 3);
        assert!(validate_request(&binding(), &get()).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn literal_fraction_writes_are_bounded_and_formula_strings_rejected() {
        let m = mapped_fixture();
        for value in [
            json!(0),
            json!(1),
            json!(""),
            json!("3/4"),
            json!("0/100"),
            json!("0.5/1.5"),
        ] {
            assert!(valid_mapped_write(&m, "C2", &value), "{value}");
        }
        for value in [
            json!(2),
            json!(-1),
            json!("=1/2"),
            json!("4/3"),
            json!("1/0"),
            json!("1e2/200"),
            json!("-1/2"),
            json!("1/2/3"),
            json!("1/2 "),
            json!(true),
        ] {
            assert!(!valid_mapped_write(&m, "C2", &value), "{value}");
        }
        assert!(!valid_mapped_write(&m, "B2", &json!("1/2")));
    }
    #[test]
    fn bounded_preview_does_not_reject_unrelated_workbook_regions() {
        let mut grid = grid_fixture(0.8);
        grid["sheets"][0]["properties"]["gridProperties"] =
            json!({"rowCount":10000,"columnCount":100});
        let snapshot = sanitize_snapshot(grid, 7, "Course grades").unwrap();
        assert_eq!(snapshot["previewRange"], "A1:Z200");
        assert_eq!(snapshot["complete"], true);
    }
    #[test]
    fn mapped_http_401_refreshes_once_and_403_pauses_without_token_loss() {
        let mock = MockTransport::new(vec![
            reply(401, json!({})),
            token_reply(),
            reply(200, grid_fixture(0.8)),
            reply(403, json!({})),
        ]);
        let (auth, root) = auth(mock.clone());
        let id = ready_mapped(&auth);
        assert!(auth.read_mapped_grade_snapshot(id.clone()).is_ok());
        assert_eq!(mock.count(), 3);
        assert_eq!(
            auth.read_mapped_grade_snapshot(id).unwrap_err(),
            "authorization-required"
        );
        assert!(auth.current().unwrap().tokens.is_some());
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejected_and_cancelled_new_templates_never_leave_authorization_running() {
        let mock = MockTransport::new(vec![]);
        let (auth, root) = auth(mock.clone());
        let mut bad = course_fixture();
        bad["assessments"][0]["status"] = json!("exempt");
        assert!(auth
            .create_mapped_grade_sheet(bad, |_| panic!("must not open"))
            .is_err());
        assert!(auth
            .create_mapped_grade_sheet(course_fixture(), |_| {
                auth.cancel_authorization();
                Ok(())
            })
            .is_err());
        assert!(auth.authorization.check().is_err());
        assert_eq!(auth.status().unwrap().state, "authorization-required");
        assert!(auth
            .create_mapped_grade_sheet(course_fixture(), |_| Err("browser failed".into()))
            .is_err());
        assert!(auth.authorization.check().is_err());
        assert_eq!(mock.count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn template_upper_bound_and_blank_snapshot_roundtrip_are_explicit() {
        let mut course = course_fixture();
        course["assessments"] = json!((0..190).map(|i| json!({"id":format!("a{i}"),"title":format!("Assessment {i}"),"weight":0.001,"status":"ungraded","score":null})).collect::<Vec<_>>());
        let (body, mapping) = mapped_template(&course).unwrap();
        assert!(
            body["sheets"][0]["data"][0]["rowData"]
                .as_array()
                .unwrap()
                .len()
                <= 200
        );
        assert_eq!(validate_mapping(&mapping).unwrap().len(), 380);
        let snapshot = sanitize_snapshot(grid_fixture(0.0), 7, "Course grades").unwrap();
        assert_eq!(snapshot["cells"]["A1"]["value"], "");
        assert_eq!(snapshot["cells"]["C2"]["value"], 0);
        assert!(!valid_mapped_write(&mapped_fixture(), "C2", &Value::Null));
    }
}
