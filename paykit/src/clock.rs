//! Receiver-scoped application time, independent of Bitcoin and invoice clocks.
use crate::{recurrence, storage::Vault};
use chrono::{DateTime, Utc};
use paykit_sdk::Clock;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
#[derive(Clone, Default, Serialize, Deserialize)]
struct State {
    controlled: Option<DateTime<Utc>>,
}
#[derive(Clone, Default)]
pub struct ApplicationClock {
    state: Arc<RwLock<State>>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockView {
    pub mode: String,
    pub now: String,
}
impl Clock for ApplicationClock {
    fn now(&self) -> DateTime<Utc> {
        self.state
            .read()
            .expect("clock lock")
            .controlled
            .unwrap_or_else(Utc::now)
    }
}
impl ApplicationClock {
    pub fn open(vault: &Vault) -> anyhow::Result<Self> {
        Ok(Self {
            state: Arc::new(RwLock::new(vault.load("clock.cbor")?.unwrap_or_default())),
        })
    }
    pub fn set(&self, vault: &Vault, value: Option<&str>) -> anyhow::Result<()> {
        let current = self.now();
        let next = value.map(recurrence::timestamp).transpose()?;
        anyhow::ensure!(next.unwrap_or_else(Utc::now) >= current, "Application time cannot move backwards. Keep the controlled clock or wait for system time to catch up.");
        let state = State { controlled: next };
        vault.save("clock.cbor", &state)?;
        *self
            .state
            .write()
            .map_err(|_| anyhow::anyhow!("clock unavailable"))? = state;
        Ok(())
    }
    pub fn view(&self) -> ClockView {
        ClockView {
            mode: if self.state.read().expect("clock lock").controlled.is_some() {
                "controlled"
            } else {
                "system"
            }
            .into(),
            now: recurrence::text(self.now()),
        }
    }
}
/// SDK bookkeeping time is causal within the unchanged application UTC second.
#[derive(Clone)]
pub struct SdkEventClock {
    application: ApplicationClock,
    logical: Arc<std::sync::Mutex<LogicalTime>>,
}
struct LogicalTime {
    last: Option<DateTime<Utc>>,
    failed: bool,
}
impl SdkEventClock {
    pub(crate) fn new(
        application: ApplicationClock,
        state: &paykit_sdk::storage::StorageState,
    ) -> Self {
        Self {
            application,
            logical: Arc::new(std::sync::Mutex::new(LogicalTime {
                last: observation_watermark(state),
                failed: false,
            })),
        }
    }
    pub(crate) fn ensure_valid(&self) -> paykit_sdk::Result<()> {
        let mut state = self.logical.lock().map_err(|_| event_clock_error())?;
        if state
            .last
            .is_some_and(|last| self.application.now().timestamp() < last.timestamp())
        {
            state.failed = true;
        }
        if state.failed {
            Err(event_clock_error())
        } else {
            Ok(())
        }
    }
    fn serialized_now(&self, before_lock: impl FnOnce()) -> DateTime<Utc> {
        before_lock();
        let Ok(mut state) = self.logical.lock() else {
            return self.application.now();
        };
        let now = self.application.now();
        if state.failed {
            return state.last.unwrap_or(now);
        }
        let next = match state.last {
            Some(last) if last >= now => last.checked_add_signed(chrono::Duration::nanoseconds(1)),
            _ => Some(now),
        };
        match next.filter(|next| next.timestamp() == now.timestamp()) {
            Some(next) => {
                state.last = Some(next);
                next
            }
            None => {
                state.failed = true;
                state.last.unwrap_or(now)
            }
        }
    }
}
impl Clock for SdkEventClock {
    fn now(&self) -> DateTime<Utc> {
        self.serialized_now(|| {})
    }
}
fn event_clock_error() -> paykit_sdk::PaykitSdkError {
    paykit_sdk::PaykitSdkError::Storage {
        context: "SDK event time requires a later application second and receiver restart".into(),
        source: None,
    }
}
fn observation_watermark(state: &paykit_sdk::storage::StorageState) -> Option<DateTime<Utc>> {
    let mut times = vec![];
    times.extend(state.identity_state.as_ref().map(|r| r.initialized_at));
    for r in state.linked_peers.values() {
        times.extend(
            [
                r.last_sync_at,
                r.last_private_receive_at,
                r.local_recovery_marker_created_at,
                r.remote_recovery_marker_observed_at,
            ]
            .into_iter()
            .flatten(),
        );
    }
    for r in state.contact_records.values() {
        times.extend(
            [
                Some(r.created_at),
                Some(r.updated_at),
                r.profile_fetched_at,
                r.public_contact_published_at,
                r.public_contact_removed_at,
            ]
            .into_iter()
            .flatten(),
        );
    }
    times.extend(state.public_endpoint_records.values().map(|r| r.updated_at));
    for r in state.payment_endpoint_reservations.values() {
        times.push(r.created_at);
        times.extend(r.cancellation_started_at);
    }
    times.extend(
        state
            .encrypted_link_states
            .values()
            .map(|r| r.checkpointed_at),
    );
    times.extend(
        state
            .peer_link_operation_leases
            .values()
            .map(|r| r.claimed_at),
    );
    for r in &state.outbound_private_messages {
        times.extend(
            [
                Some(r.created_at),
                Some(r.updated_at),
                r.last_attempt_at,
                r.sent_at,
            ]
            .into_iter()
            .flatten(),
        );
    }
    times.extend(state.private_stream_items.iter().map(|r| r.received_at));
    for r in state.receipt_access_records.values() {
        times.extend(
            [
                Some(r.received_at),
                r.retrieval_attempted_at,
                r.retrieved_at,
            ]
            .into_iter()
            .flatten(),
        );
    }
    times.extend(state.receipt_records.values().map(|r| r.retrieved_at));
    for r in state.receipt_issuance_records.values() {
        times.extend(
            [
                Some(r.created_at),
                Some(r.updated_at),
                r.stored_at,
                r.access_queued_at,
            ]
            .into_iter()
            .flatten(),
        );
    }
    times.into_iter().max()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sdk_observation_time_preserves_application_second_and_deadlines() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into(), [33; 32], "event-clock".into()).unwrap();
        let app = ApplicationClock::open(&vault).unwrap();
        app.set(&vault, Some("2090-01-01T00:00:00Z")).unwrap();
        let state = paykit_sdk::storage::StorageState::default();
        let sdk = SdkEventClock::new(app.clone(), &state);
        let before = std::fs::read(dir.path().join("clock.cbor")).unwrap();
        assert_eq!(sdk.now(), app.now());
        for _ in 0..100 {
            assert_eq!(sdk.now().timestamp(), app.now().timestamp());
        }
        assert_eq!(app.view().now, "2090-01-01T00:00:00Z");
        assert_eq!(
            std::fs::read(dir.path().join("clock.cbor")).unwrap(),
            before
        );
        assert!(app.set(&vault, Some("2089-12-31T23:59:59Z")).is_err());
        assert!(app.set(&vault, None).is_err());
        sdk.ensure_valid().unwrap();
        app.set(&vault, Some("2090-01-01T00:00:01Z")).unwrap();
        assert_eq!(sdk.now(), app.now());
        let future = paykit_sdk::storage::StorageState {
            identity_state: Some(paykit_sdk::IdentityState {
                local_pubky_public_key: None,
                local_receiver_noise_public_key: None,
                initialized_at: app.now() + chrono::Duration::seconds(1),
                sign_out_generation: 0,
            }),
            ..Default::default()
        };
        let backwards = SdkEventClock::new(app.clone(), &future);
        assert!(backwards.ensure_valid().is_err());
        assert!(backwards.ensure_valid().is_err());
    }
    #[test]
    fn live_clock_sample_is_taken_after_serializing_concurrent_event_time() {
        let directory = tempfile::tempdir().unwrap();
        let vault =
            Vault::new(directory.path().into(), [44; 32], "serialized-clock".into()).unwrap();
        let application = ApplicationClock::open(&vault).unwrap();
        application
            .set(&vault, Some("2090-01-01T00:00:00Z"))
            .unwrap();
        let advanced_second = recurrence::timestamp("2090-01-01T00:00:01Z").unwrap();
        let sdk = SdkEventClock::new(application.clone(), &Default::default());
        let mut logical = sdk.logical.lock().unwrap();
        let (reached_lock, waiting) = std::sync::mpsc::channel();
        let concurrent = sdk.clone();
        let handle = std::thread::spawn(move || {
            concurrent.serialized_now(|| reached_lock.send(()).unwrap())
        });
        waiting.recv().unwrap();
        application
            .set(&vault, Some("2090-01-01T00:00:01Z"))
            .unwrap();
        logical.last = Some(advanced_second);
        drop(logical);
        assert_eq!(
            handle.join().unwrap(),
            advanced_second + chrono::Duration::nanoseconds(1)
        );
        assert!(sdk.ensure_valid().is_ok());
    }
    #[test]
    fn controlled_time_survives_restart_and_rejects_backwards_reset() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into(), [1; 32], "clock-test".into()).unwrap();
        let clock = ApplicationClock::open(&vault).unwrap();
        clock.set(&vault, Some("2090-01-01T00:00:00Z")).unwrap();
        assert_eq!(ApplicationClock::open(&vault).unwrap().now(), clock.now());
        assert!(clock.set(&vault, Some("2089-01-01T00:00:00Z")).is_err());
        assert!(clock.set(&vault, None).is_err());
    }
    #[test]
    fn failed_clock_commit_leaves_runtime_and_reopened_clock_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into(), [2; 32], "clock-test".into()).unwrap();
        let clock = ApplicationClock::open(&vault).unwrap();
        std::fs::create_dir(dir.path().join("clock.cbor")).unwrap();
        assert!(clock.set(&vault, Some("2090-01-01T00:00:00Z")).is_err());
        assert_eq!(clock.view().mode, "system");
        assert!(vault.save("other.cbor", &1u64).is_err());
        std::fs::remove_dir(dir.path().join("clock.cbor")).unwrap();
        assert_eq!(
            ApplicationClock::open(&vault).unwrap().view().mode,
            "system"
        );
    }
}
