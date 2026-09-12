//! Durable period offers and opt-in background payments use the existing SDK stream.
use super::Runtime;
use crate::{
    model::{Command, PublicError},
    recurrence::{BillingPeriod, Recurrence},
    request_model::EndpointBinding,
    subscription_input::*,
    subscription_model::*,
    wallet_execution::SpendState,
};
use paykit_sdk::{
    Clock, PaymentRequestLifecycleState as Lifecycle, PaymentRequestLocalRole as Role,
    PaymentRequestRecord,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use uuid::Uuid;
const FILE: &str = "subscriptions.cbor";
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct SubscriptionState {
    preparations: BTreeMap<String, Preparation>,
    authorizations: BTreeMap<String, Authorization>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Preparation {
    command_id: Uuid,
    request_id: String,
    period_index: u32,
    source: String,
    expiry_seconds: u32,
    bindings: Vec<EndpointBinding>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Authorization {
    view: AutopayView,
    attempts: BTreeMap<u32, Uuid>,
    #[serde(default)]
    last_observed_index: Option<u32>,
}
impl Authorization {
    fn observe(&mut self, index: u32) -> bool {
        if self
            .last_observed_index
            .is_some_and(|previous| previous > index)
        {
            return false;
        }
        self.last_observed_index = Some(index);
        !self.attempts.contains_key(&index)
    }
}
pub(super) fn is_offer(record: &PaymentRequestRecord) -> bool {
    record
        .terms
        .as_ref()
        .is_some_and(|t| t.metadata.contains_key("polarPaykitPeriodVersion"))
}
pub(super) fn recurrence(record: &PaymentRequestRecord) -> anyhow::Result<Option<Recurrence>> {
    record
        .terms
        .as_ref()
        .and_then(|t| t.recurrence.as_ref())
        .map(Recurrence::from_record)
        .transpose()
}
pub(super) fn period_for(
    record: &PaymentRequestRecord,
    index: Option<u32>,
) -> anyhow::Result<Option<BillingPeriod>> {
    match (recurrence(record)?, index) {
        (None, None) => Ok(None),
        (Some(r), Some(i)) => Ok(Some(r.period(i)?)),
        _ => anyhow::bail!(
            "Recurring requests require an explicit period; one-time requests forbid one."
        ),
    }
}
pub(super) fn proof_period(
    record: &PaymentRequestRecord,
    period: Option<&paykit_sdk::BillingPeriodRecord>,
) -> anyhow::Result<Option<u32>> {
    match (recurrence(record)?, period) {
        (None, None) => Ok(None),
        (Some(r), Some(p)) => Ok(Some(r.index_of(&BillingPeriod::from_record(p))?)),
        _ => anyhow::bail!("Proof period does not match request schedule."),
    }
}
fn key(request: &str, index: u32) -> String {
    format!("{request}:{index}")
}
fn correlation(request: &str, index: u32) -> String {
    format!("polar-period:{request}:{index}")
}
fn active(record: &PaymentRequestRecord) -> bool {
    matches!(
        record.state,
        Lifecycle::Accepted | Lifecycle::ActiveRecurring
    ) && record.invalid_reason.is_none()
        && !is_offer(record)
}
fn error(message: &str) -> anyhow::Error {
    PublicError::new("subscription_blocked", message).into()
}
impl Runtime {
    fn subscriptions(&self) -> anyhow::Result<SubscriptionState> {
        Ok(self.vault.load(FILE)?.unwrap_or_default())
    }
    pub(super) async fn subscription_command(&mut self, c: &Command) -> anyhow::Result<Value> {
        match c.command.as_str() {
            "subscription.prepare"=>self.prepare_period(c).await?,
            "subscription.authorize"=>{
                let i:Authorize=serde_json::from_value(c.input.clone())?;
                let r=self.request_record(i.request_id).await?;
                anyhow::ensure!(active(&r) && r.local_role==Some(Role::Payer) && recurrence(&r)?.is_some(),"Only the payer can authorize an accepted subscription.");
                let terms=r.terms.as_ref().expect("recurrence terms");
                anyhow::ensure!(terms.accepted_payment_endpoint_identifiers.contains(&i.method),"Method is not accepted by this subscription.");
                let wallet=self.payments.configured_wallet(&i.wallet_id)?;
                anyhow::ensure!(wallet.view().supported_methods.contains(&i.method),"Wallet does not support the selected method.");
                let mut state=self.subscriptions()?;
                let authorization=state.authorizations.entry(r.payment_request_id).or_default();
                authorization.view=AutopayView{enabled:true,wallet_id:Some(i.wallet_id),source:Some(i.source),method:Some(i.method),status:"waiting".into(),last_error:None};
                self.vault.save(FILE,&state)?;
            }
            "subscription.disable"=>{let i:crate::request_input::Request=serde_json::from_value(c.input.clone())?;let r=self.request_record(i.request_id).await?;anyhow::ensure!(r.local_role==Some(Role::Payer) && recurrence(&r)?.is_some(),"Only the subscription payer can disable autopay.");self.disable_subscription(&r.payment_request_id)?;}
            "clock.set"=>{let i:ClockSet=serde_json::from_value(c.input.clone())?;self.clock.set(&self.vault,Some(&i.now)).map_err(|_|error("Application time cannot move backwards. Choose a later canonical UTC time."))?;}
            "clock.reset"=>self.clock.set(&self.vault,None).map_err(|_|error("System time is behind application time. Keep the controlled clock until system time catches up."))?,
            _=>anyhow::bail!("unknown subscription command")
        }
        self.project_subscriptions().await?;
        Ok(json!({"receiverId":self.state.view.receiver_id,"workspace":self.state.view}))
    }
    pub(super) fn disable_subscription(&self, request: &str) -> anyhow::Result<()> {
        let mut state = self.subscriptions()?;
        if let Some(a) = state
            .authorizations
            .get_mut(request)
            .filter(|a| a.view.enabled)
        {
            a.view.enabled = false;
            a.view.status = "disabled".into();
            self.vault.save(FILE, &state)?;
        }
        Ok(())
    }
    async fn prepare_period(&mut self, c: &Command) -> anyhow::Result<()> {
        let i: Prepare = serde_json::from_value(c.input.clone())?;
        let r = self.request_record(i.request_id).await?;
        anyhow::ensure!(
            active(&r) && r.local_role == Some(Role::Payee),
            "Only payee prepares an accepted subscription."
        );
        let period = period_for(&r, Some(i.period_index))?.expect("recurring period");
        anyhow::ensure!(
            crate::recurrence::timestamp(&period.starts_at)? <= self.clock.now(),
            "Future periods cannot be prepared."
        );
        let mut state = self.subscriptions()?;
        let k = key(&r.payment_request_id, i.period_index);
        if let Some(prepared) = state.preparations.get(&k) {
            if prepared.source != i.source || prepared.expiry_seconds != i.expiry_seconds {
                return Err(error("This period already has immutable preparation terms. Keep its original source and expiry."));
            }
            if self.period_offer(&r, i.period_index).await?.is_some() {
                self.request_bindings(&r, Some(i.period_index)).await?;
                return Ok(());
            }
            return Err(error("Period preparation is incomplete. Inspect reservations and SDK history; do not create another offer or reuse an endpoint."));
        }
        if self.period_offer(&r, i.period_index).await?.is_some() {
            return Err(error("The period offer has no local reservation claims. Restore the receiver state before continuing."));
        }
        self.ensure_request_send_ready(&r).await?;
        let terms = r.terms.as_ref().expect("recurring terms");
        let enabled = self.payments.snapshot()?.methods.enabled_methods;
        let methods =
            accepted_enabled_methods(&enabled, &terms.accepted_payment_endpoint_identifiers);
        anyhow::ensure!(
            !methods.is_empty(),
            "Configure receiving methods accepted by this subscription."
        );
        let predicted: Vec<_> = methods
            .iter()
            .map(|method| EndpointCommitment {
                source: i.source.clone(),
                method: method.clone(),
                reservation_id: Uuid::new_v5(&c.command_id, method.as_bytes()).to_string(),
                endpoint_hash: "0".repeat(64),
            })
            .collect();
        ensure_offer_fits(&offer_terms(&r, i.period_index, predicted)?)?;
        self.payments.ensure_new_issuance()?;
        state.preparations.insert(
            k.clone(),
            Preparation {
                command_id: c.command_id,
                request_id: r.payment_request_id.clone(),
                period_index: i.period_index,
                source: i.source.clone(),
                expiry_seconds: i.expiry_seconds,
                bindings: vec![],
            },
        );
        self.vault.save(FILE, &state)?;
        if i.source == "public" {
            self.retire_public("superseded").await?;
        } else {
            let old: Vec<_> = self
                .payments
                .snapshot()?
                .records
                .iter()
                .filter(|v| {
                    v.view.peer_public_key.as_deref() == Some(r.counterparty.as_str())
                        && v.view.peer_receiver_path.as_deref()
                            == Some(r.counterparty_receiver_path.as_str())
                        && crate::wallet_adapter::eligible(&v.view)
                })
                .map(|v| v.view.list_id.clone())
                .collect();
            for list in old {
                self.payments.retire_list(&list, "superseded")?;
            }
            self.cleanup_retired().await?;
        }
        let peer = (i.source == "private").then(|| {
            (
                r.counterparty.to_string(),
                r.counterparty_receiver_path.to_string(),
            )
        });
        let ids = self.payments.begin_list_for_methods(
            c.command_id,
            peer,
            terms.amount.value.clone(),
            i.expiry_seconds,
            &methods,
        )?;
        for id in &ids {
            self.payments.issue(id, false).await?;
        }
        let bindings: Vec<_> = self
            .payments
            .snapshot()?
            .records
            .into_iter()
            .filter(|v| ids.contains(&v.view.id))
            .map(|v| {
                Ok(EndpointBinding {
                    source: v.view.source,
                    method: v.view.method,
                    endpoint: v
                        .view
                        .endpoint
                        .ok_or_else(|| anyhow::anyhow!("endpoint missing"))?,
                    reservation_id: v.view.id,
                })
            })
            .collect::<anyhow::Result<_>>()?;
        anyhow::ensure!(
            bindings.len() == ids.len() && !bindings.is_empty(),
            "period endpoints incomplete"
        );
        for prepared in state
            .preparations
            .values()
            .filter(|v| v.command_id != c.command_id)
        {
            anyhow::ensure!(
                !prepared.bindings.iter().any(|old| bindings
                    .iter()
                    .any(|new| new.reservation_id == old.reservation_id
                        || new.endpoint == old.endpoint)),
                "An endpoint cannot be reused by another period."
            );
        }
        state
            .preparations
            .get_mut(&k)
            .expect("saved preparation")
            .bindings = bindings.clone();
        self.vault.save(FILE, &state)?;
        let commitments = bindings
            .iter()
            .map(EndpointCommitment::from_binding)
            .collect();
        let offer = offer_terms(&r, i.period_index, commitments)?;
        ensure_offer_fits(&offer)?;
        if i.source == "public" {
            self.publish_current().await?;
        } else {
            self.queue_current(
                r.counterparty.as_str(),
                r.counterparty_receiver_path.as_str(),
                &c.command_id.to_string(),
            )
            .await?;
        }
        self.sdk
            .propose_payment_request(r.counterparty, r.counterparty_receiver_path, offer)
            .await?;
        Ok(())
    }
    pub(super) async fn period_offer(
        &self,
        parent: &PaymentRequestRecord,
        index: u32,
    ) -> anyhow::Result<Option<PaymentRequestRecord>> {
        let records = self.sdk.payment_requests().await?;
        Ok(find_offer(&records, parent, index)?.cloned())
    }
    pub(super) async fn request_bindings(
        &self,
        record: &PaymentRequestRecord,
        index: Option<u32>,
    ) -> anyhow::Result<Vec<EndpointBinding>> {
        let Some(index) = index else {
            return super::requests::bindings(
                record
                    .terms
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("terms missing"))?,
            );
        };
        let offer=self.period_offer(record,index).await?.ok_or_else(||error("This period has no endpoint offer. Ask the payee to prepare it and synchronize delivery."))?;
        let commitments = offer_commitments(offer.terms.as_ref().expect("validated offer"))?;
        let state = self.subscriptions()?;
        let spends = SpendState::open(&self.spend_vault()?)?;
        let ledger = self.payments.snapshot()?;
        full_period_bindings(
            record,
            index,
            &commitments,
            &state,
            &spends,
            &ledger,
            self.state.view.receiver_id,
        )
    }
    pub(super) async fn subscription_background(&mut self) -> anyhow::Result<()> {
        if self.state.view.delivery_paused
            || !self.recovery_allows_automation()
            || !self.state.uncertain_peers.is_empty()
        {
            return Ok(());
        }
        for r in self.sdk.payment_requests().await? {
            if !active(&r) {
                self.disable_subscription(&r.payment_request_id)?;
                continue;
            }
            let Ok(Some(schedule)) = recurrence(&r) else {
                continue;
            };
            let mut state = self.subscriptions()?;
            let Some(a) = state
                .authorizations
                .get_mut(&r.payment_request_id)
                .filter(|a| a.view.enabled)
            else {
                continue;
            };
            let Ok(Some(index)) = schedule.current(self.clock.now()) else {
                continue;
            };
            if !a.observe(index) {
                continue;
            }
            self.vault.save(FILE, &state)?;
            match self.period_offer(&r, index).await {
                Ok(Some(_)) => {}
                Ok(None) => continue,
                Err(_) => {
                    let a = state
                        .authorizations
                        .get_mut(&r.payment_request_id)
                        .expect("authorization");
                    a.view.status = "blocked".into();
                    a.view.last_error = Some(
                        "Conflicting period offer. Restore valid peer history before paying."
                            .into(),
                    );
                    self.vault.save(FILE, &state)?;
                    continue;
                }
            }
            let a = state
                .authorizations
                .get_mut(&r.payment_request_id)
                .expect("authorization");
            let id = Uuid::new_v4();
            a.attempts.insert(index, id);
            a.view.status = "attempted".into();
            let selection = a.view.clone();
            self.vault.save(FILE, &state)?;
            let command = Command {
                command_id: id,
                command: "payment.execute".into(),
                input: json!({"receiverId":self.state.view.receiver_id,"requestId":r.payment_request_id,"periodIndex":index,"walletId":selection.wallet_id,"source":selection.source,"method":selection.method}),
            };
            let result = self.execute_request(&command).await;
            let result = match result {
                Ok(()) => {
                    let spends = SpendState::open(&self.spend_vault()?)?;
                    if let Some(e) = spends
                        .existing_period(
                            self.state.view.receiver_id,
                            &r.payment_request_id,
                            Some(index),
                        )
                        .filter(|e| e.view.status == "succeeded")
                    {
                        self.submit_proof(&Command{command_id:Uuid::new_v4(),command:"proof.submit".into(),input:json!({"receiverId":self.state.view.receiver_id,"requestId":r.payment_request_id,"executionId":e.view.id})}).await
                    } else {
                        Err(error("Automatic payment did not succeed. Inspect the execution and reconcile uncertain wallet outcomes."))
                    }
                }
                Err(e) => Err(e),
            };
            if result.is_err() {
                let mut state = self.subscriptions()?;
                let a = state
                    .authorizations
                    .get_mut(&r.payment_request_id)
                    .expect("authorization");
                a.view.status = "blocked".into();
                a.view.last_error=Some("Automatic payment or proof submission stopped. Inspect the period and execution; reconcile uncertain outcomes. Expired invoices require a new subscription, not endpoint reuse.".into());
                self.vault.save(FILE, &state)?;
            }
        }
        Ok(())
    }
    pub(super) async fn project_subscriptions(&mut self) -> anyhow::Result<()> {
        let state = self.subscriptions()?;
        let spends = SpendState::open(&self.spend_vault()?)?;
        let mut views = vec![];
        let records = self.sdk.payment_requests().await?;
        let ledger = self.payments.snapshot()?;
        for r in &records {
            let Ok(Some(schedule)) = recurrence(r) else {
                continue;
            };
            let current = schedule.current(self.clock.now()).unwrap_or(None);
            let maximum = schedule.latest_started(self.clock.now()).unwrap_or(0);
            let mut periods = vec![];
            let mut indices: std::collections::BTreeSet<_> =
                (maximum.saturating_sub(127)..=maximum).collect();
            indices.extend(
                state
                    .preparations
                    .values()
                    .filter(|p| p.request_id == r.payment_request_id)
                    .map(|p| p.period_index),
            );
            indices.extend(
                spends
                    .executions
                    .iter()
                    .filter(|e| {
                        e.receiver_id == self.state.view.receiver_id
                            && e.view.request_id == r.payment_request_id
                    })
                    .filter_map(|e| e.view.period_index),
            );
            indices.extend(
                r.payment_proofs
                    .iter()
                    .filter_map(|p| proof_period(r, p.billing_period.as_ref()).ok().flatten()),
            );
            for index in projected_indices(&records, r, indices) {
                let Ok(period) = schedule.period(index) else {
                    continue;
                };
                let status = if crate::recurrence::timestamp(&period.starts_at)? > self.clock.now()
                {
                    "future"
                } else if crate::recurrence::timestamp(&period.ends_at)? <= self.clock.now() {
                    "missed"
                } else {
                    "due"
                };
                let mut view = PeriodView::new(index, period, status);
                match find_offer(&records, r, index) {
                    Ok(Some(offer)) => {
                        view.offer_id = Some(offer.payment_request_id.clone());
                        view.endpoint_commitments =
                            offer_commitments(offer.terms.as_ref().expect("offer terms"))?;
                        match full_period_bindings(r, index, &view.endpoint_commitments, &state, &spends, &ledger, self.state.view.receiver_id) {
                            Ok(bindings) => view.endpoint_bindings = bindings,
                            Err(_) => view.last_error = Some("Period commitments do not match local reservation claims. Restore valid receiver state.".into()),
                        }
                        view.status = "prepared".into();
                    }
                    Err(_) => {
                        view.last_error =
                            Some("Conflicting or invalid period offer requires recovery.".into())
                    }
                    _ => {}
                }
                if let Some(e) = spends.existing_period(
                    self.state.view.receiver_id,
                    &r.payment_request_id,
                    Some(index),
                ) {
                    view.execution_id = Some(e.view.id.clone());
                    view.last_error = e.view.last_error.clone();
                    if e.view.status == "succeeded" {
                        view.status = "executed".into();
                    }
                }
                if let Some(p) = r
                    .payment_proofs
                    .iter()
                    .find(|p| proof_period(r, p.billing_period.as_ref()).ok() == Some(Some(index)))
                {
                    view.proof_id = Some(p.event_id.clone());
                    view.status = "proofSubmitted".into();
                    if self
                        .state
                        .view
                        .settlements
                        .iter()
                        .any(|s| s.proof_id == p.event_id && s.status == "verified")
                    {
                        view.status = "verified".into();
                    }
                }
                if state
                    .preparations
                    .contains_key(&key(&r.payment_request_id, index))
                    && view.offer_id.is_none()
                {
                    view.last_error=Some("Preparation interrupted. Inspect reservations and SDK history before proceeding.".into());
                }
                if state
                    .authorizations
                    .get(&r.payment_request_id)
                    .is_some_and(|a| a.attempts.contains_key(&index))
                    && view.execution_id.is_none()
                    && view.last_error.is_none()
                {
                    view.last_error = Some("Automatic attempt stopped before a wallet execution was recorded. Inspect the offer and wallet; manual payment is required.".into());
                }
                periods.push(view);
            }
            let mut autopay = state
                .authorizations
                .get(&r.payment_request_id)
                .map(|a| a.view.clone())
                .unwrap_or_default();
            if autopay.enabled {
                if let Some(index) = current {
                    let attempted = state
                        .authorizations
                        .get(&r.payment_request_id)
                        .is_some_and(|a| a.attempts.contains_key(&index));
                    if !attempted {
                        autopay.status = "waiting".into();
                        autopay.last_error = None;
                    } else if periods
                        .iter()
                        .find(|p| p.index == index)
                        .is_some_and(|p| p.last_error.is_some())
                    {
                        autopay.status = "blocked".into();
                    } else {
                        autopay.status = "attempted".into();
                    }
                }
            }
            if !active(r) {
                autopay.enabled = false;
                autopay.status = "disabled".into();
            }
            views.push(SubscriptionView {
                request_id: r.payment_request_id.clone(),
                current_period_index: current,
                autopay,
                periods,
            });
        }
        self.state.view.subscriptions = views;
        Ok(())
    }
}
fn projected_indices(
    records: &[PaymentRequestRecord],
    parent: &PaymentRequestRecord,
    mut history: std::collections::BTreeSet<u32>,
) -> std::collections::BTreeSet<u32> {
    let paid: std::collections::BTreeSet<_> = parent
        .payment_proofs
        .iter()
        .filter_map(|p| {
            proof_period(parent, p.billing_period.as_ref())
                .ok()
                .flatten()
        })
        .collect();
    let mut actionable = std::collections::BTreeSet::new();
    let incoming: std::collections::BTreeSet<_> = records
        .iter()
        .filter_map(|candidate| {
            let terms = candidate.terms.as_ref()?;
            if terms.metadata.get("parentRequestId") != Some(&json!(parent.payment_request_id)) {
                return None;
            }
            terms
                .metadata
                .get("periodIndex")
                .and_then(Value::as_u64)
                .and_then(|i| u32::try_from(i).ok())
        })
        .collect();
    for index in incoming {
        if find_offer(records, parent, index).is_ok_and(|offer| offer.is_some()) {
            history.insert(index);
            if !paid.contains(&index) {
                actionable.insert(index);
            }
        }
    }
    // Keep the oldest unpaid offers actionable even when recent history fills the cap.
    let mut selected: std::collections::BTreeSet<_> = actionable.into_iter().take(256).collect();
    for index in history.into_iter().rev() {
        if selected.len() == 256 {
            break;
        }
        selected.insert(index);
    }
    selected
}

fn offer_terms(
    parent: &PaymentRequestRecord,
    index: u32,
    commitments: Vec<EndpointCommitment>,
) -> anyhow::Result<paykit_lib::PaymentRequestTerms> {
    let parent_terms = parent
        .terms
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("parent terms missing"))?;
    period_for(parent, Some(index))?;
    Ok(paykit_lib::PaymentRequestTerms {
        amount: paykit_lib::PaymentAmount::new(parent_terms.amount.value.clone(), "sat")?,
        payment_reference: paykit_lib::PaymentReference::new(correlation(&parent.payment_request_id,index))?,
        proposal_expires_at: None, recurrence: None,
        accepted_payment_endpoint_identifiers: commitments.iter().map(|c| paykit_lib::PaymentEndpointIdentifier::new(&c.method)).collect::<Result<_,_>>()?,
        metadata: json!({"polarPaykitPeriodVersion":2,"parentRequestId":parent.payment_request_id,"periodIndex":index,"endpointCommitments":commitments}).as_object().expect("object").clone(),
    })
}

fn accepted_enabled_methods(enabled: &[String], accepted: &[String]) -> Vec<String> {
    enabled
        .iter()
        .filter(|method| accepted.contains(method))
        .cloned()
        .collect()
}
fn serialized_offer(terms: &paykit_lib::PaymentRequestTerms) -> anyhow::Result<String> {
    // SDK-generated event/request UUIDs always have this same encoded length.
    let request = paykit_lib::PaymentRequest::new(
        paykit_lib::EventId::new_v4(),
        paykit_lib::PaymentRequestId::new_v4(),
        terms.clone(),
    );
    Ok(paykit_lib::serialize_payment_request_event(
        &paykit_lib::PaymentRequestEvent::Request(request),
    )?)
}
fn ensure_offer_fits(terms: &paykit_lib::PaymentRequestTerms) -> anyhow::Result<()> {
    if serialized_offer(terms)?.len() > paykit_lib::pubky_noise::snow_crypto::PUBKY_NOISE_MSG_LEN {
        return Err(error("Period offer exceeds the encrypted message limit. Configure fewer receiving methods before preparing this period."));
    }
    Ok(())
}
fn offer_commitments(
    terms: &paykit_sdk::PaymentRequestTermsRecord,
) -> anyhow::Result<Vec<EndpointCommitment>> {
    let commitments: Vec<EndpointCommitment> = match terms
        .metadata
        .get("polarPaykitPeriodVersion")
        .and_then(Value::as_u64)
    {
        Some(1) => super::requests::bindings(terms)?
            .iter()
            .map(EndpointCommitment::from_binding)
            .collect(),
        Some(2) => serde_json::from_value(
            terms
                .metadata
                .get("endpointCommitments")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("commitments missing"))?,
        )?,
        _ => anyhow::bail!("unsupported period offer version"),
    };
    anyhow::ensure!(
        !commitments.is_empty() && commitments.len() <= 2,
        "invalid period commitment count"
    );
    let mut methods = std::collections::BTreeSet::new();
    let mut reservations = std::collections::BTreeSet::new();
    for c in &commitments {
        let id = Uuid::parse_str(&c.reservation_id)?;
        anyhow::ensure!(
            matches!(c.source.as_str(), "public" | "private")
                && c.source == commitments[0].source
                && !id.is_nil()
                && id.to_string() == c.reservation_id
                && c.endpoint_hash.len() == 64
                && c.endpoint_hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && methods.insert(c.method.clone())
                && reservations.insert(c.reservation_id.clone())
                && terms
                    .accepted_payment_endpoint_identifiers
                    .contains(&c.method),
            "invalid period commitment"
        );
        crate::payment_model::methods(std::slice::from_ref(&c.method), false)?;
    }
    anyhow::ensure!(
        terms
            .accepted_payment_endpoint_identifiers
            .iter()
            .all(|m| methods.contains(m)),
        "missing accepted method commitment"
    );
    Ok(commitments)
}
fn full_period_bindings(
    record: &PaymentRequestRecord,
    index: u32,
    commitments: &[EndpointCommitment],
    state: &SubscriptionState,
    spends: &SpendState,
    ledger: &crate::wallet_adapter::Ledger,
    receiver: Uuid,
) -> anyhow::Result<Vec<EndpointBinding>> {
    if record.local_role == Some(Role::Payee) {
        let local = state
            .preparations
            .get(&key(&record.payment_request_id, index))
            .ok_or_else(|| anyhow::anyhow!("period reservation claims missing"))?;
        anyhow::ensure!(
            local.request_id == record.payment_request_id
                && local.period_index == index
                && local.bindings.len() == commitments.len()
                && local.bindings.iter().all(|b| commitments
                    .iter()
                    .any(|c| c.reservation_id == b.reservation_id
                        && c.matches(&b.source, &b.method, &b.endpoint))),
            "Period offer differs from durable reservation claims."
        );
        return Ok(local.bindings.clone());
    }
    let mut bindings = vec![];
    for c in commitments {
        let executed = spends
            .existing_period(receiver, &record.payment_request_id, Some(index))
            .filter(|e| c.matches(&e.view.source, &e.view.method, &e.view.endpoint))
            .map(|e| e.view.endpoint.as_str());
        let resolved = ledger
            .resolutions
            .iter()
            .rev()
            .find(|r| {
                r.peer_public_key == record.counterparty.as_str()
                    && r.peer_receiver_path == record.counterparty_receiver_path.as_str()
                    && r.status == "payable"
                    && r.method
                        .as_ref()
                        .zip(r.endpoint.as_ref())
                        .is_some_and(|(m, e)| c.matches(&r.source, m, e))
            })
            .and_then(|r| r.endpoint.as_deref());
        if let Some(endpoint) = executed.or(resolved) {
            bindings.push(c.binding(endpoint));
        }
    }
    Ok(bindings)
}

