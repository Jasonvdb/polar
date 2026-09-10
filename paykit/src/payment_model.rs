//! Public payment method policy and bounded wire records.
use serde::{Deserialize, Serialize};

pub const ONCHAIN: &str = "btc-onchain";
pub const BOLT11: &str = "btc-lightning-bolt11";
pub const MAX_SATS: u64 = 2_100_000_000_000_000;

pub fn sats(text: &str) -> anyhow::Result<u64> {
    anyhow::ensure!(
        !text.is_empty() && !text.starts_with('0') && text.bytes().all(|b| b.is_ascii_digit()),
        "amount must be canonical positive satoshis"
    );
    let value = text.parse::<u64>()?;
    anyhow::ensure!(value <= MAX_SATS, "amount exceeds Bitcoin supply");
    Ok(value)
}
pub fn methods(values: &[String], allow_empty: bool) -> anyhow::Result<()> {
    anyhow::ensure!(
        (allow_empty || !values.is_empty()) && values.len() <= 2,
        "invalid method set"
    );
    let mut seen = std::collections::HashSet::new();
    anyhow::ensure!(
        values
            .iter()
            .all(|s| matches!(s.as_str(), ONCHAIN | BOLT11) && seen.insert(s)),
        "unsupported or duplicate method"
    );
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MethodsView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wallet_id: Option<String>,
    pub enabled_methods: Vec<String>,
    pub preference: Vec<String>,
    pub wallets: Vec<WalletView>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletView {
    pub id: String,
    pub label: String,
    pub supported_methods: Vec<String>,
    pub status: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListView {
    pub id: String,
    pub amount_sats: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: String,
    pub delivery_status: String,
    pub cleanup_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub reservation_ids: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReservationView {
    pub id: String,
    pub list_id: String,
    pub wallet_id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_receiver_path: Option<String>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub amount_sats: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: String,
    pub delivery_status: String,
    pub cleanup_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outbound_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionView {
    pub id: String,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub source: String,
    pub amount_sats: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_satoshi_boundary_rejects_ambiguous_and_overflowing_amounts() {
        assert_eq!(sats("2100000000000000").unwrap(), MAX_SATS);
        assert_eq!(sats("900719925474099").unwrap(), 900_719_925_474_099);
        for invalid in [
            "0",
            "01",
            "1.0",
            "1e3",
            "+1",
            " 1",
            "-1",
            "9007199254740993",
            "2100000000000001",
            "18446744073709551616",
        ] {
            assert!(sats(invalid).is_err(), "{invalid}");
        }
    }
    #[test]
    fn supported_methods_are_explicit_unique_and_bounded() {
        assert!(methods(&[ONCHAIN.into(), BOLT11.into()], false).is_ok());
        assert!(methods(&[], true).is_ok());
        for invalid in [
            vec![],
            vec![ONCHAIN.into(), ONCHAIN.into()],
            vec!["btc-lightning-bolt12".into()],
        ] {
            assert!(methods(&invalid, false).is_err());
        }
    }
}
