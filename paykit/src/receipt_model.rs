//! Explicit receipt projections omit SDK keys, private locations and raw errors.
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptIssuanceView {
    #[serde(default)]
    pub billing_period: Option<crate::recurrence::BillingPeriod>,
    pub id: String,
    pub request_id: String,
    pub proof_id: String,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub payment_reference: String,
    pub method: String,
    pub amount_sats: String,
    pub description: String,
    pub note: String,
    pub status: String,
    pub delivery_status: String,
    pub access_event_id: String,
    pub outbound_message_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub stored_at: Option<String>,
    pub access_queued_at: Option<String>,
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptAccessView {
    #[serde(default)]
    pub billing_period: Option<crate::recurrence::BillingPeriod>,
    pub receipt_id: String,
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub access_event_id: String,
    pub request_id: Option<String>,
    pub payment_reference: String,
    pub retrieval_status: String,
    pub received_at: String,
    pub attempted_at: Option<String>,
    pub retrieved_at: Option<String>,
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecryptedReceiptView {
    #[serde(default)]
    pub billing_period: Option<crate::recurrence::BillingPeriod>,
    pub id: String,
    pub issuer_public_key: String,
    pub issuer_receiver_path: String,
    pub recipient_public_key: String,
    pub request_id: Option<String>,
    pub proof_id: Option<String>,
    pub payment_reference: String,
    pub method: Option<String>,
    pub amount_sats: Option<String>,
    pub description: Option<String>,
    pub note: Option<String>,
    pub access_event_id: String,
    pub retrieved_at: String,
}
