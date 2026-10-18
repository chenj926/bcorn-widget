//! Private bounded storage. Renderer input is never a filesystem path, and no file
//! in this module participates in timetable/gradebook exports.
use crate::data::validate_grade_book;
use rand::{rngs::OsRng, RngCore};
use serde_json::Value;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

pub const MAX_SYNC_BYTES: usize = 4 * 1024 * 1024;
const MAX_VAULT_BYTES: usize = 128 * 1024;

pub(crate) trait Protector: Send + Sync {
    fn protect(&self, clear: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String>;
}
pub(crate) struct UserProtection;
impl Protector for UserProtection {
    fn protect(&self, clear: &[u8]) -> Result<Vec<u8>, String> {
        dpapi(clear, true).map(|v| v.to_vec())
    }
    fn unprotect(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        dpapi(sealed, false)
    }
}

#[cfg(windows)]
fn dpapi(input: &[u8], encrypt: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    if input.len() > MAX_SYNC_BYTES + MAX_VAULT_BYTES {
        return Err("private-storage-limit".into());
    }
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // No CRYPTPROTECT_LOCAL_MACHINE: only this Windows user can decrypt. DPAPI
    // supplies integrity protection; UI_FORBIDDEN prevents surprising prompts.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("windows-private-storage-unavailable".into());
    }
    let result = unsafe {
        Zeroizing::new(std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec())
    };
    unsafe {
        // Plaintext returned by DPAPI is cleared before releasing the OS buffer.
        if !encrypt {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        }
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(result)
}
#[cfg(not(windows))]
fn dpapi(_: &[u8], _: bool) -> Result<Zeroizing<Vec<u8>>, String> {
    Err("windows-private-storage-required".into())
}

pub(crate) fn random_id() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

pub(crate) fn bounded_read(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("private-storage-read-failed".into()),
    };
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "private-storage-read-failed")?;
    if bytes.len() > limit {
        return Err("private-storage-limit".into());
    }
    Ok(Some(bytes))
}

pub(crate) fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("private-storage-path")?;
    fs::create_dir_all(directory).map_err(|_| "private-storage-unavailable")?;
    let temporary = directory.join(format!(".grade-write-{}.tmp", random_id()));
    let operation = || -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "private-storage-write-failed")?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "private-storage-write-failed")?;
        drop(file);
        replace_file(&temporary, path)?;
        #[cfg(unix)]
        {
            fs::File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| "private-storage-sync-failed")?;
        }
        Ok(())
    };
    let result = operation();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err("private-storage-replace-failed".into())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|_| "private-storage-replace-failed".into())
}

pub(crate) struct PrivateStore {
    directory: PathBuf,
    protector: Arc<dyn Protector>,
    gate: Mutex<()>,
}
impl PrivateStore {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            protector: Arc::new(UserProtection),
            gate: Mutex::new(()),
        }
    }
    #[cfg(test)]
    pub(crate) fn testing(directory: PathBuf, protector: Arc<dyn Protector>) -> Self {
        Self {
            directory,
            protector,
            gate: Mutex::new(()),
        }
    }
    pub(crate) fn load_vault(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        self.load("grade-authorization-v1.bin", MAX_VAULT_BYTES)
    }
    pub(crate) fn save_vault(&self, bytes: &[u8]) -> Result<(), String> {
        self.save("grade-authorization-v1.bin", bytes, MAX_VAULT_BYTES)
    }
    fn load(&self, name: &str, limit: usize) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let _guard = self.gate.lock().map_err(|_| "private-storage-busy")?;
        let Some(sealed) = bounded_read(&self.directory.join(name), limit + 16384)? else {
            return Ok(None);
        };
        let clear = self.protector.unprotect(&sealed)?;
        if clear.len() > limit {
            return Err("private-storage-limit".into());
        }
        Ok(Some(clear))
    }
    fn save(&self, name: &str, bytes: &[u8], limit: usize) -> Result<(), String> {
        if bytes.len() > limit {
            return Err("private-storage-limit".into());
        }
        let _guard = self.gate.lock().map_err(|_| "private-storage-busy")?;
        let sealed = Zeroizing::new(self.protector.protect(bytes)?);
        atomic_private_write(&self.directory.join(name), &sealed)
    }
}

