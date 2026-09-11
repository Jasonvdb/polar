//! Receiver-scoped encrypted issuance ledger and the SDK receiving adapter.
use crate::{
    payment_model::*,
    storage::Vault,
    wallet_rpc::{self, Wallet},
};
use async_trait::async_trait;
use bitcoin::hashes::{sha256, Hash};
use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
use paykit_sdk::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const LEDGER: &str = "payments.cbor";
pub const WALLET_FAILURE: &str="Wallet issuance or cleanup is uncertain. Reconcile this reservation before creating another endpoint.";
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Record {
    pub view: ReservationView,
    pub wallet: Wallet,
    pub preimage: [u8; 32],
    pub label: String,
    pub expiry_seconds: u32,
    pub issuance_started: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Ledger {
    pub methods: MethodsView,
    pub records: Vec<Record>,
    pub public_list: Option<ListView>,
    pub resolutions: Vec<ResolutionView>,
    pub consumed: BTreeMap<String, u64>,
    pub withdrawals: BTreeMap<String, (String, String)>,
}
#[derive(Clone)]
pub struct WalletAdapter {
    clock: crate::clock::ApplicationClock,
    vault: Arc<Vault>,
    state: Arc<Mutex<Ledger>>,
    environment: Uuid,
    owner: String,
    selection: Arc<Mutex<Vec<String>>>,
}
impl WalletAdapter {
    pub fn open(vault: Arc<Vault>, environment: Uuid, owner: String) -> anyhow::Result<Self> {
        let state: Ledger = vault.load(LEDGER)?.unwrap_or_default();
        let clock = crate::clock::ApplicationClock::open(&vault)?;
        Ok(Self {
            clock,
            vault,
            state: Arc::new(Mutex::new(state)),
            environment,
            owner,
            selection: Arc::new(Mutex::new(vec![])),
        })
    }
    pub(crate) fn clock(&self) -> crate::clock::ApplicationClock {
        self.clock.clone()
    }
    pub(crate) fn execution_vault(&self) -> anyhow::Result<Vault> {
        self.vault.shared_wallets(self.environment)
    }
    pub(crate) fn configured_wallet(&self, id: &str) -> anyhow::Result<Wallet> {
        crate::wallet_rpc::configured(self.environment)?
            .into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| anyhow::anyhow!("trusted wallet missing"))
    }
    pub(crate) fn snapshot(&self) -> anyhow::Result<Ledger> {
        Ok(self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ledger unavailable"))?
            .clone())
    }
    pub(crate) fn update<T>(
        &self,
        change: impl FnOnce(&mut Ledger) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("ledger unavailable"))?;
        let mut next = guard.clone();
        let result = change(&mut next)?;
        refresh_public(&mut next);
        self.vault.save(LEDGER, &next)?;
        *guard = next;
        Ok(result)
    }
    pub fn configure(
        &self,
        wallet_id: String,
        enabled: Vec<String>,
        preference: Vec<String>,
    ) -> anyhow::Result<()> {
        let wallets = wallet_rpc::configured(self.environment)?;
        let wallet = wallets
            .iter()
            .find(|w| w.id == wallet_id)
            .ok_or_else(|| anyhow::anyhow!("configured wallet missing"))?;
        anyhow::ensure!(
            enabled
                .iter()
                .all(|m| wallet.view().supported_methods.contains(m)),
            "wallet does not support chosen methods"
        );
        self.update(|s| {
            anyhow::ensure!(
                s.methods
                    .wallet_id
                    .as_ref()
                    .is_none_or(|id| id == &wallet_id)
                    || s.records
                        .iter()
                        .all(|r| !eligible(&r.view) && r.view.cleanup_status == "complete"),
                "active or uncertain reservations prevent wallet rebinding"
            );
            s.methods = MethodsView {
                wallet_id: Some(wallet_id),
                enabled_methods: enabled,
                preference,
                wallets: wallets.iter().map(Wallet::view).collect(),
            };
            Ok(())
        })
    }
    pub fn prefer(&self, preference: Vec<String>) -> anyhow::Result<()> {
        self.update(|s| {
            anyhow::ensure!(
                preference
                    .iter()
                    .all(|m| s.methods.enabled_methods.contains(m)),
                "preference method is not enabled"
            );
            s.methods.preference = preference;
            Ok(())
        })
    }
    pub fn ensure_new_issuance(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self
                .snapshot()?
                .records
                .iter()
                .any(|r| matches!(r.view.status.as_str(), "issuing" | "uncertain")),
            "reconcile or explicitly cancel uncertain issuance before replacement"
        );
        Ok(())
    }
    pub fn begin_list(
        &self,
        list: Uuid,
        peer: Option<(String, String)>,
        amount: String,
        expiry: u32,
    ) -> anyhow::Result<Vec<String>> {
        let wallets = wallet_rpc::configured(self.environment)?;
        self.update(|s| {
            let existing: Vec<_> = s
                .records
                .iter()
                .filter(|r| r.view.list_id == list.to_string())
                .map(|r| r.view.id.clone())
                .collect();
            if !existing.is_empty() {
                return Ok(existing);
            }
            anyhow::ensure!(
                !s.methods.enabled_methods.is_empty(),
                "configure receiving methods first"
            );
            let wallet = wallets
                .iter()
                .find(|w| Some(&w.id) == s.methods.wallet_id.as_ref())
                .ok_or_else(|| anyhow::anyhow!("configured wallet missing"))?;
            anyhow::ensure!(
                !s.records
                    .iter()
                    .any(|r| matches!(r.view.status.as_str(), "issuing" | "uncertain")),
                "reconcile uncertain issuance before another list"
            );
            let now = self.clock.now();
            let expires = (now + chrono::Duration::seconds(expiry.into())).to_rfc3339();
            let mut ids = vec![];
            for method in &s.methods.enabled_methods {
                let id = Uuid::new_v5(&list, method.as_bytes()).to_string();
                ids.push(id.clone());
                let mut preimage = [0; 32];
                OsRng.fill_bytes(&mut preimage);
                s.records.push(Record {
                    view: ReservationView {
                        id: id.clone(),
                        list_id: list.to_string(),
                        wallet_id: wallet.id.clone(),
                        source: if peer.is_some() { "private" } else { "public" }.into(),
                        peer_public_key: peer.as_ref().map(|p| p.0.clone()),
                        peer_receiver_path: peer.as_ref().map(|p| p.1.clone()),
                        method: method.clone(),
                        endpoint: None,
                        amount_sats: amount.clone(),
                        created_at: now.to_rfc3339(),
                        expires_at: expires.clone(),
                        status: "issuing".into(),
                        delivery_status: "pending".into(),
                        cleanup_status: "notRequired".into(),
                        outbound_message_id: None,
                        last_error: None,
                    },
                    wallet: wallet.clone(),
                    preimage,
                    label: format!("paykit-reservation-{id}"),
                    expiry_seconds: expiry,
                    issuance_started: false,
                });
            }
            if peer.is_none() {
                s.public_list = Some(ListView {
                    id: list.to_string(),
                    amount_sats: amount,
                    created_at: now.to_rfc3339(),
                    expires_at: expires,
                    status: "issuing".into(),
                    delivery_status: "pending".into(),
                    cleanup_status: "notRequired".into(),
                    last_error: None,
                    reservation_ids: ids.clone(),
                });
            }
            Ok(ids)
        })
    }
    pub async fn issue(&self, id: &str, reconcile: bool) -> anyhow::Result<()> {
        let record = self
            .snapshot()?
            .records
            .into_iter()
            .find(|r| r.view.id == id)
            .ok_or_else(|| anyhow::anyhow!("reservation missing"))?;
        if record.view.endpoint.is_some() {
            return Ok(());
        }
        anyhow::ensure!(
            matches!(record.view.status.as_str(), "issuing" | "uncertain"),
            "reservation is no longer eligible"
        );
        anyhow::ensure!(
            !record.issuance_started || reconcile,
            "issuance requires explicit reconciliation"
        );
        self.update(|s| {
            let r = find(s, id)?;
            r.issuance_started = true;
            r.view.status = "uncertain".into();
            r.view.last_error = Some(WALLET_FAILURE.into());
            Ok(())
        })?;
        let amount = sats(&record.view.amount_sats)?;
        let endpoint = match (record.view.method.as_str(), record.issuance_started) {
            (ONCHAIN, false) => record.wallet.address(&self.owner, &record.label).await,
            (ONCHAIN, true) => {
                record
                    .wallet
                    .lookup_address(&self.owner, &record.label)
                    .await
            }
            (BOLT11, false) => {
                record
                    .wallet
                    .invoice(&record.preimage, amount, record.expiry_seconds)
                    .await
            }
            (BOLT11, true) => {
                record
                    .wallet
                    .reconcile_invoice(&record.preimage, amount, record.expiry_seconds)
                    .await
            }
            _ => anyhow::bail!("unsupported issuance method"),
        }?;
        self.update(|s| {
            let r = find(s, id)?;
            r.view.endpoint = Some(endpoint);
            r.view.status = "active".into();
            r.view.last_error = None;
            Ok(())
        })
    }
    pub fn retire_list(&self, list_id: &str, status: &str) -> anyhow::Result<()> {
        self.update(|s| {
            // A terminal list may predate the peer's current list. Keep cleanup
            // retryable without enqueueing a new peer-wide withdrawal for it.
            let mut retired = false;
            for r in &mut s.records {
                if r.view.list_id == list_id && eligible(&r.view) {
                    retired = true;
                    r.view.status = status.into();
                    r.view.cleanup_status = "pending".into();
                    if let (Some(key), Some(path)) =
                        (&r.view.peer_public_key, &r.view.peer_receiver_path)
                    {
                        s.withdrawals
                            .insert(peer_key(key, path), (key.clone(), path.clone()));
                    }
                }
            }
            if let Some(list) = s
                .public_list
                .as_mut()
                .filter(|l| retired && l.id == list_id)
            {
                list.status = if status == "cancelled" {
                    "withdrawn"
                } else {
                    status
                }
                .into();
                list.cleanup_status = "pending".into();
                list.delivery_status = "pending".into();
            }
            Ok(())
        })
    }
    pub async fn cleanup(&self, id: &str) -> anyhow::Result<()> {
        let r = self
            .snapshot()?
            .records
            .into_iter()
            .find(|r| r.view.id == id)
            .ok_or_else(|| anyhow::anyhow!("reservation missing"))?;
        if r.view.cleanup_status == "complete" {
            return Ok(());
        }
        anyhow::ensure!(!eligible(&r.view), "cannot clean eligible reservation");
        let result = if r.view.method == BOLT11 && r.issuance_started {
            r.wallet.cancel_invoice(&r.preimage).await
        } else {
            Ok(())
        };
        self.update(|s| {
            let r = find(s, id)?;
            r.view.cleanup_status = if result.is_ok() { "complete" } else { "failed" }.into();
            r.view.last_error = result.as_ref().err().map(|_| WALLET_FAILURE.into());
            Ok(())
        })?;
        result
    }
    pub fn mark_list(
        &self,
        list_id: &str,
        delivery: &str,
        message: Option<String>,
    ) -> anyhow::Result<()> {
        self.update(|s| {
            for r in &mut s.records {
                if r.view.list_id == list_id {
                    r.view.delivery_status = delivery.into();
                    r.view.outbound_message_id = message.clone();
                }
            }
            if let Some(l) = s.public_list.as_mut().filter(|l| l.id == list_id) {
                l.delivery_status = delivery.into();
                if l.status == "issuing" {
                    l.status = "active".into();
                }
            }
            Ok(())
        })
    }
    pub fn selection(&self, override_method: Option<String>) -> anyhow::Result<()> {
        let order = override_method
            .map(|m| vec![m])
            .unwrap_or(self.snapshot()?.methods.preference);
        anyhow::ensure!(!order.is_empty(), "select a method or save a preference");
        *self
            .selection
            .lock()
            .map_err(|_| anyhow::anyhow!("selection unavailable"))? = order;
        Ok(())
    }
    pub fn consumed(&self, key: &str, path: &str) -> anyhow::Result<Option<u64>> {
        Ok(self.snapshot()?.consumed.get(&peer_key(key, path)).copied())
    }
    pub fn consume(&self, id: &str) -> anyhow::Result<ResolutionView> {
        self.update(|s| {
            let index = s
                .resolutions
                .iter()
                .position(|r| r.id == id)
                .ok_or_else(|| anyhow::anyhow!("resolution missing"))?;
            let r = &s.resolutions[index];
            anyhow::ensure!(
                r.source == "private" && r.status == "payable",
                "only a payable private list can be consumed"
            );
            let version = r
                .version
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("private version missing"))?
                .parse::<u64>()?;
            let scope = peer_key(&r.peer_public_key, &r.peer_receiver_path);
            anyhow::ensure!(
                s.consumed.get(&scope).is_none_or(|old| version > *old),
                "private list already consumed"
            );
            wallet_rpc::validate_endpoint(
                r.method.as_deref().unwrap_or_default(),
                r.endpoint.as_deref().unwrap_or_default(),
                sats(&r.amount_sats)?,
            )?;
            s.consumed.insert(scope.clone(), version);
            for prior in &mut s.resolutions {
                if prior.source == "private"
                    && peer_key(&prior.peer_public_key, &prior.peer_receiver_path) == scope
                    && prior
                        .version
                        .as_ref()
                        .and_then(|v| v.parse::<u64>().ok())
                        .is_some_and(|v| v <= version)
                {
                    prior.status = "consumed".into();
                }
            }
            Ok(s.resolutions[index].clone())
        })
    }
    pub fn project(&self, workspace: &mut crate::workspace_model::Workspace) -> anyhow::Result<()> {
        let state = self.snapshot()?;
        workspace.payment_methods = state.methods;
        workspace.payment_methods.wallets = wallet_rpc::configured(self.environment)?
            .iter()
            .map(Wallet::view)
            .collect();
        workspace.public_payment_list = state.public_list;
        workspace.reservations = state
            .records
            .into_iter()
            .rev()
            .take(128)
            .map(|r| r.view)
            .collect();
        workspace.resolutions = state.resolutions.into_iter().rev().take(128).collect();
        Ok(())
    }
    fn payable(&self, method: &str, payload: &str, amount: Option<&PaymentAmountContext>) -> bool {
        amount
            .filter(|a| a.asset == "sat")
            .and_then(|a| sats(&a.value).ok())
            .is_some_and(|a| wallet_rpc::validate_endpoint(method, payload, a).is_ok())
    }
    fn order(&self) -> paykit_sdk::Result<Vec<String>> {
        self.selection
            .lock()
            .map(|v| v.clone())
            .map_err(|_| sdk_error())
    }
}
fn refresh_public(s: &mut Ledger) {
    if let Some(list) = &mut s.public_list {
        let records: Vec<_> = s
            .records
            .iter()
            .filter(|r| r.view.list_id == list.id)
            .collect();
        if matches!(list.status.as_str(), "issuing" | "active" | "uncertain") {
            list.status = if records.iter().all(|r| r.view.status == "active") {
                "active"
            } else if records.iter().any(|r| r.view.status == "uncertain") {
                "uncertain"
            } else {
                "issuing"
            }
            .into();
        }
        if records.iter().any(|r| r.view.cleanup_status == "failed") {
            list.cleanup_status = "failed".into();
        } else if !records.is_empty() && records.iter().all(|r| r.view.cleanup_status == "complete")
        {
            list.cleanup_status = "complete".into();
        }
        list.last_error = records.iter().find_map(|r| r.view.last_error.clone());
        if list.delivery_status == "failed" {
            list.last_error = Some(
                "Public endpoint synchronization failed. Reconcile or withdraw explicitly.".into(),
            );
        }
    }
}
pub(crate) fn find<'a>(s: &'a mut Ledger, id: &str) -> anyhow::Result<&'a mut Record> {
    s.records
        .iter_mut()
        .find(|r| r.view.id == id)
        .ok_or_else(|| anyhow::anyhow!("reservation missing"))
}
pub(crate) fn peer_key(key: &str, path: &str) -> String {
    format!("{key}/{path}")
}
pub(crate) fn eligible(r: &ReservationView) -> bool {
    matches!(r.status.as_str(), "active" | "issuing" | "uncertain")
}
fn sdk_error() -> PaykitSdkError {
    PaykitSdkError::PaymentAdapter {
        context: WALLET_FAILURE.into(),
        source: None,
    }
}
#[async_trait]
impl PaymentAdapter for WalletAdapter {
    async fn current_public_receiving_details(
        &self,
    ) -> paykit_sdk::Result<Vec<PublicReceivingDetail>> {
        let s = self.snapshot().map_err(|_| sdk_error())?;
        Ok(s.records
            .iter()
            .filter(|r| r.view.source == "public" && r.view.status == "active")
            .filter_map(|r| {
                r.view.endpoint.as_ref().map(|p| PublicReceivingDetail {
                    identifier: r.view.method.clone(),
                    payload: p.clone(),
                })
            })
            .collect())
    }
    async fn reserve_private_receiving_details(
        &self,
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
    ) -> paykit_sdk::Result<Option<Vec<PrivatePaymentEndpointReservation>>> {
        let s = self.snapshot().map_err(|_| sdk_error())?;
        let records = s.records.iter().filter(|r| {
            r.view.peer_public_key.as_deref() == Some(key.as_str())
                && r.view.peer_receiver_path.as_deref() == Some(path.as_str())
                && r.view.status == "active"
        });
        let mut reservations = vec![];
        for r in records {
            reservations.push(PrivatePaymentEndpointReservation {
                reservation_id: r.view.id.clone(),
                receiving_detail: PrivateReceivingDetail {
                    identifier: r.view.method.clone(),
                    payload: r.view.endpoint.clone().ok_or_else(sdk_error)?,
                },
                expires_at: Some(
                    chrono::DateTime::parse_from_rfc3339(&r.view.expires_at)
                        .map_err(|_| sdk_error())?
                        .with_timezone(&chrono::Utc),
                ),
                attribution: HashMap::from([("listId".into(), r.view.list_id.clone())]),
            });
        }
        Ok(Some(reservations))
    }
    async fn cancel_private_receiving_detail_reservation(
        &self,
        c: &PrivatePaymentEndpointReservationCancellation,
    ) -> paykit_sdk::Result<()> {
        let r = self
            .snapshot()
            .map_err(|_| sdk_error())?
            .records
            .into_iter()
            .find(|r| r.view.id == c.reservation_id)
            .ok_or_else(sdk_error)?;
        if r.view.peer_public_key.as_deref() != Some(c.counterparty.as_str())
            || r.view.peer_receiver_path.as_deref() != Some(c.counterparty_receiver_path.as_str())
            || r.view.method != c.identifier
            || r.view
                .endpoint
                .as_ref()
                .is_none_or(|p| sha256::Hash::hash(p.as_bytes()).to_string() != c.payload_hash)
            || c.attribution != HashMap::from([("listId".into(), r.view.list_id.clone())])
        {
            return Err(sdk_error());
        }
        if eligible(&r.view) {
            self.retire_list(&r.view.list_id, "superseded")
                .map_err(|_| sdk_error())?;
        }
        self.cleanup(&c.reservation_id)
            .await
            .map_err(|_| sdk_error())
    }
    async fn select_public_payment_endpoints(
        &self,
        r: &PublicPaymentEndpointSelectionRequest,
    ) -> paykit_sdk::Result<Vec<PublicPaymentEndpointCandidate>> {
        Ok(self
            .order()?
            .iter()
            .flat_map(|m| r.candidates.iter().filter(move |c| &c.identifier == m))
            .filter(|c| self.payable(&c.identifier, &c.payload, r.amount.as_ref()))
            .cloned()
            .collect())
    }
    async fn select_private_payment_endpoints(
        &self,
        r: &PrivatePaymentEndpointSelectionRequest,
    ) -> paykit_sdk::Result<Vec<PrivatePaymentEndpointCandidate>> {
        Ok(self
            .order()?
            .iter()
            .flat_map(|m| r.candidates.iter().filter(move |c| &c.identifier == m))
            .filter(|c| self.payable(&c.identifier, &c.payload, r.amount.as_ref()))
            .cloned()
            .collect())
    }
    async fn build_public_payment_target(
        &self,
        e: &PublicPaymentEndpointCandidate,
    ) -> paykit_sdk::Result<PaymentTarget> {
        Ok(PaymentTarget {
            payload: e.payload.clone(),
        })
    }
    async fn build_private_payment_target(
        &self,
        e: &PrivatePaymentEndpointCandidate,
    ) -> paykit_sdk::Result<PaymentTarget> {
        Ok(PaymentTarget {
            payload: e.payload.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ADDRESS: &str = "bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsl";
    fn adapter(root: &std::path::Path) -> WalletAdapter {
        WalletAdapter::open(
            Arc::new(Vault::new(root.into(), [42; 32], "test".into()).unwrap()),
            Uuid::nil(),
            "owner".into(),
        )
        .unwrap()
    }
    fn resolution(id: &str, version: u64, path: &str) -> ResolutionView {
        ResolutionView {
            id: id.into(),
            peer_public_key: "peer".into(),
            peer_receiver_path: path.into(),
            source: "private".into(),
            amount_sats: "100".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            method: Some(ONCHAIN.into()),
            endpoint: Some(ADDRESS.into()),
            version: Some(version.to_string()),
            expires_at: None,
            status: "payable".into(),
            last_error: None,
        }
    }
    #[test]
    fn consumption_invalidates_whole_version_and_survives_restart_without_cross_scope_leak() {
        let dir = tempfile::tempdir().unwrap();
        let a = adapter(dir.path());
        a.update(|s| {
            s.resolutions = vec![
                resolution("one", 7, "p/wallet"),
                resolution("two", 7, "p/wallet"),
                resolution("three", 8, "p/wallet"),
                resolution("sibling", 7, "p/server"),
            ];
            Ok(())
        })
        .unwrap();
        a.consume("one").unwrap();
        assert!(a.consume("two").is_err());
        drop(a);
        let a = adapter(dir.path());
        assert_eq!(a.consumed("peer", "p/wallet").unwrap(), Some(7));
        assert!(a.consume("two").is_err());
        a.consume("three").unwrap();
        a.consume("sibling").unwrap();
        assert_eq!(a.consumed("peer", "p/wallet").unwrap(), Some(8));
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            adapter(other.path()).consumed("peer", "p/wallet").unwrap(),
            None
        );
    }
    #[test]
    fn failed_atomic_commit_does_not_authorize_consumption_and_poisons_further_mutations() {
        let dir = tempfile::tempdir().unwrap();
        let a = adapter(dir.path());
        a.update(|s| {
            s.resolutions.push(resolution("one", 1, "p/wallet"));
            Ok(())
        })
        .unwrap();
        std::fs::remove_file(dir.path().join(LEDGER)).unwrap();
        std::fs::create_dir(dir.path().join(LEDGER)).unwrap();
        assert!(a.consume("one").is_err());
        assert_eq!(a.consumed("peer", "p/wallet").unwrap(), None);
        std::fs::remove_dir(dir.path().join(LEDGER)).unwrap();
        assert!(a.consume("one").is_err());
    }
    #[tokio::test]
    async fn explicit_override_does_not_fall_back_to_another_valid_rail() {
        let dir = tempfile::tempdir().unwrap();
        let a = adapter(dir.path());
        a.selection(Some(BOLT11.into())).unwrap();
        let candidate = PublicPaymentEndpointCandidate {
            counterparty: PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key()),
            counterparty_receiver_path: PaykitReceiverPath::new("peer/wallet").unwrap(),
            identifier: ONCHAIN.into(),
            payload: ADDRESS.into(),
        };
        let request = PublicPaymentEndpointSelectionRequest {
            counterparty: candidate.counterparty.clone(),
            counterparty_receiver_path: candidate.counterparty_receiver_path.clone(),
            amount: Some(PaymentAmountContext {
                value: "100".into(),
                asset: "sat".into(),
            }),
            candidates: vec![candidate],
        };
        assert!(a
            .select_public_payment_endpoints(&request)
            .await
            .unwrap()
            .is_empty());
        a.selection(Some(ONCHAIN.into())).unwrap();
        assert_eq!(
            a.select_public_payment_endpoints(&request)
                .await
                .unwrap()
                .len(),
            1
        );
        let wrong_units = PublicPaymentEndpointSelectionRequest {
            amount: Some(PaymentAmountContext {
                value: "100".into(),
                asset: "BTC".into(),
            }),
            ..request
        };
        assert!(a
            .select_public_payment_endpoints(&wrong_units)
            .await
            .unwrap()
            .is_empty());
    }
    #[test]
    fn missing_preference_is_rejected_and_public_projection_never_serializes_private_ledger() {
        let dir = tempfile::tempdir().unwrap();
        let a = adapter(dir.path());
        assert!(a.selection(None).is_err());
        let mut view = crate::workspace_model::Workspace::default();
        a.project(&mut view).unwrap();
        let json = serde_json::to_string(&view).unwrap();
        for forbidden in ["preimage", "password", "macaroon", "payments.cbor"] {
            assert!(!json.contains(forbidden));
        }
    }
}

#[cfg(test)]
mod issuance_tests {
    use super::*;
    use crate::wallet_rpc::{Core, Wallet};
    use std::sync::atomic::{AtomicUsize, Ordering};
    const ADDRESS: &str = "bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsl";
    fn setup(path: &std::path::Path, url: String) -> WalletAdapter {
        let a = WalletAdapter::open(
            Arc::new(Vault::new(path.into(), [6; 32], "issuance".into()).unwrap()),
            Uuid::nil(),
            "owner".into(),
        )
        .unwrap();
        let now = chrono::Utc::now();
        a.update(|s| {
            s.records.push(Record {
                view: ReservationView {
                    id: "reservation".into(),
                    list_id: "list".into(),
                    wallet_id: "core-0".into(),
                    source: "private".into(),
                    peer_public_key: Some(pubky::Keypair::from_secret(&[3; 32]).public_key().z32()),
                    peer_receiver_path: Some("peer/wallet".into()),
                    method: ONCHAIN.into(),
                    endpoint: None,
                    amount_sats: "10".into(),
                    created_at: now.to_rfc3339(),
                    expires_at: (now + chrono::Duration::seconds(60)).to_rfc3339(),
                    status: "issuing".into(),
                    delivery_status: "pending".into(),
                    cleanup_status: "notRequired".into(),
                    outbound_message_id: None,
                    last_error: None,
                },
                wallet: Wallet {
                    bitcoin_backend_id: None,
                    id: "core-0".into(),
                    label: "Core".into(),
                    bitcoin: Core {
                        url,
                        username: "private-user".into(),
                        password: "private-password".into(),
                    },
                    lightning: None,
                },
                preimage: [5; 32],
                label: "unique-reservation-label".into(),
                expiry_seconds: 60,
                issuance_started: false,
            });
            Ok(())
        })
        .unwrap();
        a
    }
    async fn fake_core(counter: Arc<AtomicUsize>) -> (String, tokio::task::JoinHandle<()>) {
        async fn rpc(
            axum::extract::State(counter): axum::extract::State<Arc<AtomicUsize>>,
            axum::Json(input): axum::Json<serde_json::Value>,
        ) -> axum::Json<serde_json::Value> {
            let value = match input["method"].as_str().unwrap() {
                "listwallets" => serde_json::json!({"result":["paykit-owner"],"error":null}),
                "getnewaddress" => {
                    counter.fetch_add(1, Ordering::SeqCst);
                    serde_json::json!({"error":{"code":-1,"message":"response lost after wallet commit"}})
                }
                "getaddressesbylabel" => {
                    serde_json::json!({"result":{ADDRESS:{"purpose":"receive"}},"error":null})
                }
                other => panic!("unexpected RPC {other}"),
            };
            axum::Json(value)
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new()
            .route("/", axum::routing::post(rpc))
            .route("/wallet/{name}", axum::routing::post(rpc))
            .with_state(counter);
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), task)
    }
    #[tokio::test]
    async fn lost_address_response_reconciles_label_without_reissuing_after_restart() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (url, task) = fake_core(calls.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let a = setup(dir.path(), url);
        assert!(a.issue("reservation", false).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(a.issue("reservation", false).await.is_err());
        assert!(a.ensure_new_issuance().is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        drop(a);
        let a = WalletAdapter::open(
            Arc::new(Vault::new(dir.path().into(), [6; 32], "issuance".into()).unwrap()),
            Uuid::nil(),
            "owner".into(),
        )
        .unwrap();
        a.issue("reservation", true).await.unwrap();
        a.issue("reservation", true).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            a.snapshot().unwrap().records[0].view.endpoint.as_deref(),
            Some(ADDRESS)
        );
        let ciphertext = std::fs::read(dir.path().join(LEDGER)).unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("private-password"));
        task.abort();
        let _ = task.await;
    }
    #[tokio::test]
    async fn failed_issuance_intent_commit_prevents_wallet_rpc() {
        let calls = Arc::new(AtomicUsize::new(0));
        let (url, task) = fake_core(calls.clone()).await;
        let dir = tempfile::tempdir().unwrap();
        let a = setup(dir.path(), url);
        std::fs::remove_file(dir.path().join(LEDGER)).unwrap();
        std::fs::create_dir(dir.path().join(LEDGER)).unwrap();
        assert!(a.issue("reservation", false).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!a.snapshot().unwrap().records[0].issuance_started);
        task.abort();
        let _ = task.await;
    }
    #[tokio::test]
    async fn terminal_retirement_preserves_replacement_and_cleanup_across_restart() {
        for terminal in ["superseded", "cancelled", "expired"] {
            for cleanup in ["pending", "failed", "complete"] {
                let dir = tempfile::tempdir().unwrap();
                let a = setup(dir.path(), "http://unused:18443".into());
                a.retire_list("list", terminal).unwrap();
                a.update(|s| {
                    let old = &mut s.records[0];
                    old.view.cleanup_status = cleanup.into();
                    old.view.delivery_status = "sent".into();
                    old.view.outbound_message_id = Some("11".into());
                    let mut replacement = old.clone();
                    replacement.view.id = "replacement".into();
                    replacement.view.list_id = "new-list".into();
                    replacement.view.status = "active".into();
                    replacement.view.cleanup_status = "notRequired".into();
                    replacement.view.outbound_message_id = Some("12".into());
                    s.records.push(replacement);
                    // Successful replacement publication completed the earlier withdrawal.
                    s.withdrawals.clear();
                    Ok(())
                })
                .unwrap();
                drop(a);
                let a = WalletAdapter::open(
                    Arc::new(Vault::new(dir.path().into(), [6; 32], "issuance".into()).unwrap()),
                    Uuid::nil(),
                    "owner".into(),
                )
                .unwrap();
                let before = serde_json::to_value(a.snapshot().unwrap()).unwrap();
                a.retire_list("list", "cancelled").unwrap();
                a.retire_list("list", "cancelled").unwrap();
                assert_eq!(serde_json::to_value(a.snapshot().unwrap()).unwrap(), before);
                // Pending/failed wallet cleanup remains retryable after the semantic no-op.
                a.cleanup("reservation").await.unwrap();
                let state = a.snapshot().unwrap();
                assert_eq!(state.records[0].view.cleanup_status, "complete");
                assert_eq!(state.records[0].view.status, terminal);
                assert_eq!(state.records[1].view.status, "active");
                assert!(state.withdrawals.is_empty());
            }
        }
    }
    #[test]
    fn repeated_retirement_keeps_unfinished_withdrawal_and_completed_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let a = setup(dir.path(), "http://unused:18443".into());
        a.update(|s| {
            s.records[0].view.status = "active".into();
            s.records[0].view.expires_at =
                (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
            Ok(())
        })
        .unwrap();
        a.retire_list("list", "expired").unwrap();
        assert_eq!(a.snapshot().unwrap().records[0].view.status, "expired");
        assert_eq!(
            a.snapshot().unwrap().records[0].view.cleanup_status,
            "pending"
        );
        a.update(|s| {
            s.records[0].view.cleanup_status = "complete".into();
            Ok(())
        })
        .unwrap();
        let before = serde_json::to_value(a.snapshot().unwrap()).unwrap();
        assert_eq!(a.snapshot().unwrap().withdrawals.len(), 1);
        a.retire_list("list", "cancelled").unwrap();
        assert_eq!(serde_json::to_value(a.snapshot().unwrap()).unwrap(), before);
    }
    #[tokio::test]
    async fn sdk_cancellation_must_match_peer_path_payload_and_attribution() {
        let dir = tempfile::tempdir().unwrap();
        let a = setup(dir.path(), "http://unused:18443".into());
        a.update(|s| {
            s.records[0].view.endpoint = Some(ADDRESS.into());
            s.records[0].view.status = "active".into();
            Ok(())
        })
        .unwrap();
        let c = PrivatePaymentEndpointReservationCancellation {
            reservation_id: "reservation".into(),
            counterparty: PubkyPublicKey::from_public_key(
                &pubky::Keypair::from_secret(&[3; 32]).public_key(),
            ),
            counterparty_receiver_path: PaykitReceiverPath::new("peer/wallet").unwrap(),
            identifier: ONCHAIN.into(),
            payload_hash: sha256::Hash::hash(ADDRESS.as_bytes()).to_string(),
            attribution: HashMap::from([("listId".into(), "list".into())]),
        };
        let mut wrong = c.clone();
        wrong.payload_hash = "wrong".into();
        assert!(a
            .cancel_private_receiving_detail_reservation(&wrong)
            .await
            .is_err());
        let mut wrong = c.clone();
        wrong.counterparty_receiver_path = PaykitReceiverPath::new("peer/server").unwrap();
        assert!(a
            .cancel_private_receiving_detail_reservation(&wrong)
            .await
            .is_err());
        let mut wrong = c.clone();
        wrong.attribution.clear();
        assert!(a
            .cancel_private_receiving_detail_reservation(&wrong)
            .await
            .is_err());
        assert_eq!(a.snapshot().unwrap().records[0].view.status, "active");
        a.cancel_private_receiving_detail_reservation(&c)
            .await
            .unwrap();
        a.cancel_private_receiving_detail_reservation(&c)
            .await
            .unwrap();
        let r = &a.snapshot().unwrap().records[0];
        assert_eq!(r.view.cleanup_status, "complete");
        assert_eq!(r.view.endpoint.as_deref(), Some(ADDRESS));
        assert_eq!(r.label, "unique-reservation-label");
    }
}
