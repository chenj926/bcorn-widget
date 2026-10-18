//! Calendar-only PKCE/loopback boundary. Adapted from the audited grade flow;
//! deliberately separate configuration and scopes, with no grade grant access.
use super::{valid_token, Config, Provider};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    thread,
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::{Zeroize, Zeroizing};
pub(super) struct PendingAuthorization {
    listener: TcpListener,
    pub(super) authorization_url: String,
    pub(super) redirect_uri: String,
    state: Zeroizing<String>,
    pub(super) verifier: Zeroizing<String>,
}
impl PendingAuthorization {
    pub(super) fn bind(config: &Config) -> Result<Self, String> {
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
        let mut url =
            Url::parse(config.provider.authorize()).map_err(|_| "invalid-native-endpoint")?;
        url.query_pairs_mut().extend_pairs([
            ("client_id", config.client_id.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("response_type", "code"),
            ("scope", config.provider.scope()),
            ("state", state.as_str()),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ]);
        if config.provider == Provider::Google {
            url.query_pairs_mut().append_pair("access_type", "offline");
        }
        url.query_pairs_mut().append_pair(
            "prompt",
            if config.provider == Provider::Google {
                "consent select_account"
            } else {
                "select_account"
            },
        );
        Ok(Self {
            listener,
            authorization_url: url.into(),
            redirect_uri,
            state,
            verifier,
        })
    }
    pub(super) fn receive<F>(
        &self,
        cancelled: F,
        timeout: Duration,
    ) -> Result<Zeroizing<String>, String>
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
                        "Authorization received. Return to bcorn to finish connecting your calendar."
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
        Ok(Some(Zeroizing::new(code.clone())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_loopback_validates_state_host_pkce_and_provider_scope() {
        for provider in [Provider::Google, Provider::Microsoft] {
            let config = Config {
                provider,
                client_id: "synthetic-client".into(),
                client_secret: String::new(),
            };
            let pending = PendingAuthorization::bind(&config).unwrap();
            let auth = Url::parse(&pending.authorization_url).unwrap();
            let query: HashMap<_, _> = auth
                .query_pairs()
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            assert_eq!(query["scope"], provider.scope());
            assert!(!query["scope"].contains("drive.file"));
            assert_eq!(
                query["code_challenge"],
                URL_SAFE_NO_PAD.encode(Sha256::digest(pending.verifier.as_bytes()))
            );
            assert_eq!(query["code_challenge_method"], "S256");
            let redirect = Url::parse(&pending.redirect_uri).unwrap();
            let port = redirect.port().unwrap();
            let state = pending.state.to_string();
            let client = std::thread::spawn(move || {
                let mut bad = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
                bad.write_all(format!("GET /oauth/callback?code=bad&state=wrong HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).unwrap();
                let mut ignored = String::new();
                bad.read_to_string(&mut ignored).unwrap();
                assert!(ignored.starts_with("HTTP/1.1 400"));
                let mut good = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).unwrap();
                good.write_all(format!("GET /oauth/callback?code=synthetic-code&state={state} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes()).unwrap();
                let mut response = String::new();
                good.read_to_string(&mut response).unwrap();
                assert!(response.starts_with("HTTP/1.1 200"));
                assert!(!response.contains("synthetic-code"));
            });
            assert_eq!(
                pending
                    .receive(|| Ok(()), Duration::from_secs(3))
                    .unwrap()
                    .as_str(),
                "synthetic-code"
            );
            client.join().unwrap();
        }
    }
    #[test]
    fn callback_cancel_and_host_spoof_fail_closed() {
        let c = Config {
            provider: Provider::Google,
            client_id: "synthetic".into(),
            client_secret: String::new(),
        };
        let p = PendingAuthorization::bind(&c).unwrap();
        assert_eq!(
            p.receive(|| Err("cancelled".into()), Duration::from_secs(3))
                .err()
                .unwrap(),
            "cancelled"
        );
        let state = p.state.to_string();
        assert!(p.parse_callback(&format!("GET /oauth/callback?code=synthetic&state={state} HTTP/1.1\r\nHost: evil.invalid\r\n\r\n")).is_err());
    }
}