pub struct GradeSyncStore {
    private: PrivateStore,
}
impl GradeSyncStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            private: PrivateStore::new(directory.join("grade-sync")),
        }
    }
    pub fn load(&self, connection_id: &str) -> Result<Option<Value>, String> {
        if !valid_id(connection_id) {
            return Err("invalid-connection-id".into());
        }
        let Some(bytes) = self
            .private
            .load(&format!("{connection_id}.bin"), MAX_SYNC_BYTES)?
        else {
            return Ok(None);
        };
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid-sync-storage")?;
        validate_envelope(&value)?;
        Ok(Some(value))
    }
    pub fn save(&self, connection_id: &str, envelope: Value) -> Result<(), String> {
        if !valid_id(connection_id) {
            return Err("invalid-connection-id".into());
        }
        validate_envelope(&envelope)?;
        let bytes =
            Zeroizing::new(serde_json::to_vec(&envelope).map_err(|_| "invalid-sync-storage")?);
        self.private
            .save(&format!("{connection_id}.bin"), &bytes, MAX_SYNC_BYTES)
    }
}

fn exact_keys(value: &Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.keys().all(|k| allowed.contains(&k.as_str())))
}
fn safe_json(value: &Value, depth: usize) -> bool {
    if depth > 30 {
        return false;
    }
    match value {
        Value::String(s) => s.len() <= 16000,
        Value::Array(a) => a.len() <= 10000 && a.iter().all(|v| safe_json(v, depth + 1)),
        Value::Object(o) => {
            o.len() <= 10000
                && o.iter().all(|(k, v)| {
                    !k.is_empty()
                        && k.len() <= 1000
                        && ![
                            "__proto__",
                            "prototype",
                            "constructor",
                            "access_token",
                            "refresh_token",
                            "accessToken",
                            "refreshToken",
                            "id_token",
                            "idToken",
                            "client_secret",
                            "clientSecret",
                            "authorization",
                            "Authorization",
                        ]
                        .contains(&k.as_str())
                        && safe_json(v, depth + 1)
                })
        }
        _ => true,
    }
}
fn record(value: &Value) -> bool {
    if value.is_null() {
        return true;
    }
    match value.get("kind").and_then(Value::as_str) {
        Some("course") => {
            exact_keys(value, &["kind", "courseId", "title", "termId", "rule"])
                && ["courseId", "title", "termId"]
                    .iter()
                    .all(|k| value[*k].is_string())
                && matches!(value["rule"].as_str(), Some("weighted" | "unconfirmed"))
        }
        Some("assessment") => {
            exact_keys(
                value,
                &[
                    "kind",
                    "courseId",
                    "assessmentId",
                    "title",
                    "weight",
                    "status",
                    "score",
                ],
            ) && ["courseId", "assessmentId", "title"]
                .iter()
                .all(|k| value[*k].is_string())
                && value["weight"].is_number()
                && matches!(
                    value["status"].as_str(),
                    Some("graded" | "ungraded" | "exempt")
                )
                && (value["score"].is_null()
                    || exact_keys(&value["score"], &["mode", "value", "earned", "possible"]))
        }
        _ => false,
    }
}
pub fn validate_envelope(value: &Value) -> Result<(), String> {
    let invalid = || "invalid-sync-storage".to_owned();
    if !exact_keys(value, &["schemaVersion", "coordinator", "publishedBook"])
        || value["schemaVersion"] != 1
        || !safe_json(value, 0)
    {
        return Err(invalid());
    }
    let book = &value["publishedBook"];
    validate_grade_book(book).map_err(|_| invalid())?;
    if !exact_keys(book, &["schemaVersion", "courses"]) {
        return Err(invalid());
    }
    for course in book["courses"].as_array().ok_or_else(invalid)? {
        if !exact_keys(course, &["id", "title", "termId", "rules", "assessments"])
            || !exact_keys(&course["rules"], &["kind"])
        {
            return Err(invalid());
        }
        for assessment in course["assessments"].as_array().ok_or_else(invalid)? {
            if !exact_keys(assessment, &["id", "title", "weight", "status", "score"])
                || (!assessment["score"].is_null()
                    && !exact_keys(
                        &assessment["score"],
                        &["mode", "value", "earned", "possible"],
                    ))
            {
                return Err(invalid());
            }
        }
    }
    let state = &value["coordinator"];
    if !exact_keys(
        state,
        &[
            "schemaVersion",
            "records",
            "base",
            "outbox",
            "conflicts",
            "sequence",
            "status",
            "lastSyncedAt",
            "retryAt",
            "retryAttempts",
            "automaticInbound",
            "authorizationBlocked",
            "error",
        ],
    ) || state["schemaVersion"] != 1
        || !state["sequence"]
            .as_u64()
            .is_some_and(|n| n <= 9007199254740991)
        || !state["status"].is_string()
    {
        return Err(invalid());
    }
    for key in ["records", "base"] {
        if !state[key]
            .as_object()
            .is_some_and(|o| o.values().all(record))
        {
            return Err(invalid());
        }
    }
    let outbox = state["outbox"].as_object().ok_or_else(invalid)?;
    for v in outbox.values() {
        if !exact_keys(v, &["base", "local", "mutationId"])
            || !record(&v["local"])
            || v.get("base").is_some_and(|b| !record(b))
            || !v["mutationId"].is_string()
        {
            return Err(invalid());
        }
    }
    let conflicts = state["conflicts"].as_object().ok_or_else(invalid)?;
    for v in conflicts.values() {
        if !exact_keys(v, &["code", "base", "local", "remote", "paths"])
            || !v["code"].is_string()
            || ["base", "local", "remote"]
                .iter()
                .any(|k| v.get(k).is_some_and(|b| !record(b)))
            || !v["paths"]
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return Err(invalid());
        }
    }
    if state
        .get("error")
        .is_some_and(|e| !exact_keys(e, &["code"]) || !e["code"].is_string())
    {
        return Err(invalid());
    }
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > MAX_SYNC_BYTES {
        return Err("sync-storage-limit".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    pub struct TestProtection;
    impl Protector for TestProtection {
        fn protect(&self, clear: &[u8]) -> Result<Vec<u8>, String> {
            Ok(clear.iter().map(|b| b ^ 0x5a).collect())
        }
        fn unprotect(&self, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
            Ok(Zeroizing::new(sealed.iter().map(|b| b ^ 0x5a).collect()))
        }
    }
    pub fn envelope() -> Value {
        json!({"schemaVersion":1,"coordinator":{"schemaVersion":1,"records":{},"base":{},"outbox":{},"conflicts":{},"sequence":0,"status":"pending","lastSyncedAt":null,"retryAt":null},"publishedBook":{"schemaVersion":1,"courses":[]}})
    }
    #[cfg(windows)]
    #[test]
    fn windows_dpapi_roundtrip_rejects_tampering_and_atomically_replaces() {
        let root = std::env::temp_dir().join(random_id());
        let store = PrivateStore::new(root.clone());
        store.save_vault(b"synthetic-private-token-one").unwrap();
        assert_eq!(
            store.load_vault().unwrap().unwrap().as_slice(),
            b"synthetic-private-token-one"
        );
        let path = root.join("grade-authorization-v1.bin");
        assert!(!String::from_utf8_lossy(&fs::read(&path).unwrap())
            .contains("synthetic-private-token-one"));
        store.save_vault(b"synthetic-private-token-two").unwrap();
        assert_eq!(
            store.load_vault().unwrap().unwrap().as_slice(),
            b"synthetic-private-token-two"
        );
        let mut bytes = fs::read(&path).unwrap();
        let n = bytes.len();
        bytes[n / 2] ^= 0x55;
        fs::write(&path, bytes).unwrap();
        assert!(store.load_vault().is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_paths_tokens_and_unknown_envelopes() {
        let root = std::env::temp_dir().join(random_id());
        let store = GradeSyncStore {
            private: PrivateStore::testing(root.clone(), Arc::new(TestProtection)),
        };
        for id in ["../vault", "", "/tmp/secrets", "abc"] {
            assert!(store.save(id, envelope()).is_err());
        }
        let id = random_id();
        let mut v = envelope();
        v["coordinator"]["refresh_token"] = json!("secret");
        assert!(store.save(&id, v).is_err());
        assert!(!root.exists());
        let mut v = envelope();
        v["publishedBook"]["token"] = json!("secret");
        assert!(store.save(&id, v).is_err());
    }
    #[test]
    fn private_atomic_journal_roundtrips_and_isolates_connections() {
        let root = std::env::temp_dir().join(random_id());
        let store = GradeSyncStore {
            private: PrivateStore::testing(root.clone(), Arc::new(TestProtection)),
        };
        let id = random_id();
        store.save(&id, envelope()).unwrap();
        let mut next = envelope();
        next["coordinator"]["sequence"] = json!(2);
        store.save(&id, next.clone()).unwrap();
        assert_eq!(store.load(&id).unwrap(), Some(next));
        assert_eq!(store.load(&random_id()).unwrap(), None);
        assert!(
            !String::from_utf8_lossy(&fs::read(root.join(format!("{id}.bin"))).unwrap())
                .contains("publishedBook")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn failed_protection_preserves_last_durable_snapshot() {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct Failable(AtomicBool);
        impl Protector for Failable {
            fn protect(&self, bytes: &[u8]) -> Result<Vec<u8>, String> {
                if self.0.load(Ordering::SeqCst) {
                    Err("synthetic-protection-failure".into())
                } else {
                    TestProtection.protect(bytes)
                }
            }
            fn unprotect(&self, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
                TestProtection.unprotect(bytes)
            }
        }
        let root = std::env::temp_dir().join(random_id());
        let protector = Arc::new(Failable(AtomicBool::new(false)));
        let store = GradeSyncStore {
            private: PrivateStore::testing(root.clone(), protector.clone()),
        };
        let id = random_id();
        store.save(&id, envelope()).unwrap();
        protector.0.store(true, Ordering::SeqCst);
        let mut next = envelope();
        next["coordinator"]["sequence"] = json!(1);
        assert!(store.save(&id, next).is_err());
        assert_eq!(store.load(&id).unwrap(), Some(envelope()));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn concurrent_journal_saves_are_whole_snapshots() {
        let root = std::env::temp_dir().join(random_id());
        let store = Arc::new(GradeSyncStore {
            private: PrivateStore::testing(root.clone(), Arc::new(TestProtection)),
        });
        let id = random_id();
        let mut tasks = vec![];
        for n in 0..12 {
            let store = store.clone();
            let id = id.clone();
            tasks.push(std::thread::spawn(move || {
                let mut value = envelope();
                value["coordinator"]["sequence"] = json!(n);
                store.save(&id, value).unwrap();
            }));
        }
        for task in tasks {
            task.join().unwrap();
        }
        let saved = store.load(&id).unwrap().unwrap();
        validate_envelope(&saved).unwrap();
        assert!(saved["coordinator"]["sequence"].as_u64().unwrap() < 12);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn journal_rejects_deep_unknown_and_oversized_snapshots() {
        let mut value = envelope();
        value["coordinator"]["records"]["unknown"] =
            json!({"kind":"credential","token":"synthetic"});
        assert!(validate_envelope(&value).is_err());
        let mut value = envelope();
        let records = value["coordinator"]["records"].as_object_mut().unwrap();
        for n in 0..600 {
            records.insert(format!("course:{n}"),json!({"kind":"course","courseId":format!("{n}"),"title":"x".repeat(8000),"termId":"","rule":"unconfirmed"}));
        }
        assert!(validate_envelope(&value).is_err());
    }
    #[test]
    fn bounded_reader_does_not_accept_oversized_or_truncated_data() {
        let root = std::env::temp_dir().join(random_id());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("test");
        fs::write(&path, vec![0; 11]).unwrap();
        assert!(bounded_read(&path, 10).is_err());
        assert_eq!(bounded_read(&path, 11).unwrap().unwrap().len(), 11);
        fs::remove_dir_all(root).unwrap();
    }
}
