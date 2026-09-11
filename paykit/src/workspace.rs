//! Receiver-owned use cases. SDK and application metadata have one process writer.
use crate::{
    commands::{self, ContactInput, ContactKey, PeerInput, ProfileInput},
    model::{Command, PublicError},
    storage::{ReceiverStorage, Vault},
    workspace_model::*,
};
use paykit_sdk::{
    storage::{LinkedPeerRecord, StorageAdapter},
    Clock, ContactUpdate, LinkedPeerState, OutboundPrivateMessageStatus, PaykitProfile,
    PaykitProfileRecord, PaykitReceiverPath, PaykitSdk, PubkyPublicKey, PubkySessionProvider,
    PublicationStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

pub(crate) type Sdk = PaykitSdk<
    Arc<ReceiverStorage>,
    crate::receiver::SessionProvider,
    crate::wallet_adapter::WalletAdapter,
    crate::clock::SdkEventClock,
>;
const FAILURE: &str = "The receiver operation failed. Check peer state and local services. An interrupted command requires reconciliation before another attempt.";
#[derive(Clone, Serialize, Deserialize)]
struct Intent {
    command: Command,
    result: Option<Value>,
    error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct LocalState {
    view: Workspace,
    intents: BTreeMap<Uuid, Intent>,
    #[serde(default)]
    uncertain_peers: Vec<(String, String)>,
    #[serde(default)]
    owned_avatars: Vec<String>,
    #[serde(default)]
    recovery_preparations: Vec<RecoveryPreparationAnchor>,
}
#[derive(Clone, Serialize, Deserialize)]
struct RecoveryPreparationAnchor {
    peer_public_key: String,
    peer_receiver_path: String,
    episode_started_at: chrono::DateTime<chrono::Utc>,
    anchored_local_attempt_id: Option<String>,
    anchored_remote_attempt_id: Option<String>,
    #[serde(default)]
    remote_attested_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    marker_retry_started_at: Option<chrono::DateTime<chrono::Utc>>,
}
pub struct Runtime {
    clock: crate::clock::ApplicationClock,
    sdk: Sdk,
    storage: Arc<ReceiverStorage>,
    vault: Arc<Vault>,
    state: LocalState,
    owner: PubkyPublicKey,
    sessions: crate::receiver::SessionProvider,
    payments: crate::wallet_adapter::WalletAdapter,
}

pub(crate) fn with_recovery_gate(
    value: ciborium::Value,
    recovery: crate::model::Recovery,
) -> anyhow::Result<ciborium::Value> {
    let mut encoded = Vec::new();
    ciborium::into_writer(&value, &mut encoded)?;
    let mut state: LocalState = ciborium::from_reader(encoded.as_slice())?;
    state.view.delivery_paused = true;
    state.view.recovery = Some(recovery);
    state.recovery_preparations.clear();
    Ok(ciborium::Value::serialized(&state)?)
}

pub(crate) fn save_recovery(vault: &Vault, recovery: crate::model::Recovery) -> anyhow::Result<()> {
    let mut state: LocalState = vault
        .load("workspace.cbor")?
        .ok_or_else(|| anyhow::anyhow!("receiver workspace missing"))?;
    state.view.delivery_paused = recovery.automation_paused;
    state.view.recovery = Some(recovery);
    vault.save("workspace.cbor", &state)
}
impl Runtime {
    pub(crate) fn new(
        sdk: Sdk,
        storage: Arc<ReceiverStorage>,
        vault: Arc<Vault>,
        id: Uuid,
        owner: PubkyPublicKey,
        sessions: crate::receiver::SessionProvider,
        payments: crate::wallet_adapter::WalletAdapter,
    ) -> anyhow::Result<Self> {
        let clock = payments.clock();
        let mut state: LocalState = vault.load("workspace.cbor")?.unwrap_or_else(|| LocalState {
            view: Workspace {
                receiver_id: id,
                ..Workspace::default()
            },
            intents: BTreeMap::new(),
            uncertain_peers: vec![],
            owned_avatars: vec![],
            recovery_preparations: vec![],
        });
        anyhow::ensure!(state.view.receiver_id == id, "workspace receiver mismatch");
        for intent in state
            .intents
            .values_mut()
            .filter(|i| i.result.is_none() && i.error.is_none())
        {
            intent.error = Some(FAILURE.into());
            if let Ok(peer) = serde_json::from_value::<PeerInput>(intent.command.input.clone()) {
                if intent.command.command.starts_with("link.") {
                    state
                        .uncertain_peers
                        .push((peer.peer_public_key, peer.peer_receiver_path));
                }
            }
            state.view.last_error = Some(FAILURE.into());
        }
        vault.save("workspace.cbor", &state)?;
        Ok(Self {
            clock,
            sdk,
            storage,
            vault,
            state,
            owner,
            sessions,
            payments,
        })
    }
    pub fn view(&self) -> Workspace {
        self.state.view.clone()
    }
    fn save(&mut self) -> anyhow::Result<()> {
        self.state.view.updated_at = Some(chrono::Utc::now().to_rfc3339());
        self.vault.save("workspace.cbor", &self.state)
    }
    pub async fn execute(&mut self, command: Command) -> anyhow::Result<Result<Value, String>> {
        if let Some(prior) = self.state.intents.get(&command.command_id) {
            anyhow::ensure!(
                prior.command.command == command.command && prior.command.input == command.input,
                "receiver command conflict"
            );
            return Ok(match (&prior.result, &prior.error) {
                (Some(v), _) => Ok(v.clone()),
                _ => Err(prior.error.clone().unwrap_or_else(|| FAILURE.into())),
            });
        }
        commands::validate(&command).map_err(|_| anyhow::anyhow!("receiver input rejected"))?;
        anyhow::ensure!(
            command.input["receiverId"] == self.state.view.receiver_id.to_string(),
            "receiver routing rejected"
        );
        self.state.intents.insert(
            command.command_id,
            Intent {
                command: command.clone(),
                result: None,
                error: None,
            },
        );
        self.save()?; // Intent reaches durable receiver storage before any SDK side effect.

        // Transport deadlines return through the SDK, allowing durable lease cleanup.
        let result = self.dispatch(&command).await;
        self.refresh().await?;
        let public = result.map_err(|error| {
            error
                .downcast_ref::<PublicError>()
                .map_or_else(|| FAILURE.to_string(), |e| e.message.clone())
        });
        self.state.view.last_error = public.as_ref().err().cloned();
        let intent = self
            .state
            .intents
            .get_mut(&command.command_id)
            .expect("saved intent");
        match &public {
            Ok(value) => intent.result = Some(value.clone()),
            Err(error) => intent.error = Some(error.clone()),
        };
        self.save()?;
        Ok(public)
    }
    async fn dispatch(&mut self, command: &Command) -> anyhow::Result<Value> {
        let name = command.command.as_str();
        if self.state.view.recovery.is_some()
            && !self.recovery_allows_automation()
            && !name.starts_with("link.")
            && name != "delivery.pause"
        {
            return Err(PublicError::new(
                "recovery_required",
                "Finish receiver recovery before changing receiver or payment state.",
            )
            .into());
        }
        if crate::subscription_input::is_command(name) {
            return self.subscription_command(command).await;
        }
        if crate::receipt_input::is_command(name) {
            return self.receipt_command(command).await;
        }
        if crate::request_input::is_command(name) {
            return self.request_command(command).await;
        }
        if crate::payment_input::is_command(name) {
            return self.payment_command(command).await;
        }
        if name.starts_with("link.") {
            let i: PeerInput = serde_json::from_value(command.input.clone())?;
            let key = PubkyPublicKey::new(&i.peer_public_key)?;
            let path = PaykitReceiverPath::new(&i.peer_receiver_path)?;
            if key == self.owner {
                return Err(PublicError::new("same_owner", "Choose a peer owned by a different participant. Receivers under the same identity cannot link to each other.").into());
            }
            let peer = (i.peer_public_key, i.peer_receiver_path);
            let peers = self.sdk.linked_peers().await?;
            let sdk_peer = peers.iter().find(|value| {
                value.counterparty == key && value.counterparty_receiver_path == path
            });
            ensure_capacity(
                peers
                    .iter()
                    .any(|p| p.counterparty == key && p.counterparty_receiver_path == path),
                peers.len(),
                64,
                "This receiver already tracks 64 peers. Use an existing peer.",
            )?;
            if !matches!(
                name,
                "link.prepareRecovery"
                    | "link.retryRecoveryMarker"
                    | "link.initiate"
                    | "link.accept"
                    | "link.advance"
                    | "link.block"
                    | "link.unblock"
            ) {
                anyhow::ensure!(
                    !self.state.uncertain_peers.contains(&peer),
                    "relink required"
                );
            }
            match name {
                "link.prepareRecovery" => {
                    return self.prepare_link_recovery(key, path, sdk_peer).await;
                }
                "link.retryRecoveryMarker" => {
                    return self.retry_link_recovery_marker(key, path, sdk_peer).await;
                }
                "link.initiate" => {
                    self.ensure_recovery_prepared(&peer, sdk_peer)?;
                    self.prepare_explicit_relink(
                        &key,
                        &path,
                        self.state.uncertain_peers.contains(&peer),
                    )
                    .await?;
                    self.sdk.initiate_link_with_peer(key, path).await?;
                }
                "link.accept" => {
                    self.ensure_recovery_prepared(&peer, sdk_peer)?;
                    self.prepare_explicit_relink(
                        &key,
                        &path,
                        self.state.uncertain_peers.contains(&peer),
                    )
                    .await?;
                    self.sdk.accept_link_with_peer(key, path).await?;
                }
                "link.advance" => {
                    if !sdk_peer.is_some_and(|value| self.link_advancement_allowed(value)) {
                        return Err(PublicError::new(
                            "recovery_preparation_required",
                            "Prepare reciprocal recovery markers before advancing the fresh link.",
                        )
                        .into());
                    }
                    self.sdk.advance_link_handshake(key, path).await?;
                }
                "link.block" => {
                    self.sdk.block_peer(key, path).await?;
                    self.state.uncertain_peers.retain(|p| p != &peer);
                    self.clear_recovery_preparation(&peer);
                }
                "link.unblock" => {
                    self.clear_blocked_outbox(&key, &path).await?;
                    self.sdk.unblock_peer(key, path).await?;
                    self.clear_recovery_preparation(&peer);
                }
                "link.sendEmptyList" => {
                    let message = self
                        .sdk
                        .enqueue_private_payment_list_with_receiving_details(key, path, vec![])
                        .await?;
                    return Ok(
                        json!({"receiverId":self.state.view.receiver_id,"outboundMessageId":message.outbound_message_id.to_string(),"status":"queued"}),
                    );
                }
                _ => anyhow::bail!("unknown link command"),
            }
        } else {
            match name {
                "delivery.pause" => self.state.view.delivery_paused = true,
                "delivery.resume" => {
                    if !self.recovery_allows_automation() {
                        return Err(PublicError::new(
                            "recovery_required",
                            "Finish receiver recovery before resuming private delivery.",
                        )
                        .into());
                    }
                    self.state.view.delivery_paused = false;
                }
                "delivery.sync" => {
                    if self.state.view.delivery_paused {
                        return Err(PublicError::new(
                            "delivery_paused",
                            "Private delivery is paused. Resume delivery before synchronizing.",
                        )
                        .into());
                    }
                    self.sync().await?;
                }
                "profile.publish" => {
                    let i: ProfileInput = serde_json::from_value(command.input.clone())?;
                    self.publish(i).await?;
                }
                "profile.delete" => {
                    self.sdk.delete_paykit_profile().await?;
                    self.state.view.profile = None;
                    self.save()?;
                    self.cleanup_avatars().await?;
                }
                "profile.fetch" => {
                    let i: PeerInput = serde_json::from_value(command.input.clone())?;
                    let profile = self
                        .sdk
                        .fetch_paykit_profile(
                            PubkyPublicKey::new(&i.peer_public_key)?,
                            PaykitReceiverPath::new(&i.peer_receiver_path)?,
                        )
                        .await?;
                    let view = match profile {
                        Some(p) => Some(self.profile_view(p, i.peer_receiver_path.clone()).await?),
                        None => None,
                    };
                    self.state.view.profiles.retain(|p| {
                        p.peer_public_key != i.peer_public_key
                            || p.peer_receiver_path != i.peer_receiver_path
                    });
                    if let Some(p) = view {
                        self.state.view.profiles.push(p);
                        retain_recent(&mut self.state.view.profiles, 16);
                    }
                }
                "contact.save" => {
                    let i: ContactInput = serde_json::from_value(command.input.clone())?;
                    let public_key = PubkyPublicKey::new(i.peer_public_key)?;
                    let contacts = self.sdk.contact_records().await?;
                    ensure_capacity(contacts.iter().any(|c|c.public_key == public_key),contacts.len(),128,"This receiver already has 128 contacts. Remove a private contact before adding another.")?;
                    if let Some(record) = self.sdk.contact_record(&public_key).await? {
                        if !matches!(
                            record.public_contact_marker_status,
                            PublicationStatus::NotPublished | PublicationStatus::Removed
                        ) {
                            anyhow::ensure!(
                                record
                                    .public_contact_marker_receiver_path
                                    .as_ref()
                                    .is_some_and(|p| i
                                        .receiver_paths
                                        .iter()
                                        .any(|v| v == p.as_str())),
                                "unpublish tracked marker before removing receiver path"
                            );
                        }
                    }
                    self.sdk
                        .save_contact(ContactUpdate {
                            public_key,
                            label: Some(i.label),
                            receiver_paths: i
                                .receiver_paths
                                .into_iter()
                                .map(PaykitReceiverPath::new)
                                .collect::<Result<_, _>>()?,
                        })
                        .await?;
                }
                "contact.remove" => {
                    let i: ContactKey = serde_json::from_value(command.input.clone())?;
                    self.sdk
                        .remove_contact(&PubkyPublicKey::new(i.peer_public_key)?)
                        .await?;
                }
                "contact.discover" => {
                    let i: ContactKey = serde_json::from_value(command.input.clone())?;
                    let paths = self
                        .sdk
                        .paykit_receiver_paths(PubkyPublicKey::new(&i.peer_public_key)?)
                        .await?;
                    self.state
                        .view
                        .discoveries
                        .retain(|p| p.peer_public_key != i.peer_public_key);
                    self.state.view.discoveries.push(DiscoveryView {
                        peer_public_key: i.peer_public_key,
                        receiver_paths: paths.into_iter().map(|p| p.to_string()).collect(),
                        updated_at: chrono::Utc::now().to_rfc3339(),
                    });
                    retain_recent(&mut self.state.view.discoveries, 64);
                }
                "contact.publish" | "contact.unpublish" => {
                    let i: PeerInput = serde_json::from_value(command.input.clone())?;
                    let key = PubkyPublicKey::new(i.peer_public_key)?;
                    let path = PaykitReceiverPath::new(i.peer_receiver_path)?;
                    if let Some(record) = self.sdk.contact_record(&key).await? {
                        ensure_marker_path(&record, &path)?;
                    }
                    if name == "contact.publish" {
                        self.sdk.publish_public_contact(key, path).await?;
                    } else {
                        self.sdk.remove_public_contact(key, path).await?;
                    }
                }
                _ => anyhow::bail!("unsupported workspace command"),
            }
        }
        Ok(json!({"receiverId":self.state.view.receiver_id}))
    }

    async fn prepare_link_recovery(
        &mut self,
        key: PubkyPublicKey,
        path: PaykitReceiverPath,
        initial_peer: Option<&LinkedPeerRecord>,
    ) -> anyhow::Result<Value> {
        let initial_peer =
            initial_peer.ok_or_else(|| anyhow::anyhow!("peer recovery unavailable"))?;
        anyhow::ensure!(
            initial_peer.state != LinkedPeerState::Blocked,
            "peer recovery unavailable"
        );
        if initial_peer.state == LinkedPeerState::Linking {
            return Err(PublicError::new(
                "recovery_handshake_active",
                "Finish or recover the active link handshake before preparing recovery.",
            )
            .into());
        }
        let target = (key.to_string(), path.to_string());
        self.ensure_recovery_preparation_anchor(&target)?;
        self.save()?;
        let observed = self
            .sdk
            .observe_encrypted_link_recovery_marker(key.clone(), path.clone())
            .await
            .map_err(|_| recovery_marker_failed())?;
        let live_remote = self
            .live_remote_recovery_marker(&key, &path)
            .await
            .map_err(|_| recovery_marker_failed())?;
        let mut peer = self
            .sdk_peer(&key, &path)
            .await?
            .ok_or_else(|| anyhow::anyhow!("peer recovery unavailable"))?;
        self.anchor_live_remote_evidence(&target, &observed, live_remote.as_ref());
        self.save()?;
        let application_target = self.application_recovery_targets(&peer);
        let observed_preparation = self.recovery_preparation(&peer, application_target);
        if live_recovery_marker_was_rejected(&observed, live_remote.as_ref()) {
            self.clear_recovery_preparation(&target);
            self.save()?;
            return Err(recovery_marker_stale().into());
        }
        if !application_target
            && peer.state != LinkedPeerState::RecoveryRequired
            && observed_preparation.is_none()
        {
            self.clear_recovery_preparation(&target);
            self.save()?;
            return Err(PublicError::new(
                "recovery_not_required",
                "No current recovery evidence exists for this peer.",
            )
            .into());
        }
        if !observed_preparation
            .as_ref()
            .is_some_and(|value| value.local_marker_present)
        {
            if peer.local_recovery_attempt_id.is_some() {
                self.sdk
                    .remove_encrypted_link_recovery_marker(key.clone(), path.clone())
                    .await
                    .map_err(|_| recovery_marker_failed())?;
                peer = self
                    .sdk_peer(&key, &path)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("peer recovery unavailable"))?;
                if peer.local_recovery_attempt_id.is_some()
                    || peer.local_recovery_marker_last_error.is_some()
                {
                    return Err(recovery_marker_failed().into());
                }
            }
            let published = self
                .sdk
                .publish_encrypted_link_recovery_marker(key.clone(), path.clone())
                .await
                .map_err(|_| recovery_marker_failed())?;
            peer = self
                .sdk_peer(&key, &path)
                .await?
                .ok_or_else(|| anyhow::anyhow!("peer recovery unavailable"))?;
            self.anchor_published_local_evidence(&target, &published);
            self.save()?;
        }
        if peer.local_recovery_marker_last_error.is_some() {
            return Err(recovery_marker_failed().into());
        }
        let preparation = self
            .recovery_preparation(&peer, application_target)
            .ok_or_else(|| anyhow::anyhow!("peer recovery unavailable"))?;
        Ok(recovery_preparation_result(
            self.state.view.receiver_id,
            &peer,
            &preparation,
            observed.remote_marker_changed,
        ))
    }

    async fn retry_link_recovery_marker(
        &mut self,
        key: PubkyPublicKey,
        path: PaykitReceiverPath,
        initial_peer: Option<&LinkedPeerRecord>,
    ) -> anyhow::Result<Value> {
        let initial_peer = initial_peer.ok_or_else(recovery_marker_retry_unavailable)?;
        let target = (key.to_string(), path.to_string());
        let application_target = self.application_recovery_targets(initial_peer);
        let now = self.clock.now();
        if initial_peer.local_recovery_attempt_id.is_some() {
            ensure_recovery_marker_retry_allowed(initial_peer, application_target, now)?;
            self.ensure_recovery_preparation_anchor(&target)?;
            let anchor = self
                .state
                .recovery_preparations
                .iter_mut()
                .find(|anchor| {
                    anchor.peer_public_key == target.0 && anchor.peer_receiver_path == target.1
                })
                .ok_or_else(recovery_marker_retry_unavailable)?;
            anchor.anchored_local_attempt_id = initial_peer.local_recovery_attempt_id.clone();
            anchor.marker_retry_started_at = Some(now);
            self.save()?;
            self.sdk
                .remove_encrypted_link_recovery_marker(key.clone(), path.clone())
                .await
                .map_err(|_| recovery_marker_failed())?;
        } else {
            let anchor = self
                .recovery_preparation_anchor(&target)
                .ok_or_else(recovery_marker_retry_unavailable)?;
            ensure_recovery_marker_retry_resume_allowed(
                initial_peer,
                application_target,
                anchor,
                now,
            )?;
        }
        let cleared = self
            .sdk_peer(&key, &path)
            .await?
            .ok_or_else(recovery_marker_retry_unavailable)?;
        if cleared.local_recovery_attempt_id.is_some()
            || cleared.local_recovery_marker_last_error.is_some()
        {
            return Err(recovery_marker_failed().into());
        }

        let published = self
            .sdk
            .publish_encrypted_link_recovery_marker(key.clone(), path.clone())
            .await
            .map_err(|_| recovery_marker_failed())?;
        let peer = self
            .sdk_peer(&key, &path)
            .await?
            .ok_or_else(recovery_marker_retry_unavailable)?;
        self.anchor_published_local_evidence(&target, &published);
        self.save()?;
        let preparation = self
            .recovery_preparation(&peer, application_target)
            .ok_or_else(recovery_marker_retry_unavailable)?;
        Ok(recovery_preparation_result(
            self.state.view.receiver_id,
            &peer,
            &preparation,
            false,
        ))
    }

    async fn sdk_peer(
        &self,
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
    ) -> anyhow::Result<Option<LinkedPeerRecord>> {
        Ok(self
            .sdk
            .linked_peers()
            .await?
            .into_iter()
            .find(|peer| peer.counterparty == *key && peer.counterparty_receiver_path == *path))
    }

    async fn live_remote_recovery_marker(
        &self,
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
    ) -> anyhow::Result<Option<paykit_lib::EncryptedLinkRecoveryMarker>> {
        let access = self
            .sessions
            .load_session_access()
            .await?
            .ok_or_else(|| anyhow::anyhow!("receiver grant unavailable"))?;
        let public_storage = self
            .sessions
            .load_public_storage()
            .await?
            .ok_or_else(|| anyhow::anyhow!("public storage unavailable"))?;
        let marker = self
            .sdk
            .paykit_receiver_marker(key.clone(), path.clone())
            .await?
            .ok_or_else(|| anyhow::anyhow!("peer receiver marker unavailable"))?;
        Ok(paykit_lib::fetch_encrypted_link_recovery_marker(
            &public_storage,
            access.receiver_noise_secret_key.as_bytes(),
            access.session.info().public_key(),
            &key.to_public_key()?,
            &marker.noise_public_key,
            &self.sdk.config().receiver_path,
            path,
        )
        .await?)
    }

    fn ensure_recovery_prepared(
        &self,
        target: &(String, String),
        peer: Option<&LinkedPeerRecord>,
    ) -> anyhow::Result<()> {
        let application_target = self.recovery_targets(target);
        let Some(peer) = peer else {
            anyhow::ensure!(!application_target, "peer recovery unavailable");
            return Ok(());
        };
        let preparation = self.recovery_preparation(peer, application_target);
        let barrier_required = application_target
            || peer.state == LinkedPeerState::RecoveryRequired
            || preparation.is_some();
        if barrier_required && !preparation.is_some_and(|value| value.ready_for_handshake) {
            return Err(PublicError::new(
                "recovery_preparation_required",
                "Prepare reciprocal recovery markers before starting the fresh link.",
            )
            .into());
        }
        Ok(())
    }

    fn application_recovery_targets(&self, peer: &LinkedPeerRecord) -> bool {
        self.recovery_targets(&(
            peer.counterparty.to_string(),
            peer.counterparty_receiver_path.to_string(),
        ))
    }

    fn recovery_targets(&self, peer: &(String, String)) -> bool {
        self.state.view.recovery.as_ref().is_some_and(|recovery| {
            recovery
                .peers_requiring_relink
                .iter()
                .any(|value| value.peer_public_key == peer.0 && value.peer_receiver_path == peer.1)
        })
    }

    fn ensure_recovery_preparation_anchor(
        &mut self,
        peer: &(String, String),
    ) -> anyhow::Result<()> {
        if !self
            .state
            .recovery_preparations
            .iter()
            .any(|value| value.peer_public_key == peer.0 && value.peer_receiver_path == peer.1)
        {
            self.state
                .recovery_preparations
                .push(RecoveryPreparationAnchor {
                    peer_public_key: peer.0.clone(),
                    peer_receiver_path: peer.1.clone(),
                    episode_started_at: self.clock.now(),
                    anchored_local_attempt_id: None,
                    anchored_remote_attempt_id: None,
                    remote_attested_at: None,
                    marker_retry_started_at: None,
                });
        }
        Ok(())
    }

    fn recovery_preparation_anchor(
        &self,
        peer: &(String, String),
    ) -> Option<&RecoveryPreparationAnchor> {
        self.state
            .recovery_preparations
            .iter()
            .find(|value| value.peer_public_key == peer.0 && value.peer_receiver_path == peer.1)
    }

    fn anchor_live_remote_evidence(
        &mut self,
        target: &(String, String),
        observed: &paykit_sdk::EncryptedLinkRecoveryMarkerReport,
        live: Option<&paykit_lib::EncryptedLinkRecoveryMarker>,
    ) {
        let attested = live
            .filter(|marker| Some(marker.attempt_id()) == observed.remote_attempt_id.as_deref())
            .map(|_| (observed.remote_attempt_id.clone(), self.clock.now()));
        let Some(anchor) = self.state.recovery_preparations.iter_mut().find(|value| {
            value.peer_public_key == target.0 && value.peer_receiver_path == target.1
        }) else {
            return;
        };
        if let Some((attempt_id, attested_at)) = attested {
            anchor.anchored_remote_attempt_id = attempt_id;
            anchor.remote_attested_at = Some(attested_at);
        } else {
            anchor.anchored_remote_attempt_id = None;
            anchor.remote_attested_at = None;
        }
    }

    fn anchor_published_local_evidence(
        &mut self,
        target: &(String, String),
        published: &paykit_sdk::EncryptedLinkRecoveryMarkerReport,
    ) {
        let Some(anchor) = self.state.recovery_preparations.iter_mut().find(|value| {
            value.peer_public_key == target.0 && value.peer_receiver_path == target.1
        }) else {
            return;
        };
        anchor.anchored_local_attempt_id = published.local_attempt_id.clone();
        anchor.marker_retry_started_at = None;
    }

    fn clear_recovery_preparation(&mut self, peer: &(String, String)) {
        self.state
            .recovery_preparations
            .retain(|value| value.peer_public_key != peer.0 || value.peer_receiver_path != peer.1);
    }

    fn recovery_preparation(
        &self,
        peer: &LinkedPeerRecord,
        application_target: bool,
    ) -> Option<RecoveryPreparationView> {
        let target = (
            peer.counterparty.to_string(),
            peer.counterparty_receiver_path.to_string(),
        );
        recovery_preparation(
            peer,
            application_target,
            self.recovery_preparation_anchor(&target),
        )
    }

    fn link_advancement_allowed(&self, peer: &LinkedPeerRecord) -> bool {
        let target = (
            peer.counterparty.to_string(),
            peer.counterparty_receiver_path.to_string(),
        );
        if !self.state.uncertain_peers.contains(&target) || !self.recovery_targets(&target) {
            return true;
        }
        peer.state == LinkedPeerState::Linking
            && self.recovery_preparation(peer, true).is_some_and(|value| {
                value.local_marker_present
                    && value.remote_marker_present
                    && peer.local_recovery_marker_last_error.is_none()
            })
    }

    pub(super) fn recovery_allows_automation(&self) -> bool {
        self.state.view.recovery.as_ref().is_none_or(|recovery| {
            recovery.sdk_validated
                && recovery.wallet_reconciled
                && recovery.grant_valid
                && recovery.marker_valid
                && matches!(recovery.phase, crate::model::RecoveryPhase::Ready)
        })
    }

    fn complete_recovery_peer(&mut self, peer: &(String, String)) {
        let Some(recovery) = self.state.view.recovery.as_mut() else {
            return;
        };
        recovery
            .peers_requiring_relink
            .retain(|value| value.peer_public_key != peer.0 || value.peer_receiver_path != peer.1);
        if recovery.peers_requiring_relink.is_empty() {
            recovery.blocked_reasons.retain(|reason| {
                *reason != crate::model::RecoveryBlockedReason::PeerRelinkRequired
            });
            if recovery.wallet_reconciled && recovery.sdk_validated {
                recovery.phase = crate::model::RecoveryPhase::Ready;
                recovery.automation_paused = false;
            }
        }
    }
    fn reconcile_local_link_recovery(&mut self, peers: &[LinkedPeerRecord]) {
        for peer in peers {
            let target = (
                peer.counterparty.to_string(),
                peer.counterparty_receiver_path.to_string(),
            );
            let uncertain = self.state.uncertain_peers.contains(&target);
            let locally_converged = peer.state == LinkedPeerState::Linked
                && peer.local_recovery_attempt_id.is_none()
                && peer.local_recovery_marker_last_error.is_none();
            if peer.state == LinkedPeerState::RecoveryRequired || (uncertain && !locally_converged)
            {
                self.require_recovery_peer(&target);
                continue;
            }
            if locally_converged {
                self.state.uncertain_peers.retain(|value| value != &target);
                self.clear_recovery_preparation(&target);
                self.complete_recovery_peer(&target);
            }
        }
    }
    fn require_recovery_peer(&mut self, peer: &(String, String)) {
        let Some(recovery) = self.state.view.recovery.as_mut() else {
            return;
        };
        if !recovery
            .peers_requiring_relink
            .iter()
            .any(|value| value.peer_public_key == peer.0 && value.peer_receiver_path == peer.1)
        {
            recovery
                .peers_requiring_relink
                .push(crate::model::RecoveryPeer {
                    peer_public_key: peer.0.clone(),
                    peer_receiver_path: peer.1.clone(),
                });
        }
        if !recovery
            .blocked_reasons
            .contains(&crate::model::RecoveryBlockedReason::PeerRelinkRequired)
        {
            recovery
                .blocked_reasons
                .push(crate::model::RecoveryBlockedReason::PeerRelinkRequired);
        }
        recovery.phase = crate::model::RecoveryPhase::RelinkRequired;
        recovery.automation_paused = true;
        self.state.view.delivery_paused = true;
    }
    /// Clear abandoned responder slots before removing the block, so an initiator
    /// cannot consume a previous handshake while a human is deciding to accept.
    /// Every failure (including cancellation) leaves the SDK's blocked state intact.
    async fn clear_blocked_outbox(
        &self,
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
    ) -> anyhow::Result<()> {
        let blocked_checkpoint = self
            .storage
            .transaction(|tx| {
                Ok(tx
                    .linked_peer(key, path)
                    .is_some_and(|peer| peer.state == LinkedPeerState::Blocked)
                    && tx.encrypted_link_state(key, path).is_some())
            })
            .await?;
        if !blocked_checkpoint {
            return Ok(());
        }
        let access = self
            .sessions
            .load_session_access()
            .await?
            .ok_or_else(|| anyhow::anyhow!("receiver grant unavailable"))?;
        let marker = self
            .sdk
            .paykit_receiver_marker(key.clone(), path.clone())
            .await?
            .ok_or_else(|| anyhow::anyhow!("peer receiver marker unavailable"))?;
        paykit_lib::clear_encrypted_link_outbox(
            &access.session,
            access.receiver_noise_secret_key.as_bytes(),
            &key.to_public_key()?,
            &marker.noise_public_key,
            &self.sdk.config().receiver_path,
            path,
        )
        .await?;
        Ok(())
    }
    /// SDK block/unblock abandons local snapshots but retains the old public stream.
    /// Explicit recovery makes the SDK clear only this peer's local outbox before
    /// the next handshake; starting directly from NotLinked would reuse old slots.
    async fn prepare_explicit_relink(
        &self,
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
        uncertain: bool,
    ) -> anyhow::Result<()> {
        let needs_recovery = self
            .storage
            .transaction(|tx| {
                let peer = tx.linked_peer(key, path);
                Ok(recovery_before_explicit_link(
                    peer.as_ref().map(|p| &p.state),
                    tx.encrypted_link_state(key, path).is_some(),
                    uncertain,
                ))
            })
            .await?;
        if needs_recovery {
            self.sdk
                .publish_encrypted_link_recovery_marker(key.clone(), path.clone())
                .await?;
        }
        Ok(())
    }
    async fn publish(&mut self, input: ProfileInput) -> anyhow::Result<()> {
        let mut image = self
            .sdk
            .fetch_paykit_profile(self.owner.clone(), self.sdk.config().receiver_path.clone())
            .await?
            .and_then(|p| p.profile.image_uri);
        if let (Some(encoded), Some(mime)) = (input.avatar_base64, input.avatar_mime) {
            if encoded.is_empty() {
                image = None;
            } else {
                let bytes = commands::decode_avatar(&encoded, &mime)
                    .map_err(|_| anyhow::anyhow!("invalid avatar"))?;
                let blob = self.sdk.upload_profile_avatar(bytes, &mime).await?;
                if !self.state.owned_avatars.contains(&blob.uri) {
                    self.state.owned_avatars.push(blob.uri.clone());
                }
                self.save()?;
                image = Some(blob.uri);
            }
        }
        let record = self
            .sdk
            .publish_paykit_profile(PaykitProfile {
                display_name: Some(input.display_name),
                image_uri: image,
                extra: Some(serde_json::Map::from_iter([(
                    "about".into(),
                    Value::String(input.about),
                )])),
            })
            .await?;
        self.state.view.profile = Some(
            self.profile_view(record, self.sdk.config().receiver_path.to_string())
                .await?,
        );
        self.save()?;
        self.cleanup_avatars().await
    }
    async fn cleanup_avatars(&mut self) -> anyhow::Result<()> {
        let current = self
            .state
            .view
            .profile
            .as_ref()
            .and_then(|p| p.image_uri.clone());
        for uri in self.state.owned_avatars.clone() {
            if current.as_ref() != Some(&uri) {
                self.sdk.delete_paykit_blob(&uri).await?;
                self.state.owned_avatars.retain(|v| v != &uri);
                self.save()?;
            }
        }
        Ok(())
    }
    async fn profile_view(
        &self,
        record: PaykitProfileRecord,
        receiver_path: String,
    ) -> anyhow::Result<ProfileView> {
        let mut avatar_data_url = None;
        if let Some(uri) = &record.profile.image_uri {
            // Only the advertised owner's receiver-scoped public blob can be fetched.
            let prefix = format!(
                "pubky://{}/pub/paykit/v0/{receiver_path}/blobs/",
                record.public_key
            );
            anyhow::ensure!(
                uri.starts_with(&prefix)
                    && !uri[prefix.len()..].contains('/')
                    && !uri.contains(".."),
                "unsupported public avatar location"
            );
            {
                if let Some(bytes) = fetch_avatar(uri).await? {
                    avatar_data_url = commands::avatar_preview(&bytes);
                    anyhow::ensure!(avatar_data_url.is_some(), "invalid public avatar preview");
                }
            }
        }
        anyhow::ensure!(
            record
                .profile
                .display_name
                .as_ref()
                .is_none_or(|name| name.len() <= 80),
            "public profile name too large"
        );
        let about = record
            .profile
            .extra
            .as_ref()
            .and_then(|m| m.get("about"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        anyhow::ensure!(about.len() <= 2000, "public profile about too large");
        Ok(ProfileView {
            peer_public_key: record.public_key.to_string(),
            peer_receiver_path: receiver_path,
            display_name: record.profile.display_name.unwrap_or_default(),
            about: record
                .profile
                .extra
                .and_then(|m| m.get("about").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_default(),
            image_uri: record.profile.image_uri,
            avatar_data_url,
            path: record.path,
            updated_at: record.updated_at.to_rfc3339(),
        })
    }
    pub async fn background(&mut self) -> anyhow::Result<()> {
        let before = self.state.view.clone();
        let result = self.sync().await;
        if result.is_ok() {
            self.subscription_background().await?;
        }
        self.state.view.last_error = result.err().map(|_| FAILURE.into());
        self.refresh().await?;
        if self.state.view != before {
            self.save()?;
        }
        Ok(())
    }
    async fn sync(&self) -> anyhow::Result<()> {
        let peers = self.sdk.linked_peers().await?;
        self.observe_linked_recovery_markers(&peers).await?;
        let mut failed = self.payment_maintenance().await.is_err();
        for peer in peers {
            if peer.state == LinkedPeerState::Linking && self.link_advancement_allowed(&peer) {
                failed |= self
                    .sdk
                    .advance_link_handshake(peer.counterparty, peer.counterparty_receiver_path)
                    .await
                    .is_err();
            }
        }
        if !self.state.view.delivery_paused && self.state.uncertain_peers.is_empty() {
            let outbound = self.sdk.process_pending_private_messages().await?;
            let inbound = self
                .sdk
                .receive_private_messages_from_linked_peers()
                .await?;
            anyhow::ensure!(
                !failed
                    && outbound.iter().all(|r| r.error.is_none()
                        && r.report.as_ref().is_some_and(|v| v.failed.is_empty()
                            && v.reservation_cleanup_failures.is_empty()
                            && v.recovery_marker_failures.is_empty()))
                    && inbound.iter().all(|r| r.error.is_none()
                        && r.report
                            .as_ref()
                            .is_some_and(|v| v.event_conflicts.is_empty())),
                "private delivery failure"
            );
        }
        anyhow::ensure!(!failed, "link advancement failed");
        Ok(())
    }
    async fn observe_linked_recovery_markers(
        &self,
        peers: &[LinkedPeerRecord],
    ) -> anyhow::Result<()> {
        for peer in peers
            .iter()
            .filter(|peer| peer.state == LinkedPeerState::Linked)
        {
            self.sdk
                .observe_encrypted_link_recovery_marker(
                    peer.counterparty.clone(),
                    peer.counterparty_receiver_path.clone(),
                )
                .await?;
        }
        Ok(())
    }
    pub async fn refresh(&mut self) -> anyhow::Result<()> {
        self.project_receipts().await?;
        self.project_requests().await?;
        self.project_subscriptions().await?;
        self.state.view.application_clock = Some(self.clock.view());
        self.payments.project(&mut self.state.view)?;
        let peers = self.sdk.linked_peers().await?;
        self.reconcile_local_link_recovery(&peers);
        self.state.view.links = self
            .storage
            .transaction(|tx| {
                peers
                    .into_iter()
                    .map(|peer| {
                        let key = &peer.counterparty;
                        let path = &peer.counterparty_receiver_path;
                        let encrypted = tx.encrypted_link_state(key, path);
                        let messages = tx.outbound_private_messages(key, path);
                        let latest = tx
                            .private_stream_items(key, path)
                            .into_iter()
                            .filter(|m| {
                                paykit_lib::parse_private_payment_list_json(&m.raw_json).is_ok()
                            })
                            .map(|m| m.stream_item_id)
                            .max();
                        let uncertain = self
                            .state
                            .uncertain_peers
                            .contains(&(key.to_string(), path.to_string()));
                        let state = if uncertain && peer.state != LinkedPeerState::Blocked {
                            "recoveryRequired"
                        } else {
                            linked_peer_state_name(&peer.state)
                        };
                        let application_target = self.application_recovery_targets(&peer);
                        Ok(LinkView {
                            peer_public_key: key.to_string(),
                            peer_receiver_path: path.to_string(),
                            state: state.into(),
                            generation: encrypted.as_ref().map_or(0, |s| s.generation),
                            handshake_role: encrypted
                                .and_then(|s| s.handshake_role)
                                .map(|r| format!("{r:?}").to_lowercase()),
                            recovery_preparation: self
                                .recovery_preparation(&peer, application_target),
                            last_sync_at: peer.last_sync_at.map(|t| t.to_rfc3339()),
                            last_receive_at: peer.last_private_receive_at.map(|t| t.to_rfc3339()),
                            failure_count: peer.failure_count,
                            pending_messages: messages
                                .iter()
                                .filter(|m| {
                                    !matches!(
                                        m.status,
                                        OutboundPrivateMessageStatus::Sent
                                            | OutboundPrivateMessageStatus::Superseded
                                    )
                                })
                                .count(),
                            latest_received_list_id: latest.map(|id| id.to_string()),
                            last_sent_message_id: messages
                                .iter()
                                .filter(|m| {
                                    m.status == OutboundPrivateMessageStatus::Sent
                                        && m.sent_at.is_some()
                                })
                                .map(|m| m.outbound_message_id)
                                .max()
                                .map(|id| id.to_string()),
                            last_error: (uncertain
                                || state == "unknown"
                                || peer.local_recovery_marker_last_error.is_some()
                                || messages.iter().any(|m| m.last_error.is_some()))
                            .then(|| FAILURE.into()),
                        })
                    })
                    .collect()
            })
            .await?;
        self.state.view.contacts = self
            .sdk
            .contact_records()
            .await?
            .into_iter()
            .map(|r| ContactView {
                peer_public_key: r.public_key.to_string(),
                label: r.label.unwrap_or_default(),
                receiver_paths: r
                    .receiver_paths
                    .into_iter()
                    .map(|p| p.to_string())
                    .collect(),
                public_sharing: match r.public_contact_marker_status {
                    PublicationStatus::NotPublished | PublicationStatus::Removed => "private",
                    PublicationStatus::PendingPublication => "publishing",
                    PublicationStatus::Published => "public",
                    PublicationStatus::PendingRemoval => "removing",
                    _ => "error",
                }
                .into(),
                public_receiver_path: r.public_contact_marker_receiver_path.map(|p| p.to_string()),
                last_error: r.public_contact_last_error.map(|_| FAILURE.into()),
            })
            .collect();
        Ok(())
    }
}
fn recovery_before_explicit_link(
    state: Option<&LinkedPeerState>,
    has_checkpoint: bool,
    uncertain: bool,
) -> bool {
    has_checkpoint
        && state != Some(&LinkedPeerState::Blocked)
        && (state == Some(&LinkedPeerState::NotLinked) || uncertain)
}
fn recovery_preparation(
    peer: &LinkedPeerRecord,
    application_target: bool,
    anchor: Option<&RecoveryPreparationAnchor>,
) -> Option<RecoveryPreparationView> {
    let local_marker_present = anchor.is_some_and(|anchor| {
        peer.local_recovery_marker_created_at
            .is_some_and(|value| value >= anchor.episode_started_at)
            && peer.local_recovery_attempt_id == anchor.anchored_local_attempt_id
            && anchor.anchored_local_attempt_id.is_some()
    });
    let remote_marker_present = anchor.is_some_and(|anchor| {
        anchor
            .remote_attested_at
            .is_some_and(|value| value >= anchor.episode_started_at)
            && peer.remote_recovery_attempt_id == anchor.anchored_remote_attempt_id
            && anchor.anchored_remote_attempt_id.is_some()
    });
    let relevant = application_target
        || peer.state == LinkedPeerState::RecoveryRequired
        || local_marker_present
        || remote_marker_present
        || peer.local_recovery_marker_last_error.is_some();
    relevant.then(|| RecoveryPreparationView {
        local_marker_present,
        local_marker_created_at: local_marker_present
            .then(|| {
                peer.local_recovery_marker_created_at
                    .map(|value| value.to_rfc3339())
            })
            .flatten(),
        remote_marker_present,
        remote_marker_observed_at: remote_marker_present
            .then(|| {
                anchor
                    .and_then(|value| value.remote_attested_at)
                    .map(|value| value.to_rfc3339())
            })
            .flatten(),
        ready_for_handshake: peer.state == LinkedPeerState::RecoveryRequired
            && local_marker_present
            && remote_marker_present
            && peer.local_recovery_marker_last_error.is_none(),
    })
}
fn linked_peer_state_name(state: &LinkedPeerState) -> &'static str {
    match state {
        LinkedPeerState::NotLinked => "notLinked",
        LinkedPeerState::Linking => "linking",
        LinkedPeerState::Linked => "linked",
        LinkedPeerState::RecoveryRequired => "recoveryRequired",
        LinkedPeerState::Blocked => "blocked",
        _ => "unknown",
    }
}
fn recovery_preparation_result(
    receiver_id: Uuid,
    peer: &LinkedPeerRecord,
    preparation: &RecoveryPreparationView,
    remote_marker_changed: bool,
) -> Value {
    json!({
        "receiverId": receiver_id,
        "peerPublicKey": peer.counterparty.to_string(),
        "peerReceiverPath": peer.counterparty_receiver_path.to_string(),
        "state": linked_peer_state_name(&peer.state),
        "localMarkerPresent": preparation.local_marker_present,
        "localMarkerCreatedAt": preparation.local_marker_created_at,
        "remoteMarkerPresent": preparation.remote_marker_present,
        "remoteMarkerObservedAt": preparation.remote_marker_observed_at,
        "remoteMarkerChanged": remote_marker_changed,
        "readyForHandshake": preparation.ready_for_handshake,
    })
}
fn live_recovery_marker_was_rejected(
    observed: &paykit_sdk::EncryptedLinkRecoveryMarkerReport,
    live: Option<&paykit_lib::EncryptedLinkRecoveryMarker>,
) -> bool {
    live.is_some_and(|marker| Some(marker.attempt_id()) != observed.remote_attempt_id.as_deref())
}
fn ensure_recovery_marker_retry_allowed(
    peer: &LinkedPeerRecord,
    application_target: bool,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), PublicError> {
    let Some(marker_created_at) = peer.local_recovery_marker_created_at else {
        return Err(recovery_marker_retry_unavailable());
    };
    if peer.local_recovery_attempt_id.is_none()
        || peer.state == LinkedPeerState::Blocked
        || peer.state == LinkedPeerState::Linking
        || (!application_target && peer.state != LinkedPeerState::RecoveryRequired)
    {
        return Err(recovery_marker_retry_unavailable());
    }
    if now.timestamp() <= marker_created_at.timestamp() {
        return Err(PublicError::new(
            "recovery_marker_retry_too_soon",
            "Pause delivery on the healthy peer, advance the application clock beyond the current marker second if fixed, then retry the recovering peer's marker.",
        ));
    }
    Ok(())
}
fn ensure_recovery_marker_retry_resume_allowed(
    peer: &LinkedPeerRecord,
    application_target: bool,
    anchor: &RecoveryPreparationAnchor,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), PublicError> {
    let Some(retry_started_at) = anchor.marker_retry_started_at else {
        return Err(recovery_marker_retry_unavailable());
    };
    if anchor.anchored_local_attempt_id.is_none()
        || peer.local_recovery_attempt_id.is_some()
        || peer.state == LinkedPeerState::Blocked
        || peer.state == LinkedPeerState::Linking
        || (!application_target && peer.state != LinkedPeerState::RecoveryRequired)
    {
        return Err(recovery_marker_retry_unavailable());
    }
    if now.timestamp() <= retry_started_at.timestamp() {
        return Err(PublicError::new(
            "recovery_marker_retry_too_soon",
            "Pause delivery on the healthy peer, advance the application clock beyond the current marker second if fixed, then retry the recovering peer's marker.",
        ));
    }
    Ok(())
}
fn recovery_marker_retry_unavailable() -> PublicError {
    PublicError::new(
        "recovery_marker_retry_unavailable",
        "No retryable local recovery marker exists for this peer.",
    )
}
fn recovery_marker_stale() -> PublicError {
    PublicError::new(
        "recovery_marker_stale",
        "The peer recovery marker is stale. Pause delivery on this healthy peer, advance the application clock beyond its last link checkpoint if fixed, then retry the recovery marker on the recovering peer.",
    )
}
fn recovery_marker_failed() -> PublicError {
    PublicError::new(
        "recovery_marker_failed",
        "Recovery marker preparation failed. Check peer state and retry.",
    )
}
fn retain_recent<T>(cache: &mut Vec<T>, limit: usize) {
    if cache.len() > limit {
        cache.drain(..cache.len() - limit);
    }
}
fn ensure_capacity(
    existing: bool,
    count: usize,
    limit: usize,
    message: &str,
) -> anyhow::Result<()> {
    if !existing && count >= limit {
        return Err(PublicError::new("receiver_limit", message).into());
    }
    Ok(())
}
fn ensure_marker_path(
    record: &paykit_sdk::ContactRecord,
    path: &PaykitReceiverPath,
) -> anyhow::Result<()> {
    if !matches!(
        record.public_contact_marker_status,
        PublicationStatus::NotPublished | PublicationStatus::Removed
    ) && record.public_contact_marker_receiver_path.as_ref() != Some(path)
    {
        return Err(PublicError::new(
            "public_marker_exists",
            "Unpublish the existing public contact marker before sharing another receiver path.",
        )
        .into());
    }
    Ok(())
}

/// Stream the public blob with a hard allocation bound; no arbitrary HTTP or local path.
pub(crate) async fn fetch_avatar(uri: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let storage = crate::receiver::pubky_client()?.public_storage();
    let mut response = storage.get(uri).await?;
    if response.status().as_u16() == 404 {
        return Ok(None);
    }
    anyhow::ensure!(response.status().is_success(), "avatar fetch failed");
    anyhow::ensure!(
        response
            .content_length()
            .is_none_or(|n| n <= commands::MAX_AVATAR as u64),
        "avatar too large"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            bytes.len() + chunk.len() <= commands::MAX_AVATAR,
            "avatar too large"
        );
        bytes.extend_from_slice(&chunk);
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command(id: Uuid, receiver: Uuid) -> Command {
        Command {
            command_id: id,
            command: "link.sendEmptyList".into(),
            input: json!({"receiverId":receiver,"peerPublicKey":pubky::Keypair::random().public_key().z32(),"peerReceiverPath":"peer/wallet"}),
        }
    }
    fn open(path: &std::path::Path, receiver: Uuid) -> Runtime {
        let vault = Arc::new(Vault::new(path.into(), [8; 32], receiver.to_string()).unwrap());
        let storage = Arc::new(
            ReceiverStorage::open(Vault::new(path.into(), [8; 32], receiver.to_string()).unwrap())
                .unwrap(),
        );
        let provider = crate::receiver::SessionProvider::without_access(vault.clone());
        let payments =
            crate::wallet_adapter::WalletAdapter::open(vault.clone(), receiver, "test".into())
                .unwrap();
        let clock = storage.sdk_clock(payments.clock()).unwrap();
        let sdk = PaykitSdk::try_with_clock(
            storage.clone(),
            provider.clone(),
            payments.clone(),
            paykit_sdk::PaykitSdkConfig::new(PaykitReceiverPath::new("test/wallet").unwrap()),
            clock.clone(),
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
    #[tokio::test]
    async fn completed_child_reply_lost_before_supervisor_commit_is_not_reenqueued() {
        use crate::model::*;
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let id = Uuid::new_v4();
        let request = command(id, receiver);
        let result =
            json!({"receiverId":receiver,"outboundMessageId":"9007199254740993","status":"queued"});
        let mut runtime = open(dir.path(), receiver);
        runtime.state.view.delivery_paused = true;
        runtime.state.intents.insert(
            id,
            Intent {
                command: request.clone(),
                result: Some(result.clone()),
                error: None,
            },
        );
        runtime.save().unwrap(); // Child committed, but deliberately drop its reply before parent commit.
        drop(runtime);
        let mut parent = AppState::new(Uuid::new_v4());
        parent.operations.push(OperationRecord {
            public: Operation {
                id,
                command: request.command.clone(),
                status: OperationStatus::Running,
                result: None,
                error: None,
            },
            request: request.clone(),
        });
        commands::reconcile_interrupted(&mut parent).unwrap();
        assert!(parent.operations[0].public.status == OperationStatus::Failed);
        assert_eq!(
            parent.operations[0].public.error.as_ref().unwrap().code,
            "reconciliation_required"
        );
        let mut reopened = open(dir.path(), receiver);
        assert!(reopened.state.view.delivery_paused);
        // The SDK has no session here: any accidental dispatch would fail, not reproduce this ID.
        assert_eq!(
            reopened.execute(request.clone()).await.unwrap().unwrap(),
            result
        );
        assert_eq!(reopened.state.intents.len(), 1);
        let mut changed = request;
        changed.input["peerReceiverPath"] = "peer/server".into();
        assert!(reopened.execute(changed).await.is_err());
    }
    #[tokio::test]
    async fn interrupted_receiver_intent_requires_explicit_relink_and_same_id_never_dispatches() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let id = Uuid::new_v4();
        let request = command(id, receiver);
        let mut runtime = open(dir.path(), receiver);
        runtime.state.intents.insert(
            id,
            Intent {
                command: request.clone(),
                result: None,
                error: None,
            },
        );
        runtime.save().unwrap();
        drop(runtime);
        let mut reopened = open(dir.path(), receiver);
        assert_eq!(reopened.state.uncertain_peers.len(), 1);
        assert!(reopened.execute(request).await.unwrap().is_err());
        assert_eq!(reopened.state.intents.len(), 1);
        assert!(reopened.state.view.last_error.is_some());
    }
    #[test]
    fn possible_public_marker_blocks_path_switch_including_failed_first_publication() {
        let key = pubky::Keypair::random().public_key().z32();
        for status in [
            "PendingPublication",
            "Published",
            "PendingRemoval",
            "Failed",
        ] {
            let record:paykit_sdk::ContactRecord=serde_json::from_value(json!({"public_key":key,"receiver_paths":["bob/wallet","bob/server"],"label":null,"profile":null,"profile_fetched_at":null,"created_at":"2026-09-10T00:00:00Z","updated_at":"2026-09-10T00:00:00Z","public_contact_marker_status":status,"public_contact_marker_receiver_path":"bob/wallet","public_contact_published_at":null,"public_contact_removed_at":null,"public_contact_last_error":null})).unwrap();
            assert!(
                ensure_marker_path(&record, &PaykitReceiverPath::new("bob/server").unwrap())
                    .is_err()
            );
            assert!(
                ensure_marker_path(&record, &PaykitReceiverPath::new("bob/wallet").unwrap())
                    .is_ok()
            );
        }
    }
    #[test]
    fn relinking_abandoned_state_requires_sdk_recovery_but_existing_links_are_preserved() {
        assert!(recovery_before_explicit_link(
            Some(&LinkedPeerState::NotLinked),
            true,
            false
        ));
        assert!(!recovery_before_explicit_link(
            Some(&LinkedPeerState::NotLinked),
            false,
            false
        ));
        assert!(!recovery_before_explicit_link(None, false, false));
        for state in [LinkedPeerState::Linked, LinkedPeerState::Linking] {
            assert!(!recovery_before_explicit_link(Some(&state), true, false));
            assert!(recovery_before_explicit_link(Some(&state), true, true));
        }
        assert!(!recovery_before_explicit_link(
            Some(&LinkedPeerState::Blocked),
            true,
            true
        ));
        // The SDK already clears abandoned outboxes when starting from RecoveryRequired.
        assert!(!recovery_before_explicit_link(
            Some(&LinkedPeerState::RecoveryRequired),
            true,
            false
        ));
    }
    fn ready_recovery() -> crate::model::Recovery {
        crate::model::Recovery {
            phase: crate::model::RecoveryPhase::Ready,
            automation_paused: false,
            sdk_validated: true,
            wallet_reconciled: true,
            identity_fingerprint: "identity".into(),
            receiver_fingerprint: "receiver".into(),
            grant_valid: true,
            marker_valid: true,
            terminal_execution_count: 0,
            uncertain_execution_count: 0,
            unknown_after_export_count: 0,
            peers_requiring_relink: vec![],
            unresolved_execution_ids: vec![],
            blocked_reasons: vec![],
            restored_at: Some("2026-09-11T00:00:00Z".into()),
            last_error: None,
        }
    }
    fn recovery_peer_record(
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
        state: LinkedPeerState,
    ) -> LinkedPeerRecord {
        LinkedPeerRecord {
            counterparty: key.clone(),
            counterparty_receiver_path: path.clone(),
            state,
            last_sync_at: None,
            last_private_receive_at: None,
            failure_count: 0,
            local_recovery_attempt_id: None,
            local_recovery_marker_created_at: None,
            local_recovery_marker_last_error: None,
            remote_recovery_attempt_id: None,
            remote_recovery_marker_observed_at: None,
        }
    }
    fn recovery_marker_report(
        peer: &LinkedPeerRecord,
    ) -> paykit_sdk::EncryptedLinkRecoveryMarkerReport {
        paykit_sdk::EncryptedLinkRecoveryMarkerReport {
            counterparty: peer.counterparty.clone(),
            counterparty_receiver_path: peer.counterparty_receiver_path.clone(),
            state: peer.state.clone(),
            local_attempt_id: peer.local_recovery_attempt_id.clone(),
            local_marker_created_at: peer.local_recovery_marker_created_at,
            local_marker_last_error: peer.local_recovery_marker_last_error.clone(),
            remote_attempt_id: peer.remote_recovery_attempt_id.clone(),
            remote_marker_observed_at: peer.remote_recovery_marker_observed_at,
            remote_marker_changed: false,
        }
    }
    #[test]
    fn recovery_clears_only_after_local_sdk_convergence_and_recloses_on_regression() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let target = (key.to_string(), path.to_string());
        runtime.state.view.recovery = Some(ready_recovery());
        runtime.require_recovery_peer(&target);

        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::Linking);
        runtime.reconcile_local_link_recovery(&[peer.clone()]);
        let recovery = runtime.state.view.recovery.as_ref().unwrap();
        assert!(recovery.automation_paused);
        assert_eq!(recovery.peers_requiring_relink.len(), 1);

        peer.state = LinkedPeerState::Linked;
        peer.local_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        runtime.reconcile_local_link_recovery(&[peer.clone()]);
        assert_eq!(
            runtime
                .state
                .view
                .recovery
                .as_ref()
                .unwrap()
                .peers_requiring_relink
                .len(),
            1
        );

        peer.local_recovery_attempt_id = None;
        peer.local_recovery_marker_last_error = Some("marker removal failed".into());
        runtime.reconcile_local_link_recovery(&[peer.clone()]);
        assert_eq!(
            runtime
                .state
                .view
                .recovery
                .as_ref()
                .unwrap()
                .peers_requiring_relink
                .len(),
            1
        );

        peer.local_recovery_marker_last_error = None;
        runtime.reconcile_local_link_recovery(&[peer.clone()]);
        let recovery = runtime.state.view.recovery.as_ref().unwrap();
        assert!(matches!(recovery.phase, crate::model::RecoveryPhase::Ready));
        assert!(!recovery.automation_paused);
        assert!(recovery.peers_requiring_relink.is_empty());

        runtime.state.view.delivery_paused = false;
        peer.state = LinkedPeerState::RecoveryRequired;
        runtime.reconcile_local_link_recovery(&[peer]);
        let recovery = runtime.state.view.recovery.as_ref().unwrap();
        assert!(matches!(
            recovery.phase,
            crate::model::RecoveryPhase::RelinkRequired
        ));
        assert!(recovery.automation_paused);
        assert_eq!(recovery.peers_requiring_relink.len(), 1);
        assert!(runtime.state.view.delivery_paused);
    }
    #[test]
    fn recovery_preparation_requires_both_markers_from_the_current_episode() {
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let episode = chrono::Utc::now();
        let stale = episode - chrono::Duration::minutes(1);
        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::Linked);
        peer.last_sync_at = Some(episode);
        peer.local_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.local_recovery_marker_created_at = Some(stale);
        peer.remote_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.remote_recovery_marker_observed_at = Some(stale);

        let mut anchor = RecoveryPreparationAnchor {
            peer_public_key: key.to_string(),
            peer_receiver_path: path.to_string(),
            episode_started_at: episode,
            anchored_local_attempt_id: peer.local_recovery_attempt_id.clone(),
            anchored_remote_attempt_id: peer.remote_recovery_attempt_id.clone(),
            remote_attested_at: Some(stale),
            marker_retry_started_at: None,
        };
        assert!(recovery_preparation(&peer, false, Some(&anchor)).is_none());
        let stale_target = recovery_preparation(&peer, true, Some(&anchor)).unwrap();
        assert!(!stale_target.local_marker_present);
        assert!(!stale_target.remote_marker_present);
        assert!(!stale_target.ready_for_handshake);

        peer.state = LinkedPeerState::RecoveryRequired;
        peer.local_recovery_marker_created_at = Some(episode);
        peer.remote_recovery_marker_observed_at = Some(episode);
        anchor.anchored_local_attempt_id = peer.local_recovery_attempt_id.clone();
        anchor.anchored_remote_attempt_id = peer.remote_recovery_attempt_id.clone();
        anchor.remote_attested_at = Some(episode);
        let prepared = recovery_preparation(&peer, true, Some(&anchor)).unwrap();
        assert!(prepared.local_marker_present);
        assert!(prepared.remote_marker_present);
        assert!(prepared.ready_for_handshake);

        peer.local_recovery_marker_last_error = Some("private marker failure".into());
        let failed = recovery_preparation(&peer, true, Some(&anchor)).unwrap();
        assert!(!failed.ready_for_handshake);
        let public = serde_json::to_string(&failed).unwrap();
        assert!(!public.contains("private marker failure"));
    }
    #[test]
    fn recovery_marker_retry_requires_a_recovery_episode_and_a_later_second() {
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let marker_created_at = chrono::Utc::now();
        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::RecoveryRequired);
        peer.local_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.local_recovery_marker_created_at = Some(marker_created_at);

        let too_soon =
            ensure_recovery_marker_retry_allowed(&peer, false, marker_created_at).unwrap_err();
        assert_eq!(too_soon.code, "recovery_marker_retry_too_soon");
        ensure_recovery_marker_retry_allowed(
            &peer,
            false,
            marker_created_at + chrono::Duration::seconds(1),
        )
        .unwrap();

        peer.state = LinkedPeerState::Linked;
        assert_eq!(
            ensure_recovery_marker_retry_allowed(
                &peer,
                false,
                marker_created_at + chrono::Duration::seconds(1),
            )
            .unwrap_err()
            .code,
            "recovery_marker_retry_unavailable"
        );
        ensure_recovery_marker_retry_allowed(
            &peer,
            true,
            marker_created_at + chrono::Duration::seconds(1),
        )
        .unwrap();

        peer.state = LinkedPeerState::Linking;
        assert_eq!(
            ensure_recovery_marker_retry_allowed(
                &peer,
                true,
                marker_created_at + chrono::Duration::seconds(1),
            )
            .unwrap_err()
            .code,
            "recovery_marker_retry_unavailable"
        );

        peer.state = LinkedPeerState::RecoveryRequired;
        peer.local_recovery_attempt_id = None;
        peer.local_recovery_marker_created_at = None;
        let anchor = RecoveryPreparationAnchor {
            peer_public_key: key.to_string(),
            peer_receiver_path: path.to_string(),
            episode_started_at: marker_created_at,
            anchored_local_attempt_id: Some(Uuid::new_v4().to_string()),
            anchored_remote_attempt_id: None,
            remote_attested_at: None,
            marker_retry_started_at: Some(marker_created_at),
        };
        assert_eq!(
            ensure_recovery_marker_retry_resume_allowed(&peer, false, &anchor, marker_created_at,)
                .unwrap_err()
                .code,
            "recovery_marker_retry_too_soon"
        );
        ensure_recovery_marker_retry_resume_allowed(
            &peer,
            false,
            &anchor,
            marker_created_at + chrono::Duration::seconds(1),
        )
        .unwrap();
    }
    #[test]
    fn live_marker_without_matching_sdk_observation_maps_to_stale_retry_guidance() {
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let peer = recovery_peer_record(&key, &path, LinkedPeerState::Linked);
        let observed = recovery_marker_report(&peer);
        let live = paykit_lib::EncryptedLinkRecoveryMarker::new(
            Uuid::new_v4().to_string(),
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        )
        .unwrap();

        assert!(live_recovery_marker_was_rejected(&observed, Some(&live)));
        let error = recovery_marker_stale();
        assert_eq!(error.code, "recovery_marker_stale");
        assert!(error.message.contains("Pause delivery"));
    }
    #[test]
    fn recovery_marker_retry_intent_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let mut runtime = open(dir.path(), receiver);
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let target = (key.to_string(), path.to_string());
        let retry_started_at = chrono::Utc::now();
        let old_attempt = Uuid::new_v4().to_string();
        runtime.ensure_recovery_preparation_anchor(&target).unwrap();
        let anchor = runtime
            .state
            .recovery_preparations
            .iter_mut()
            .find(|anchor| {
                anchor.peer_public_key == target.0 && anchor.peer_receiver_path == target.1
            })
            .unwrap();
        anchor.anchored_local_attempt_id = Some(old_attempt.clone());
        anchor.marker_retry_started_at = Some(retry_started_at);
        runtime.save().unwrap();
        drop(runtime);

        let reopened = open(dir.path(), receiver);
        let anchor = reopened.recovery_preparation_anchor(&target).unwrap();
        assert_eq!(
            anchor.anchored_local_attempt_id.as_deref(),
            Some(old_attempt.as_str())
        );
        assert_eq!(anchor.marker_retry_started_at, Some(retry_started_at));
    }

    #[test]
    fn fixed_time_evidence_requires_live_remote_and_published_local_attestation() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let target = (key.to_string(), path.to_string());
        let boundary = crate::recurrence::timestamp(&crate::recurrence::text(
            chrono::Utc::now() + chrono::Duration::hours(1),
        ))
        .unwrap();
        runtime
            .clock
            .set(&runtime.vault, Some(&crate::recurrence::text(boundary)))
            .unwrap();
        runtime
            .state
            .recovery_preparations
            .push(RecoveryPreparationAnchor {
                peer_public_key: target.0.clone(),
                peer_receiver_path: target.1.clone(),
                episode_started_at: boundary,
                anchored_local_attempt_id: None,
                anchored_remote_attempt_id: None,
                remote_attested_at: None,
                marker_retry_started_at: None,
            });
        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::RecoveryRequired);
        let archived_local = Uuid::new_v4().to_string();
        let live_remote = Uuid::new_v4().to_string();
        peer.local_recovery_attempt_id = Some(archived_local);
        peer.remote_recovery_attempt_id = Some(live_remote.clone());
        peer.local_recovery_marker_created_at = Some(boundary);
        peer.remote_recovery_marker_observed_at = Some(boundary);
        let observed = recovery_marker_report(&peer);
        runtime.anchor_live_remote_evidence(&target, &observed, None);
        assert!(runtime
            .recovery_preparation(&peer, true)
            .is_some_and(|value| { !value.local_marker_present && !value.remote_marker_present }));

        let raced = paykit_lib::EncryptedLinkRecoveryMarker::new(
            Uuid::new_v4().to_string(),
            crate::recurrence::text(boundary),
        )
        .unwrap();
        runtime.anchor_live_remote_evidence(&target, &observed, Some(&raced));
        assert!(runtime
            .recovery_preparation_anchor(&target)
            .unwrap()
            .anchored_remote_attempt_id
            .is_none());

        let live = paykit_lib::EncryptedLinkRecoveryMarker::new(
            live_remote.clone(),
            crate::recurrence::text(boundary),
        )
        .unwrap();
        runtime.anchor_live_remote_evidence(&target, &observed, Some(&live));
        let published_local = Uuid::new_v4().to_string();
        peer.local_recovery_attempt_id = Some(published_local.clone());
        let published = recovery_marker_report(&peer);
        runtime.anchor_published_local_evidence(&target, &published);
        let anchor = runtime.recovery_preparation_anchor(&target).unwrap();
        assert_eq!(
            anchor.anchored_local_attempt_id.as_deref(),
            Some(published_local.as_str())
        );
        assert_eq!(
            anchor.anchored_remote_attempt_id.as_deref(),
            Some(live_remote.as_str())
        );
        assert!(runtime
            .recovery_preparation(&peer, true)
            .is_some_and(|value| value.ready_for_handshake));
    }

    #[test]
    fn recovery_preparation_anchor_survives_restart_and_archive_gate_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let mut runtime = open(dir.path(), receiver);
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let target = (key.to_string(), path.to_string());
        runtime.ensure_recovery_preparation_anchor(&target).unwrap();
        runtime.save().unwrap();
        drop(runtime);

        let mut reopened = open(dir.path(), receiver);
        assert!(reopened.recovery_preparation_anchor(&target).is_some());
        let boundary = reopened
            .recovery_preparation_anchor(&target)
            .unwrap()
            .episode_started_at;
        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::RecoveryRequired);
        peer.local_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.local_recovery_marker_created_at = Some(boundary);
        peer.remote_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.remote_recovery_marker_observed_at = Some(boundary);
        assert!(reopened
            .recovery_preparation(&peer, true)
            .is_some_and(|value| { !value.local_marker_present && !value.remote_marker_present }));

        let live = paykit_lib::EncryptedLinkRecoveryMarker::new(
            peer.remote_recovery_attempt_id.clone().unwrap(),
            crate::recurrence::text(boundary),
        )
        .unwrap();
        reopened.anchor_live_remote_evidence(&target, &recovery_marker_report(&peer), Some(&live));
        reopened.anchor_published_local_evidence(&target, &recovery_marker_report(&peer));
        reopened.save().unwrap();
        drop(reopened);
        let reopened = open(dir.path(), receiver);
        assert!(reopened
            .recovery_preparation(&peer, true)
            .is_some_and(|value| value.ready_for_handshake));
        let encoded = ciborium::Value::serialized(&reopened.state).unwrap();
        let gated = with_recovery_gate(encoded, ready_recovery()).unwrap();
        let mut bytes = Vec::new();
        ciborium::into_writer(&gated, &mut bytes).unwrap();
        let restored: LocalState = ciborium::from_reader(bytes.as_slice()).unwrap();
        assert!(restored.recovery_preparations.is_empty());
    }
    #[test]
    fn recovery_handshake_requires_complete_preparation_barrier() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let target = (key.to_string(), path.to_string());
        runtime.state.view.recovery = Some(ready_recovery());
        runtime.require_recovery_peer(&target);
        let episode = chrono::Utc::now();
        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::RecoveryRequired);
        peer.last_sync_at = Some(episode);
        peer.local_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.local_recovery_marker_created_at = Some(episode);

        runtime
            .state
            .recovery_preparations
            .push(RecoveryPreparationAnchor {
                peer_public_key: target.0.clone(),
                peer_receiver_path: target.1.clone(),
                episode_started_at: episode,
                anchored_local_attempt_id: peer.local_recovery_attempt_id.clone(),
                anchored_remote_attempt_id: None,
                remote_attested_at: None,
                marker_retry_started_at: None,
            });

        let error = runtime
            .ensure_recovery_prepared(&target, Some(&peer))
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<PublicError>().unwrap().code,
            "recovery_preparation_required"
        );

        peer.remote_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.remote_recovery_marker_observed_at = Some(episode);
        let live = paykit_lib::EncryptedLinkRecoveryMarker::new(
            peer.remote_recovery_attempt_id.clone().unwrap(),
            crate::recurrence::text(episode),
        )
        .unwrap();
        runtime.anchor_live_remote_evidence(&target, &recovery_marker_report(&peer), Some(&live));
        runtime
            .ensure_recovery_prepared(&target, Some(&peer))
            .unwrap();

        runtime.state.view.recovery = None;
        let normal = recovery_peer_record(&key, &path, LinkedPeerState::NotLinked);
        runtime
            .ensure_recovery_prepared(&target, Some(&normal))
            .unwrap();
    }
    #[test]
    fn uncertain_link_advancement_preserves_legacy_and_requires_prepared_backup() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let target = (key.to_string(), path.to_string());
        let mut peer = recovery_peer_record(&key, &path, LinkedPeerState::Linking);
        runtime.state.uncertain_peers.push(target.clone());

        assert!(runtime.link_advancement_allowed(&peer));

        runtime.state.view.recovery = Some(ready_recovery());
        runtime.require_recovery_peer(&target);
        assert!(!runtime.link_advancement_allowed(&peer));

        peer.local_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        peer.remote_recovery_attempt_id = Some(Uuid::new_v4().to_string());
        let episode = chrono::Utc::now();
        peer.last_sync_at = Some(episode + chrono::Duration::minutes(1));
        peer.local_recovery_marker_created_at = Some(episode);
        peer.remote_recovery_marker_observed_at = Some(episode);
        runtime
            .state
            .recovery_preparations
            .push(RecoveryPreparationAnchor {
                peer_public_key: target.0.clone(),
                peer_receiver_path: target.1.clone(),
                episode_started_at: episode,
                anchored_local_attempt_id: peer.local_recovery_attempt_id.clone(),
                anchored_remote_attempt_id: peer.remote_recovery_attempt_id.clone(),
                remote_attested_at: Some(episode),
                marker_retry_started_at: None,
            });
        assert!(runtime.link_advancement_allowed(&peer));

        peer.local_recovery_marker_last_error = Some("private marker failure".into());
        assert!(!runtime.link_advancement_allowed(&peer));
    }
    #[tokio::test]
    async fn recovery_preparation_rejects_active_handshake_before_network_access() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        let peer = recovery_peer_record(&key, &path, LinkedPeerState::Linking);

        let error = runtime
            .prepare_link_recovery(key, path, Some(&peer))
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<PublicError>().unwrap().code,
            "recovery_handshake_active"
        );
    }
    async fn seed_abandoned_link(
        runtime: &Runtime,
        key: &PubkyPublicKey,
        path: &PaykitReceiverPath,
        state: LinkedPeerState,
    ) {
        runtime
            .storage
            .transaction(|tx| {
                tx.save_linked_peer(paykit_sdk::storage::LinkedPeerRecord {
                    counterparty: key.clone(),
                    counterparty_receiver_path: path.clone(),
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
                    counterparty: key.clone(),
                    counterparty_receiver_path: path.clone(),
                    link_snapshot: None,
                    handshake_snapshot: None,
                    handshake_role: None,
                    generation: 5,
                    checkpointed_at: chrono::Utc::now(),
                });
                Ok(())
            })
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn failed_unblock_cleanup_preserves_durable_block_and_never_replays() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let mut runtime = open(dir.path(), receiver);
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        runtime
            .storage
            .save_identity_state(paykit_sdk::IdentityState {
                local_pubky_public_key: Some(runtime.owner.clone()),
                local_receiver_noise_public_key: None,
                initialized_at: chrono::Utc::now(),
                sign_out_generation: 0,
            })
            .await
            .unwrap();
        seed_abandoned_link(&runtime, &key, &path, LinkedPeerState::Blocked).await;
        let command = Command {
            command_id: Uuid::new_v4(),
            command: "link.unblock".into(),
            input: json!({"receiverId":receiver,"peerPublicKey":key.to_string(),"peerReceiverPath":path.to_string()}),
        };
        assert_eq!(
            runtime.execute(command.clone()).await.unwrap(),
            Err(FAILURE.into())
        );
        assert_eq!(
            runtime.sdk.linked_peers().await.unwrap()[0].state,
            LinkedPeerState::Blocked
        );
        drop(runtime);
        let mut restored = open(dir.path(), receiver);
        assert_eq!(
            restored.execute(command).await.unwrap(),
            Err(FAILURE.into())
        );
        assert_eq!(
            restored.sdk.linked_peers().await.unwrap()[0].state,
            LinkedPeerState::Blocked
        );
        // Control: the SDK itself can unblock this persisted identity without a live grant.
        // The wrapper's cleanup gate, not an unrelated SDK identity error, kept it blocked.
        restored.sdk.unblock_peer(key, path).await.unwrap();
        assert_eq!(
            restored.sdk.linked_peers().await.unwrap()[0].state,
            LinkedPeerState::NotLinked
        );
    }
    #[tokio::test]
    async fn persisted_uncertainty_preserves_blocked_policy_projection() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let mut runtime = open(dir.path(), receiver);
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        runtime
            .storage
            .save_identity_state(paykit_sdk::IdentityState {
                local_pubky_public_key: Some(runtime.owner.clone()),
                local_receiver_noise_public_key: None,
                initialized_at: chrono::Utc::now(),
                sign_out_generation: 0,
            })
            .await
            .unwrap();
        seed_abandoned_link(&runtime, &key, &path, LinkedPeerState::Blocked).await;
        let uncertain_peer = (key.to_string(), path.to_string());
        runtime.state.uncertain_peers.push(uncertain_peer.clone());
        runtime.state.view.last_error = Some(FAILURE.into());
        runtime.save().unwrap();
        drop(runtime);
        let mut restored = open(dir.path(), receiver);
        restored.refresh().await.unwrap();
        assert_eq!(restored.view().links[0].state, "blocked");
        assert_eq!(restored.view().last_error.as_deref(), Some(FAILURE));
        assert_eq!(
            restored.view().links[0].last_error.as_deref(),
            Some(FAILURE)
        );
        assert!(restored.state.uncertain_peers.contains(&uncertain_peer));
        // Uncertainty still gates private execution; a display change cannot authorize it.
        let result = restored.execute(Command {
            command_id: Uuid::new_v4(),
            command: "link.sendEmptyList".into(),
            input: json!({"receiverId":receiver,"peerPublicKey":key.to_string(),"peerReceiverPath":path.to_string()}),
        }).await.unwrap();
        assert_eq!(result, Err(FAILURE.into()));
        assert_eq!(restored.view().links[0].state, "blocked");
    }
    #[tokio::test]
    async fn outbox_cleanup_does_not_touch_active_or_untracked_peers() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        runtime.clear_blocked_outbox(&key, &path).await.unwrap();
        for state in [
            LinkedPeerState::Linked,
            LinkedPeerState::Linking,
            LinkedPeerState::NotLinked,
            LinkedPeerState::RecoveryRequired,
        ] {
            seed_abandoned_link(&runtime, &key, &path, state.clone()).await;
            runtime.clear_blocked_outbox(&key, &path).await.unwrap();
            assert_eq!(runtime.sdk.linked_peers().await.unwrap()[0].state, state);
        }
    }
    #[tokio::test]
    async fn failed_recovery_preparation_does_not_start_a_fresh_handshake() {
        let dir = tempfile::tempdir().unwrap();
        let receiver = Uuid::new_v4();
        let runtime = open(dir.path(), receiver);
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        seed_abandoned_link(&runtime, &key, &path, LinkedPeerState::NotLinked).await;
        // An unavailable grant makes the official recovery API fail. Never bypass it.
        assert!(runtime
            .prepare_explicit_relink(&key, &path, false)
            .await
            .is_err());
        let after = runtime
            .storage
            .transaction(|tx| Ok(tx.encrypted_link_state(&key, &path).unwrap()))
            .await
            .unwrap();
        assert_eq!(after.generation, 5);
        assert!(after.handshake_snapshot.is_none());
        assert!(after.link_snapshot.is_none());
    }
    #[tokio::test]
    async fn failed_recovery_observation_preserves_the_link_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = open(dir.path(), Uuid::new_v4());
        let key = PubkyPublicKey::from_public_key(&pubky::Keypair::random().public_key());
        let path = PaykitReceiverPath::new("peer/wallet").unwrap();
        seed_abandoned_link(&runtime, &key, &path, LinkedPeerState::Linked).await;
        let before = runtime
            .storage
            .transaction(|tx| Ok(tx.encrypted_link_state(&key, &path).unwrap()))
            .await
            .unwrap();

        assert!(runtime.sync().await.is_err());

        let after = runtime
            .storage
            .transaction(|tx| Ok(tx.encrypted_link_state(&key, &path).unwrap()))
            .await
            .unwrap();
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.checkpointed_at, before.checkpointed_at);
    }
    #[test]
    fn cache_eviction_preserves_durable_data_and_capacity_allows_existing_edits() {
        let mut view = Workspace::default();
        view.contacts.push(ContactView {
            peer_public_key: "owner".into(),
            label: "Keep me".into(),
            receiver_paths: vec!["peer/wallet".into()],
            public_sharing: "private".into(),
            public_receiver_path: None,
            last_error: None,
        });
        for i in 0..17 {
            view.profiles.push(ProfileView {
                peer_public_key: format!("owner-{i}"),
                peer_receiver_path: "peer/wallet".into(),
                display_name: i.to_string(),
                about: String::new(),
                image_uri: None,
                avatar_data_url: None,
                path: "profile".into(),
                updated_at: "time".into(),
            });
        }
        retain_recent(&mut view.profiles, 16);
        assert_eq!(view.profiles.len(), 16);
        assert_eq!(view.profiles[0].display_name, "1");
        assert_eq!(view.contacts[0].label, "Keep me");
        assert!(ensure_capacity(false, 128, 128, "limit").is_err());
        assert!(ensure_capacity(true, 128, 128, "limit").is_ok());
        assert!(ensure_capacity(false, 63, 64, "limit").is_ok());
        assert!(ensure_capacity(false, 64, 64, "limit").is_err());
    }
    #[test]
    fn public_workspace_wire_type_rejects_injected_sdk_snapshot() {
        let mut view = serde_json::to_value(Workspace::default()).unwrap();
        view["noiseSecret"] = "must-not-cross".into();
        assert!(serde_json::from_value::<Workspace>(view).is_err());
    }

    #[test]
    fn recovery_gate_survives_receiver_service_restart() {
        let dir = tempfile::tempdir().unwrap();
        let receiver_id = Uuid::new_v4();
        let vault = Vault::new(dir.path().into(), [7; 32], receiver_id.to_string()).unwrap();
        vault
            .save(
                "workspace.cbor",
                &LocalState {
                    view: Workspace {
                        receiver_id,
                        ..Workspace::default()
                    },
                    intents: BTreeMap::new(),
                    uncertain_peers: vec![],
                    owned_avatars: vec![],
                    recovery_preparations: vec![],
                },
            )
            .unwrap();
        let recovery = crate::model::Recovery {
            phase: crate::model::RecoveryPhase::WalletReconciliationRequired,
            automation_paused: true,
            sdk_validated: true,
            wallet_reconciled: false,
            identity_fingerprint: "identity".into(),
            receiver_fingerprint: "receiver".into(),
            grant_valid: true,
            marker_valid: true,
            terminal_execution_count: 2,
            uncertain_execution_count: 1,
            unknown_after_export_count: 0,
            peers_requiring_relink: vec![],
            unresolved_execution_ids: vec!["execution".into()],
            blocked_reasons: vec![crate::model::RecoveryBlockedReason::WalletUncertain],
            restored_at: Some("2026-09-11T00:00:00Z".into()),
            last_error: None,
        };
        save_recovery(&vault, recovery.clone()).unwrap();
        let reopened: LocalState = vault.load("workspace.cbor").unwrap().unwrap();
        assert!(reopened.view.delivery_paused);
        assert!(reopened.view.recovery == Some(recovery));
    }
}

#[path = "payment_workflow.rs"]
mod payments;

#[path = "request_workflow.rs"]
mod requests;

#[path = "receipt_workflow.rs"]
mod receipts;

#[path = "subscription_workflow.rs"]
mod subscription_workflow;
