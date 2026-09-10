//! Versioned public protocol and private persisted workbench records.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const EVENT_RETENTION: usize = 256;

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
            receiver_workspaces: vec![],
            participants: vec![],
            receivers: vec![],
            operations: vec![],
            events: vec![],
            last_event_sequence: 0,
        }
    }
    pub fn public(&self, ready: bool) -> PublicState {
        PublicState {
            api_version: 1,
            receiver_workspaces: self.receiver_workspaces.clone(),
            environment_id: self.environment_id,
            ready,
            participants: self.participants.iter().map(|v| v.public.clone()).collect(),
            receivers: self.receivers.iter().map(|v| v.public.clone()).collect(),
            operations: self.operations.iter().map(|v| v.public.clone()).collect(),
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
