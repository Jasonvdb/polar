//! Payment list use cases within the receiver's existing SDK ownership boundary.
use super::Runtime;
use crate::{
    model::Command,
    payment_input::*,
    payment_model::*,
    wallet_adapter::{eligible, peer_key},
    wallet_rpc,
};
use bitcoin::hashes::{sha256, Hash};
use paykit_sdk::{
    storage::StorageAdapter, OutboundPrivateMessageStatus, PaykitReceiverPath,
    PaymentAmountContext, PrivatePaymentResolutionState, PrivatePaymentResolutionStatus,
    PubkyPublicKey, PublicPaymentResolutionStatus,
};
use serde_json::{json, Value};

impl Runtime {
    pub(super) async fn payment_command(&mut self, c: &Command) -> anyhow::Result<Value> {
        match c.command.as_str() {
            "method.configure" => {
                let i: Configure = serde_json::from_value(c.input.clone())?;
                self.payments
                    .configure(i.wallet_id, i.enabled_methods, i.preference)?;
            }
            "method.prefer" => {
                let i: Prefer = serde_json::from_value(c.input.clone())?;
                self.payments.prefer(i.preference)?;
            }
            "paymentList.publish" => {
                self.payments.ensure_new_issuance()?;
                let i: Publish = serde_json::from_value(c.input.clone())?;
                self.retire_public("superseded").await?;
                let ids = self.payments.begin_list(
                    c.command_id,
                    None,
                    i.amount_sats,
                    i.expiry_seconds,
                )?;
                for id in ids {
                    self.payments.issue(&id, false).await?;
                }
                self.publish_current().await?;
            }
            "paymentList.unpublish" => {
                self.retire_public("cancelled").await?;
            }
            "reservation.create" | "reservation.rotate" => {
                self.payments.ensure_new_issuance()?;
                let i: Reserve = serde_json::from_value(c.input.clone())?;
                self.ensure_payment_peer(&i.peer_public_key, &i.peer_receiver_path)?;
                let old: Vec<_> = self
                    .payments
                    .snapshot()?
                    .records
                    .iter()
                    .filter(|r| {
                        r.view.peer_public_key.as_deref() == Some(&i.peer_public_key)
                            && r.view.peer_receiver_path.as_deref() == Some(&i.peer_receiver_path)
                            && eligible(&r.view)
                    })
                    .map(|r| r.view.list_id.clone())
                    .collect();
                anyhow::ensure!(
                    c.command == "reservation.rotate" || old.is_empty(),
                    "peer already has a list; rotate it explicitly"
                );
                for list in old {
                    self.payments.retire_list(&list, "superseded")?;
                }
                self.cleanup_retired().await?;
                let ids = self.payments.begin_list(
                    c.command_id,
                    Some((i.peer_public_key.clone(), i.peer_receiver_path.clone())),
                    i.amount_sats,
                    i.expiry_seconds,
                )?;
                for id in ids {
                    self.payments.issue(&id, false).await?;
                }
                self.queue_current(
                    &i.peer_public_key,
                    &i.peer_receiver_path,
                    &c.command_id.to_string(),
                )
                .await?;
            }
            "reservation.cancel" => {
                let i: ReservationId = serde_json::from_value(c.input.clone())?;
                let record = self.reservation(&i.reservation_id.to_string())?;
                self.payments
                    .retire_list(&record.view.list_id, "cancelled")?;
                self.payment_maintenance().await?;
            }
            "reservation.reconcile" => {
                let i: ReservationId = serde_json::from_value(c.input.clone())?;
                let r = self.reservation(&i.reservation_id.to_string())?;
                if eligible(&r.view) {
                    let ids: Vec<_> = self
                        .payments
                        .snapshot()?
                        .records
                        .iter()
                        .filter(|other| other.view.list_id == r.view.list_id)
                        .map(|other| other.view.id.clone())
                        .collect();
                    for id in ids {
                        self.payments.issue(&id, true).await?;
                    }
                    if r.view.source == "public" {
                        self.publish_current().await?;
                    } else {
                        self.queue_current(
                            r.view
                                .peer_public_key
                                .as_deref()
                                .ok_or_else(|| anyhow::anyhow!("peer missing"))?,
                            r.view
                                .peer_receiver_path
                                .as_deref()
                                .ok_or_else(|| anyhow::anyhow!("peer path missing"))?,
                            &r.view.list_id,
                        )
                        .await?;
                    }
                } else {
                    self.payment_maintenance().await?;
                }
            }
            "paymentList.resolve" => {
                let i: Resolve = serde_json::from_value(c.input.clone())?;
                let resolution = self.resolve_payment(c.command_id.to_string(), i).await?;
                self.payments.project(&mut self.state.view)?;
                return Ok(
                    json!({"receiverId":self.state.view.receiver_id,"workspace":self.state.view,"resolution":resolution}),
                );
            }
            "paymentList.consume" => {
                let i: Consume = serde_json::from_value(c.input.clone())?;
                let r = self
                    .payments
                    .snapshot()?
                    .resolutions
                    .iter()
                    .find(|r| r.id == i.resolution_id.to_string())
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("resolution missing"))?;
                self.ensure_payment_peer(&r.peer_public_key, &r.peer_receiver_path)?;
                self.validate_current_resolution(&r).await?;
                let resolution = self.payments.consume(&i.resolution_id.to_string())?;
                self.payments.project(&mut self.state.view)?;
                return Ok(
                    json!({"receiverId":self.state.view.receiver_id,"workspace":self.state.view,"resolution":resolution}),
                );
            }
            _ => anyhow::bail!("unknown payment command"),
        }
        self.payments.project(&mut self.state.view)?;
        Ok(json!({"receiverId":self.state.view.receiver_id,"workspace":self.state.view}))
    }
    pub(super) async fn validate_current_resolution(
        &self,
        r: &ResolutionView,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.state.view.delivery_paused && r.source == "private" && r.status == "payable",
            "private resolution is not eligible"
        );
        self.payments.selection(r.method.clone())?;
        let current = self
            .sdk
            .resolve_private_contact_payment(
                PubkyPublicKey::new(&r.peer_public_key)?,
                PaykitReceiverPath::new(&r.peer_receiver_path)?,
                Some(PaymentAmountContext {
                    value: r.amount_sats.clone(),
                    asset: "sat".into(),
                }),
                self.payments
                    .consumed(&r.peer_public_key, &r.peer_receiver_path)?,
            )
            .await?;
        anyhow::ensure!(
            current.status == PrivatePaymentResolutionStatus::Payable
                && current.private_payment_list_version.map(|v| v.to_string()) == r.version
                && current
                    .payable_endpoints
                    .iter()
                    .any(|e| Some(&e.endpoint.identifier) == r.method.as_ref()
                        && Some(&e.endpoint.payload) == r.endpoint.as_ref()),
            "private list was withdrawn, replaced or consumed; resolve again"
        );
        Ok(())
    }
    fn reservation(&self, id: &str) -> anyhow::Result<crate::wallet_adapter::Record> {
        self.payments
            .snapshot()?
            .records
            .into_iter()
            .find(|r| r.view.id == id)
            .ok_or_else(|| anyhow::anyhow!("reservation missing"))
    }
    pub(super) fn ensure_payment_peer(&self, key: &str, path: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.state
                .view
                .links
                .iter()
                .any(|p| p.peer_public_key == key
                    && p.peer_receiver_path == path
                    && p.state == "linked"),
            "explicit linked peer required"
        );
        anyhow::ensure!(
            !self
                .state
                .uncertain_peers
                .contains(&(key.into(), path.into())),
            "peer recovery required"
        );
        Ok(())
    }
    async fn retire_public(&self, status: &str) -> anyhow::Result<()> {
        if let Some(list) = self.payments.snapshot()?.public_list {
            if matches!(list.status.as_str(), "issuing" | "active" | "uncertain") {
                self.payments.retire_list(&list.id, status)?;
            }
        }
        self.withdraw_public().await?;
        self.cleanup_retired().await
    }
    async fn publish_current(&self) -> anyhow::Result<()> {
        let list = self
            .payments
            .snapshot()?
            .public_list
            .ok_or_else(|| anyhow::anyhow!("public list missing"))?;
        anyhow::ensure!(
            chrono::DateTime::parse_from_rfc3339(&list.expires_at)? > chrono::Utc::now(),
            "public list expired before publication"
        );
        let report = self.sdk.sync_public_endpoints().await;
        let success = report.as_ref().is_ok_and(|r| r.failed.is_empty());
        self.payments
            .mark_list(&list.id, if success { "published" } else { "failed" }, None)?;
        anyhow::ensure!(
            success,
            "public endpoint publication failed or partially failed"
        );
        Ok(())
    }
    async fn queue_current(&self, key: &str, path: &str, list: &str) -> anyhow::Result<()> {
        let peer = PubkyPublicKey::new(key)?;
        let receiver_path = PaykitReceiverPath::new(path)?;
        let entries: Vec<_> = self
            .payments
            .snapshot()?
            .records
            .into_iter()
            .filter(|r| r.view.list_id == list)
            .collect();
        anyhow::ensure!(
            !entries.is_empty()
                && entries.iter().all(|r| r.view.status == "active"
                    && chrono::DateTime::parse_from_rfc3339(&r.view.expires_at)
                        .is_ok_and(|t| t > chrono::Utc::now())),
            "private list issuance incomplete"
        );
        if self
            .reconcile_private_publication(&peer, &receiver_path, &entries)
            .await?
        {
            return Ok(());
        }
        anyhow::ensure!(
            entries.iter().all(
                |r| r.view.outbound_message_id.is_none() && r.view.delivery_status == "pending"
            ),
            "uncertain private publication cannot be replayed"
        );
        self.payments.mark_list(list, "failed", None)?;
        let record = self
            .sdk
            .enqueue_private_payment_list(peer, receiver_path)
            .await;
        match record {
            Ok(message) => {
                self.acknowledge_private_publication(key, path, list, message.outbound_message_id)?;
            }
            Err(error) => {
                self.payments.mark_list(list, "failed", None)?;
                return Err(error.into());
            }
        }
        Ok(())
    }
    fn acknowledge_private_publication(
        &self,
        key: &str,
        path: &str,
        list: &str,
        message: u64,
    ) -> anyhow::Result<()> {
        // Acknowledgement and predecessor withdrawal retirement share one ledger commit.
        self.payments.update(|state| {
            for record in state.records.iter_mut().filter(|r| r.view.list_id == list) {
                anyhow::ensure!(
                    record.view.status == "active"
                        && record.view.peer_public_key.as_deref() == Some(key)
                        && record.view.peer_receiver_path.as_deref() == Some(path),
                    "private publication no longer current"
                );
                record.view.delivery_status = "queued".into();
                record.view.outbound_message_id = Some(message.to_string());
            }
            state.withdrawals.remove(&peer_key(key, path));
            Ok(())
        })
    }
    async fn reconcile_private_publication(
        &self,
        peer: &PubkyPublicKey,
        path: &PaykitReceiverPath,
        entries: &[crate::wallet_adapter::Record],
    ) -> anyhow::Result<bool> {
        let bindings = self
            .storage
            .transaction(|tx| {
                Ok(entries
                    .iter()
                    .filter_map(|r| tx.payment_endpoint_reservation(peer, path, &r.view.id))
                    .collect::<Vec<_>>())
            })
            .await?;
        if bindings.is_empty() {
            anyhow::ensure!(
                entries.iter().all(|r| r.view.outbound_message_id.is_none()),
                "acknowledged private publication binding missing"
            );
            return Ok(false);
        }
        let message = bindings[0].outbound_message_id;
        anyhow::ensure!(
            bindings.len() == entries.len()
                && entries.iter().all(|record| {
                    bindings.iter().any(|binding| {
                        binding.reservation_id == record.view.id
                            && binding.counterparty == *peer
                            && binding.counterparty_receiver_path == *path
                            && binding.identifier == record.view.method
                            && record.view.endpoint.as_ref().is_some_and(|endpoint| {
                                sha256::Hash::hash(endpoint.as_bytes()).to_string()
                                    == binding.payload_hash
                            })
                            && binding.attribution
                                == std::collections::HashMap::from([(
                                    "listId".into(),
                                    record.view.list_id.clone(),
                                )])
                            && binding.expires_at
                                == chrono::DateTime::parse_from_rfc3339(&record.view.expires_at)
                                    .ok()
                                    .map(|date| date.with_timezone(&chrono::Utc))
                            && binding.outbound_message_id == message
                            && binding.cancellation_started_at.is_none()
                            && record
                                .view
                                .outbound_message_id
                                .as_ref()
                                .is_none_or(|id| id == &message.to_string())
                    })
                }),
            "private publication requires recovery"
        );
        let list = &entries[0].view.list_id;
        let state = self.payments.snapshot()?;
        anyhow::ensure!(
            state
                .records
                .iter()
                .filter(|r| r.view.list_id != *list
                    && r.view.peer_public_key.as_deref() == Some(peer.as_str())
                    && r.view.peer_receiver_path.as_deref() == Some(path.as_str()))
                .all(|r| !eligible(&r.view)
                    && r.view
                        .outbound_message_id
                        .as_ref()
                        .is_none_or(|id| id.parse::<u64>().is_ok_and(|old| old < message))),
            "private publication is not the current peer list"
        );
        self.acknowledge_private_publication(peer.as_str(), path.as_str(), list, message)?;
        Ok(true)
    }
    async fn reconcile_before_withdrawal(&self, key: &str, path: &str) -> anyhow::Result<bool> {
        let state = self.payments.snapshot()?;
        let entries: Vec<_> = state
            .records
            .into_iter()
            .filter(|r| {
                eligible(&r.view)
                    && r.view.peer_public_key.as_deref() == Some(key)
                    && r.view.peer_receiver_path.as_deref() == Some(path)
            })
            .collect();
        if entries.is_empty() || entries.iter().any(|r| r.view.status != "active") {
            return Ok(false);
        }
        anyhow::ensure!(
            entries
                .iter()
                .all(|r| r.view.list_id == entries[0].view.list_id
                    && chrono::DateTime::parse_from_rfc3339(&r.view.expires_at)
                        .is_ok_and(|time| time > chrono::Utc::now())),
            "private publication requires recovery"
        );
        self.reconcile_private_publication(
            &PubkyPublicKey::new(key)?,
            &PaykitReceiverPath::new(path)?,
            &entries,
        )
        .await
    }
    async fn cleanup_retired(&self) -> anyhow::Result<()> {
        let records = self.payments.snapshot()?.records;
        let mut failed = false;
        for r in records
            .iter()
            .filter(|r| !eligible(&r.view) && r.view.cleanup_status != "complete")
        {
            failed |= self.payments.cleanup(&r.view.id).await.is_err();
        }
        anyhow::ensure!(
            !failed,
            "wallet cleanup pending or failed; reconcile reservation"
        );
        Ok(())
    }
    async fn withdraw_public(&self) -> anyhow::Result<()> {
        let Some(list) = self.payments.snapshot()?.public_list.filter(|l| {
            !matches!(l.status.as_str(), "active" | "issuing" | "uncertain")
                && l.delivery_status != "published"
        }) else {
            return Ok(());
        };
        let report = self
            .sdk
            .sync_public_endpoints_with_receiving_details(vec![])
            .await;
        let success = report.as_ref().is_ok_and(|r| r.failed.is_empty());
        self.payments
            .mark_list(&list.id, if success { "published" } else { "failed" }, None)?;
        anyhow::ensure!(success, "public withdrawal failed");
        Ok(())
    }
    pub(super) async fn payment_maintenance(&self) -> anyhow::Result<()> {
        let now = chrono::Utc::now();
        let expired: Vec<_> = self
            .payments
            .snapshot()?
            .records
            .iter()
            .filter(|r| {
                eligible(&r.view)
                    && chrono::DateTime::parse_from_rfc3339(&r.view.expires_at)
                        .is_ok_and(|t| t <= now)
            })
            .map(|r| r.view.list_id.clone())
            .collect();
        for list in expired {
            self.payments.retire_list(&list, "expired")?;
        }
        let mut failed = self.cleanup_retired().await.is_err();
        failed |= self.withdraw_public().await.is_err();
        for (scope, (key, path)) in self.payments.snapshot()?.withdrawals {
            // SDK enqueue may have committed before its application acknowledgement.
            // Recover that replacement before an old peer-wide empty list can be queued.
            match self.reconcile_before_withdrawal(&key, &path).await {
                Ok(true) => continue,
                Ok(false) => {}
                Err(_) => {
                    failed = true;
                    continue;
                }
            }
            match self
                .sdk
                .clear_private_payment_list(
                    PubkyPublicKey::new(&key)?,
                    PaykitReceiverPath::new(&path)?,
                )
                .await
            {
                Ok(message) => {
                    self.payments.update(|s| {
                        s.withdrawals.remove(&scope);
                        for r in &mut s.records {
                            if r.view.peer_public_key.as_deref() == Some(&key)
                                && r.view.peer_receiver_path.as_deref() == Some(&path)
                                && !eligible(&r.view)
                            {
                                r.view.delivery_status = "queued".into();
                                r.view.outbound_message_id =
                                    Some(message.outbound_message_id.to_string());
                            }
                        }
                        Ok(())
                    })?;
                }
                Err(_) => failed = true,
            }
        }
        self.refresh_payment_delivery().await?;
        anyhow::ensure!(!failed, "reservation cleanup or withdrawal pending");
        Ok(())
    }
    async fn refresh_payment_delivery(&self) -> anyhow::Result<()> {
        let before = self.payments.snapshot()?;
        let mut changes = vec![];
        for record in before
            .records
            .iter()
            .filter(|r| r.view.delivery_status == "queued")
        {
            if let (Some(key), Some(path), Some(message)) = (
                &record.view.peer_public_key,
                &record.view.peer_receiver_path,
                &record.view.outbound_message_id,
            ) {
                let key = PubkyPublicKey::new(key)?;
                let path = PaykitReceiverPath::new(path)?;
                let status = self
                    .storage
                    .transaction(|tx| {
                        Ok(tx
                            .outbound_private_messages(&key, &path)
                            .into_iter()
                            .find(|m| m.outbound_message_id.to_string() == *message)
                            .map(|m| m.status))
                    })
                    .await?;
                if status == Some(OutboundPrivateMessageStatus::Sent) {
                    changes.push(record.view.id.clone());
                }
            }
        }
        if !changes.is_empty() {
            self.payments.update(|s| {
                for r in &mut s.records {
                    if changes.contains(&r.view.id) {
                        r.view.delivery_status = "sent".into();
                    }
                }
                Ok(())
            })?;
        }
        Ok(())
    }
    pub(super) async fn resolve_payment(
        &self,
        id: String,
        i: Resolve,
    ) -> anyhow::Result<ResolutionView> {
        self.payments.selection(i.method.clone())?;
        let key = PubkyPublicKey::new(&i.peer_public_key)?;
        let path = PaykitReceiverPath::new(&i.peer_receiver_path)?;
        let amount = Some(PaymentAmountContext {
            value: i.amount_sats.clone(),
            asset: "sat".into(),
        });
        let mut view = ResolutionView {
            id,
            peer_public_key: i.peer_public_key.clone(),
            peer_receiver_path: i.peer_receiver_path.clone(),
            source: i.source.clone(),
            amount_sats: i.amount_sats.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            method: i.method,
            endpoint: None,
            version: None,
            expires_at: None,
            status: "noEndpoint".into(),
            last_error: None,
        };
        if i.source == "private" {
            if self.state.view.delivery_paused
                || self
                    .ensure_payment_peer(&i.peer_public_key, &i.peer_receiver_path)
                    .is_err()
            {
                view.status = "recoveryPending".into();
            } else {
                let resolved = self
                    .sdk
                    .resolve_private_contact_payment(
                        key,
                        path,
                        amount,
                        self.payments
                            .consumed(&i.peer_public_key, &i.peer_receiver_path)?,
                    )
                    .await?;
                view.version = resolved.private_payment_list_version.map(|v| v.to_string());
                view.status = match resolved.status {
                    PrivatePaymentResolutionStatus::Payable => "payable",
                    PrivatePaymentResolutionStatus::NoEndpoint => "noEndpoint",
                    PrivatePaymentResolutionStatus::UnsupportedEndpoint => "unsupportedEndpoint",
                    PrivatePaymentResolutionStatus::WaitingForUpdatedPaymentList => {
                        "waitingForUpdatedPaymentList"
                    }
                    _ => "unsupportedEndpoint",
                }
                .into();
                if resolved.state == PrivatePaymentResolutionState::RecoveryPending {
                    view.status = "recoveryPending".into();
                }
                if let Some(first) = resolved.payable_endpoints.first() {
                    view.method = Some(first.endpoint.identifier.clone());
                    view.endpoint = Some(first.endpoint.payload.clone());
                }
            }
        } else {
            let resolved = self
                .sdk
                .resolve_public_contact_payment(key, path, amount)
                .await?;
            view.status = match resolved.status {
                PublicPaymentResolutionStatus::Payable => "payable",
                PublicPaymentResolutionStatus::NoEndpoint => "noEndpoint",
                PublicPaymentResolutionStatus::UnsupportedEndpoint => "unsupportedEndpoint",
                _ => "unsupportedEndpoint",
            }
            .into();
            if let Some(first) = resolved.payable_endpoints.first() {
                view.method = Some(first.endpoint.identifier.clone());
                view.endpoint = Some(first.endpoint.payload.clone());
            }
        }
        if let (Some(method), Some(endpoint)) = (&view.method, &view.endpoint) {
            view.expires_at =
                wallet_rpc::validate_endpoint(method, endpoint, sats(&view.amount_sats)?)?;
        }
        self.payments.update(|s| {
            s.resolutions.push(view.clone());
            Ok(())
        })?;
        Ok(view)
    }
}

