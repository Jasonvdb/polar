//! Payment list use cases within the receiver's existing SDK ownership boundary.
use super::Runtime;
use crate::{
    model::Command,
    payment_input::*,
    payment_model::*,
    wallet_adapter::{eligible, peer_key},
    wallet_rpc,
};
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
    async fn validate_current_resolution(&self, r: &ResolutionView) -> anyhow::Result<()> {
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
    fn ensure_payment_peer(&self, key: &str, path: &str) -> anyhow::Result<()> {
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
        // Reconcile SDK's durable reservation-to-message binding before any enqueue.
        let existing = self
            .storage
            .transaction(|tx| {
                Ok(entries
                    .iter()
                    .filter_map(|r| {
                        tx.payment_endpoint_reservation(&peer, &receiver_path, &r.view.id)
                    })
                    .collect::<Vec<_>>())
            })
            .await?;
        if !existing.is_empty() {
            anyhow::ensure!(
                existing.len() == entries.len()
                    && existing
                        .iter()
                        .all(|r| r.outbound_message_id == existing[0].outbound_message_id
                            && r.cancellation_started_at.is_none()),
                "private publication requires recovery"
            );
            self.payments.mark_list(
                list,
                "queued",
                Some(existing[0].outbound_message_id.to_string()),
            )?;
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
                self.payments.mark_list(
                    list,
                    "queued",
                    Some(message.outbound_message_id.to_string()),
                )?;
                self.payments.update(|s| {
                    s.withdrawals.remove(&peer_key(key, path));
                    Ok(())
                })?;
            }
            Err(error) => {
                self.payments.mark_list(list, "failed", None)?;
                return Err(error.into());
            }
        }
        Ok(())
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
    async fn resolve_payment(&self, id: String, i: Resolve) -> anyhow::Result<ResolutionView> {
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
