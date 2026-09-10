//! Versioned public protocol and private persisted workbench records.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

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
            last_event_sequence: self.events.last().map_or(0, |v| v.sequence),
        }
    }
    pub fn event(&mut self, event_type: &str, payload: Value) {
        self.events.push(Event {
            sequence: self.events.last().map_or(1, |v| v.sequence + 1),
            event_type: event_type.into(),
            payload,
        });
    }
}

impl std::fmt::Display for PublicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for PublicError {}
