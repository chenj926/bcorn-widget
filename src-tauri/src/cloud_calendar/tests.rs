use super::*;
use crate::grade_sync_store::tests::TestProtection;
use std::sync::atomic::AtomicBool;
#[derive(Default)]
struct Mock {
    events: Mutex<BTreeMap<String, Value>>,
    calls: Mutex<Vec<(String, String)>>,
    lose_post: AtomicBool,
    fail: Mutex<Option<u16>>,
    fail_post: Mutex<Option<u16>>,
    retired: Mutex<std::collections::BTreeSet<String>>,
}
fn response(status: u16, v: Value) -> NativeResponse {
    NativeResponse {
        status,
        body: Zeroizing::new(serde_json::to_vec(&v).unwrap()),
        retry_after_ms: Some(1000),
    }
}
impl Transport for Mock {
    fn send(&self, r: NativeRequest) -> Result<NativeResponse, String> {
        self.calls
            .lock()
            .unwrap()
            .push((r.method.into(), r.url.clone()));
        if let Some(status) = self.fail.lock().unwrap().take() {
            return Ok(response(
                status,
                json!({"error":{"errors":[{"reason":if status==403{"userRateLimitExceeded"}else{"other"}}]}}),
            ));
        }
        let u = Url::parse(&r.url).unwrap();
        let p = u.path();
        let mut events = self.events.lock().unwrap();
        let graph = u.host_str() == Some("graph.microsoft.com");
        if p.ends_with("/token") {
            return Ok(response(
                200,
                json!({"access_token":"test-access","refresh_token":"test-refresh","expires_in":3600}),
            ));
        }
        if p == "/v1.0/me" || p == "/v1/userinfo" {
            return Ok(response(
                200,
                json!({"id":"account-test","sub":"account-test","userPrincipalName":"test@example.invalid","email":"test@example.invalid"}),
            ));
        }
        if p.ends_with("/calendars") && r.method == "GET" {
            return Ok(response(
                200,
                json!({"value":[{"id":"calendar-test","name":"Test calendar","canEdit":true},{"id":"readonly","name":"Read only","canEdit":false}]}),
            ));
        }
        if p.ends_with("/calendars") && r.method == "POST" {
            return Ok(response(
                200,
                json!({"id":"calendar-test","summary":"Test calendar"}),
            ));
        }
        if p.ends_with("/events") {
            if r.method == "GET" {
                return Ok(response(
                    200,
                    json!({"value":events.values().cloned().collect::<Vec<_>>()}),
                ));
            }
            if let Some(status) = self.fail_post.lock().unwrap().take() {
                return Ok(response(
                    status,
                    json!({"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}),
                ));
            }
            let mut b = r.json.unwrap();
            let id = b["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("graph-{}", b["transactionId"].as_str().unwrap()));
            if self.retired.lock().unwrap().contains(&id) {
                return Ok(response(409, json!({})));
            }
            b["id"] = json!(id);
            b[if graph { "@odata.etag" } else { "etag" }] = json!("\"version-1\"");
            events.insert(id, b.clone());
            if self.lose_post.swap(false, Ordering::SeqCst) {
                return Err("network-error".into());
            }
            return Ok(response(201, b));
        }
        let id = p.rsplit('/').next().unwrap();
        match r.method {
            "GET" => Ok(match events.get(id) {
                Some(b) => response(200, b.clone()),
                None => response(404, json!({})),
            }),
            "PATCH" => {
                assert_eq!(r.if_match.as_deref(), Some("\"version-1\""));
                let mut b = r.json.unwrap();
                b["id"] = json!(id);
                b[if graph { "@odata.etag" } else { "etag" }] = json!("\"version-1\"");
                events.insert(id.into(), b.clone());
                Ok(response(200, b))
            }
            "DELETE" => {
                assert!(r.if_match.is_some());
                events.remove(id);
                self.retired.lock().unwrap().insert(id.into());
                Ok(response(204, Value::Null))
            }
            _ => panic!("unexpected method"),
        }
    }
}
fn setup(p: Provider) -> (CloudCalendar, Arc<Mock>, PathBuf) {
    let root = std::env::temp_dir().join(format!("bcorn-calendar-tests-{}", random_id()));
    let mock = Arc::new(Mock::default());
    fn conn(p: Provider, path: PathBuf) -> Connection {
        Connection::open(
            Config {
                provider: p,
                client_id: if p == Provider::Google {
                    "test.apps.googleusercontent.com".into()
                } else {
                    "12345678-1234-1234-1234-123456789abc".into()
                },
                client_secret: String::new(),
            },
            CalendarStore::testing(path, Arc::new(TestProtection)),
        )
        .unwrap()
    }
    let service = CloudCalendar {
        google: conn(Provider::Google, root.join("google")),
        microsoft: conn(Provider::Microsoft, root.join("microsoft")),
        transport: mock.clone(),
    };
    let c = service.connection(p);
    let mut v = c.current().unwrap();
    v.tokens = Some(Tokens {
        access: "test-access".into(),
        refresh: "test-refresh".into(),
        expires_at: now() + 3600,
    });
    v.account = Some("account-test".into());
    v.label = "test@example.invalid".into();
    v.enabled = true;
    v.accounts.insert(
        "account-test".into(),
        Account {
            selected: Some("calendar-test".into()),
            calendars: BTreeMap::from([(
                "calendar-test".into(),
                Calendar {
                    target: Target {
                        id: "calendar-test".into(),
                        name: "Test calendar".into(),
                    },
                    entries: BTreeMap::new(),
                },
            )]),
        },
    );
    c.commit(v).unwrap();
    (service, mock, root)
}
fn series() -> Vec<Series> {
    vec![Series {
        id: "stable-meeting".into(),
        title: "Test lecture".into(),
        description: "Synthetic".into(),
        location: "Test room".into(),
        time_zone: "America/Toronto".into(),
        reminders: vec![15],
        occurrences: vec![Occurrence {
            key: "2026-11-02".into(),
            start_millis: 1793628000000,
            end_millis: 1793631600000,
        }],
    }]
}
#[test]
fn google_and_graph_create_noop_update_confirm_delete() {
    for p in [Provider::Google, Provider::Microsoft] {
        let (s, m, root) = setup(p);
        assert_eq!(s.sync(p, series(), false).unwrap().written, 1);
        assert_eq!(s.sync(p, series(), false).unwrap().unchanged, 1);
        let mut changed = series();
        changed[0].location = "Changed room".into();
        assert_eq!(s.sync(p, changed, false).unwrap().written, 1);
        let r = s.sync(p, vec![], false).unwrap();
        assert_eq!(r.pending_delete_count, 1);
        assert_eq!(m.events.lock().unwrap().len(), 1);
        assert_eq!(s.sync(p, vec![], true).unwrap().deleted, 1);
        assert!(m.events.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn lost_post_response_recovers_without_duplicate_post() {
    for p in [Provider::Google, Provider::Microsoft] {
        let (s, m, root) = setup(p);
        m.lose_post.store(true, Ordering::SeqCst);
        assert_eq!(s.sync(p, series(), false).err().unwrap(), "network-error");
        assert_eq!(s.sync(p, series(), false).unwrap().written, 1);
        assert_eq!(
            m.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(method, url)| method == "POST" && url.contains("/events"))
                .count(),
            1
        );
        assert_eq!(m.events.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn ownership_conflict_never_patches_or_deletes() {
    for p in [Provider::Google, Provider::Microsoft] {
        let (s, m, root) = setup(p);
        s.sync(p, series(), false).unwrap();
        for v in m.events.lock().unwrap().values_mut() {
            v["extendedProperties"] = json!({});
            v["singleValueExtendedProperties"] = json!([]);
        }
        let before = m.calls.lock().unwrap().len();
        assert_eq!(
            s.sync(p, vec![], true).err().unwrap(),
            "calendar-ownership-conflict"
        );
        assert!(m.calls.lock().unwrap()[before..]
            .iter()
            .all(|(method, _)| method == "GET"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn rate_limit_retains_grant_revoked_drops_grant() {
    let (s, m, root) = setup(Provider::Microsoft);
    *m.fail.lock().unwrap() = Some(403);
    assert_eq!(
        s.targets(Provider::Microsoft).err().unwrap(),
        "rate-limited"
    );
    assert!(s.microsoft.current().unwrap().tokens.is_some());
    s.microsoft.rate_until.store(0, Ordering::SeqCst);
    *m.fail.lock().unwrap() = Some(401);
    assert_eq!(
        s.targets(Provider::Microsoft).err().unwrap(),
        "authorization-revoked"
    );
    assert!(s.microsoft.current().unwrap().tokens.is_none());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn background_and_invalid_payload_cannot_write() {
    let (s, m, root) = setup(Provider::Google);
    s.set_foreground(false);
    assert_eq!(
        s.sync(Provider::Google, series(), false).err().unwrap(),
        "background-paused"
    );
    assert!(m.calls.lock().unwrap().is_empty());
    s.set_foreground(true);
    let mut bad = series();
    bad[0].occurrences[0].end_millis = 0;
    assert_eq!(
        s.sync(Provider::Google, bad, false).err().unwrap(),
        "invalid-calendar-occurrence"
    );
    assert!(m.calls.lock().unwrap().is_empty());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn encrypted_journal_survives_disconnect_and_no_remote_deletion() {
    let (s, m, root) = setup(Provider::Google);
    s.sync(Provider::Google, series(), false).unwrap();
    let before = m.calls.lock().unwrap().len();
    s.disconnect(Provider::Google).unwrap();
    assert_eq!(m.calls.lock().unwrap().len(), before);
    let v = s.google.current().unwrap();
    assert!(v.tokens.is_none());
    assert_eq!(selected(&v).unwrap().entries.len(), 1);
    let bytes = std::fs::read(root.join("google/calendar-authorization-v1.bin")).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("test-access"));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn stable_keys_preserve_dst_and_reminders() {
    let a = desired(Provider::Google, "owner", "account", "calendar", series()).unwrap();
    let mut b = series();
    b[0].title = "Renamed".into();
    b[0].occurrences[0].start_millis += 3600000;
    b[0].occurrences[0].end_millis += 3600000;
    let b = desired(Provider::Google, "owner", "account", "calendar", b).unwrap();
    assert_eq!(a.keys().next(), b.keys().next());
    assert_ne!(
        a.values().next().unwrap().fingerprint,
        b.values().next().unwrap().fingerprint
    );
    assert_eq!(utc(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(utc(1709164800000), "2024-02-29T00:00:00.000Z");
}
#[test]
fn failed_account_switch_disables_previous_sync() {
    let (s, _m, root) = setup(Provider::Google);
    assert_eq!(
        s.connect(Provider::Google, |_| Err(
            "synthetic browser unavailable".into()
        ))
        .err()
        .unwrap(),
        "system-browser-unavailable"
    );
    let state = s.status(Provider::Google).unwrap();
    assert!(!state.enabled);
    assert_eq!(state.state, "authorization-required");
    assert!(s.google.current().unwrap().tokens.is_none());
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn all_scopes_are_explicit_and_separate_from_grade() {
    assert!(!Provider::Google.scope().contains("drive.file"));
    assert!(Provider::Google.scope().contains("calendar.app.created"));
    assert!(!Provider::Google.scope().contains("calendar.events "));
    assert!(Provider::Microsoft.scope().contains("Calendars.ReadWrite"));
}
#[test]
fn normal_thousand_occurrences_fit_calendar_journal() {
    let (s, _m, root) = setup(Provider::Google);
    let mut payload = Vec::new();
    for i in 0..1000 {
        let mut item = series().remove(0);
        item.id = format!("stable-meeting-{i}");
        payload.push(item);
    }
    let desired = desired(
        Provider::Google,
        "owner",
        "account",
        "calendar",
        payload.clone(),
    )
    .unwrap();
    assert_eq!(desired.len(), 1000);
    let mut v = s.google.current().unwrap();
    for (key, item) in desired {
        selected_mut(&mut v).unwrap().entries.insert(
            key.clone(),
            Entry {
                generation: 0,
                deleted: false,
                remote: Some(format!("bcorn{key}")),
                fingerprint: item.fingerprint,
                pending: false,
            },
        );
    }
    s.google.commit(v).unwrap();
    assert_eq!(
        selected(&s.google.current().unwrap())
            .unwrap()
            .entries
            .len(),
        1000
    );
    payload.push(series().remove(0));
    assert!(desired_fn(payload).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
fn desired_fn(payload: Vec<Series>) -> Result<BTreeMap<String, Desired>, String> {
    desired(Provider::Google, "owner", "account", "calendar", payload)
}
#[test]
fn rejected_post_is_retryable_without_uncertain_intent() {
    for p in [Provider::Google, Provider::Microsoft] {
        for status in [429, 403] {
            let (s, m, root) = setup(p);
            *m.fail_post.lock().unwrap() = Some(status);
            assert_eq!(s.sync(p, series(), false).err().unwrap(), "rate-limited");
            assert!(selected(&s.connection(p).current().unwrap())
                .unwrap()
                .entries
                .is_empty());
            s.connection(p).rate_until.store(0, Ordering::SeqCst);
            assert_eq!(s.sync(p, series(), false).unwrap().written, 1);
            assert_eq!(m.events.lock().unwrap().len(), 1);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
#[test]
fn removed_then_readded_occurrence_uses_new_generation_not_tombstoned_id() {
    for p in [Provider::Google, Provider::Microsoft] {
        let (s, m, root) = setup(p);
        s.sync(p, series(), false).unwrap();
        let first = m.events.lock().unwrap().keys().next().unwrap().clone();
        s.sync(p, vec![], true).unwrap();
        assert_eq!(s.status(p).unwrap().owned_count, 0);
        assert_eq!(s.sync(p, vec![], false).unwrap().pending_delete_count, 0);
        assert_eq!(s.sync(p, series(), false).unwrap().written, 1);
        let second = m.events.lock().unwrap().keys().next().unwrap().clone();
        assert_ne!(first, second);
        assert_eq!(s.sync(p, series(), false).unwrap().unchanged, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn reduced_scope_rejected_and_omitted_scope_uses_requested_grant() {
    struct ScopeTransport(Option<&'static str>);
    impl Transport for ScopeTransport {
        fn send(&self, _: NativeRequest) -> Result<NativeResponse, String> {
            let mut body = json!({"access_token":"synthetic","refresh_token":"synthetic-refresh","expires_in":3600});
            if let Some(scope) = self.0 {
                body["scope"] = json!(scope)
            }
            Ok(response(200, body))
        }
    }
    for p in [Provider::Google, Provider::Microsoft] {
        let (mut s, _m, root) = setup(p);
        s.transport = Arc::new(ScopeTransport(Some("openid email")));
        assert_eq!(
            s.token_exchange(s.connection(p), vec![], None)
                .err()
                .unwrap(),
            "calendar-scope-not-granted"
        );
        s.transport = Arc::new(ScopeTransport(None));
        assert!(s.token_exchange(s.connection(p), vec![], None).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
}
