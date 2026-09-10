//! Request use cases combine SDK lifecycle with independent durable wallet state.
use super::Runtime;
use crate::{
    model::Command,
    payment_model::{self, ONCHAIN},
    request_input::*,
    request_model::*,
    wallet_execution::{self, SpendState},
};
use paykit_sdk::{
    storage::StorageAdapter, LinkedPeerState, PaykitReceiverPath, PaymentRequestLifecycleState,
    PaymentRequestLocalRole, PaymentRequestRecord, PubkyPublicKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
#[derive(Default, Serialize, Deserialize)]
struct RequestState {
    #[serde(default)]
    claims: BTreeMap<String, String>,
    proposals: BTreeMap<Uuid, String>,
    transitions: BTreeMap<Uuid, String>,
    settlements: Vec<SettlementView>,
}
impl Runtime {
    fn request_state(&self) -> anyhow::Result<RequestState> {
        Ok(self.vault.load("requests.cbor")?.unwrap_or_default())
    }
    fn spend_vault(&self) -> anyhow::Result<crate::storage::Vault> {
        self.payments.execution_vault()
    }
    async fn request_record(&self, id: Uuid) -> anyhow::Result<PaymentRequestRecord> {
        self.sdk
            .payment_requests()
            .await?
            .into_iter()
            .find(|r| r.payment_request_id == id.to_string())
            .ok_or_else(|| anyhow::anyhow!("request missing"))
    }
    pub(super) async fn request_command(&mut self, c: &Command) -> anyhow::Result<Value> {
        match c.command.as_str() {
            "request.create" => self.create_request(c).await?,
            "request.accept" | "request.reject" | "request.cancel" => {
                self.transition_request(c).await?
            }
            "payment.execute" => self.execute_request(c).await?,
            "payment.reconcile" => {
                let i: Reconcile = serde_json::from_value(c.input.clone())?;
                let vault = self.spend_vault()?;
                let _lock = vault.lock("spending.lock")?;
                let mut state = SpendState::open(&vault)?;
                let n = state.index(&i.execution_id.to_string())?;
                anyhow::ensure!(
                    state.executions[n].receiver_id == i.receiver_id,
                    "execution belongs to another receiver"
                );
                wallet_execution::execute(&mut state, &vault, n, true).await?;
            }
            "proof.submit" => self.submit_proof(c).await?,
            "proof.verify" => self.verify_proof(c).await?,
            _ => anyhow::bail!("unknown request command"),
        }
        self.project_requests().await?;
        Ok(json!({"receiverId":self.state.view.receiver_id,"workspace":self.state.view}))
    }
    async fn create_request(&self, c: &Command) -> anyhow::Result<()> {
        let i: Create = serde_json::from_value(c.input.clone())?;
        self.ensure_payment_peer(&i.peer_public_key, &i.peer_receiver_path)?;
        let correlation = format!("polar:{}", c.command_id);
        let mut local = self.request_state()?;
        let records = self.sdk.payment_requests().await?;
        if records.iter().any(|r| {
            r.terms
                .as_ref()
                .is_some_and(|t| t.payment_reference == correlation)
        }) {
            return Ok(());
        }
        anyhow::ensure!(
            !local.proposals.contains_key(&c.command_id),
            "proposal checkpoint unresolved; inspect SDK history before retry"
        );
        let bindings = self.fresh_request_bindings(&i, &local).await?;
        for binding in &bindings {
            local
                .claims
                .insert(binding.reservation_id.clone(), correlation.clone());
        }
        local.proposals.insert(c.command_id, correlation.clone());
        self.vault.save("requests.cbor", &local)?;
        let amount = paykit_lib::PaymentAmount::new(i.amount_sats, "sat")?;
        let terms = paykit_lib::PaymentRequestTerms {
            amount,
            payment_reference: paykit_lib::PaymentReference::new(correlation)?,
            proposal_expires_at: Some(
                (chrono::Utc::now() + chrono::Duration::seconds(i.expiry_seconds.into()))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            ),
            recurrence: None,
            accepted_payment_endpoint_identifiers: i
                .accepted_methods
                .into_iter()
                .map(paykit_lib::PaymentEndpointIdentifier::new)
                .collect::<Result<_, _>>()?,
            metadata: json!({"description":i.description,"polarPaykitEndpoints":bindings})
                .as_object()
                .expect("object literal")
                .clone(),
        };
        self.sdk
            .propose_payment_request(
                PubkyPublicKey::new(i.peer_public_key)?,
                PaykitReceiverPath::new(i.peer_receiver_path)?,
                terms,
            )
            .await?;
        Ok(())
    }
    async fn fresh_request_bindings(
        &self,
        input: &Create,
        local: &RequestState,
    ) -> anyhow::Result<Vec<EndpointBinding>> {
        let mut bindings = vec![];
        for r in self.payments.snapshot()?.records {
            if r.view.status != "active"
                || r.view.amount_sats != input.amount_sats
                || !input.accepted_methods.contains(&r.view.method)
                || local.claims.contains_key(&r.view.id)
            {
                continue;
            }
            if r.view.source == "private"
                && (r.view.peer_public_key.as_deref() != Some(&input.peer_public_key)
                    || r.view.peer_receiver_path.as_deref() != Some(&input.peer_receiver_path))
            {
                continue;
            }
            let Some(endpoint) = r.view.endpoint else {
                continue;
            };
            if crate::wallet_rpc::validate_endpoint(
                &r.view.method,
                &endpoint,
                payment_model::sats(&input.amount_sats)?,
            )
            .is_err()
            {
                continue;
            }
            let fresh = if r.view.method == ONCHAIN {
                let wallet = r.wallet.ensure_core_wallet(self.owner.as_str()).await?;
                wallet_execution::amount(
                    &r.wallet
                        .core(Some(&wallet), "getreceivedbyaddress", json!([endpoint, 0]))
                        .await?,
                )? == 0
            } else {
                use bitcoin::hashes::{sha256, Hash};
                let hash = sha256::Hash::hash(&r.preimage);
                r.wallet
                    .lnd("GET", &format!("/v1/invoice/{hash}"), None)
                    .await?["state"]
                    == "OPEN"
            };
            if fresh {
                bindings.push(EndpointBinding {
                    source: r.view.source,
                    method: r.view.method,
                    endpoint,
                    reservation_id: r.view.id,
                });
            }
        }
        if !input
            .accepted_methods
            .iter()
            .all(|method| bindings.iter().any(|b| &b.method == method))
        {
            return Err(crate::model::PublicError::new("request_endpoints_required","Publish or rotate fresh receiving endpoints for every accepted method and this exact amount before creating the request.").into());
        }
        Ok(bindings)
    }
    /// The pinned SDK has no public combined private-send readiness query. Mirror
    /// its identity + linked-peer/snapshot predicate before our one-shot intent.
    /// This inspects local readiness only: offline peers and paused delivery may queue.
    async fn ensure_request_send_ready(&self, record: &PaymentRequestRecord) -> anyhow::Result<()> {
        let identity = self.sdk.identity_status().await?;
        let linked = self
            .storage
            .transaction(|tx| {
                Ok(tx
                    .linked_peer(&record.counterparty, &record.counterparty_receiver_path)
                    .is_some_and(|peer| peer.state == LinkedPeerState::Linked)
                    && tx
                        .encrypted_link_state(
                            &record.counterparty,
                            &record.counterparty_receiver_path,
                        )
                        .and_then(|state| state.link_snapshot)
                        .is_some())
            })
            .await?;
        if !linked
            || self.state.uncertain_peers.contains(&(
                record.counterparty.to_string(),
                record.counterparty_receiver_path.to_string(),
            ))
        {
            return Err(crate::model::PublicError::new("request_link_required", "Relink this peer and finish local link recovery before sending a request response or payment proof.").into());
        }
        if !identity.is_some_and(|identity| {
            identity.public_key.is_some() && identity.live_session_available
        }) {
            return Err(crate::model::PublicError::new(
                "request_session_required",
                "Restore the receiver session before sending a request response or payment proof.",
            )
            .into());
        }
        Ok(())
    }
    async fn transition_request(&self, c: &Command) -> anyhow::Result<()> {
        let i: Request = serde_json::from_value(c.input.clone())?;
        let record = self.request_record(i.request_id).await?;
        let already = match c.command.as_str() {
            "request.accept" => record.accepted_event_id.is_some(),
            "request.reject" => record.rejected_event_id.is_some(),
            _ => record.canceled_event_id.is_some(),
        };
        if already {
            return Ok(());
        }
        self.ensure_request_send_ready(&record).await?;
        let mut local = self.request_state()?;
        let transition = format!("{}:{}", c.command, record.payment_request_id);
        anyhow::ensure!(
            !local.transitions.values().any(|v| v == &transition),
            "request transition checkpoint unresolved"
        );
        local.transitions.insert(c.command_id, transition);
        self.vault.save("requests.cbor", &local)?;
        let id = paykit_lib::PaymentRequestId::new(i.request_id.to_string())?;
        match c.command.as_str() {
            "request.accept" => {
                self.sdk
                    .accept_payment_request(
                        record.counterparty,
                        record.counterparty_receiver_path,
                        &id,
                    )
                    .await?;
            }
            "request.reject" => {
                self.sdk
                    .reject_payment_request(
                        record.counterparty,
                        record.counterparty_receiver_path,
                        &id,
                        None,
                    )
                    .await?;
            }
            _ => {
                self.sdk
                    .cancel_payment_request(
                        record.counterparty,
                        record.counterparty_receiver_path,
                        &id,
                        None,
                    )
                    .await?;
            }
        }
        Ok(())
    }
    async fn execute_request(&mut self, c: &Command) -> anyhow::Result<()> {
        let i: Execute = serde_json::from_value(c.input.clone())?;
        let vault = self.spend_vault()?;
        let _lock = vault.lock("spending.lock")?;
        let mut state = SpendState::open(&vault)?;
        if state
            .existing(i.receiver_id, &i.request_id.to_string())
            .is_some()
        {
            return Ok(());
        }
        let record = self.request_record(i.request_id).await?;
        anyhow::ensure!(
            record.local_role == Some(PaymentRequestLocalRole::Payer)
                && record.state == PaymentRequestLifecycleState::Accepted,
            "only payer can execute an accepted unpaid request"
        );
        let terms = record
            .terms
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("request terms missing"))?;
        anyhow::ensure!(
            terms.recurrence.is_none() && terms.amount.asset == "sat",
            "unsupported request terms"
        );
        payment_model::sats(&terms.amount.value)?;
        let wallet = self.payments.configured_wallet(&i.wallet_id)?;
        let resolution = self
            .resolve_payment(
                c.command_id.to_string(),
                crate::payment_input::Resolve {
                    receiver_id: i.receiver_id,
                    peer_public_key: record.counterparty.to_string(),
                    peer_receiver_path: record.counterparty_receiver_path.to_string(),
                    source: i.source,
                    amount_sats: terms.amount.value.clone(),
                    method: i.method,
                },
            )
            .await?;
        anyhow::ensure!(
            resolution.status == "payable"
                && resolution
                    .method
                    .as_ref()
                    .is_some_and(|m| terms.accepted_payment_endpoint_identifiers.contains(m)),
            "selected endpoint is not accepted or payable"
        );
        let bindings = bindings(terms)?;
        anyhow::ensure!(bindings.iter().any(|b|b.source==resolution.source && Some(&b.method)==resolution.method.as_ref() && Some(&b.endpoint)==resolution.endpoint.as_ref()),"resolved endpoint is not bound to this immutable request; restore the expected list or create a new request");
        if resolution.source == "private" {
            self.validate_current_resolution(&resolution).await?;
        }
        let owner = wallet.ensure_core_wallet(self.owner.as_str()).await?;
        let mut execution = wallet_execution::new_execution(
            i.receiver_id,
            owner,
            wallet,
            i.request_id.to_string(),
            resolution.clone(),
        )?;
        if execution.view.method == crate::payment_model::BOLT11 {
            let info = execution
                .wallet
                .lnd_with_credential("GET", "/v1/getinfo", None, "payment")
                .await?;
            execution.lightning_node = Some(
                info["identity_pubkey"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Lightning identity missing"))?
                    .into(),
            );
        }
        state.reserve(&vault, execution)?;
        let n = state.index(&c.command_id.to_string())?;
        if resolution.source == "private" {
            self.payments.consume(&resolution.id)?;
        }
        state.executions[n].authorized = true;
        state.save(&vault)?;
        wallet_execution::execute(&mut state, &vault, n, false).await
    }
    async fn submit_proof(&self, c: &Command) -> anyhow::Result<()> {
        let i: Submit = serde_json::from_value(c.input.clone())?;
        let record = self.request_record(i.request_id).await?;
        anyhow::ensure!(
            record.local_role == Some(PaymentRequestLocalRole::Payer),
            "only payer submits proofs"
        );
        let proof = if let Some(id) = i.execution_id {
            let vault = self.spend_vault()?;
            let state = SpendState::open(&vault)?;
            let e = &state.executions[state.index(&id.to_string())?];
            anyhow::ensure!(
                e.receiver_id == i.receiver_id
                    && e.view.request_id == i.request_id.to_string()
                    && e.view.status == "succeeded",
                "execution has no successful payment for this request"
            );
            e.proof
                .clone()
                .ok_or_else(|| anyhow::anyhow!("execution proof missing"))?
        } else {
            i.proof.ok_or_else(|| anyhow::anyhow!("proof missing"))?
        };
        proof.validate()?;
        let value = serde_json::to_value(&proof)?
            .as_object()
            .expect("proof object")
            .clone();
        if !record.payment_proofs.is_empty() {
            anyhow::ensure!(
                record.payment_proofs.iter().any(|p| p.proof == value),
                "request already has a different proof"
            );
            return Ok(());
        }
        self.ensure_request_send_ready(&record).await?;
        checkpoint_proof(&self.vault, c.command_id, &record, &proof)?;
        self.sdk
            .submit_payment_proof(
                record.counterparty,
                record.counterparty_receiver_path,
                &paykit_lib::PaymentRequestId::new(i.request_id.to_string())?,
                None,
                paykit_lib::PaymentEndpointIdentifier::new(proof.method())?,
                value,
            )
            .await?;
        Ok(())
    }
    pub(super) async fn project_requests(&mut self) -> anyhow::Result<()> {
        let records = self.sdk.payment_requests().await?;
        let mut requests = vec![];
        let mut proofs = vec![];
        for record in records.into_iter().take(128) {
            if let Some(terms) = record.terms {
                let endpoint_bindings = bindings(&terms).unwrap_or_default();
                requests.push(RequestView {
                    id: record.payment_request_id.clone(),
                    peer_public_key: record.counterparty.to_string(),
                    peer_receiver_path: record.counterparty_receiver_path.to_string(),
                    role: match record.local_role {
                        Some(PaymentRequestLocalRole::Payer) => "payer",
                        _ => "payee",
                    }
                    .into(),
                    lifecycle: lifecycle(record.state).into(),
                    amount_sats: terms.amount.value,
                    description: terms
                        .metadata
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    payment_reference: terms.payment_reference,
                    proposal_expires_at: terms.proposal_expires_at,
                    endpoint_bindings,
                    accepted_methods: terms.accepted_payment_endpoint_identifiers,
                    delivery_status: delivery(record.last_outbound_status.as_ref()),
                    created_at: record
                        .last_event_at
                        .map(|t| t.to_rfc3339())
                        .unwrap_or_default(),
                });
            }
            for p in record.payment_proofs {
                if let Ok(proof) = serde_json::from_value::<Proof>(json!(p.proof)) {
                    proofs.push(ProofView {
                        id: p.event_id,
                        request_id: record.payment_request_id.clone(),
                        method: p.payment_endpoint_identifier,
                        proof,
                        delivery_status: delivery(p.outbound_status.as_ref()),
                        recorded_at: p.recorded_at.to_rfc3339(),
                    });
                }
            }
        }
        self.state.view.requests = requests;
        self.state.view.proofs = proofs.into_iter().rev().take(128).collect();
        self.state.view.executions =
            SpendState::open(&self.spend_vault()?)?.project(self.state.view.receiver_id);
        self.state.view.settlements = self
            .request_state()?
            .settlements
            .into_iter()
            .rev()
            .take(128)
            .collect();
        Ok(())
    }
    async fn verify_proof(&self, c: &Command) -> anyhow::Result<()> {
        let i: Verify = serde_json::from_value(c.input.clone())?;
        let record = self.request_record(i.request_id).await?;
        anyhow::ensure!(
            record.local_role == Some(PaymentRequestLocalRole::Payee)
                && record.state == PaymentRequestLifecycleState::ProofSubmitted,
            "only payee verifies a proof for an accepted request"
        );
        let p = record
            .payment_proofs
            .iter()
            .find(|p| p.event_id == i.proof_id.to_string())
            .ok_or_else(|| anyhow::anyhow!("proof missing"))?;
        let proof: Proof = serde_json::from_value(json!(p.proof))?;
        proof.validate()?;
        let vault = self.spend_vault()?;
        let _lock = vault.lock("spending.lock")?;
        let mut spends = SpendState::open(&vault)?;
        let key = proof.identity();
        let binding = format!("{}:{}", i.receiver_id, i.request_id);
        let reused = spends.settlements.get(&key).is_some_and(|r| r != &binding);
        let result = if reused {
            Ok((false, 0, None))
        } else {
            self.check_settlement(&record, &proof).await
        };
        let mut view = SettlementView {
            proof_id: i.proof_id.to_string(),
            request_id: i.request_id.to_string(),
            status: "pending".into(),
            required_confirmations: i.required_confirmations,
            confirmations: 0,
            verified_at: None,
            last_error: None,
        };
        match result {
            Ok((valid, confirmations, reservation_id)) => {
                view.confirmations = confirmations;
                if !valid {
                    view.status = "invalid".into();
                    view.last_error=Some("Proof does not match an unused receiving endpoint, amount or payment hash.".into());
                } else if proof.method() != ONCHAIN || confirmations >= i.required_confirmations {
                    spends.settlements.insert(key, binding);
                    spends.save(&vault)?;
                    self.payments.update(|ledger| {
                        let record = ledger
                            .records
                            .iter_mut()
                            .find(|r| Some(&r.view.id) == reservation_id.as_ref())
                            .ok_or_else(|| anyhow::anyhow!("verified reservation missing"))?;
                        record.view.status = "settled".into();
                        record.view.cleanup_status = "complete".into();
                        record.view.last_error = None;
                        Ok(())
                    })?;
                    view.status = "verified".into();
                    view.verified_at = Some(chrono::Utc::now().to_rfc3339());
                }
            }
            Err(_) => {
                view.status = "failed".into();
                view.last_error = Some(
                    "Settlement service unavailable or transaction unknown. Retry verification."
                        .into(),
                );
            }
        }
        let mut state = self.request_state()?;
        state.settlements.retain(|v| v.proof_id != view.proof_id);
        state.settlements.push(view);
        self.vault.save("requests.cbor", &state)
    }
    async fn check_settlement(
        &self,
        request: &PaymentRequestRecord,
        proof: &Proof,
    ) -> anyhow::Result<(bool, u32, Option<String>)> {
        let terms = request
            .terms
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("terms missing"))?;
        let expected = payment_model::sats(&terms.amount.value)?;
        if terms.amount.asset != "sat"
            || !terms
                .accepted_payment_endpoint_identifiers
                .iter()
                .any(|m| m == proof.method())
        {
            return Ok((false, 0, None));
        }
        let bindings = bindings(terms)?;
        let local = self.request_state()?;
        let records = self.payments.snapshot()?.records;
        for reservation in records.into_iter().filter(|r| {
            r.view.method == proof.method()
                && local.claims.get(&r.view.id) == Some(&terms.payment_reference)
                && bindings.iter().any(|b| {
                    b.reservation_id == r.view.id
                        && b.source == r.view.source
                        && b.method == r.view.method
                        && Some(&b.endpoint) == r.view.endpoint.as_ref()
                })
                && (r.view.source == "public"
                    || r.view.peer_public_key.as_deref() == Some(request.counterparty.as_str())
                        && r.view.peer_receiver_path.as_deref()
                            == Some(request.counterparty_receiver_path.as_str()))
        }) {
            let Some(endpoint) = reservation.view.endpoint else {
                continue;
            };
            match proof {
                Proof::Onchain { txid, output_index } => {
                    let owner = reservation
                        .wallet
                        .ensure_core_wallet(self.owner.as_str())
                        .await?;
                    let tx = reservation
                        .wallet
                        .core(Some(&owner), "gettransaction", json!([txid]))
                        .await?;
                    let raw = tx["hex"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("transaction hex missing"))?;
                    let txbytes: bitcoin::Transaction =
                        bitcoin::consensus::deserialize(&hex::decode(raw)?)?;
                    if wallet_execution::validate_transaction(
                        &txbytes,
                        &endpoint,
                        expected,
                        *output_index,
                    )
                    .is_ok()
                    {
                        let confirmations = tx["confirmations"].as_i64().unwrap_or(0);
                        return Ok((
                            confirmations >= 0,
                            confirmations.max(0).try_into()?,
                            Some(reservation.view.id),
                        ));
                    }
                }
                Proof::Lightning {
                    payment_hash,
                    preimage,
                } => {
                    use bitcoin::hashes::{sha256, Hash};
                    use std::str::FromStr;
                    let invoice = lightning_invoice::Bolt11Invoice::from_str(&endpoint)?;
                    if invoice.payment_hash().to_string() != payment_hash.to_lowercase() {
                        continue;
                    }
                    if sha256::Hash::hash(&hex::decode(preimage)?).to_string()
                        != payment_hash.to_lowercase()
                        || invoice.amount_milli_satoshis() != Some(expected * 1000)
                    {
                        return Ok((false, 0, None));
                    }
                    let current = reservation
                        .wallet
                        .lnd("GET", &format!("/v1/invoice/{payment_hash}"), None)
                        .await?;
                    let paid = current["amt_paid_sat"]
                        .as_str()
                        .unwrap_or("0")
                        .parse::<u64>()?;
                    return Ok((
                        current["state"] == "SETTLED" && paid == expected,
                        0,
                        Some(reservation.view.id),
                    ));
                }
            }
        }
        Ok((false, 0, None))
    }
}
/// Validate all known pre-enqueue failures before the durable one-shot checkpoint.
/// Once saved, an SDK error can include an uncertain write and must not release it.
fn checkpoint_proof(
    vault: &crate::storage::Vault,
    command_id: Uuid,
    record: &PaymentRequestRecord,
    proof: &Proof,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        record.local_role == Some(PaymentRequestLocalRole::Payer)
            && record.state == PaymentRequestLifecycleState::Accepted,
        "only payer can submit a proof for an accepted unpaid request"
    );
    let terms = record
        .terms
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("request terms missing"))?;
    anyhow::ensure!(
        terms.recurrence.is_none() && terms.amount.asset == "sat",
        "unsupported request terms"
    );
    payment_model::sats(&terms.amount.value)?;
    proof.validate()?;
    let request = paykit_lib::PaymentRequest::new(
        paykit_lib::EventId::new(
            record
                .proposal_event_id
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("proposal event missing"))?,
        )?,
        paykit_lib::PaymentRequestId::new(record.payment_request_id.clone())?,
        paykit_lib::PaymentRequestTerms {
            amount: paykit_lib::PaymentAmount::new(
                terms.amount.value.clone(),
                terms.amount.asset.clone(),
            )?,
            payment_reference: paykit_lib::PaymentReference::new(terms.payment_reference.clone())?,
            proposal_expires_at: terms.proposal_expires_at.clone(),
            recurrence: None,
            accepted_payment_endpoint_identifiers: terms
                .accepted_payment_endpoint_identifiers
                .iter()
                .map(paykit_lib::PaymentEndpointIdentifier::new)
                .collect::<Result<_, _>>()?,
            metadata: terms.metadata.clone(),
        },
    );
    paykit_lib::PaymentProof::new(
        paykit_lib::EventId::new_v4(),
        request.payment_request_id.clone(),
        request.request.payment_reference.clone(),
        None,
        paykit_lib::PaymentEndpointIdentifier::new(proof.method())?,
        serde_json::to_value(proof)?
            .as_object()
            .expect("proof object")
            .clone(),
    )
    .validate_for_request(&request)?;
    let mut local: RequestState = vault.load("requests.cbor")?.unwrap_or_default();
    let transition = format!("proof:{}", record.payment_request_id);
    anyhow::ensure!(
        !local.transitions.values().any(|v| v == &transition),
        "proof enqueue checkpoint unresolved; synchronize existing SDK history"
    );
    local.transitions.insert(command_id, transition);
    vault.save("requests.cbor", &local)
}

