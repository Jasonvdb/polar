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
#[cfg(test)]
mod tests {
    use super::*;
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
