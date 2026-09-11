//! Strict request and execution command inputs, before durable acceptance.
use crate::{
    model::{Command, PublicError},
    payment_model,
    request_model::Proof,
};
use serde::Deserialize;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Create {
    pub recurrence: Option<crate::recurrence::Recurrence>,
    pub receiver_id: Uuid,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub amount_sats: String,
    pub description: String,
    pub expiry_seconds: u32,
    pub accepted_methods: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub receiver_id: Uuid,
    pub request_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Execute {
    pub period_index: Option<u32>,
    pub receiver_id: Uuid,
    pub request_id: Uuid,
    pub wallet_id: String,
    pub source: String,
    pub method: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reconcile {
    pub receiver_id: Uuid,
    pub execution_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Submit {
    pub period_index: Option<u32>,
    pub receiver_id: Uuid,
    pub request_id: Uuid,
    pub execution_id: Option<Uuid>,
    pub proof: Option<Proof>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verify {
    pub receiver_id: Uuid,
    pub request_id: Uuid,
    pub proof_id: Uuid,
    #[serde(default = "one")]
    pub required_confirmations: u32,
}
fn one() -> u32 {
    1
}
pub fn is_command(name: &str) -> bool {
    matches!(
        name,
        "request.create"
            | "request.accept"
            | "request.reject"
            | "request.cancel"
            | "payment.execute"
            | "payment.reconcile"
            | "proof.submit"
            | "proof.verify"
    )
}
pub fn validate(c: &Command) -> Result<(), PublicError> {
    validate_inner(c).map_err(|_| {
        PublicError::new(
            "invalid_input",
            "Check request, wallet, exact satoshi amount and proof fields.",
        )
    })
}
fn id(id: Uuid) -> anyhow::Result<()> {
    anyhow::ensure!(!id.is_nil(), "nil identifier");
    Ok(())
}
fn parse<T: serde::de::DeserializeOwned>(c: &Command) -> anyhow::Result<T> {
    Ok(serde_json::from_value(c.input.clone())?)
}
fn validate_inner(c: &Command) -> anyhow::Result<()> {
    match c.command.as_str() {
        "request.create" => {
            let i: Create = parse(c)?;
            if let Some(r) = &i.recurrence {
                r.validate()?;
            }
            id(i.receiver_id)?;
            crate::commands::public_key(&i.peer_public_key)?;
            paykit_sdk::PaykitReceiverPath::new(i.peer_receiver_path)?;
            payment_model::sats(&i.amount_sats)?;
            payment_model::methods(&i.accepted_methods, false)?;
            anyhow::ensure!(
                (1..=604800).contains(&i.expiry_seconds)
                    && !i.description.trim().is_empty()
                    && i.description.len() <= 500
                    && !i.description.chars().any(char::is_control),
                "invalid terms"
            );
        }
        "request.accept" | "request.reject" | "request.cancel" => {
            let i: Request = parse(c)?;
            id(i.receiver_id)?;
            id(i.request_id)?;
        }
        "payment.execute" => {
            let i: Execute = parse(c)?;
            anyhow::ensure!(
                i.period_index
                    .is_none_or(|n| n <= crate::recurrence::MAX_PERIOD),
                "invalid period"
            );
            id(i.receiver_id)?;
            id(i.request_id)?;
            anyhow::ensure!(
                !i.wallet_id.is_empty()
                    && i.wallet_id.len() <= 128
                    && matches!(i.source.as_str(), "public" | "private"),
                "invalid selection"
            );
            if let Some(m) = i.method {
                payment_model::methods(&[m], false)?;
            }
        }
        "payment.reconcile" => {
            let i: Reconcile = parse(c)?;
            id(i.receiver_id)?;
            id(i.execution_id)?;
        }
        "proof.submit" => {
            let i: Submit = parse(c)?;
            anyhow::ensure!(
                i.period_index
                    .is_none_or(|n| n <= crate::recurrence::MAX_PERIOD),
                "invalid period"
            );
            id(i.receiver_id)?;
            id(i.request_id)?;
            anyhow::ensure!(
                i.execution_id.is_some() != i.proof.is_some(),
                "choose one proof source"
            );
            if let Some(e) = i.execution_id {
                id(e)?;
            }
            if let Some(p) = i.proof {
                p.validate()?;
            }
        }
        "proof.verify" => {
            let i: Verify = parse(c)?;
            id(i.receiver_id)?;
            id(i.request_id)?;
            id(i.proof_id)?;
            anyhow::ensure!(
                (1..=144).contains(&i.required_confirmations),
                "invalid confirmations"
            );
        }
        _ => anyhow::bail!("unknown request command"),
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_ambiguous_or_secret_proof_input() {
        let mut input = json!({"receiverId":Uuid::new_v4(),"requestId":Uuid::new_v4(),"proof":{"method":"btc-onchain","txid":"ab".repeat(32),"outputIndex":0}});
        let mut c = Command {
            command_id: Uuid::new_v4(),
            command: "proof.submit".into(),
            input: input.clone(),
        };
        assert!(validate(&c).is_ok());
        input["proof"]["rawTransaction"] = json!("secret");
        c.input = input;
        assert!(validate(&c).is_err());
        c.input = json!({"receiverId":Uuid::new_v4(),"requestId":Uuid::new_v4()});
        assert!(validate(&c).is_err());
    }
    #[test]
    fn rejects_float_amount_and_unbounded_confirmations() {
        let c = Command {
            command_id: Uuid::new_v4(),
            command: "proof.verify".into(),
            input: json!({"receiverId":Uuid::new_v4(),"requestId":Uuid::new_v4(),"proofId":Uuid::new_v4(),"requiredConfirmations":0}),
        };
        assert!(validate(&c).is_err());
        assert!(payment_model::sats("1.1").is_err());
    }
}