fn lifecycle(state: PaymentRequestLifecycleState) -> &'static str {
    match state {
        PaymentRequestLifecycleState::Proposed => "proposed",
        PaymentRequestLifecycleState::ProposalExpired => "proposalExpired",
        PaymentRequestLifecycleState::Accepted => "accepted",
        PaymentRequestLifecycleState::Rejected => "rejected",
        PaymentRequestLifecycleState::Canceled => "canceled",
        PaymentRequestLifecycleState::ProofSubmitted => "proofSubmitted",
        PaymentRequestLifecycleState::RecoveryRequired => "recoveryRequired",
        _ => "invalidConflict",
    }
}
fn delivery(status: Option<&paykit_sdk::OutboundPrivateMessageStatus>) -> String {
    status
        .map(|s| {
            let s = format!("{s:?}");
            let mut chars = s.chars();
            chars
                .next()
                .map(|c| c.to_lowercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .unwrap_or_else(|| "received".into())
}

fn bindings(terms: &paykit_sdk::PaymentRequestTermsRecord) -> anyhow::Result<Vec<EndpointBinding>> {
    let value = terms
        .metadata
        .get("polarPaykitEndpoints")
        .ok_or_else(|| anyhow::anyhow!("request endpoint bindings missing"))?;
    let bindings: Vec<EndpointBinding> = serde_json::from_value(value.clone())?;
    anyhow::ensure!(
        !bindings.is_empty() && bindings.len() <= 256,
        "invalid request endpoint bindings"
    );
    let mut seen = std::collections::BTreeSet::new();
    for b in &bindings {
        anyhow::ensure!(
            matches!(b.source.as_str(), "public" | "private")
                && terms
                    .accepted_payment_endpoint_identifiers
                    .contains(&b.method)
                && !Uuid::parse_str(&b.reservation_id)?.is_nil()
                && seen.insert(b.reservation_id.clone()),
            "invalid request endpoint binding"
        );
        payment_model::methods(std::slice::from_ref(&b.method), false)?;
        anyhow::ensure!(
            !b.endpoint.is_empty() && b.endpoint.len() <= 16384,
            "invalid bound endpoint"
        );
    }
    anyhow::ensure!(
        terms
            .accepted_payment_endpoint_identifiers
            .iter()
            .all(|m| bindings.iter().any(|b| &b.method == m)),
        "missing accepted method binding"
    );
    Ok(bindings)
}

#[cfg(test)]
mod binding_tests {
    use super::*;
    fn terms() -> paykit_sdk::PaymentRequestTermsRecord {
        let amount = paykit_lib::PaymentAmount::new("5000", "sat").unwrap();
        let terms=paykit_lib::PaymentRequestTerms{amount,payment_reference:paykit_lib::PaymentReference::new("fixture-reference").unwrap(),proposal_expires_at:None,recurrence:None,accepted_payment_endpoint_identifiers:vec![paykit_lib::PaymentEndpointIdentifier::new(ONCHAIN).unwrap()],metadata:json!({"polarPaykitEndpoints":[{"source":"public","method":ONCHAIN,"endpoint":"bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsl","reservationId":Uuid::new_v4()}]}).as_object().unwrap().clone()};
        paykit_sdk::PaymentRequestTermsRecord::from(&terms)
    }
    fn payer_record() -> PaymentRequestRecord {
        serde_json::from_value(json!({
            "counterparty": PubkyPublicKey::new(pubky::Keypair::from_secret(&[19; 32]).public_key().z32()).unwrap(),
            "counterparty_receiver_path": PaykitReceiverPath::new("fixture/wallet").unwrap(),
            "payment_request_id": Uuid::new_v4().to_string(),
            "local_role": PaymentRequestLocalRole::Payer,
            "state": PaymentRequestLifecycleState::Accepted,
            "proposal_event_id": Uuid::new_v4().to_string(),
            "terms": terms(),
            "payment_proofs": []
        })).unwrap()
    }
    #[test]
    fn rejected_proof_preflight_survives_reopen_without_poisoning_corrected_proof() {
        let dir = tempfile::tempdir().unwrap();
        let open =
            || crate::storage::Vault::new(dir.path().into(), [23; 32], "receiver".into()).unwrap();
        let mut record = payer_record();
        let proof = Proof::Onchain {
            txid: "ab".repeat(32),
            output_index: 0,
        };
        record.state = PaymentRequestLifecycleState::Proposed;
        assert!(checkpoint_proof(&open(), Uuid::new_v4(), &record, &proof).is_err());
        assert!(open()
            .load::<RequestState>("requests.cbor")
            .unwrap()
            .is_none());
        record.state = PaymentRequestLifecycleState::Accepted;
        let wrong_rail = Proof::Lightning {
            payment_hash: "cd".repeat(32),
            preimage: "ef".repeat(32),
        };
        assert!(checkpoint_proof(&open(), Uuid::new_v4(), &record, &wrong_rail).is_err());
        assert!(open()
            .load::<RequestState>("requests.cbor")
            .unwrap()
            .is_none());
        let command = Uuid::new_v4();
        checkpoint_proof(&open(), command, &record, &proof).unwrap();
        let saved = open()
            .load::<RequestState>("requests.cbor")
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.transitions.get(&command),
            Some(&format!("proof:{}", record.payment_request_id))
        );
        // A saved checkpoint without an SDK result is an uncertain write, even after restart.
        assert!(checkpoint_proof(&open(), Uuid::new_v4(), &record, &proof)
            .unwrap_err()
            .to_string()
            .contains("checkpoint unresolved"));
        assert_eq!(
            open()
                .load::<RequestState>("requests.cbor")
                .unwrap()
                .unwrap()
                .transitions
                .len(),
            1
        );
    }
    #[test]
    fn invalid_immutable_terms_never_reserve_a_proof_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let vault =
            crate::storage::Vault::new(dir.path().into(), [23; 32], "receiver".into()).unwrap();
        let proof = Proof::Onchain {
            txid: "ab".repeat(32),
            output_index: 0,
        };
        let original = payer_record();
        let mut unsupported = original.clone();
        unsupported.terms.as_mut().unwrap().amount.asset = "USD".into();
        let mut malformed = original.clone();
        malformed.terms.as_mut().unwrap().proposal_expires_at = Some("invalid".into());
        let mut missing_proposal = original;
        missing_proposal.proposal_event_id = None;
        for record in [unsupported, malformed, missing_proposal] {
            assert!(checkpoint_proof(&vault, Uuid::new_v4(), &record, &proof).is_err());
        }
        assert!(vault
            .load::<RequestState>("requests.cbor")
            .unwrap()
            .is_none());
    }
    fn request_runtime(directory: &std::path::Path, receiver_id: Uuid, accepted: bool) -> Runtime {
        use crate::storage::{ReceiverStorage, Vault};
        use paykit_sdk::storage::{
            OutboundPrivateMessageRecord, PrivateStreamItemRecord, StorageState,
        };
        use std::sync::Arc;
        let vault =
            Arc::new(Vault::new(directory.into(), [24; 32], "request-readiness".into()).unwrap());
        let owner =
            PubkyPublicKey::from_public_key(&pubky::Keypair::from_secret(&[27; 32]).public_key());
        let peer =
            PubkyPublicKey::from_public_key(&pubky::Keypair::from_secret(&[28; 32]).public_key());
        let receiver_path = PaykitReceiverPath::new("fixture/wallet").unwrap();
        if !directory.join("sdk.cbor").exists() {
            let now = chrono::Utc::now();
            let id = paykit_lib::PaymentRequestId::new_v4();
            let terms = paykit_lib::PaymentRequestTerms {
                amount: paykit_lib::PaymentAmount::new("5000", "sat").unwrap(),
                payment_reference: paykit_lib::PaymentReference::new("readiness-regression")
                    .unwrap(),
                proposal_expires_at: None,
                recurrence: None,
                accepted_payment_endpoint_identifiers: vec![
                    paykit_lib::PaymentEndpointIdentifier::new(ONCHAIN).unwrap(),
                ],
                metadata: Default::default(),
            };
            let proposal = paykit_lib::serialize_payment_request_event(
                &paykit_lib::PaymentRequestEvent::Request(paykit_lib::PaymentRequest::new(
                    paykit_lib::EventId::new_v4(),
                    id.clone(),
                    terms,
                )),
            )
            .unwrap();
            let mut state = StorageState {
                identity_state: Some(paykit_sdk::IdentityState {
                    local_pubky_public_key: Some(owner.clone()),
                    local_receiver_noise_public_key: Some(owner.clone()),
                    initialized_at: now,
                    sign_out_generation: 0,
                }),
                ..Default::default()
            };
            let kind = serde_json::from_str::<Value>(&proposal).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string();
            state.private_stream_items.push(PrivateStreamItemRecord {
                stream_item_id: 1,
                counterparty: peer.clone(),
                counterparty_receiver_path: receiver_path.clone(),
                receive_batch_id: 1,
                raw_json: proposal,
                parsed_version: Some(1),
                parsed_kind: Some(kind.clone()),
                known_paykit_kind: Some(kind),
                parse_status: paykit_sdk::PrivateStreamParseStatus::Valid,
                parse_error: None,
                received_at: now,
            });
            state.next_private_stream_item_id = 2;
            if accepted {
                let raw = paykit_lib::serialize_payment_request_event(
                    &paykit_lib::PaymentRequestEvent::Acceptance(
                        paykit_lib::PaymentRequestAcceptance::new(
                            paykit_lib::EventId::new_v4(),
                            id,
                        ),
                    ),
                )
                .unwrap();
                let kind = serde_json::from_str::<Value>(&raw).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string();
                state
                    .outbound_private_messages
                    .push(OutboundPrivateMessageRecord {
                        outbound_message_id: 1,
                        counterparty: peer.clone(),
                        counterparty_receiver_path: receiver_path.clone(),
                        kind,
                        raw_json: raw,
                        status: paykit_sdk::OutboundPrivateMessageStatus::Sent,
                        attempt_count: 1,
                        created_at: now,
                        updated_at: now,
                        last_attempt_at: Some(now),
                        sent_at: Some(now),
                        last_error: None,
                    });
            }
            vault.save("sdk.cbor", &state).unwrap();
        }
        let storage = Arc::new(
            ReceiverStorage::open(
                Vault::new(directory.into(), [24; 32], "request-readiness".into()).unwrap(),
            )
            .unwrap(),
        );
        let provider = crate::receiver::SessionProvider::without_access(vault.clone());
        let payments = crate::wallet_adapter::WalletAdapter::open(
            vault.clone(),
            receiver_id,
            owner.to_string(),
        )
        .unwrap();
        let sdk = paykit_sdk::PaykitSdk::new(
            storage.clone(),
            provider.clone(),
            payments.clone(),
            paykit_sdk::PaykitSdkConfig::new(receiver_path),
        )
        .unwrap();
        Runtime::new(sdk, storage, vault, receiver_id, owner, provider, payments).unwrap()
    }
    async fn seed_readiness(
        runtime: &Runtime,
        record: &PaymentRequestRecord,
        state: LinkedPeerState,
        snapshot: bool,
    ) {
        runtime
            .storage
            .transaction(|tx| {
                tx.save_linked_peer(paykit_sdk::storage::LinkedPeerRecord {
                    counterparty: record.counterparty.clone(),
                    counterparty_receiver_path: record.counterparty_receiver_path.clone(),
                    state,
                    last_sync_at: None,
                    last_private_receive_at: None,
                    failure_count: 0,
                    local_recovery_attempt_id: None,
                    local_recovery_marker_created_at: None,
                    local_recovery_marker_last_error: None,
                    remote_recovery_attempt_id: None,
                    remote_recovery_marker_observed_at: None,
                });
                tx.save_encrypted_link_state(paykit_sdk::storage::EncryptedLinkStateRecord {
                    counterparty: record.counterparty.clone(),
                    counterparty_receiver_path: record.counterparty_receiver_path.clone(),
                    link_snapshot: snapshot.then_some(vec![1]),
                    handshake_snapshot: None,
                    handshake_role: None,
                    generation: 1,
                    checkpointed_at: chrono::Utc::now(),
                });
                Ok(())
            })
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn actual_sdk_block_unblock_rejects_proof_and_transition_before_checkpoint_across_reopen()
    {
        for accepted in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let receiver_id = Uuid::new_v4();
            let mut runtime = request_runtime(dir.path(), receiver_id, accepted);
            let record = runtime.sdk.payment_requests().await.unwrap().remove(0);
            seed_readiness(&runtime, &record, LinkedPeerState::Linked, true).await;
            runtime
                .sdk
                .block_peer(
                    record.counterparty.clone(),
                    record.counterparty_receiver_path.clone(),
                )
                .await
                .unwrap();
            runtime
                .sdk
                .unblock_peer(
                    record.counterparty.clone(),
                    record.counterparty_receiver_path.clone(),
                )
                .await
                .unwrap();
            for _ in 0..2 {
                let retained = runtime.sdk.payment_requests().await.unwrap().remove(0);
                assert!(
                    retained.state
                        == if accepted {
                            PaymentRequestLifecycleState::Accepted
                        } else {
                            PaymentRequestLifecycleState::Proposed
                        }
                );
                assert_eq!(retained.payment_proofs.len(), 0);
                assert_eq!(
                    runtime.sdk.linked_peers().await.unwrap()[0].state,
                    LinkedPeerState::NotLinked
                );
                let command = Command {
                    command_id: Uuid::new_v4(),
                    command: if accepted {
                        "proof.submit"
                    } else {
                        "request.accept"
                    }
                    .into(),
                    input: if accepted {
                        json!({"receiverId":receiver_id,"requestId":record.payment_request_id,"proof":{"method":ONCHAIN,"txid":"ab".repeat(32),"outputIndex":0}})
                    } else {
                        json!({"receiverId":receiver_id,"requestId":record.payment_request_id})
                    },
                };
                let error = if accepted {
                    runtime.submit_proof(&command).await
                } else {
                    runtime.transition_request(&command).await
                }
                .unwrap_err();
                assert_eq!(
                    error
                        .downcast_ref::<crate::model::PublicError>()
                        .unwrap()
                        .code,
                    "request_link_required"
                );
                assert!(runtime
                    .vault
                    .load::<RequestState>("requests.cbor")
                    .unwrap()
                    .is_none());
                let count = runtime
                    .storage
                    .transaction(|tx| Ok(tx.export_storage_state().outbound_private_messages.len()))
                    .await
                    .unwrap();
                assert_eq!(count, usize::from(accepted));
                drop(runtime);
                runtime = request_runtime(dir.path(), receiver_id, accepted);
            }
            if accepted {
                // Existing SDK acceptance acknowledgments remain idempotent with no active link/session.
                let command = Command {
                    command_id: Uuid::new_v4(),
                    command: "request.accept".into(),
                    input: json!({"receiverId":receiver_id,"requestId":record.payment_request_id}),
                };
                runtime.transition_request(&command).await.unwrap();
                assert!(runtime
                    .vault
                    .load::<RequestState>("requests.cbor")
                    .unwrap()
                    .is_none());
            }
        }
    }
    #[tokio::test]
    async fn request_readiness_requires_actual_snapshot_session_and_local_recovery_clearance() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = request_runtime(dir.path(), Uuid::new_v4(), true);
        let record = runtime.sdk.payment_requests().await.unwrap().remove(0);
        for (state, snapshot) in [
            (LinkedPeerState::NotLinked, true),
            (LinkedPeerState::Linking, true),
            (LinkedPeerState::RecoveryRequired, true),
            (LinkedPeerState::Blocked, true),
            (LinkedPeerState::Linked, false),
        ] {
            seed_readiness(&runtime, &record, state, snapshot).await;
            let error = runtime
                .ensure_request_send_ready(&record)
                .await
                .unwrap_err();
            assert_eq!(
                error
                    .downcast_ref::<crate::model::PublicError>()
                    .unwrap()
                    .code,
                "request_link_required"
            );
        }
        seed_readiness(&runtime, &record, LinkedPeerState::Linked, true).await;
        let error = runtime
            .ensure_request_send_ready(&record)
            .await
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<crate::model::PublicError>()
                .unwrap()
                .code,
            "request_session_required"
        );
        runtime.state.uncertain_peers.push((
            record.counterparty.to_string(),
            record.counterparty_receiver_path.to_string(),
        ));
        let error = runtime
            .ensure_request_send_ready(&record)
            .await
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<crate::model::PublicError>()
                .unwrap()
                .code,
            "request_link_required"
        );
        assert!(runtime
            .vault
            .load::<RequestState>("requests.cbor")
            .unwrap()
            .is_none());
    }
    #[test]
    fn immutable_bindings_reject_missing_partial_or_unrecognized_fields() {
        let original = terms();
        assert_eq!(bindings(&original).unwrap().len(), 1);
        let mut old = original.clone();
        old.metadata.clear();
        assert!(bindings(&old).is_err());
        let mut partial = original.clone();
        partial
            .accepted_payment_endpoint_identifiers
            .push(crate::payment_model::BOLT11.into());
        assert!(bindings(&partial).is_err());
        let mut injected = original;
        injected.metadata.get_mut("polarPaykitEndpoints").unwrap()[0]["walletSecret"] =
            json!("injected");
        assert!(bindings(&injected).is_err());
    }
    #[test]
    fn durable_claims_do_not_become_reusable_when_a_request_expires() {
        let dir = tempfile::tempdir().unwrap();
        let vault =
            crate::storage::Vault::new(dir.path().into(), [17; 32], "receiver".into()).unwrap();
        let mut state = RequestState::default();
        state
            .claims
            .insert("reservation".into(), "original-correlation".into());
        state
            .proposals
            .insert(Uuid::new_v4(), "original-correlation".into());
        vault.save("requests.cbor", &state).unwrap();
        let reopened: RequestState = vault.load("requests.cbor").unwrap().unwrap();
        assert_eq!(
            reopened.claims.get("reservation").map(String::as_str),
            Some("original-correlation")
        );
    }
}
