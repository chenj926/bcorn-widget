//! Private native transport. No renderer-provided URLs, forms, tokens, or HTTP methods.
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use url::Url;
use zeroize::Zeroizing;
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
pub(super) struct NativeRequest {
    pub(super) method: &'static str,
    pub(super) url: String,
    pub(super) if_match: Option<String>,
    pub(super) bearer: Option<Zeroizing<String>>,
    pub(super) form: Option<Vec<(String, Zeroizing<String>)>>,
    pub(super) json: Option<Value>,
    pub(super) cancellation: Option<Arc<OperationGate>>,
}
pub(super) struct NativeResponse {
    pub(super) status: u16,
    pub(super) body: Zeroizing<Vec<u8>>,
    pub(super) retry_after_ms: Option<u64>,
}
pub(super) trait Transport: Send + Sync {
    fn send(&self, request: NativeRequest) -> Result<NativeResponse, String>;
}
/// A watch signal exists only while an operation is running: no idle polling.
/// Disabling a gate drops the HTTP future, stopping queued and in-flight work.
pub(super) struct OperationGate {
    enabled: AtomicBool,
    changed: tokio::sync::watch::Sender<u64>,
    reason: &'static str,
}
impl OperationGate {
    pub(super) fn new(enabled: bool, reason: &'static str) -> Self {
        let (changed, _) = tokio::sync::watch::channel(0);
        Self {
            enabled: AtomicBool::new(enabled),
            changed,
            reason,
        }
    }
    pub(super) fn set(&self, enabled: bool) {
        if self.enabled.swap(enabled, Ordering::SeqCst) != enabled {
            self.changed
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if self.enabled.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(self.reason.into())
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
pub(super) struct CalendarTransport {
    client: reqwest::Client,
    runtime: Option<tokio::runtime::Runtime>,
}
impl Drop for CalendarTransport {
    fn drop(&mut self) {
        // Tauri may drop app state inside an async shutdown callback.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}
impl CalendarTransport {
    pub(super) fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .min_tls_version(reqwest::tls::Version::TLS_1_2)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("bcorn-calendar-sync/1")
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
impl Transport for CalendarTransport {
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
                    && url.path() == "/token"
                    && request.bearer.is_none()
                    && request.json.is_none()
                    && url.query().is_none()
            }
            Some("login.microsoftonline.com") => {
                request.method == "POST"
                    && url.path() == "/common/oauth2/v2.0/token"
                    && request.bearer.is_none()
                    && request.json.is_none()
                    && url.query().is_none()
            }
            Some("openidconnect.googleapis.com") => {
                request.method == "GET"
                    && url.path() == "/v1/userinfo"
                    && url.query().is_none()
                    && request.form.is_none()
                    && request.json.is_none()
            }
            Some("www.googleapis.com") => {
                request.form.is_none() && allowed_calendar_route(&url, request.method, false)
            }
            Some("graph.microsoft.com") => {
                request.form.is_none() && allowed_calendar_route(&url, request.method, true)
            }
            _ => false,
        };
        if !allowed {
            return Err("invalid-native-endpoint".into());
        }
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "invalid-native-method")?;
        let mut call = apply_provider_preferences(
            self.client.request(method, url.clone()),
            &url,
            request.method,
        );
        if let Some(etag) = request.if_match.as_ref() {
            call = call.header(reqwest::header::IF_MATCH, etag);
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_drops_inflight_work() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let gate = Arc::new(OperationGate::new(true, "cancelled"));
        let clone = gate.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            clone.set(false);
        });
        let started = std::time::Instant::now();
        let result: Result<(), String> = rt.block_on(cancellable(Some(&gate), async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok(())
        }));
        assert_eq!(result.err().unwrap(), "cancelled");
        assert!(started.elapsed() < Duration::from_secs(2));
        thread.join().unwrap();
    }
    #[test]
    fn unknown_hosts_and_credentials_are_rejected_before_network() {
        let transport = CalendarTransport::new().unwrap();
        for url in [
            "https://evil.invalid/calendar/v3/calendars",
            "https://www.googleapis.com.evil.invalid/calendar/v3/calendars",
            "https://token@graph.microsoft.com/v1.0/me",
            "http://graph.microsoft.com/v1.0/me",
            "https://sheets.googleapis.com/v4/spreadsheets",
        ] {
            assert_eq!(
                transport
                    .send(NativeRequest {
                        method: "GET",
                        url: url.into(),
                        if_match: None,
                        bearer: None,
                        form: None,
                        json: None,
                        cancellation: None
                    })
                    .err()
                    .unwrap(),
                "invalid-native-endpoint"
            );
        }
    }
}

fn allowed_calendar_route(url: &Url, method: &str, graph: bool) -> bool {
    let parts: Vec<_> = url.path().split('/').filter(|s| !s.is_empty()).collect();
    let base = if graph {
        vec!["v1.0", "me", "calendars"]
    } else {
        vec!["calendar", "v3", "calendars"]
    };
    if graph && parts == ["v1.0", "me"] {
        return method == "GET";
    }
    if !parts.starts_with(&base) {
        return false;
    }
    match &parts[3..] {
        [] => method == if graph { "GET" } else { "POST" },
        [calendar, "events"] => !calendar.is_empty() && ["GET", "POST"].contains(&method),
        [calendar, "events", event] => {
            !calendar.is_empty()
                && !event.is_empty()
                && ["GET", "PATCH", "DELETE"].contains(&method)
        }
        _ => false,
    }
}

fn apply_provider_preferences(
    builder: reqwest::RequestBuilder,
    url: &Url,
    method: &str,
) -> reqwest::RequestBuilder {
    if url.host_str() == Some("graph.microsoft.com")
        && method == "GET"
        && url.path().contains("/events")
    {
        builder.header(
            "Prefer",
            "outlook.body-content-type=\"text\", outlook.timezone=\"UTC\"",
        )
    } else {
        builder
    }
}
#[cfg(test)]
mod preference_tests {
    use super::*;
    #[test]
    fn graph_read_requests_plaintext_and_utc_but_google_does_not() {
        let client = reqwest::Client::new();
        for (address, expected) in [
            (
                "https://graph.microsoft.com/v1.0/me/calendars/c/events/e",
                true,
            ),
            (
                "https://www.googleapis.com/calendar/v3/calendars/c/events/e",
                false,
            ),
        ] {
            let url = Url::parse(address).unwrap();
            let request = apply_provider_preferences(client.get(url.clone()), &url, "GET")
                .build()
                .unwrap();
            assert_eq!(request.headers().contains_key("Prefer"), expected);
            if expected {
                assert_eq!(
                    request.headers()["Prefer"],
                    "outlook.body-content-type=\"text\", outlook.timezone=\"UTC\""
                );
            }
        }
    }
}
