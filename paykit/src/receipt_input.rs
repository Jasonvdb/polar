//! Strict receipt commands; secrets and arbitrary retrieval locations are never inputs.
use crate::{
    commands,
    model::{Command, PublicError},
};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepare {
    pub receiver_id: Uuid,
    pub request_id: Uuid,
    pub proof_id: Uuid,
    #[serde(default)]
    pub note: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Process {
    pub receiver_id: Uuid,
    pub receipt_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retrieve {
    pub receiver_id: Uuid,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub receipt_id: Uuid,
}
pub fn is_command(name: &str) -> bool {
    matches!(
        name,
        "receipt.prepare" | "receipt.process" | "receipt.retrieve"
    )
}
pub fn text_valid(text: &str, empty: bool) -> bool {
    (empty || !text.trim().is_empty()) && text.len() <= 500 && !text.chars().any(char::is_control)
}
pub fn validate(command: &Command) -> Result<(), PublicError> {
    validate_inner(command).map_err(|_| PublicError::new("invalid_input", "Check receipt identifiers and note (at most 500 UTF-8 bytes, without control characters)."))
}
fn validate_inner(c: &Command) -> anyhow::Result<()> {
    for key in ["receiverId", "requestId", "proofId", "receiptId"] {
        if let Some(value) = c.input.get(key) {
            let text = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid identifier"))?;
            let id = Uuid::parse_str(text)?;
            anyhow::ensure!(
                !id.is_nil() && id.to_string() == text,
                "noncanonical identifier"
            );
            match key {
                "requestId" => {
                    paykit_lib::PaymentRequestId::new(text)?;
                }
                "proofId" => {
                    paykit_lib::EventId::new(text)?;
                }
                "receiptId" => {
                    paykit_lib::ReceiptId::new(text)?;
                }
                _ => {}
            }
        }
    }

    let ids = match c.command.as_str() {
        "receipt.prepare" => {
            let i: Prepare = serde_json::from_value(c.input.clone())?;
            anyhow::ensure!(text_valid(&i.note, true), "invalid note");
            vec![i.receiver_id, i.request_id, i.proof_id]
        }
        "receipt.process" => {
            let i: Process = serde_json::from_value(c.input.clone())?;
            vec![i.receiver_id, i.receipt_id]
        }
        "receipt.retrieve" => {
            let i: Retrieve = serde_json::from_value(c.input.clone())?;
            commands::public_key(&i.peer_public_key)
                .map_err(|_| anyhow::anyhow!("invalid peer"))?;
            paykit_sdk::PaykitReceiverPath::new(i.peer_receiver_path)?;
            vec![i.receiver_id, i.receipt_id]
        }
        _ => anyhow::bail!("unknown receipt command"),
    };
    anyhow::ensure!(ids.iter().all(|id| !id.is_nil()), "nil receipt identifier");
    Ok(())
}
