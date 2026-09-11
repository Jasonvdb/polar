//! Versioned public protocol and private persisted workbench records.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const EVENT_RETENTION: usize = 256;
pub const STATE_OPERATION_RETENTION: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub command_id: Uuid,
    pub command: String,
    pub input: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: Uuid,
    pub name: String,
    pub public_key: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receiver {
    pub id: Uuid,
    pub participant_id: Uuid,
    pub name: String,
    pub path: String,
    pub status: ReceiverStatus,
    pub generation: u64,
    pub noise_public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiverStatus {
    Stopped,
    Starting,
    Running,
    Error,
}
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PublicError {
    pub code: String,
    pub message: String,
}
impl PublicError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Operation {
    pub id: Uuid,
    pub command: String,
    pub status: OperationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PublicError>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicState {
    #[serde(default)]
    pub funding: crate::request_model::FundingView,
    pub receiver_workspaces: Vec<crate::workspace_model::Workspace>,
    pub api_version: u8,
    pub environment_id: Uuid,
    pub ready: bool,
    pub participants: Vec<Participant>,
    pub receivers: Vec<Receiver>,
    pub operations: Vec<Operation>,
    pub last_event_sequence: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OwnerRecord {
    pub public: Participant,
    pub secret: [u8; 32],
    pub registered: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct ReceiverRecord {
    pub public: Receiver,
    pub desired_running: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OperationRecord {
    pub public: Operation,
    pub request: Command,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct AppState {
    #[serde(default)]
    pub funding: crate::request_model::FundingView,
    #[serde(default)]
    pub receiver_workspaces: Vec<crate::workspace_model::Workspace>,
    pub environment_id: Uuid,
    pub participants: Vec<OwnerRecord>,
    pub receivers: Vec<ReceiverRecord>,
    pub operations: Vec<OperationRecord>,
    pub events: Vec<Event>,
    #[serde(default)]
    pub last_event_sequence: u64,
}
impl AppState {
    pub fn new(environment_id: Uuid) -> Self {
        Self {
            environment_id,
            funding: crate::request_model::FundingView::default(),
            receiver_workspaces: vec![],
            participants: vec![],
            receivers: vec![],
            operations: vec![],
            events: vec![],
            last_event_sequence: 0,
        }
    }
    pub fn public(&self, ready: bool) -> PublicState {
        let terminal_count = self
            .operations
            .iter()
            .filter(|value| {
                matches!(
                    value.public.status,
                    OperationStatus::Succeeded | OperationStatus::Failed
                )
            })
            .count();
        let skip_terminal = terminal_count.saturating_sub(STATE_OPERATION_RETENTION);
        let mut terminal_index = 0;
        let operations = self
            .operations
            .iter()
            .filter_map(|value| {
                let terminal = matches!(
                    value.public.status,
                    OperationStatus::Succeeded | OperationStatus::Failed
                );
                let include = !terminal || terminal_index >= skip_terminal;
                terminal_index += usize::from(terminal);
                include.then(|| Operation {
                    id: value.public.id,
                    command: value.public.command.clone(),
                    status: value.public.status,
                    result: None,
                    error: value.public.error.clone(),
                })
            })
            .collect();
        PublicState {
            api_version: 1,
            funding: self.funding.clone(),
            receiver_workspaces: self.receiver_workspaces.clone(),
            environment_id: self.environment_id,
            ready,
            participants: self.participants.iter().map(|v| v.public.clone()).collect(),
            receivers: self.receivers.iter().map(|v| v.public.clone()).collect(),
            operations,
            last_event_sequence: self.last_event_sequence,
        }
    }
    pub fn compact_events(&mut self) {
        self.last_event_sequence = self
            .last_event_sequence
            .max(self.events.last().map_or(0, |event| event.sequence));
        self.events
            .drain(..self.events.len().saturating_sub(EVENT_RETENTION));
        for event in &mut self.events {
            if event.event_type == "receiver.workspace" {
                event.payload = serde_json::json!({"receiverId": event.payload["receiverId"]});
            }
        }
    }
    pub fn events_after(&self, cursor: u64) -> Result<Vec<Event>, PublicError> {
        let oldest_cursor = self
            .events
            .first()
            .map_or(self.last_event_sequence, |event| {
                event.sequence.saturating_sub(1)
            });
        if cursor < oldest_cursor || cursor > self.last_event_sequence {
            return Err(PublicError::new(
                "event_cursor_reset",
                "The cursor is outside retained history. Reload /v1/state and reconnect using lastEventSequence.",
            ));
        }
        Ok(self
            .events
            .iter()
            .filter(|event| event.sequence > cursor)
            .cloned()
            .collect())
    }
    pub fn set_workspace(&mut self, workspace: crate::workspace_model::Workspace) {
        let id = workspace.receiver_id;
        self.receiver_workspaces
            .retain(|value| value.receiver_id != id);
        self.receiver_workspaces.push(workspace);
        self.event("receiver.workspace", serde_json::json!({"receiverId": id}));
    }
    pub fn event(&mut self, event_type: &str, payload: Value) {
        self.last_event_sequence = self
            .last_event_sequence
            .checked_add(1)
            .expect("environment event sequence exhausted");
        self.events.push(Event {
            sequence: self.last_event_sequence,
            event_type: event_type.into(),
            payload,
        });
        self.events
            .drain(..self.events.len().saturating_sub(EVENT_RETENTION));
    }
}

impl std::fmt::Display for PublicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for PublicError {}

#[cfg(test)]
mod funding_migration_tests {
    use super::*;
    #[test]
    fn legacy_application_snapshot_projects_not_started_funding() {
        let environment = Uuid::new_v4();
        let state = AppState::new(environment);
        let mut legacy = ciborium::value::Value::serialized(&state).unwrap();
        legacy
            .as_map_mut()
            .unwrap()
            .retain(|(key, _)| key.as_text() != Some("funding"));
        let mut encoded = Vec::new();
        ciborium::into_writer(&legacy, &mut encoded).unwrap();
        let recovered: AppState = ciborium::from_reader(encoded.as_slice()).unwrap();
        assert_eq!(recovered.environment_id, environment);
        assert_eq!(recovered.funding.status, "notStarted");
        assert!(!recovered.funding.funded);
        let public = serde_json::to_value(recovered.public(true)).unwrap();
        assert_eq!(public["funding"]["status"], "notStarted");
        assert_eq!(public["funding"]["funded"], false);
    }

    #[test]
    fn public_state_retains_active_and_recent_terminal_operation_summaries() {
        let mut state = AppState::new(Uuid::new_v4());
        let active_ids = [Uuid::new_v4(), Uuid::new_v4()];
        let terminal_ids: Vec<_> = (0..STATE_OPERATION_RETENTION + 2)
            .map(|_| Uuid::new_v4())
            .collect();
        state
            .operations
            .push(operation(active_ids[0], OperationStatus::Running));
        state
            .operations
            .push(operation(active_ids[1], OperationStatus::Queued));
        state.operations.extend(
            terminal_ids
                .iter()
                .map(|id| operation(*id, OperationStatus::Succeeded)),
        );

        let public = state.public(true);

        assert_eq!(public.operations.len(), STATE_OPERATION_RETENTION + 2);
        assert_eq!(public.operations[0].id, active_ids[0]);
        assert_eq!(public.operations[1].id, active_ids[1]);
        assert_eq!(public.operations[2].id, terminal_ids[2]);
        assert!(public.operations.iter().all(|value| value.result.is_none()));
        assert!(public.operations.iter().all(|value| value.error.is_some()));
        assert!(state
            .operations
            .iter()
            .all(|value| value.public.result.is_some()));
    }

    fn operation(id: Uuid, status: OperationStatus) -> OperationRecord {
        OperationRecord {
            public: Operation {
                id,
                command: "test.command".into(),
                status,
                result: Some(serde_json::json!({"workspace":"durable"})),
                error: Some(PublicError::new("test", "Retained public error")),
            },
            request: Command {
                command_id: id,
                command: "test.command".into(),
                input: serde_json::json!({}),
            },
        }
    }
}
