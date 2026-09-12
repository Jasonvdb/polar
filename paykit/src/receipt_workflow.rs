//! Prepared receipt issuance and retrieval use the SDK's atomic encrypted checkpoints.
use super::Runtime;
use crate::{
    model::{Command, PublicError},
    payment_model, receipt_input,
    receipt_model::*,
};
use paykit_sdk::{storage::StorageAdapter, ReceiptIssuanceStatus, ReceiptRetrievalStatus};
use serde_json::{json, Value};
use uuid::Uuid;

// The SDK storage boundary exposes this record structurally but does not export its type.
// This transient adapter snapshot is never persisted or serialized onto the public API.
#[derive(PartialEq)]
struct IssuanceSnapshot {
    counterparty: paykit_sdk::PubkyPublicKey,
    counterparty_receiver_path: paykit_sdk::PaykitReceiverPath,
    receipt_id: String,
    receipt_access_event_id: String,
    payment_reference: String,
    payment_request_id: Option<String>,
    billing_period: Option<paykit_sdk::BillingPeriodRecord>,
    payment_endpoint_identifier: Option<String>,
    amount: Option<paykit_sdk::AmountRecord>,
    location: String,
    encrypted_receipt: String,
    access_json: String,
    status: ReceiptIssuanceStatus,
    outbound_message_id: Option<u64>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    stored_at: Option<chrono::DateTime<chrono::Utc>>,
    access_queued_at: Option<chrono::DateTime<chrono::Utc>>,
}
macro_rules! issuance_snapshot {
    ($record:expr) => {{
        let record = $record;
        IssuanceSnapshot {
            counterparty: record.counterparty.clone(),
            counterparty_receiver_path: record.counterparty_receiver_path.clone(),
            receipt_id: record.receipt_id.clone(),
            receipt_access_event_id: record.receipt_access_event_id.clone(),
            payment_reference: record.payment_reference.clone(),
            payment_request_id: record.payment_request_id.clone(),
            billing_period: record.billing_period.clone(),
            payment_endpoint_identifier: record.payment_endpoint_identifier.clone(),
            amount: record.amount.clone(),
            location: record.location.clone(),
            encrypted_receipt: record.encrypted_receipt.clone(),
            access_json: record.access_json.clone(),
            status: record.status,
            outbound_message_id: record.outbound_message_id,
            created_at: record.created_at,
            updated_at: record.updated_at,
            stored_at: record.stored_at,
            access_queued_at: record.access_queued_at,
        }
    }};
}
impl Runtime {
    pub(super) async fn receipt_command(&mut self, command: &Command) -> anyhow::Result<Value> {
        let id = match command.command.as_str() {
            "receipt.prepare" => {
                self.prepare_receipt(serde_json::from_value(command.input.clone())?)
                    .await?
            }
            "receipt.process" => {
                self.process_receipt(serde_json::from_value(command.input.clone())?)
                    .await?
            }
            "receipt.retrieve" => {
                self.retrieve_receipt(serde_json::from_value(command.input.clone())?)
                    .await?
            }
            _ => anyhow::bail!("unknown receipt command"),
        };
        self.project_receipts().await?;
        Ok(
            json!({"receiverId":self.state.view.receiver_id,"receiptId":id,"workspace":self.state.view}),
        )
    }
    async fn issuance(&self, id: Uuid) -> anyhow::Result<Option<IssuanceSnapshot>> {
        Ok(self
            .storage
            .transaction(|tx| {
                Ok(tx
                    .receipt_issuance_record_by_receipt_id(&id.to_string())
                    .as_ref()
                    .map(|record| issuance_snapshot!(record)))
            })
            .await?)
    }
    async fn prepare_receipt(&self, input: receipt_input::Prepare) -> anyhow::Result<Uuid> {
        let id = receipt_id(input.receiver_id, input.request_id, input.proof_id);
        if let Some(existing) = self.issuance(id).await? {
            let view =
                issuance_view(input.receiver_id, &existing, None).map_err(|_| invalid_record())?;
            if view.note != input.note
                || view.request_id != input.request_id.to_string()
                || view.proof_id != input.proof_id.to_string()
            {
                return Err(public("receipt_conflict", "This receipt is already prepared with different immutable fields. Keep its original note.").into());
            }
            return Ok(id);
        }
        let (request, proof) = self.verified_receipt_request(input.request_id, input.proof_id).await
            .map_err(|_| public("receipt_settlement_required", "Choose this receiver's independently verified settlement before preparing a receipt."))?;
        let draft = receipt_draft(&request, &proof, &input, id).map_err(|_| invalid_record())?;
        self.sdk
            .prepare_receipt_issuance(
                request.counterparty,
                request.counterparty_receiver_path,
                draft,
            )
            .await
            .map_err(receipt_error)?;
        Ok(id)
    }
    async fn process_receipt(&self, input: receipt_input::Process) -> anyhow::Result<Uuid> {
        let record = self
            .issuance(input.receipt_id)
            .await?
            .ok_or_else(missing_receipt)?;
        issuance_view(input.receiver_id, &record, None).map_err(|_| invalid_record())?;
        if record.status == ReceiptIssuanceStatus::AccessQueued {
            let retained = self
                .storage
                .transaction(|tx| {
                    Ok(tx
                        .outbound_private_messages(
                            &record.counterparty,
                            &record.counterparty_receiver_path,
                        )
                        .iter()
                        .any(|m| {
                            Some(m.outbound_message_id) == record.outbound_message_id
                                && m.raw_json == record.access_json
                                && m.kind == "paykit.receipt_access"
                        }))
                })
                .await?;
            if !retained {
                return Err(invalid_record().into());
            }
            return Ok(input.receipt_id);
        }
        if self.state.uncertain_peers.contains(&(
            record.counterparty.to_string(),
            record.counterparty_receiver_path.to_string(),
        )) {
            return Err(link_required().into());
        }
        self.sdk
            .process_receipt_issuance(
                record.counterparty,
                record.counterparty_receiver_path,
                &record.receipt_id,
            )
            .await
            .map_err(receipt_error)?;
        Ok(input.receipt_id)
    }
    async fn retrieve_receipt(&self, input: receipt_input::Retrieve) -> anyhow::Result<Uuid> {
        let receipt = self
            .sdk
            .retrieve_receipt(
                paykit_sdk::PubkyPublicKey::new(input.peer_public_key)?,
                paykit_sdk::PaykitReceiverPath::new(input.peer_receiver_path)?,
                &input.receipt_id.to_string(),
            )
            .await
            .map_err(receipt_error)?;
        known_receipt_matches(&receipt, &self.sdk.payment_requests().await?)
            .map_err(|_| receipt_mismatch())?;
        Ok(input.receipt_id)
    }
    pub(super) async fn project_receipts(&mut self) -> anyhow::Result<()> {
        let issued = self.sdk.issued_receipts().await?;
        let mut issuances = vec![];
        let mut invalid = false;
        for view in issued {
            let (record, delivery) = self
                .storage
                .transaction(|tx| {
                    let record = tx.receipt_issuance_record(
                        &view.counterparty,
                        &view.counterparty_receiver_path,
                        &view.receipt_id,
                    );
                    let delivery = tx
                        .outbound_private_messages(
                            &view.counterparty,
                            &view.counterparty_receiver_path,
                        )
                        .into_iter()
                        .find(|m| Some(m.outbound_message_id) == view.outbound_message_id)
                        .map(|m| m.status);
                    Ok((
                        record.as_ref().map(|record| issuance_snapshot!(record)),
                        delivery,
                    ))
                })
                .await?;
            if let Some(record) = record {
                match issuance_view(self.state.view.receiver_id, &record, delivery.as_ref()) {
                    Ok(view) => issuances.push(view),
                    Err(_) => invalid = true,
                }
            }
        }
        issuances.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
        let mut access: Vec<_> = self
            .sdk
            .receipt_access()
            .await?
            .iter()
            .map(access_view)
            .collect();
        access.sort_by(|a, b| {
            b.received_at.cmp(&a.received_at).then(
                (
                    &a.peer_public_key,
                    &a.peer_receiver_path,
                    &a.access_event_id,
                )
                    .cmp(&(
                        &b.peer_public_key,
                        &b.peer_receiver_path,
                        &b.access_event_id,
                    )),
            )
        });
        let requests = self.sdk.payment_requests().await?;
        let mut receipts = vec![];
        for receipt in self.sdk.receipts().await? {
            if known_receipt_matches(&receipt, &requests).is_ok() {
                receipts.push(decrypted_view(&receipt));
            } else {
                invalid = true;
                for item in &mut access {
                    if item.receipt_id == receipt.receipt_id
                        && item.peer_public_key == receipt.issuer.to_string()
                        && item.peer_receiver_path == receipt.issuer_receiver_path.to_string()
                    {
                        item.retrieval_status = "failed".into();
                        item.retrieved_at = None;
                        item.last_error = Some(receipt_mismatch().message);
                    }
                }
            }
        }
        receipts.sort_by(|a, b| {
            b.retrieved_at.cmp(&a.retrieved_at).then(
                (&a.issuer_public_key, &a.issuer_receiver_path, &a.id).cmp(&(
                    &b.issuer_public_key,
                    &b.issuer_receiver_path,
                    &b.id,
                )),
            )
        });
        self.state.view.receipt_issuances = issuances;
        self.state.view.receipt_access = access;
        self.state.view.receipts = receipts;
        if invalid {
            self.state.view.last_error = Some(invalid_record().message);
        }
        Ok(())
    }
}
fn receipt_id(receiver: Uuid, request: Uuid, proof: Uuid) -> Uuid {
    // The pinned SDK requires v4-shaped IDs. This stable identifier is not key material.
    let derived = Uuid::new_v5(
        &receiver,
        format!("polar-paykit:receipt:v1:{request}:{proof}").as_bytes(),
    );
    uuid::Builder::from_bytes(*derived.as_bytes())
        .with_version(uuid::Version::Random)
        .into_uuid()
}
fn receipt_draft(
    request: &paykit_sdk::PaymentRequestRecord,
    proof: &crate::request_model::Proof,
    input: &receipt_input::Prepare,
    id: Uuid,
) -> anyhow::Result<paykit_lib::ReceiptDraft> {
    let terms = request
        .terms
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("receipt terms missing"))?;
    anyhow::ensure!(
        terms.amount.asset == "sat"
            && terms
                .accepted_payment_endpoint_identifiers
                .iter()
                .any(|m| m == proof.method()),
        "unsupported receipt terms"
    );
    payment_model::sats(&terms.amount.value)?;
    let description = super::requests::request_description(terms)
        .ok_or_else(|| anyhow::anyhow!("description missing"))?;
    anyhow::ensure!(
        receipt_input::text_valid(&description, false),
        "invalid description"
    );
    let proof_record = request
        .payment_proofs
        .iter()
        .find(|p| p.event_id == input.proof_id.to_string())
        .ok_or_else(|| anyhow::anyhow!("receipt proof missing"))?;
    super::subscription_workflow::proof_period(request, proof_record.billing_period.as_ref())?;
    let mut builder = paykit_sdk::ReceiptDraftBuilder::new(&terms.payment_reference)?
        .with_receipt_id(paykit_lib::ReceiptId::new(id.to_string())?)
        .with_payment_request_id(paykit_lib::PaymentRequestId::new(input.request_id.to_string())?)
        .with_payment_endpoint_identifier_text(proof.method())?
        .with_amount_text(&terms.amount.value, "sat")?
        .with_metadata(json!({"polarPaykitReceiptVersion":1,"proofId":input.proof_id.to_string(),"description":description,"note":input.note}).as_object().expect("object").clone());
    if let Some(period) = &proof_record.billing_period {
        builder = builder
            .with_billing_period(crate::recurrence::BillingPeriod::from_record(period).sdk());
    }
    Ok(builder.build()?)
}
fn issuance_view(
    receiver: Uuid,
    record: &IssuanceSnapshot,
    delivery: Option<&paykit_sdk::OutboundPrivateMessageStatus>,
) -> anyhow::Result<ReceiptIssuanceView> {
    let access = paykit_lib::parse_receipt_access_json(&record.access_json)?;
    let plaintext =
        paykit_lib::decrypt_receipt(&record.encrypted_receipt, &access.key, &access.location)?;
    let request = canonical_id(record.payment_request_id.as_deref())
        .ok_or_else(|| anyhow::anyhow!("request missing"))?;
    let proof = canonical_id(plaintext.metadata.get("proofId").and_then(Value::as_str))
        .ok_or_else(|| anyhow::anyhow!("proof missing"))?;
    let description = metadata_text(&plaintext.metadata, "description", false)
        .ok_or_else(|| anyhow::anyhow!("description missing"))?;
    let note = metadata_text(&plaintext.metadata, "note", true)
        .ok_or_else(|| anyhow::anyhow!("note missing"))?;
    let method = supported_method(record.payment_endpoint_identifier.as_deref())
        .ok_or_else(|| anyhow::anyhow!("method missing"))?;
    let amount = supported_amount(record.amount.as_ref())
        .ok_or_else(|| anyhow::anyhow!("amount missing"))?;
    anyhow::ensure!(
        record.receipt_id
            == receipt_id(
                receiver,
                Uuid::parse_str(&request)?,
                Uuid::parse_str(&proof)?
            )
            .to_string()
            && plaintext.metadata.len() == 4
            && plaintext.metadata.get("polarPaykitReceiptVersion") == Some(&json!(1))
            && plaintext.receipt_id.as_str() == record.receipt_id
            && access.receipt_id.as_str() == record.receipt_id
            && access.event_id.as_str() == record.receipt_access_event_id
            && access.location == record.location
            && plaintext.recipient_public_key == record.counterparty.to_public_key()?
            && plaintext.payment_reference.as_str() == record.payment_reference
            && access.payment_reference.as_str() == record.payment_reference
            && plaintext.payment_request_id.as_ref().map(|v| v.as_str()) == Some(request.as_str())
            && access.payment_request_id.as_ref().map(|v| v.as_str()) == Some(request.as_str())
            && plaintext.billing_period == access.billing_period
            && plaintext
                .billing_period
                .as_ref()
                .map(|p| crate::recurrence::BillingPeriod {
                    starts_at: p.starts_at.clone(),
                    ends_at: p.ends_at.clone()
                })
                == record
                    .billing_period
                    .as_ref()
                    .map(crate::recurrence::BillingPeriod::from_record)
            && plaintext
                .payment_endpoint_identifier
                .as_ref()
                .map(|m| m.as_str())
                == Some(method.as_str())
            && plaintext
                .amount
                .as_ref()
                .is_some_and(|a| a.value == amount && a.asset == "sat"),
        "invalid receipt provenance"
    );
    Ok(ReceiptIssuanceView {
        billing_period: record
            .billing_period
            .as_ref()
            .map(crate::recurrence::BillingPeriod::from_record),
        id: record.receipt_id.clone(),
        request_id: request,
        proof_id: proof,
        peer_public_key: record.counterparty.to_string(),
        peer_receiver_path: record.counterparty_receiver_path.to_string(),
        payment_reference: record.payment_reference.clone(),
        method,
        amount_sats: amount,
        description,
        note,
        status: issuance_status(record.status).into(),
        delivery_status: delivery_status(record.outbound_message_id, delivery).into(),
        access_event_id: record.receipt_access_event_id.clone(),
        outbound_message_id: record.outbound_message_id.map(|id| id.to_string()),
        created_at: record.created_at.to_rfc3339(),
        updated_at: record.updated_at.to_rfc3339(),
        stored_at: record.stored_at.map(|t| t.to_rfc3339()),
        access_queued_at: record.access_queued_at.map(|t| t.to_rfc3339()),
        last_error: (record.status == ReceiptIssuanceStatus::Failed).then(|| {
            "Receipt publication failed. Check local services and resume this receipt.".into()
        }),
    })
}
fn issuance_status(status: ReceiptIssuanceStatus) -> &'static str {
    match status {
        ReceiptIssuanceStatus::PendingStorage => "pendingStorage",
        ReceiptIssuanceStatus::Stored => "stored",
        ReceiptIssuanceStatus::AccessQueued => "accessQueued",
        _ => "failed",
    }
}
fn delivery_status(
    id: Option<u64>,
    status: Option<&paykit_sdk::OutboundPrivateMessageStatus>,
) -> &'static str {
    use paykit_sdk::OutboundPrivateMessageStatus::*;
    if id.is_none() {
        return "notQueued";
    }
    match status {
        Some(Pending) => "pending",
        Some(Sending) => "sending",
        Some(Sent) => "sent",
        Some(Failed) => "failed",
        Some(Invalid) => "invalid",
        Some(RecoveryRequired) => "recoveryRequired",
        Some(Superseded) => "superseded",
        _ => "unknown",
    }
}
fn access_view(record: &paykit_sdk::ReceiptAccessView) -> ReceiptAccessView {
    let (status, error) = match record.retrieval_status {
        ReceiptRetrievalStatus::Pending => ("pending", None),
        ReceiptRetrievalStatus::Retrieved => ("retrieved", None),
        ReceiptRetrievalStatus::NotFound => ("notFound", Some("Encrypted receipt was not found. Ask the issuer to restore publication, then retry.".into())),
        _ => ("failed", Some("Receipt retrieval or decryption failed. Check issuer access and local services, then retry.".into())),
    };
    ReceiptAccessView {
        billing_period: record
            .billing_period
            .as_ref()
            .map(crate::recurrence::BillingPeriod::from_record),
        receipt_id: record.receipt_id.clone(),
        peer_public_key: record.counterparty.to_string(),
        peer_receiver_path: record.counterparty_receiver_path.to_string(),
        access_event_id: record.event_id.clone(),
        request_id: record.payment_request_id.clone(),
        payment_reference: record.payment_reference.clone(),
        retrieval_status: status.into(),
        received_at: record.received_at.to_rfc3339(),
        attempted_at: record.retrieval_attempted_at.map(|t| t.to_rfc3339()),
        retrieved_at: record.retrieved_at.map(|t| t.to_rfc3339()),
        last_error: error,
    }
}
fn decrypted_view(record: &paykit_sdk::ReceiptRecord) -> DecryptedReceiptView {
    DecryptedReceiptView {
        billing_period: record
            .billing_period
            .as_ref()
            .map(crate::recurrence::BillingPeriod::from_record),
        id: record.receipt_id.clone(),
        issuer_public_key: record.issuer.to_string(),
        issuer_receiver_path: record.issuer_receiver_path.to_string(),
        recipient_public_key: record.recipient_public_key.to_string(),
        request_id: record.payment_request_id.clone(),
        proof_id: canonical_id(record.metadata.get("proofId").and_then(Value::as_str)),
        payment_reference: record.payment_reference.clone(),
        method: supported_method(record.payment_endpoint_identifier.as_deref()),
        amount_sats: supported_amount(record.amount.as_ref()),
        description: metadata_text(&record.metadata, "description", false),
        note: metadata_text(&record.metadata, "note", true),
        access_event_id: record.receipt_access_event_id.clone(),
        retrieved_at: record.retrieved_at.to_rfc3339(),
    }
}
fn supported_method(value: Option<&str>) -> Option<String> {
    value
        .filter(|m| matches!(*m, payment_model::ONCHAIN | payment_model::BOLT11))
        .map(str::to_owned)
}
fn supported_amount(amount: Option<&paykit_sdk::AmountRecord>) -> Option<String> {
    amount
        .filter(|a| a.asset == "sat" && payment_model::sats(&a.value).is_ok())
        .map(|a| a.value.clone())
}
fn canonical_id(value: Option<&str>) -> Option<String> {
    let value = value?;
    let id = Uuid::parse_str(value).ok()?;
    (!id.is_nil() && id.to_string() == value).then(|| value.into())
}
fn metadata_text(
    metadata: &serde_json::Map<String, Value>,
    key: &str,
    empty: bool,
) -> Option<String> {
    metadata
        .get(key)?
        .as_str()
        .filter(|s| receipt_input::text_valid(s, empty))
        .map(str::to_owned)
}
fn public(code: &str, message: &str) -> PublicError {
    PublicError::new(code, message)
}
fn invalid_record() -> PublicError {
    public(
        "receipt_invalid",
        "Receipt fields are invalid or do not match this receiver's immutable request and proof.",
    )
}
fn missing_receipt() -> PublicError {
    public(
        "receipt_missing",
        "Prepared receipt was not found in this receiver. Select the issuing receiver.",
    )
}
fn link_required() -> PublicError {
    public(
        "receipt_link_required",
        "Restore this receiver's session and relink the peer before resuming receipt publication.",
    )
}
fn receipt_error(error: paykit_sdk::PaykitSdkError) -> PublicError {
    use paykit_sdk::PaykitSdkError::*;
    match error {
        Identity { .. } | RecoveryRequired { .. } => link_required(),
        NotFound { .. } => public("receipt_missing", "Receipt or access was not found. Synchronize access or ask the issuer to restore publication, then retry."),
        Storage { .. } => public("receipt_storage_failed", "Receipt state could not be committed. Restore local storage, restart this receiver, and retry the same receipt."),
        _ => public("receipt_failed", "Receipt publication, access or decryption failed. Check the encrypted link and local services, then retry the same receipt."),
    }
}
#[cfg(test)]
#[path = "receipt_workflow_tests.rs"]
mod tests;

