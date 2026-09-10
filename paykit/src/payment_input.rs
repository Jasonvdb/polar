//! Strict command boundary for payment methods and reservations.
use crate::{
    commands::public_key,
    model::{Command, PublicError},
    payment_model::{methods, sats},
};
use serde::Deserialize;
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configure {
    pub receiver_id: Uuid,
    pub wallet_id: String,
    pub enabled_methods: Vec<String>,
    pub preference: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prefer {
    pub receiver_id: Uuid,
    pub preference: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publish {
    pub receiver_id: Uuid,
    pub amount_sats: String,
    pub expiry_seconds: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reserve {
    pub receiver_id: Uuid,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub amount_sats: String,
    pub expiry_seconds: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReservationId {
    pub receiver_id: Uuid,
    pub reservation_id: Uuid,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resolve {
    pub receiver_id: Uuid,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub source: String,
    pub amount_sats: String,
    pub method: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consume {
    pub receiver_id: Uuid,
    pub resolution_id: Uuid,
}
pub fn is_command(name: &str) -> bool {
    matches!(
        name,
        "method.configure"
            | "method.prefer"
            | "paymentList.publish"
            | "paymentList.unpublish"
            | "reservation.create"
            | "reservation.rotate"
            | "reservation.cancel"
            | "reservation.reconcile"
            | "paymentList.resolve"
            | "paymentList.consume"
    )
}
pub fn validate(c: &Command) -> Result<(), PublicError> {
    validate_inner(c).map_err(|_| {
        PublicError::new(
            "invalid_input",
            "Check the wallet, methods, exact satoshi amount, expiry and peer fields.",
        )
    })
}
fn id(value: Uuid) -> anyhow::Result<()> {
    anyhow::ensure!(!value.is_nil(), "nil identifier");
    Ok(())
}
fn terms(amount: &str, expiry: u32) -> anyhow::Result<()> {
    sats(amount)?;
    anyhow::ensure!(
        (1..=604800).contains(&expiry),
        "expiry must be 1..604800 seconds"
    );
    Ok(())
}
fn peer(key: &str, path: &str) -> anyhow::Result<()> {
    public_key(key)?;
    paykit_sdk::PaykitReceiverPath::new(path)?;
    Ok(())
}
fn parse<T: serde::de::DeserializeOwned>(c: &Command) -> anyhow::Result<T> {
    Ok(serde_json::from_value(c.input.clone())?)
}
fn validate_inner(c: &Command) -> anyhow::Result<()> {
    match c.command.as_str() {
        "method.configure" => {
            let i: Configure = parse(c)?;
            id(i.receiver_id)?;
            anyhow::ensure!(
                !i.wallet_id.is_empty()
                    && i.wallet_id.len() <= 128
                    && !i.wallet_id.chars().any(char::is_control),
                "invalid wallet"
            );
            methods(&i.enabled_methods, false)?;
            methods(&i.preference, true)?;
            anyhow::ensure!(
                i.preference.iter().all(|m| i.enabled_methods.contains(m)),
                "preference must be enabled"
            );
        }
        "method.prefer" => {
            let i: Prefer = parse(c)?;
            id(i.receiver_id)?;
            methods(&i.preference, true)?;
        }
        "paymentList.publish" => {
            let i: Publish = parse(c)?;
            id(i.receiver_id)?;
            terms(&i.amount_sats, i.expiry_seconds)?;
        }
        "paymentList.unpublish" => id(parse::<crate::commands::ReceiverId>(c)?.receiver_id)?,
        "reservation.create" | "reservation.rotate" => {
            let i: Reserve = parse(c)?;
            id(i.receiver_id)?;
            peer(&i.peer_public_key, &i.peer_receiver_path)?;
            terms(&i.amount_sats, i.expiry_seconds)?;
        }
        "reservation.cancel" | "reservation.reconcile" => {
            let i: ReservationId = parse(c)?;
            id(i.receiver_id)?;
            id(i.reservation_id)?;
        }
        "paymentList.resolve" => {
            let i: Resolve = parse(c)?;
            id(i.receiver_id)?;
            peer(&i.peer_public_key, &i.peer_receiver_path)?;
            sats(&i.amount_sats)?;
            anyhow::ensure!(
                matches!(i.source.as_str(), "public" | "private"),
                "explicit source required"
            );
            if let Some(m) = i.method {
                methods(&[m], false)?;
            }
        }
        "paymentList.consume" => {
            let i: Consume = parse(c)?;
            id(i.receiver_id)?;
            id(i.resolution_id)?;
        }
        _ => anyhow::bail!("unsupported payment command"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn valid(name: &str, input: serde_json::Value) -> bool {
        validate(&Command {
            command_id: Uuid::new_v4(),
            command: name.into(),
            input,
        })
        .is_ok()
    }
    #[test]
    fn requires_explicit_source_exact_amount_and_rejects_secret_injection() {
        let input = json!({"receiverId":Uuid::new_v4(),"peerPublicKey":pubky::Keypair::random().public_key().z32(),"peerReceiverPath":"peer/wallet","amountSats":"123","source":"private","method":"btc-onchain"});
        assert!(valid("paymentList.resolve", input.clone()));
        for (key, value) in [
            ("source", json!("automatic")),
            ("amountSats", json!(123)),
            ("method", json!("bolt12")),
            ("secret", json!("injected")),
            ("peerReceiverPath", json!("../wallet")),
        ] {
            let mut bad = input.clone();
            bad[key] = value;
            assert!(!valid("paymentList.resolve", bad));
        }
        let mut missing = input;
        missing.as_object_mut().unwrap().remove("source");
        assert!(!valid("paymentList.resolve", missing));
    }
    #[test]
    fn expiry_and_preference_are_validated_before_durable_commands() {
        for expiry in [0, 604801] {
            assert!(!valid(
                "paymentList.publish",
                json!({"receiverId":Uuid::new_v4(),"amountSats":"1","expirySeconds":expiry})
            ));
        }
        assert!(!valid(
            "method.configure",
            json!({"receiverId":Uuid::new_v4(),"walletId":"core-0","enabledMethods":["btc-onchain"],"preference":["btc-lightning-bolt11"]})
        ));
    }
}