#[cfg(test)]
mod publication_recovery_tests {
    use super::*;
    use crate::{
        storage::{ReceiverStorage, Vault},
        wallet_adapter::{Record, WalletAdapter},
        wallet_rpc::{Core, Wallet},
    };
    use paykit_sdk::{
        storage::{OutboundPrivateMessageRecord, PaymentEndpointReservationRecord, StorageState},
        PaykitSdk,
    };
    use std::{collections::HashMap, sync::Arc};
    use uuid::Uuid;
    const ADDRESS: &str = "bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsl";
    fn open(root: &std::path::Path) -> Runtime {
        let receiver = Uuid::nil();
        let vault = Arc::new(Vault::new(root.into(), [8; 32], receiver.to_string()).unwrap());
        let storage = Arc::new(
            ReceiverStorage::open(Vault::new(root.into(), [8; 32], receiver.to_string()).unwrap())
                .unwrap(),
        );
        let provider = crate::receiver::SessionProvider::without_access(vault.clone());
        let payments = WalletAdapter::open(vault.clone(), receiver, "test".into()).unwrap();
        let sdk = PaykitSdk::new(
            storage.clone(),
            provider.clone(),
            payments.clone(),
            paykit_sdk::PaykitSdkConfig::new(PaykitReceiverPath::new("test/wallet").unwrap()),
        )
        .unwrap();
        Runtime::new(
            sdk,
            storage,
            vault,
            receiver,
            PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key()),
            provider,
            payments,
        )
        .unwrap()
    }
    fn peer() -> PubkyPublicKey {
        PubkyPublicKey::from_public_key(&pubky::Keypair::from_secret(&[3; 32]).public_key())
    }
    fn path() -> PaykitReceiverPath {
        PaykitReceiverPath::new("peer/wallet").unwrap()
    }
    // Persist the exact SDK enqueue checkpoint: reservation bindings and their
    // nonempty outbound message in encrypted sdk.cbor, with an earlier withdrawal.
    async fn checkpoint(root: &std::path::Path, acknowledged: bool) -> Runtime {
        let runtime = open(root);
        let now = chrono::Utc::now();
        let deadline = now + chrono::Duration::seconds(600);
        let replacement = Record {
            view: ReservationView {
                id: "replacement".into(),
                list_id: "new-list".into(),
                wallet_id: "core-0".into(),
                source: "private".into(),
                peer_public_key: Some(peer().to_string()),
                peer_receiver_path: Some(path().to_string()),
                method: ONCHAIN.into(),
                endpoint: Some(ADDRESS.into()),
                amount_sats: "37".into(),
                created_at: now.to_rfc3339(),
                expires_at: deadline.to_rfc3339(),
                status: "active".into(),
                delivery_status: "failed".into(),
                cleanup_status: "notRequired".into(),
                outbound_message_id: None,
                last_error: None,
            },
            wallet: Wallet {
                bitcoin_backend_id: None,
                id: "core-0".into(),
                label: "offline test binding".into(),
                bitcoin: Core {
                    url: "http://unused:18443".into(),
                    username: "test".into(),
                    password: "test".into(),
                },
                lightning: None,
            },
            preimage: [0; 32],
            label: "replacement-unique-label".into(),
            expiry_seconds: 600,
            issuance_started: true,
        };
        // Include never-published history and several earlier delivered/withdrawn versions.
        for (index, message) in [None, Some("1"), Some("7")].into_iter().enumerate() {
            let mut old = replacement.clone();
            old.view.id = format!("old-{index}");
            old.view.list_id = format!("old-list-{index}");
            old.view.outbound_message_id = message.map(String::from);
            runtime
                .payments
                .update(|s| {
                    s.records.push(old.clone());
                    Ok(())
                })
                .unwrap();
            runtime
                .payments
                .retire_list(&old.view.list_id, "superseded")
                .unwrap();
        }
        runtime.cleanup_retired().await.unwrap();
        runtime
            .payments
            .update(|s| {
                s.records.push(replacement.clone());
                Ok(())
            })
            .unwrap();
        runtime
            .storage
            .transaction(|tx| {
                tx.save_payment_endpoint_reservation(PaymentEndpointReservationRecord {
                    reservation_id: replacement.view.id.clone(),
                    counterparty: peer(),
                    counterparty_receiver_path: path(),
                    identifier: ONCHAIN.into(),
                    payload_hash: sha256::Hash::hash(ADDRESS.as_bytes()).to_string(),
                    outbound_message_id: 42,
                    attribution: HashMap::from([(
                        "listId".into(),
                        replacement.view.list_id.clone(),
                    )]),
                    expires_at: Some(deadline),
                    cancellation_started_at: None,
                    created_at: now,
                });
                Ok(())
            })
            .await
            .unwrap();
        let mut sdk_state: StorageState = runtime.vault.load("sdk.cbor").unwrap().unwrap();
        let list = paykit_lib::PrivatePaymentList::new(HashMap::from([(
            paykit_lib::PaymentEndpointIdentifier::new(ONCHAIN).unwrap(),
            paykit_lib::PaymentEndpointPayload::new(ADDRESS),
        )]));
        sdk_state
            .outbound_private_messages
            .push(OutboundPrivateMessageRecord {
                outbound_message_id: 42,
                counterparty: peer(),
                counterparty_receiver_path: path(),
                kind: paykit_lib::PrivateMessageKind::PrivatePaymentList
                    .as_str()
                    .into(),
                raw_json: paykit_lib::serialize_private_payment_list_json(&list).unwrap(),
                status: OutboundPrivateMessageStatus::Pending,
                attempt_count: 0,
                created_at: now,
                updated_at: now,
                last_attempt_at: None,
                sent_at: None,
                last_error: None,
            });
        sdk_state.next_outbound_private_message_id = 43;
        runtime.vault.save("sdk.cbor", &sdk_state).unwrap();
        if acknowledged {
            // Legacy second checkpoint: acknowledgement committed, old withdrawal not retired.
            runtime
                .payments
                .mark_list("new-list", "queued", Some("42".into()))
                .unwrap();
        }
        drop(runtime);
        open(root)
    }
    async fn messages(runtime: &Runtime) -> Vec<OutboundPrivateMessageRecord> {
        runtime
            .storage
            .transaction(|tx| Ok(tx.outbound_private_messages(&peer(), &path())))
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn maintenance_recovers_both_publication_checkpoints_before_any_peer_clear() {
        for acknowledged in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let runtime = checkpoint(dir.path(), acknowledged).await;
            let before = messages(&runtime).await;
            // No session exists: an attempted SDK peer clear would fail this maintenance call.
            runtime.payment_maintenance().await.unwrap();
            runtime
                .queue_current(peer().as_str(), path().as_str(), "new-list")
                .await
                .unwrap();
            assert_eq!(messages(&runtime).await, before);
            let list = paykit_lib::parse_private_payment_list_json(&before[0].raw_json).unwrap();
            assert_eq!(list.payment_endpoints.len(), 1);
            assert_eq!(
                list.payment_endpoints.values().next().unwrap().as_str(),
                ADDRESS
            );
            drop(runtime);
            let runtime = open(dir.path());
            assert!(runtime.payments.snapshot().unwrap().withdrawals.is_empty());
            let replacement = runtime.reservation("replacement").unwrap();
            assert_eq!(replacement.view.status, "active");
            assert_eq!(replacement.view.delivery_status, "queued");
            assert_eq!(replacement.view.outbound_message_id.as_deref(), Some("42"));
            assert_eq!(replacement.view.endpoint.as_deref(), Some(ADDRESS));
        }
    }
    #[tokio::test]
    async fn failed_acknowledgement_commit_keeps_withdrawal_until_safe_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = checkpoint(dir.path(), false).await;
        let ledger = dir.path().join("payments.cbor");
        let backup = dir.path().join("payments-backup");
        std::fs::rename(&ledger, &backup).unwrap();
        std::fs::create_dir(&ledger).unwrap();
        assert!(runtime
            .reconcile_before_withdrawal(peer().as_str(), path().as_str())
            .await
            .is_err());
        assert_eq!(runtime.payments.snapshot().unwrap().withdrawals.len(), 1);
        assert_eq!(
            runtime
                .reservation("replacement")
                .unwrap()
                .view
                .delivery_status,
            "failed"
        );
        std::fs::remove_dir(&ledger).unwrap();
        std::fs::rename(backup, ledger).unwrap();
        drop(runtime);
        let runtime = open(dir.path());
        runtime.payment_maintenance().await.unwrap();
        assert!(runtime.payments.snapshot().unwrap().withdrawals.is_empty());
        assert_eq!(
            runtime
                .reservation("replacement")
                .unwrap()
                .view
                .delivery_status,
            "queued"
        );
    }
    #[tokio::test]
    async fn cancelled_expired_and_unbound_lists_keep_legitimate_withdrawals() {
        for terminal in ["cancelled", "expired", "unbound"] {
            let dir = tempfile::tempdir().unwrap();
            let mut runtime = checkpoint(dir.path(), false).await;
            if terminal == "unbound" {
                // A failed enqueue commits neither binding nor outbound message.
                let mut sdk_state: StorageState = runtime.vault.load("sdk.cbor").unwrap().unwrap();
                sdk_state.payment_endpoint_reservations.clear();
                sdk_state.outbound_private_messages.clear();
                runtime.vault.save("sdk.cbor", &sdk_state).unwrap();
                drop(runtime);
                runtime = open(dir.path());
            } else {
                runtime.payments.retire_list("new-list", terminal).unwrap();
            }
            assert!(!runtime
                .reconcile_before_withdrawal(peer().as_str(), path().as_str())
                .await
                .unwrap());
            // Withdrawal still reaches the real SDK and visibly fails without a session.
            assert!(runtime.payment_maintenance().await.is_err());
            assert_eq!(runtime.payments.snapshot().unwrap().withdrawals.len(), 1);
        }
    }
    #[tokio::test]
    async fn partial_mismatched_or_older_bindings_do_not_retire_a_withdrawal() {
        for fault in [
            "partial",
            "payload",
            "attribution",
            "peer",
            "older",
            "missing-acknowledged",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let runtime = checkpoint(dir.path(), fault == "missing-acknowledged").await;
            if fault == "partial" {
                runtime
                    .payments
                    .update(|s| {
                        let mut other = s.records.last().unwrap().clone();
                        other.view.id = "unbound-method".into();
                        other.view.method = BOLT11.into();
                        s.records.push(other);
                        Ok(())
                    })
                    .unwrap();
            } else if fault == "older" {
                runtime
                    .payments
                    .update(|s| {
                        s.records[0].view.outbound_message_id = Some("43".into());
                        Ok(())
                    })
                    .unwrap();
            } else {
                runtime
                    .storage
                    .transaction(|tx| {
                        let mut binding = tx
                            .payment_endpoint_reservation(&peer(), &path(), "replacement")
                            .unwrap();
                        match fault {
                            "payload" => binding.payload_hash = "wrong".into(),
                            "attribution" => binding.attribution.clear(),
                            "peer" | "missing-acknowledged" => {
                                tx.remove_payment_endpoint_reservation(
                                    &peer(),
                                    &path(),
                                    "replacement",
                                );
                            }
                            _ => unreachable!(),
                        }
                        if fault == "peer" {
                            binding.counterparty_receiver_path =
                                PaykitReceiverPath::new("peer/server").unwrap();
                        }
                        if fault != "missing-acknowledged" {
                            tx.save_payment_endpoint_reservation(binding);
                        }
                        Ok(())
                    })
                    .await
                    .unwrap();
            }
            if fault == "peer" {
                assert!(!runtime
                    .reconcile_before_withdrawal(peer().as_str(), path().as_str())
                    .await
                    .unwrap());
            } else {
                assert!(
                    runtime
                        .reconcile_before_withdrawal(peer().as_str(), path().as_str())
                        .await
                        .is_err(),
                    "{fault}"
                );
            }
            assert_eq!(runtime.payments.snapshot().unwrap().withdrawals.len(), 1);
        }
    }
}
