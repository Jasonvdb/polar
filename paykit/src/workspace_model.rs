//! Public, explicitly projected receiver workspaces. No SDK snapshot is a wire type.
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Workspace {
    pub receiver_id: Uuid,
    #[serde(default)]
    pub receipt_issuances: Vec<crate::receipt_model::ReceiptIssuanceView>,
    #[serde(default)]
    pub receipt_access: Vec<crate::receipt_model::ReceiptAccessView>,
    #[serde(default)]
    pub receipts: Vec<crate::receipt_model::DecryptedReceiptView>,
    #[serde(default)]
    pub requests: Vec<crate::request_model::RequestView>,
    #[serde(default)]
    pub executions: Vec<crate::request_model::ExecutionView>,
    #[serde(default)]
    pub proofs: Vec<crate::request_model::ProofView>,
    #[serde(default)]
    pub settlements: Vec<crate::request_model::SettlementView>,
    #[serde(default)]
    pub payment_methods: crate::payment_model::MethodsView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_payment_list: Option<crate::payment_model::ListView>,
    #[serde(default)]
    pub reservations: Vec<crate::payment_model::ReservationView>,
    #[serde(default)]
    pub resolutions: Vec<crate::payment_model::ResolutionView>,
    pub delivery_paused: bool,
    pub links: Vec<LinkView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<ProfileView>,
    pub profiles: Vec<ProfileView>,
    pub contacts: Vec<ContactView>,
    pub discoveries: Vec<DiscoveryView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkView {
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub state: String,
    pub generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handshake_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_receive_at: Option<String>,
    pub failure_count: u32,
    pub pending_messages: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_received_list_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sent_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileView {
    pub peer_public_key: String,
    pub peer_receiver_path: String,
    pub display_name: String,
    pub about: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_data_url: Option<String>,
    pub path: String,
    pub updated_at: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContactView {
    pub peer_public_key: String,
    pub label: String,
    pub receiver_paths: Vec<String>,
    pub public_sharing: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_receiver_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoveryView {
    pub peer_public_key: String,
    pub receiver_paths: Vec<String>,
    pub updated_at: String,
}
