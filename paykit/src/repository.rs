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
    pub transfers: crate::backup::TransferRegistry,
}
impl Repository {
    pub fn open(config: &Config) -> anyhow::Result<Self> {
        crate::backup::recover_restore_transaction(config)?;
        let vault = Vault::new(
            config.data_dir.clone(),
            *config.key,
            config.environment_id.to_string(),
        )?;
        let lock = vault.lock("environment.lock")?;
        let mut state: AppState = vault
            .load("application.cbor")?
            .unwrap_or_else(|| AppState::new(config.environment_id));
        anyhow::ensure!(
            state.environment_id == config.environment_id,
            "environment identity mismatch"
        );
        state.compact_events();
        vault.save("application.cbor", &state)?;
        Ok(Self {
            state: Mutex::new(state),
            vault,
            _lock: lock,
            ready: AtomicBool::new(false),
            notify: Notify::new(),
            transfers: crate::backup::TransferRegistry::default(),
        })
    }
    pub fn snapshot(&self) -> anyhow::Result<AppState> {
        Ok(self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("state unavailable"))?
            .clone())
    }
    pub fn public_state(&self) -> anyhow::Result<PublicState> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("state unavailable"))?;
        Ok(state.public(self.ready.load(Ordering::SeqCst)))
    }
    pub fn events_after(&self, cursor: u64) -> Result<Vec<Event>, PublicError> {
        self.state
            .lock()
            .map_err(|_| unavailable())?
            .events_after(cursor)
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
    fn avatar_workspace(id: Uuid) -> crate::workspace_model::Workspace {
        crate::workspace_model::Workspace {
            receiver_id: id,
            links: vec![crate::workspace_model::LinkView {
                peer_public_key: "public-peer".into(),
                peer_receiver_path: "peer/wallet".into(),
                state: "linked".into(),
                generation: 0,
                handshake_role: None,
                recovery_preparation: None,
                last_sync_at: None,
                last_receive_at: None,
                failure_count: 0,
                pending_messages: 0,
                latest_received_list_id: None,
                last_sent_message_id: None,
                last_error: None,
            }],
            profile: Some(crate::workspace_model::ProfileView {
                peer_public_key: "public-owner".into(),
                peer_receiver_path: "test/wallet".into(),
                display_name: "Alice".into(),
                about: "A retained current profile".into(),
                image_uri: Some("pubky://public-owner/pub/test/wallet/avatar".into()),
                avatar_data_url: Some(format!("data:image/png;base64,{}", "A".repeat(16_000))),
                path: "profile".into(),
                updated_at: "2026-09-10T00:00:00Z".into(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn idle_workspace_history_plateaus_without_losing_current_state_or_command_intent() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let repo = Repository::open(&config).unwrap();
        repo.ready.store(true, Ordering::SeqCst);
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "participant.create".into(),
            input: json!({"name":"Alice"}),
        };
        let operation_id = repo.accept(command.clone()).unwrap();
        let mut workspace = avatar_workspace(Uuid::new_v4());
        let mut retained_sizes = vec![];
        for tick in 0..EVENT_RETENTION * 3 {
            workspace.updated_at = Some(format!("idle-poll-{tick:08}"));
            workspace.links[0].generation = tick as u64;
            workspace.links[0]
                .last_sync_at
                .clone_from(&workspace.updated_at);
            repo.update(|state| {
                state.set_workspace(workspace.clone());
                Ok(())
            })
            .unwrap();
            let state = repo.snapshot().unwrap();
            assert!(state.events.len() <= EVENT_RETENTION);
            assert!(state
                .events
                .iter()
                .filter(|event| event.event_type == "receiver.workspace")
                .all(|event| event.payload == json!({"receiverId":workspace.receiver_id})));
            if tick >= EVENT_RETENTION {
                retained_sizes.push(
                    std::fs::metadata(dir.path().join("application.cbor"))
                        .unwrap()
                        .len(),
                );
            }
        }
        let min = retained_sizes.iter().min().unwrap();
        let max = retained_sizes.iter().max().unwrap();
        assert!(max - min < 1024, "idle history must plateau: {min}..{max}");
        assert!(
            *max < 64_000,
            "history must not multiply the avatar payload"
        );
        let sequence = repo.public_state().unwrap().last_event_sequence;
        assert_eq!(sequence, (EVENT_RETENTION * 3 + 1) as u64);
        assert_eq!(
            serde_json::to_value(&repo.public_state().unwrap().receiver_workspaces[0]).unwrap(),
            serde_json::to_value(&workspace).unwrap()
        );
        drop(repo);

        let reopened = Repository::open(&config).unwrap();
        assert_eq!(reopened.accept(command).unwrap(), operation_id);
        assert_eq!(reopened.snapshot().unwrap().operations.len(), 1);
        assert_eq!(
            reopened.public_state().unwrap().last_event_sequence,
            sequence
        );
        assert_eq!(
            serde_json::to_value(&reopened.public_state().unwrap().receiver_workspaces[0]).unwrap(),
            serde_json::to_value(workspace).unwrap()
        );
        reopened
            .update(|state| {
                state.event("environment.ready", json!({}));
                Ok(())
            })
            .unwrap();
        assert_eq!(
            reopened.events_after(sequence).unwrap()[0].sequence,
            sequence + 1
        );
    }

    #[test]
    fn old_snapshot_compaction_preserves_counter_and_full_latest_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let config = config(dir.path());
        let mut state = AppState::new(config.environment_id);
        let workspace = avatar_workspace(Uuid::new_v4());
        state.receiver_workspaces.push(workspace.clone());
        state.events = (1..=EVENT_RETENTION + 20)
            .map(|sequence| Event {
                sequence: sequence as u64 + 1000,
                event_type: "receiver.workspace".into(),
                payload: json!(workspace),
            })
            .collect();
        let mut bytes = vec![];
        ciborium::into_writer(&state, &mut bytes).unwrap();
        let mut legacy: ciborium::Value = ciborium::from_reader(bytes.as_slice()).unwrap();
        let ciborium::Value::Map(fields) = &mut legacy else {
            panic!("expected state map")
        };
        fields.retain(|(key, _)| key != &ciborium::Value::Text("last_event_sequence".into()));
        let vault = Vault::new(
            config.data_dir.clone(),
            *config.key,
            config.environment_id.to_string(),
        )
        .unwrap();
        vault.save("application.cbor", &legacy).unwrap();
        let before = std::fs::metadata(dir.path().join("application.cbor"))
            .unwrap()
            .len();
        let repo = Repository::open(&config).unwrap();
        let migrated = repo.snapshot().unwrap();
        assert_eq!(migrated.events.len(), EVENT_RETENTION);
        assert_eq!(migrated.last_event_sequence, 1276);
        assert_eq!(migrated.events[0].sequence, 1021);
        assert!(migrated
            .events
            .iter()
            .all(|event| event.payload == json!({"receiverId":workspace.receiver_id})));
        assert_eq!(
            serde_json::to_value(&migrated.receiver_workspaces[0]).unwrap(),
            json!(workspace)
        );
        assert!(
            std::fs::metadata(dir.path().join("application.cbor"))
                .unwrap()
                .len()
                < before / 10
        );
        drop(repo);
        let reopened = Repository::open(&config).unwrap();
        assert_eq!(reopened.events_after(1020).unwrap().len(), EVENT_RETENTION);
        assert_eq!(
            reopened.events_after(1019).err().unwrap().code,
            "event_cursor_reset"
        );
        reopened
            .update(|state| {
                state.event("environment.ready", json!({}));
                Ok(())
            })
            .unwrap();
        assert_eq!(reopened.events_after(1276).unwrap()[0].sequence, 1277);
    }
}