fn validate_offer(
    parent: &PaymentRequestRecord,
    offer: &PaymentRequestRecord,
    index: u32,
) -> anyhow::Result<()> {
    let p = parent
        .terms
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("parent terms missing"))?;
    let o = offer
        .terms
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("offer terms missing"))?;
    let period = period_for(parent, Some(index))?.expect("recurring period");
    anyhow::ensure!(
        is_offer(offer)
            && offer.counterparty == parent.counterparty
            && offer.counterparty_receiver_path == parent.counterparty_receiver_path
            && offer.local_role == parent.local_role
            && offer.invalid_reason.is_none()
            && offer.state == Lifecycle::Proposed
            && o.recurrence.is_none()
            && o.metadata.get("parentRequestId") == Some(&json!(parent.payment_request_id))
            && o.metadata.get("periodIndex") == Some(&json!(index))
            && o.amount == p.amount
            && o.payment_reference == correlation(&parent.payment_request_id, index)
            && !o.accepted_payment_endpoint_identifiers.is_empty()
            && o.accepted_payment_endpoint_identifiers
                .iter()
                .all(|m| p.accepted_payment_endpoint_identifiers.contains(m)),
        "Period offer does not match its immutable parent, peer, amount or schedule."
    );
    if o.metadata.get("polarPaykitPeriodVersion") == Some(&json!(1)) {
        anyhow::ensure!(
            o.metadata.get("billingPeriod") == Some(&json!(period)),
            "Legacy offer period does not match its parent."
        );
    } else {
        anyhow::ensure!(
            o.metadata.get("polarPaykitPeriodVersion") == Some(&json!(2)) && o.metadata.len() == 4,
            "Unsupported or malformed period offer version."
        );
    }
    offer_commitments(o)?;
    Ok(())
}

