//! Validated command inputs; rejected requests never enter the durable queue.
use crate::model::{Command, PublicError};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NameInput {
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParticipantName {
    pub participant_id: Uuid,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiverName {
    pub receiver_id: Uuid,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiverId {
    pub receiver_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateReceiver {
    pub participant_id: Uuid,
    pub name: String,
    pub kind: ReceiverKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiverKind {
    Wallet,
    Server,
}
impl ReceiverKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Wallet => "wallet",
            Self::Server => "server",
        }
    }
}

pub fn validate(command: &Command) -> Result<(), PublicError> {
    if command.command_id.is_nil() {
        return Err(invalid());
    }
    match command.command.as_str() {
        "participant.create" => name(&parse::<NameInput>(command)?.name),
        "participant.rename" => name(&parse::<ParticipantName>(command)?.name),
        "receiver.create" => name(&parse::<CreateReceiver>(command)?.name),
        "receiver.rename" => name(&parse::<ReceiverName>(command)?.name),
        "receiver.start" | "receiver.stop" | "receiver.restart" => {
            parse::<ReceiverId>(command)?;
            Ok(())
        }
        "preset.create" if command.input == serde_json::json!({}) => Ok(()),
        _ => Err(PublicError::new(
            "unsupported_command",
            "This command is not supported by API v1.",
        )),
    }
}
pub fn parse<T: serde::de::DeserializeOwned>(command: &Command) -> Result<T, PublicError> {
    serde_json::from_value(command.input.clone()).map_err(|_| invalid())
}
fn name(value: &str) -> Result<(), PublicError> {
    if value.trim().is_empty() || value.len() > 80 || value.chars().any(char::is_control) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn invalid() -> PublicError {
    PublicError::new(
        "invalid_input",
        "Check the command identifier and input fields.",
    )
}

/// Replay is deliberately limited to these idempotent environment commands.
/// Payment execution commands must provide independent settlement reconciliation.
pub fn reconcile_interrupted(state: &mut crate::model::AppState) -> anyhow::Result<()> {
    use crate::model::{OperationStatus, PublicError};
    let mut requeued = vec![];
    for operation in &mut state.operations {
        if operation.public.status != OperationStatus::Running {
            continue;
        }
        let replay_safe = matches!(
            operation.request.command.as_str(),
            "participant.create"
                | "participant.rename"
                | "receiver.create"
                | "receiver.rename"
                | "receiver.start"
                | "receiver.stop"
                | "receiver.restart"
                | "preset.create"
        );
        if replay_safe && validate(&operation.request).is_ok() {
            operation.public.status = OperationStatus::Queued;
            operation.public.error = None;
            requeued.push(operation.public.clone());
        } else {
            operation.public.status = OperationStatus::Failed;
            operation.public.error = Some(PublicError::new(
                "reconciliation_required",
                "This operation requires manual recovery.",
            ));
        }
    }
    for operation in requeued {
        state.event("operation.requeued", serde_json::json!(operation));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_names_and_unknown_secret_fields_rejected() {
        for input in [
            serde_json::json!({"name":" "}),
            serde_json::json!({"name":"Alice","secret":"forbidden"}),
        ] {
            assert!(validate(&Command {
                command_id: Uuid::new_v4(),
                command: "participant.create".into(),
                input
            })
            .is_err());
        }
    }
    #[test]
    fn interrupted_environment_commands_requeue_but_future_payments_do_not() {
        use crate::model::*;
        let mut state = AppState::new(Uuid::new_v4());
        for (command, status) in [
            ("preset.create", OperationStatus::Running),
            ("payment.execute", OperationStatus::Running),
            ("preset.create", OperationStatus::Succeeded),
        ] {
            let id = Uuid::new_v4();
            state.operations.push(OperationRecord {
                public: Operation {
                    id,
                    command: command.into(),
                    status,
                    result: None,
                    error: None,
                },
                request: Command {
                    command_id: id,
                    command: command.into(),
                    input: serde_json::json!({}),
                },
            });
        }
        reconcile_interrupted(&mut state).unwrap();
        assert!(state.operations[0].public.status == OperationStatus::Queued);
        assert!(state.operations[1].public.status == OperationStatus::Failed);
        assert!(state.operations[2].public.status == OperationStatus::Succeeded);
        assert_eq!(state.events.len(), 1);
        assert_eq!(state.events[0].event_type, "operation.requeued");
    }
}
