//! Separate Calendar vault schema, filename and budget. Only audited storage
//! primitives are shared with grades; grants/scopes/records never cross modules.
use crate::grade_sync_store::{atomic_private_write, bounded_read, Protector, UserProtection};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;
const LIMIT: usize = 4 * 1024 * 1024;
const FILE: &str = "calendar-authorization-v1.bin";
pub(super) struct CalendarStore {
    directory: PathBuf,
    protector: Arc<dyn Protector>,
    gate: Mutex<()>,
}
impl CalendarStore {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            protector: Arc::new(UserProtection),
            gate: Mutex::new(()),
        }
    }
    #[cfg(test)]
    pub(super) fn testing(directory: PathBuf, protector: Arc<dyn Protector>) -> Self {
        Self {
            directory,
            protector,
            gate: Mutex::new(()),
        }
    }
    pub(super) fn load_vault(&self) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let _guard = self.gate.lock().map_err(|_| "calendar-storage-busy")?;
        let Some(bytes) = bounded_read(&self.directory.join(FILE), LIMIT + 16384)? else {
            return Ok(None);
        };
        let clear = self.protector.unprotect(&bytes)?;
        if clear.len() > LIMIT {
            return Err("calendar-storage-limit".into());
        }
        Ok(Some(clear))
    }
    pub(super) fn save_vault(&self, bytes: &[u8]) -> Result<(), String> {
        if bytes.len() > LIMIT {
            return Err("calendar-storage-limit".into());
        }
        let _guard = self.gate.lock().map_err(|_| "calendar-storage-busy")?;
        let sealed = Zeroizing::new(self.protector.protect(bytes)?);
        atomic_private_write(&self.directory.join(FILE), &sealed)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::grade_sync_store::{random_id, tests::TestProtection};
    #[test]
    fn oversize_journal_preserves_prior_atomically() {
        let root = std::env::temp_dir().join(random_id());
        let store = CalendarStore::testing(root.clone(), Arc::new(TestProtection));
        store.save_vault(b"last-good-snapshot").unwrap();
        assert_eq!(
            store.save_vault(&vec![b'x'; LIMIT + 1]).err().unwrap(),
            "calendar-storage-limit"
        );
        assert_eq!(
            store.load_vault().unwrap().unwrap().as_slice(),
            b"last-good-snapshot"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn calendar_dpapi_roundtrip_tampering_and_large_journal() {
        let root = std::env::temp_dir().join(random_id());
        let store = CalendarStore::new(root.clone());
        let payload = vec![b'x'; 1024 * 1024];
        store.save_vault(&payload).unwrap();
        assert_eq!(store.load_vault().unwrap().unwrap().as_slice(), payload);
        let path = root.join(FILE);
        let mut sealed = std::fs::read(&path).unwrap();
        let i = sealed.len() / 2;
        sealed[i] ^= 1;
        std::fs::write(&path, sealed).unwrap();
        assert!(store.load_vault().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
