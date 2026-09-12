//! Strictly allowlisted diagnostics derived from the public API projection.

use crate::{
    interfaces,
    model::{OperationStatus, PublicState, ReceiverStatus},
};
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub api_version: u8,
    pub environment_id: Uuid,
    pub ready: bool,
    pub funding_status: &'static str,
    pub receivers: Vec<ReceiverDiagnostic>,
    pub operations: Vec<OperationDiagnostic>,
    pub last_event_sequence: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiverDiagnostic {
    pub id: Uuid,
    pub status: ReceiverStatus,
    pub generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationDiagnostic {
    pub id: Uuid,
    pub command: &'static str,
    pub status: OperationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}

pub fn build(state: &PublicState) -> Diagnostics {
    Diagnostics {
        api_version: state.api_version,
        environment_id: state.environment_id,
        ready: state.ready,
        funding_status: funding_status(&state.funding.status),
        receivers: state.receivers.iter().map(receiver).collect(),
        operations: state.operations.iter().map(operation).collect(),
        last_event_sequence: state.last_event_sequence,
    }
}

fn receiver(value: &crate::model::Receiver) -> ReceiverDiagnostic {
    ReceiverDiagnostic {
        id: value.id,
        status: value.status,
        generation: value.generation,
    }
}

fn operation(value: &crate::model::Operation) -> OperationDiagnostic {
    OperationDiagnostic {
        id: value.id,
        command: interfaces::command_spec(&value.command).map_or("unknown", |spec| spec.id),
        status: value.status,
        error_code: value
            .error
            .as_ref()
            .map(|error| safe_error_code(&error.code)),
    }
}

fn funding_status(value: &str) -> &'static str {
    match value {
        "notStarted" => "notStarted",
        "running" => "running",
        "ready" => "ready",
        "failed" => "failed",
        "uncertain" => "uncertain",
        _ => "unavailable",
    }
}

fn safe_error_code(value: &str) -> &'static str {
    match value {
        "invalid_input" => "invalid_input",
        "unsupported_command" => "unsupported_command",
        "command_conflict" => "command_conflict",
        "unavailable" => "unavailable",
        "reconciliation_required" => "reconciliation_required",
        "not_found" => "not_found",
        "conflict" => "conflict",
        "expired" => "expired",
        _ => "unavailable",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Operation, PublicError};

    #[test]
    fn diagnostics_drop_free_form_and_unknown_values() {
        let mut state = crate::model::AppState::new(Uuid::new_v4()).public(true);
        state.funding.status = "/private/secret".into();
        state.operations.push(Operation {
            id: Uuid::new_v4(),
            command: "secret.command".into(),
            status: OperationStatus::Failed,
            result: Some(serde_json::json!({"preimage":"sentinel"})),
            error: Some(PublicError::new("/secret/code", "/private/path sentinel")),
        });
        let json = serde_json::to_string(&build(&state)).unwrap();
        assert!(!json.contains("sentinel"));
        assert!(!json.contains("/private"));
        assert!(!json.contains("secret.command"));
        assert!(json.contains("\"command\":\"unknown\""));
        assert!(json.contains("\"fundingStatus\":\"unavailable\""));
        assert!(json.contains("\"errorCode\":\"unavailable\""));
    }
}
