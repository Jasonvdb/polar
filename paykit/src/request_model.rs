//! Explicit public request, execution, proof and settlement projections.
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointBinding {
    pub source: String,
    pub method: String,
    pub endpoint: String,
    pub reservation_id: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestView {
    #[serde(default)]
    pub recurrence: Option<crate::recurrence::Recurrence>,
    pub id: String,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub role: String,
    pub lifecycle: String,
    pub amount_sats: String,
    pub description: String,
    pub payment_reference: String,
    pub proposal_expires_at: Option<String>,
    pub accepted_methods: Vec<String>,
    #[serde(default)]
    pub endpoint_bindings: Vec<EndpointBinding>,
    pub delivery_status: String,
    pub created_at: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionView {
    #[serde(default)]
    pub period_index: Option<u32>,
    #[serde(default)]
    pub billing_period: Option<crate::recurrence::BillingPeriod>,
    pub id: String,
    pub request_id: String,
    pub wallet_id: String,
    pub source: String,
    pub method: String,
    pub endpoint: String,
    pub amount_sats: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub txid: Option<String>,
    pub output_index: Option<u32>,
    pub payment_hash: Option<String>,
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Proof {
    #[serde(rename = "btc-onchain")]
    Onchain {
        txid: String,
        #[serde(rename = "outputIndex")]
        output_index: u32,
    },
    #[serde(rename = "btc-lightning-bolt11")]
    Lightning {
        #[serde(rename = "paymentHash")]
        payment_hash: String,
        preimage: String,
    },
}
impl Proof {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Onchain { .. } => crate::payment_model::ONCHAIN,
            Self::Lightning { .. } => crate::payment_model::BOLT11,
        }
    }
    pub fn validate(&self) -> anyhow::Result<()> {
        fn hash(text: &str) -> anyhow::Result<()> {
            anyhow::ensure!(
                text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid proof hash"
            );
            Ok(())
        }
        match self {
            Self::Onchain { txid, .. } => hash(txid),
            Self::Lightning {
                payment_hash,
                preimage,
            } => {
                hash(payment_hash)?;
                hash(preimage)
            }
        }
    }
    pub fn identity(&self) -> String {
        match self {
            Self::Onchain { txid, output_index } => {
                format!("btc:{txid}:{output_index}").to_lowercase()
            }
            Self::Lightning { payment_hash, .. } => format!("ln:{payment_hash}").to_lowercase(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofView {
    #[serde(default)]
    pub period_index: Option<u32>,
    #[serde(default)]
    pub billing_period: Option<crate::recurrence::BillingPeriod>,
    pub id: String,
    pub request_id: String,
    pub method: String,
    pub proof: Proof,
    pub delivery_status: String,
    pub recorded_at: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettlementView {
    #[serde(default)]
    pub period_index: Option<u32>,
    #[serde(default)]
    pub billing_period: Option<crate::recurrence::BillingPeriod>,
    pub proof_id: String,
    pub request_id: String,
    pub status: String,
    pub required_confirmations: u32,
    pub confirmations: u32,
    pub verified_at: Option<String>,
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FundingView {
    pub status: String,
    pub funded: bool,
    pub step: String,
    pub wallets: Vec<FundedWallet>,
    pub channel_points: Vec<String>,
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FundedWallet {
    pub participant: String,
    pub wallet_id: String,
    pub onchain_balance_sats: String,
    pub lightning_balance_sats: String,
}

impl Default for FundingView {
    fn default() -> Self {
        Self {
            status: "notStarted".into(),
            funded: false,
            step: String::new(),
            wallets: vec![],
            channel_points: vec![],
            last_error: None,
        }
    }
}
