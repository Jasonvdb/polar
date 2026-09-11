//! Strict recurring payment and application clock command inputs.
use crate::{
    model::{Command, PublicError},
    payment_model,
};
use serde::Deserialize;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepare {
    pub receiver_id: Uuid,
    pub request_id: Uuid,
    pub period_index: u32,
    pub source: String,
    pub expiry_seconds: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorize {
    pub receiver_id: Uuid,
    pub request_id: Uuid,
    pub wallet_id: String,
    pub source: String,
    pub method: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockSet {
    pub receiver_id: Uuid,
    pub now: String,
}
pub fn is_command(name: &str) -> bool {
    matches!(
        name,
        "subscription.prepare"
            | "subscription.authorize"
            | "subscription.disable"
            | "clock.set"
            | "clock.reset"
    )
}
pub fn validate(c: &Command) -> Result<(), PublicError> {
    validate_inner(c).map_err(|_|PublicError::new("invalid_input","Check subscription, period, explicit wallet/source/method and canonical UTC clock fields."))
}
fn validate_inner(c: &Command) -> anyhow::Result<()> {
    let receiver = match c.command.as_str() {
        "subscription.prepare" => {
            let i: Prepare = serde_json::from_value(c.input.clone())?;
            anyhow::ensure!(
                !i.request_id.is_nil()
                    && i.period_index <= crate::recurrence::MAX_PERIOD
                    && matches!(i.source.as_str(), "public" | "private")
                    && (1..=604800).contains(&i.expiry_seconds),
                "invalid preparation"
            );
            i.receiver_id
        }
        "subscription.authorize" => {
            let i: Authorize = serde_json::from_value(c.input.clone())?;
            anyhow::ensure!(
                !i.request_id.is_nil()
                    && !i.wallet_id.is_empty()
                    && i.wallet_id.len() <= 128
                    && !i.wallet_id.chars().any(char::is_control)
                    && matches!(i.source.as_str(), "public" | "private"),
                "invalid authorization"
            );
            payment_model::methods(&[i.method], false)?;
            i.receiver_id
        }
        "subscription.disable" => {
            let i: crate::request_input::Request = serde_json::from_value(c.input.clone())?;
            anyhow::ensure!(!i.request_id.is_nil(), "nil request");
            i.receiver_id
        }
        "clock.set" => {
            let i: ClockSet = serde_json::from_value(c.input.clone())?;
            crate::recurrence::timestamp(&i.now)?;
            i.receiver_id
        }
        "clock.reset" => {
            serde_json::from_value::<crate::commands::ReceiverId>(c.input.clone())?.receiver_id
        }
        _ => anyhow::bail!("unknown subscription command"),
    };
    anyhow::ensure!(!receiver.is_nil(), "nil receiver");
    Ok(())
}