fn find_offer<'a>(
    records: &'a [PaymentRequestRecord],
    parent: &PaymentRequestRecord,
    index: u32,
) -> anyhow::Result<Option<&'a PaymentRequestRecord>> {
    let mut found = None;
    for candidate in records {
        let Some(terms) = &candidate.terms else {
            continue;
        };
        if terms.metadata.get("parentRequestId") != Some(&json!(parent.payment_request_id))
            || terms.metadata.get("periodIndex") != Some(&json!(index))
        {
            continue;
        }
        validate_offer(parent, candidate, index)?;
        anyhow::ensure!(
            found.is_none(),
            "Conflicting period offers require recovery."
        );
        found = Some(candidate);
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parent() -> PaymentRequestRecord {
        serde_json::from_value(json!({"counterparty":pubky::Keypair::from_secret(&[81;32]).public_key().z32(),"counterparty_receiver_path":"test/wallet","payment_request_id":Uuid::new_v4(),"proposal_event_id":Uuid::new_v4(),"local_role":"Payer","state":"ActiveRecurring","terms":{"amount":{"value":"5000","asset":"sat"},"payment_reference":"subscription-fixture","accepted_payment_endpoint_identifiers":["btc-onchain"],"recurrence":{"every":1,"unit":"month","starts_at":"2026-01-31T00:00:00Z","anchor":"2026-01-31T00:00:00Z","ends_at":null},"metadata":{}},"payment_proofs":[]})).unwrap()
    }
    fn offer(parent: &PaymentRequestRecord, index: u32) -> PaymentRequestRecord {
        let mut offer = parent.clone();
        offer.payment_request_id = Uuid::new_v4().to_string();
        offer.state = Lifecycle::Proposed;
        let terms = offer.terms.as_mut().unwrap();
        terms.recurrence = None;
        terms.payment_reference = correlation(&parent.payment_request_id, index);
        terms.metadata=json!({"polarPaykitPeriodVersion":1,"parentRequestId":parent.payment_request_id,"periodIndex":index,"billingPeriod":period_for(parent,Some(index)).unwrap(),"polarPaykitEndpoints":[{"source":"private","method":"btc-onchain","endpoint":"bcrt1qfixture","reservationId":Uuid::new_v4()}]}).as_object().unwrap().clone();
        offer
    }
    #[test]
    fn period_offer_rejects_peer_path_amount_schedule_and_duplicate_conflicts() {
        let parent = parent();
        let original = offer(&parent, 1);
        assert!(validate_offer(&parent, &original, 1).is_ok());
        let mut other_path = original.clone();
        other_path.counterparty_receiver_path =
            paykit_sdk::PaykitReceiverPath::new("test/server").unwrap();
        let mut other_owner = original.clone();
        other_owner.counterparty = paykit_sdk::PubkyPublicKey::from_public_key(
            &pubky::Keypair::from_secret(&[82; 32]).public_key(),
        );
        let mut wrong_amount = original.clone();
        wrong_amount.terms.as_mut().unwrap().amount.value = "5001".into();
        let mut wrong_period = original.clone();
        wrong_period.terms.as_mut().unwrap().metadata.insert(
            "billingPeriod".into(),
            json!({"startsAt":"2026-02-28T00:00:00Z","endsAt":"2026-03-28T00:00:00Z"}),
        );
        for invalid in [other_path, other_owner, wrong_amount, wrong_period] {
            assert!(validate_offer(&parent, &invalid, 1).is_err());
        }
        assert!(find_offer(&[original.clone(), original], &parent, 1).is_err());
    }
    #[test]
    fn missed_periods_and_attempt_markers_survive_restart_without_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let vault =
            crate::storage::Vault::new(dir.path().into(), [83; 32], "subscription-test".into())
                .unwrap();
        let mut authorization = Authorization::default();
        authorization.view.enabled = true;
        assert!(authorization.observe(0));
        authorization.attempts.insert(0, Uuid::new_v4());
        assert!(authorization.observe(3));
        vault.save(FILE, &authorization).unwrap();
        let mut restored: Authorization = vault.load(FILE).unwrap().unwrap();
        assert!(!restored.observe(1));
        assert!(!restored.observe(2));
        assert!(restored.observe(3));
        restored.attempts.insert(3, Uuid::new_v4());
        assert!(!restored.observe(3));
        assert_eq!(restored.attempts.len(), 2);
    }
    #[test]
    fn recurring_proof_requires_exact_anchored_period() {
        let r = parent();
        assert!(proof_period(&r, None).is_err());
        let period = period_for(&r, Some(1)).unwrap().unwrap();
        let mut record = paykit_sdk::BillingPeriodRecord {
            starts_at: period.starts_at,
            ends_at: period.ends_at,
        };
        assert_eq!(proof_period(&r, Some(&record)).unwrap(), Some(1));
        record.ends_at = "2026-03-28T00:00:00Z".into();
        assert!(proof_period(&r, Some(&record)).is_err());
    }
    fn v2_offer(parent: &PaymentRequestRecord, index: u32) -> PaymentRequestRecord {
        let legacy = offer(parent, index);
        let commitments = offer_commitments(legacy.terms.as_ref().unwrap()).unwrap();
        let mut record = legacy;
        record.terms = Some(paykit_sdk::PaymentRequestTermsRecord::from(
            &offer_terms(parent, index, commitments).unwrap(),
        ));
        record
    }
    #[test]
    fn old_incoming_manual_offer_survives_a_full_recent_history_cap() {
        let mut parent = parent();
        parent
            .terms
            .as_mut()
            .unwrap()
            .recurrence
            .as_mut()
            .unwrap()
            .unit = "minute".into();
        let incoming = v2_offer(&parent, 0);
        let history = (128..=512).collect();
        let projected = projected_indices(std::slice::from_ref(&incoming), &parent, history);
        assert_eq!(projected.len(), 256);
        assert!(projected.contains(&0));
        assert!(projected.contains(&512));
        let retained = find_offer(&[incoming], &parent, 0)
            .unwrap()
            .unwrap()
            .clone();
        assert!(!offer_commitments(retained.terms.as_ref().unwrap())
            .unwrap()
            .is_empty());
        let mut authorization = Authorization::default();
        assert!(authorization.observe(512));
        assert!(!authorization.observe(0));
    }
    #[test]
    fn invalid_or_conflicting_old_offers_do_not_displace_history() {
        let parent = parent();
        let mut bad = v2_offer(&parent, 0);
        bad.counterparty_receiver_path =
            paykit_sdk::PaykitReceiverPath::new("other/wallet").unwrap();
        assert!(!projected_indices(&[bad], &parent, (128..=383).collect()).contains(&0));
        let valid = v2_offer(&parent, 0);
        assert!(
            !projected_indices(&[valid.clone(), valid], &parent, (128..=383).collect())
                .contains(&0)
        );
    }
    #[test]
    fn compact_offer_does_not_duplicate_invoice_and_both_rails_fit() {
        let mut parent = parent();
        parent.counterparty_receiver_path =
            paykit_sdk::PaykitReceiverPath::new(format!("{}/wallet", "a".repeat(64))).unwrap();
        parent.terms.as_mut().unwrap().amount.value = crate::payment_model::MAX_SATS.to_string();
        parent
            .terms
            .as_mut()
            .unwrap()
            .recurrence
            .as_mut()
            .unwrap()
            .unit = "minute".into();
        parent
            .terms
            .as_mut()
            .unwrap()
            .accepted_payment_endpoint_identifiers
            .push(crate::payment_model::BOLT11.into());
        let invoice = "l".repeat(299);
        let bindings = [
            EndpointBinding {
                source: "private".into(),
                method: crate::payment_model::ONCHAIN.into(),
                reservation_id: Uuid::new_v4().to_string(),
                endpoint: "b".repeat(64),
            },
            EndpointBinding {
                source: "private".into(),
                method: crate::payment_model::BOLT11.into(),
                reservation_id: Uuid::new_v4().to_string(),
                endpoint: invoice.clone(),
            },
        ];
        let terms = offer_terms(
            &parent,
            10_000,
            bindings
                .iter()
                .map(EndpointCommitment::from_binding)
                .collect(),
        )
        .unwrap();
        ensure_offer_fits(&terms).unwrap();
        let serialized = serialized_offer(&terms).unwrap();
        assert!(!serialized.contains(&invoice));
        assert!(!serialized.contains(parent.counterparty_receiver_path.as_str()));
        let mut legacy = terms.clone();
        legacy.metadata=json!({"polarPaykitPeriodVersion":1,"parentRequestId":parent.payment_request_id,"periodIndex":0,"billingPeriod":{"startsAt":"2026-01-31T00:00:00Z","endsAt":"2026-02-28T00:00:00Z"},"polarPaykitEndpoints":bindings,"description":"Subscription period endpoint offer"}).as_object().unwrap().clone();
        assert!(ensure_offer_fits(&legacy).is_err());
    }
    #[test]
    fn exact_sdk_noise_frame_boundary_is_checked_without_relaxing_limit() {
        let parent = parent();
        let record = v2_offer(&parent, 0);
        let commitments = offer_commitments(record.terms.as_ref().unwrap()).unwrap();
        let mut terms = offer_terms(&parent, 0, commitments).unwrap();
        terms.metadata.insert("padding".into(), json!(""));
        let overhead = serialized_offer(&terms).unwrap().len();
        let limit = paykit_lib::pubky_noise::snow_crypto::PUBKY_NOISE_MSG_LEN;
        assert_eq!(limit, 1000);
        terms
            .metadata
            .insert("padding".into(), json!("x".repeat(limit - overhead)));
        assert_eq!(serialized_offer(&terms).unwrap().len(), limit);
        ensure_offer_fits(&terms).unwrap();
        terms
            .metadata
            .insert("padding".into(), json!("x".repeat(limit - overhead + 1)));
        assert!(ensure_offer_fits(&terms).is_err());
    }
    #[test]
    fn v2_offer_rejects_peer_parent_period_source_and_malformed_hash() {
        let parent = parent();
        let original = v2_offer(&parent, 1);
        validate_offer(&parent, &original, 1).unwrap();
        for (field, value) in [
            ("parentRequestId", json!(Uuid::new_v4())),
            ("periodIndex", json!(2)),
            ("polarPaykitPeriodVersion", json!(3)),
        ] {
            let mut bad = original.clone();
            bad.terms
                .as_mut()
                .unwrap()
                .metadata
                .insert(field.into(), value);
            assert!(validate_offer(&parent, &bad, 1).is_err());
        }
        let mut peer = original.clone();
        peer.counterparty_receiver_path =
            paykit_sdk::PaykitReceiverPath::new("other/wallet").unwrap();
        assert!(validate_offer(&parent, &peer, 1).is_err());
        for (field, value) in [
            ("source", json!("automatic")),
            ("endpointHash", json!("AB".repeat(32))),
            ("reservationId", json!(Uuid::nil())),
        ] {
            let mut bad = original.clone();
            bad.terms
                .as_mut()
                .unwrap()
                .metadata
                .get_mut("endpointCommitments")
                .unwrap()[0][field] = value;
            assert!(validate_offer(&parent, &bad, 1).is_err());
        }
    }
    #[test]
    fn restored_payee_claims_validate_legacy_and_compact_offers_identically() {
        let mut parent = parent();
        parent.local_role = Some(Role::Payee);
        let legacy = offer(&parent, 0);
        let bindings = super::super::requests::bindings(legacy.terms.as_ref().unwrap()).unwrap();
        let commitments: Vec<_> = bindings
            .iter()
            .map(EndpointCommitment::from_binding)
            .collect();
        let mut compact = legacy.clone();
        compact.terms = Some(paykit_sdk::PaymentRequestTermsRecord::from(
            &offer_terms(&parent, 0, commitments.clone()).unwrap(),
        ));
        let mut state = SubscriptionState::default();
        state.preparations.insert(
            key(&parent.payment_request_id, 0),
            Preparation {
                command_id: Uuid::new_v4(),
                request_id: parent.payment_request_id.clone(),
                period_index: 0,
                source: "private".into(),
                expiry_seconds: 600,
                bindings,
            },
        );
        let dir = tempfile::tempdir().unwrap();
        let vault = crate::storage::Vault::new(dir.path().into(), [84; 32], "period-claims".into())
            .unwrap();
        vault.save(FILE, &state).unwrap();
        let restored = vault.load(FILE).unwrap().unwrap();
        let spends = SpendState::default();
        let ledger = crate::wallet_adapter::Ledger::default();
        let receiver = Uuid::new_v4();
        for record in [&legacy, &compact] {
            validate_offer(&parent, record, 0).unwrap();
            let parsed = offer_commitments(record.terms.as_ref().unwrap()).unwrap();
            assert_eq!(parsed, commitments);
            assert_eq!(
                full_period_bindings(&parent, 0, &parsed, &restored, &spends, &ledger, receiver)
                    .unwrap()[0]
                    .endpoint,
                "bcrt1qfixture"
            );
        }
        for field in ["hash", "source", "reservation"] {
            let mut bad = commitments.clone();
            match field {
                "hash" => bad[0].endpoint_hash = "a".repeat(64),
                "source" => bad[0].source = "public".into(),
                _ => bad[0].reservation_id = Uuid::new_v4().to_string(),
            }
            assert!(
                full_period_bindings(&parent, 0, &bad, &restored, &spends, &ledger, receiver)
                    .is_err()
            );
        }
        assert!(full_period_bindings(
            &parent,
            1,
            &commitments,
            &restored,
            &spends,
            &ledger,
            receiver
        )
        .is_err());
    }
    #[test]
    fn hash_preview_cannot_turn_into_an_endpoint_without_matching_explicit_resolution() {
        let parent = parent();
        let record = v2_offer(&parent, 0);
        let commitments = offer_commitments(record.terms.as_ref().unwrap()).unwrap();
        let mut ledger = crate::wallet_adapter::Ledger::default();
        let receiver = Uuid::new_v4();
        let state = SubscriptionState::default();
        let spends = SpendState::default();
        assert!(
            full_period_bindings(&parent, 0, &commitments, &state, &spends, &ledger, receiver)
                .unwrap()
                .is_empty()
        );
        let mut resolution = crate::payment_model::ResolutionView {
            id: Uuid::new_v4().to_string(),
            peer_public_key: parent.counterparty.to_string(),
            peer_receiver_path: parent.counterparty_receiver_path.to_string(),
            source: "private".into(),
            amount_sats: "5000".into(),
            created_at: "2026-01-31T00:00:00Z".into(),
            method: Some(crate::payment_model::ONCHAIN.into()),
            endpoint: Some("wrong endpoint".into()),
            version: Some("1".into()),
            expires_at: None,
            status: "payable".into(),
            last_error: None,
        };
        ledger.resolutions.push(resolution.clone());
        assert!(
            full_period_bindings(&parent, 0, &commitments, &state, &spends, &ledger, receiver)
                .unwrap()
                .is_empty()
        );
        resolution.endpoint = Some("bcrt1qfixture".into());
        ledger.resolutions.push(resolution.clone());
        assert_eq!(
            full_period_bindings(&parent, 0, &commitments, &state, &spends, &ledger, receiver)
                .unwrap()[0]
                .endpoint,
            "bcrt1qfixture"
        );
        ledger.resolutions.clear();
        resolution.source = "public".into();
        ledger.resolutions.push(resolution);
        assert!(
            full_period_bindings(&parent, 0, &commitments, &state, &spends, &ledger, receiver)
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn period_methods_intersect_parent_terms_in_configured_order() {
        let enabled = vec![
            crate::payment_model::BOLT11.into(),
            crate::payment_model::ONCHAIN.into(),
        ];
        let onchain_only = vec![crate::payment_model::ONCHAIN.into()];

        assert_eq!(
            accepted_enabled_methods(&enabled, &onchain_only),
            onchain_only
        );
        assert!(accepted_enabled_methods(&enabled, &["unsupported".into()]).is_empty());
    }
}
