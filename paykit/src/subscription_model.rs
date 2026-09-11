//! Explicit subscription progress and authorization projections.
use crate::{recurrence::BillingPeriod, request_model::EndpointBinding};
use serde::{Deserialize, Serialize};
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutopayView {
    pub enabled: bool,
    pub wallet_id: Option<String>,
    pub source: Option<String>,
    pub method: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
}
impl Default for AutopayView {
    fn default() -> Self {
        Self {
            enabled: false,
            wallet_id: None,
            source: None,
            method: None,
            status: "disabled".into(),
            last_error: None,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeriodView {
    pub index: u32,
    pub starts_at: String,
    pub ends_at: String,
    pub status: String,
    pub offer_id: Option<String>,
    pub endpoint_bindings: Vec<EndpointBinding>,
    #[serde(default)]
    pub endpoint_commitments: Vec<EndpointCommitment>,
    pub execution_id: Option<String>,
    pub proof_id: Option<String>,
    pub last_error: Option<String>,
}
impl PeriodView {
    pub fn new(index: u32, period: BillingPeriod, status: &str) -> Self {
        Self {
            index,
            starts_at: period.starts_at,
            ends_at: period.ends_at,
            status: status.into(),
            offer_id: None,
            endpoint_bindings: vec![],
            endpoint_commitments: vec![],
            execution_id: None,
            proof_id: None,
            last_error: None,
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionView {
    pub request_id: String,
    pub current_period_index: Option<u32>,
    pub autopay: AutopayView,
    pub periods: Vec<PeriodView>,
}

/// An immutable digest binds a period to an endpoint without duplicating invoices in Noise frames.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndpointCommitment {
    pub source: String,
    pub method: String,
    pub reservation_id: String,
    pub endpoint_hash: String,
}
impl EndpointCommitment {
    pub(crate) fn from_binding(binding: &EndpointBinding) -> Self {
        Self {
            source: binding.source.clone(),
            method: binding.method.clone(),
            reservation_id: binding.reservation_id.clone(),
            endpoint_hash: endpoint_hash(&binding.endpoint),
        }
    }
    pub(crate) fn matches(&self, source: &str, method: &str, endpoint: &str) -> bool {
        self.source == source
            && self.method == method
            && self.endpoint_hash == endpoint_hash(endpoint)
    }
    pub(crate) fn binding(&self, endpoint: &str) -> EndpointBinding {
        EndpointBinding {
            source: self.source.clone(),
            method: self.method.clone(),
            reservation_id: self.reservation_id.clone(),
            endpoint: endpoint.into(),
        }
    }
}
fn endpoint_hash(endpoint: &str) -> String {
    use bitcoin::hashes::{sha256, Hash};
    sha256::Hash::hash(endpoint.as_bytes()).to_string()
}