fn receipt_mismatch() -> PublicError {
    public("receipt_mismatch", "Decrypted receipt contradicts the known request or payment proof. Ask the issuer to correct its receipt; payment settlement is unchanged.")
}
fn known_receipt_matches(
    receipt: &paykit_sdk::ReceiptRecord,
    requests: &[paykit_sdk::PaymentRequestRecord],
) -> anyhow::Result<()> {
    if receipt.metadata.get("polarPaykitReceiptVersion") != Some(&json!(1)) {
        return Ok(());
    }
    let Some(request) = requests
        .iter()
        .find(|r| Some(&r.payment_request_id) == receipt.payment_request_id.as_ref())
    else {
        return Ok(());
    };
    let terms = request
        .terms
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("known terms missing"))?;
    let proof_id = canonical_id(receipt.metadata.get("proofId").and_then(Value::as_str));
    let proof = request
        .payment_proofs
        .iter()
        .find(|p| Some(&p.event_id) == proof_id.as_ref())
        .ok_or_else(|| anyhow::anyhow!("known proof missing"))?;
    super::subscription_workflow::proof_period(request, proof.billing_period.as_ref())?;
    let billing_period = proof.billing_period.clone();
    let proof: crate::request_model::Proof = serde_json::from_value(json!(proof.proof))?;
    proof.validate()?;
    anyhow::ensure!(
        request.local_role == Some(paykit_sdk::PaymentRequestLocalRole::Payer)
            && receipt.issuer == request.counterparty
            && receipt.issuer_receiver_path == request.counterparty_receiver_path
            && receipt.payment_reference == terms.payment_reference
            && receipt.amount.as_ref() == Some(&terms.amount)
            && receipt.payment_endpoint_identifier.as_deref() == Some(proof.method())
            && terms
                .accepted_payment_endpoint_identifiers
                .iter()
                .any(|m| m == proof.method())
            && receipt.billing_period == billing_period,
        "receipt contradicts known request"
    );
    Ok(())
}
