//! Authenticated CBOR snapshots with atomic commit and process exclusion.
use async_trait::async_trait;
use chacha20poly1305::{
    aead::{Aead, AeadCore, OsRng, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use fs2::FileExt;
use paykit_sdk::storage::{
    run_storage_state_transaction, StorageState, StorageTransactionCallback,
};
use paykit_sdk::{PaykitSdkError, StorageAdapter};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    any::Any,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use zeroize::Zeroizing;

pub struct Vault {
    root: PathBuf,
    key: Zeroizing<[u8; 32]>,
    binding: String,
    poisoned: AtomicBool,
}

impl Vault {
    pub fn new(root: PathBuf, key: [u8; 32], binding: String) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            key: Zeroizing::new(key),
            binding,
            poisoned: AtomicBool::new(false),
        })
    }
    pub(crate) fn shared_wallets(&self, environment: uuid::Uuid) -> anyhow::Result<Self> {
        let parent = self
            .root
            .parent()
            .ok_or_else(|| anyhow::anyhow!("receiver parent missing"))?;
        let receivers = if parent.file_name().is_some_and(|n| n == "receivers") {
            parent
        } else {
            &self.root
        };
        Self::new(
            receivers.join("wallet-execution"),
            *self.key,
            format!("{environment}:wallet-execution"),
        )
    }
    pub fn lock(&self, name: &str) -> anyhow::Result<File> {
        let file = private_options()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join(name))?;
        file.try_lock_exclusive()?;
        Ok(file)
    }
    pub fn load<T: DeserializeOwned>(&self, name: &str) -> anyhow::Result<Option<T>> {
        let path = self.root.join(name);
        let bytes = match std::fs::read(path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        anyhow::ensure!(bytes.len() >= 24, "invalid encrypted state");
        let cipher = XChaCha20Poly1305::new((&*self.key).into());
        let aad = format!("polar-paykit:v1:{}:{name}", self.binding);
        let clear = Zeroizing::new(
            cipher
                .decrypt(
                    XNonce::from_slice(&bytes[..24]),
                    Payload {
                        msg: &bytes[24..],
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|_| anyhow::anyhow!("state authentication failed"))?,
        );
        Ok(Some(ciborium::from_reader(clear.as_slice())?))
    }
    pub fn save<T: Serialize>(&self, name: &str, state: &T) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.poisoned.load(Ordering::SeqCst),
            "state requires reopen after failed commit"
        );
        let mut clear = Zeroizing::new(Vec::new());
        ciborium::into_writer(state, &mut *clear)?;
        let cipher = XChaCha20Poly1305::new((&*self.key).into());
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let aad = format!("polar-paykit:v1:{}:{name}", self.binding);
        let encrypted = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: &clear,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| anyhow::anyhow!("state encryption failed"))?;
        let result = atomic_write(
            &self.root.join(name),
            &[nonce.as_slice(), &encrypted].concat(),
        );
        if result.is_err() {
            self.poisoned.store(true, Ordering::SeqCst);
        }
        result
    }
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    commit_file(path, bytes, |parent| {
        File::open(parent)?.sync_all()?;
        Ok(())
    })
}
fn commit_file(
    path: &Path,
    bytes: &[u8],
    sync_directory: impl FnOnce(&Path) -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing state directory"))?;
    let temp = parent.join(format!(".commit-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = private_options().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&temp, path)?;
        sync_directory(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

pub struct ReceiverStorage {
    vault: Vault,
    state: Mutex<StorageState>,
    _lock: File,
}
impl ReceiverStorage {
    pub fn open(vault: Vault) -> anyhow::Result<Self> {
        let lock = vault.lock("receiver.lock")?;
        let state = vault.load("sdk.cbor")?.unwrap_or_default();
        Ok(Self {
            vault,
            state: Mutex::new(state),
            _lock: lock,
        })
    }
}
#[async_trait]
impl StorageAdapter for ReceiverStorage {
    async fn transaction_erased<'a>(
        &self,
        f: StorageTransactionCallback<'a>,
    ) -> paykit_sdk::Result<Box<dyn Any + Send>> {
        let mut state = self.state.lock().map_err(|_| storage_error())?;
        let (updated, value) = run_storage_state_transaction(state.clone(), f)?;
        if updated != *state {
            self.vault
                .save("sdk.cbor", &updated)
                .map_err(|_| storage_error())?;
        }
        *state = updated;
        Ok(value)
    }
}
fn storage_error() -> PaykitSdkError {
    PaykitSdkError::Storage {
        context: "receiver state commit failed".into(),
        source: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn readonly_sdk_transactions_do_not_reencrypt_or_replace_state() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ReceiverStorage::open(
            Vault::new(dir.path().into(), [3; 32], "receiver".into()).unwrap(),
        )
        .unwrap();
        storage
            .transaction(|tx| Ok(tx.allocate_receive_batch_id()))
            .await
            .unwrap();
        let before = std::fs::read(dir.path().join("sdk.cbor")).unwrap();
        storage
            .transaction(|tx| Ok(tx.export_storage_state()))
            .await
            .unwrap();
        assert_eq!(std::fs::read(dir.path().join("sdk.cbor")).unwrap(), before);
    }
    #[test]
    fn cbor_preserves_tuple_map_keys() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into(), [7; 32], "receiver-a".into()).unwrap();
        let state = std::collections::BTreeMap::from([(
            ("owner".to_string(), "receiver".to_string()),
            9u64,
        )]);
        vault.save("test.cbor", &state).unwrap();
        assert_eq!(
            vault
                .load::<std::collections::BTreeMap<(String, String), u64>>("test.cbor")
                .unwrap()
                .unwrap(),
            state
        );
    }
    #[test]
    fn corrupted_ciphertext_and_wrong_receiver_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into(), [7; 32], "a".into()).unwrap();
        vault.save("state", &42).unwrap();
        let wrong = Vault::new(dir.path().into(), [7; 32], "b".into()).unwrap();
        assert!(wrong.load::<u32>("state").is_err());
        let mut bytes = std::fs::read(dir.path().join("state")).unwrap();
        bytes[25] ^= 1;
        std::fs::write(dir.path().join("state"), bytes).unwrap();
        assert!(vault.load::<u32>("state").is_err());
    }
    #[test]
    fn receiver_lock_excludes_second_process_handle() {
        let dir = tempfile::tempdir().unwrap();
        let a = Vault::new(dir.path().into(), [1; 32], "a".into()).unwrap();
        let lock = a.lock("receiver.lock").unwrap();
        assert!(a.lock("receiver.lock").is_err());
        drop(lock);
        assert!(a.lock("receiver.lock").is_ok());
    }
    #[test]
    fn failed_atomic_replace_preserves_previous_data() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("existing"), b"unchanged").unwrap();
        assert!(atomic_write(&target, b"new").is_err());
        assert_eq!(
            std::fs::read(target.join("existing")).unwrap(),
            b"unchanged"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn directory_sync_failure_reports_uncertain_committed_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state");
        std::fs::write(&path, b"old").unwrap();
        assert!(commit_file(&path, b"new", |_| Err(anyhow::anyhow!(
            "injected directory sync failure"
        )))
        .is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"new");
    }
    #[tokio::test]
    async fn sdk_tuple_keyed_leases_and_counters_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ReceiverStorage::open(
            Vault::new(dir.path().into(), [3; 32], "receiver".into()).unwrap(),
        )
        .unwrap();
        let owner =
            paykit_sdk::PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = paykit_sdk::PaykitReceiverPath::new("polar/wallet").unwrap();
        let lease = storage
            .transaction(|tx| {
                let lease = tx
                    .claim_peer_link_operation(
                        &owner,
                        &path,
                        "2026-09-10T00:00:00Z".parse().unwrap(),
                        "2026-09-10T00:01:00Z".parse().unwrap(),
                    )
                    .unwrap();
                tx.allocate_receive_batch_id();
                Ok(lease)
            })
            .await
            .unwrap();
        drop(storage);
        let reopened = ReceiverStorage::open(
            Vault::new(dir.path().into(), [3; 32], "receiver".into()).unwrap(),
        )
        .unwrap();
        let result = reopened
            .transaction(|tx| {
                Ok((
                    tx.peer_link_operation_lease(&owner, &path),
                    tx.allocate_receive_batch_id(),
                ))
            })
            .await
            .unwrap();
        assert_eq!(result.0, Some(lease));
        assert_eq!(result.1, 1);
    }
    #[tokio::test]
    async fn sdk_failed_write_keeps_memory_and_blocks_further_transactions() {
        let dir = tempfile::tempdir().unwrap();
        let storage = ReceiverStorage::open(
            Vault::new(dir.path().into(), [3; 32], "receiver".into()).unwrap(),
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("sdk.cbor")).unwrap();
        assert!(storage
            .transaction(|tx| Ok(tx.allocate_receive_batch_id()))
            .await
            .is_err());
        assert_eq!(storage.state.lock().unwrap().next_receive_batch_id, 0);
        std::fs::remove_dir(dir.path().join("sdk.cbor")).unwrap();
        assert!(storage
            .transaction(|tx| Ok(tx.allocate_receive_batch_id()))
            .await
            .is_err());
    }
}
