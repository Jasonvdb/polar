//! Durable application transactions and command deduplication.
use crate::{commands, config::Config, model::*, storage::Vault};
use serde_json::json;
use std::{
    fs::File,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tokio::sync::Notify;
use uuid::Uuid;
pub struct Repository {
    state: Mutex<AppState>,
    vault: Vault,
    _lock: File,
    pub ready: AtomicBool,
    pub notify: Notify,
}
impl Repository {
    pub fn open(config: &Config) -> anyhow::Result<Self> {
        let vault = Vault::new(
            config.data_dir.clone(),
            *config.key,
            config.environment_id.to_string(),
        )?;
        let lock = vault.lock("environment.lock")?;
        let state: AppState = vault
            .load("application.cbor")?
            .unwrap_or_else(|| AppState::new(config.environment_id));
        anyhow::ensure!(
            state.environment_id == config.environment_id,
            "environment identity mismatch"
        );
        vault.save("application.cbor", &state)?;
        Ok(Self {
            state: Mutex::new(state),
            vault,
            _lock: lock,
            ready: AtomicBool::new(false),
            notify: Notify::new(),
        })
    }
    pub fn snapshot(&self) -> anyhow::Result<AppState> {
        Ok(self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("state unavailable"))?
            .clone())
    }
    pub fn update<T>(
        &self,
        f: impl FnOnce(&mut AppState) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("state unavailable"))?;
        let mut candidate = guard.clone();
        let value = f(&mut candidate)?;
        if self.vault.save("application.cbor", &candidate).is_err() {
            self.ready.store(false, Ordering::SeqCst);
            anyhow::bail!("state commit failed; restart for reconciliation");
        }
        *guard = candidate;
        self.notify.notify_waiters();
        Ok(value)
    }
    pub fn accept(&self, request: Command) -> Result<Uuid, PublicError> {
        commands::validate(&request)?;
        let mut guard = self.state.lock().map_err(|_| unavailable())?;
        if let Some(existing) = guard
            .operations
            .iter()
            .find(|v| v.request.command_id == request.command_id)
        {
            return if existing.request.command == request.command
                && existing.request.input == request.input
            {
                Ok(existing.public.id)
            } else {
                Err(PublicError::new(
                    "command_conflict",
                    "This command ID was already used with different input.",
                ))
            };
        }
        if !self.ready.load(Ordering::SeqCst) {
            return Err(unavailable());
        }
        let mut candidate = guard.clone();
        let id = request.command_id;
        let operation = Operation {
            id,
            command: request.command.clone(),
            status: OperationStatus::Queued,
            result: None,
            error: None,
        };
        candidate.operations.push(OperationRecord {
            public: operation.clone(),
            request,
        });
        candidate.event("operation.queued", json!(operation));
        if self.vault.save("application.cbor", &candidate).is_err() {
            self.ready.store(false, Ordering::SeqCst);
            return Err(unavailable());
        }
        *guard = candidate;
        self.notify.notify_one();
        Ok(id)
    }
}
fn unavailable() -> PublicError {
    PublicError::new(
        "unavailable",
        "The environment is unavailable; restart it to reconcile persistent state.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(path: &std::path::Path) -> Config {
        Config {
            environment_id: Uuid::new_v4(),
            data_dir: path.into(),
            key: zeroize::Zeroizing::new([9; 32]),
            token: zeroize::Zeroizing::new("a".repeat(64)),
            listen: "127.0.0.1:0".into(),
        }
    }
    #[test]
    fn acceptance_is_durable_and_duplicate_payload_cannot_change() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let repo = Repository::open(&config).unwrap();
        repo.ready.store(true, Ordering::SeqCst);
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "participant.create".into(),
            input: json!({"name":"Alice"}),
        };
        let id = repo.accept(command.clone()).ok().unwrap();
        assert_eq!(repo.accept(command.clone()).ok().unwrap(), id);
        let mut conflicting = command.clone();
        conflicting.input = json!({"name":"Bob"});
        assert_eq!(
            repo.accept(conflicting).err().unwrap().code,
            "command_conflict"
        );
        drop(repo);
        let reopened = Repository::open(&config).unwrap();
        assert_eq!(reopened.accept(command).ok().unwrap(), id);
        let state = reopened.snapshot().unwrap();
        assert_eq!(state.operations.len(), 1);
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.events[0].sequence, 1);
    }
    #[test]
    fn environment_identity_binding_rejects_copied_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = config(dir.path());
        drop(Repository::open(&config).unwrap());
        config.environment_id = Uuid::new_v4();
        assert!(Repository::open(&config).is_err());
    }
    #[test]
    fn failed_acceptance_blocks_environment_and_preserves_memory() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let repo = Repository::open(&config).unwrap();
        repo.ready.store(true, Ordering::SeqCst);
        std::fs::remove_file(dir.path().join("application.cbor")).unwrap();
        std::fs::create_dir(dir.path().join("application.cbor")).unwrap();
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "preset.create".into(),
            input: json!({}),
        };
        assert!(repo.accept(command.clone()).is_err());
        assert!(!repo.ready.load(Ordering::SeqCst));
        assert!(repo.snapshot().unwrap().operations.is_empty());
        std::fs::remove_dir(dir.path().join("application.cbor")).unwrap();
        assert!(repo.accept(command).is_err());
    }
    #[test]
    fn public_state_never_serializes_owner_secrets() {
        let mut state = AppState::new(Uuid::new_v4());
        state.participants.push(OwnerRecord {
            public: Participant {
                id: Uuid::new_v4(),
                name: "Alice".into(),
                public_key: "public".into(),
            },
            secret: [42; 32],
            registered: true,
        });
        let public = serde_json::to_string(&state.public(true)).unwrap();
        assert!(!public.contains("secret"));
        assert!(!public.contains("registered"));
        assert!(public.contains("publicKey"));
    }
}
