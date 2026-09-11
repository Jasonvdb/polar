//! Encrypted receiver backup envelopes and short-lived secret transfer handles.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, AeadCore, OsRng, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, SystemTime},
};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::model::PublicError;

const TRANSFER_MAGIC: &[u8; 4] = b"PKTR";
const TRANSFER_VERSION: u8 = 1;
const ENVELOPE_MAGIC: &[u8; 17] = b"POLARPAYKITBACKUP";
const ENVELOPE_VERSION: u8 = 1;
const KDF_MEMORY_KIB: u32 = 64 * 1024;
const KDF_ITERATIONS: u32 = 3;
const KDF_PARALLELISM: u32 = 1;
const TAG_BYTES: usize = 16;
const HEADER_BYTES: usize = 17 + 1 + 4 + 4 + 4 + 16 + 24 + 4;
pub const MAX_ARCHIVE_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_TRANSFER_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TRANSFER_HANDLES: usize = 8;
const MIN_PASSPHRASE_BYTES: usize = 12;
const MAX_PASSPHRASE_BYTES: usize = 1024;
const UPLOAD_TTL: Duration = Duration::from_secs(10 * 60);
const EXPORT_TTL: Duration = Duration::from_secs(2 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferPurpose {
    Export,
    Restore,
}

impl TransferPurpose {
    #[cfg(test)]
    fn byte(self) -> u8 {
        match self {
            Self::Export => 1,
            Self::Restore => 2,
        }
    }

    fn from_byte(value: u8) -> Result<Self, PublicError> {
        match value {
            1 => Ok(Self::Export),
            2 => Ok(Self::Restore),
            _ => Err(transfer_invalid()),
        }
    }
}

#[derive(Debug)]
pub struct TransferUpload {
    pub purpose: TransferPurpose,
    pub receiver_id: Uuid,
    pub passphrase: Zeroizing<Vec<u8>>,
    pub archive: Zeroizing<Vec<u8>>,
}

impl TransferUpload {
    pub fn decode(bytes: &[u8]) -> Result<Self, PublicError> {
        if bytes.len() > MAX_ARCHIVE_BYTES + MAX_PASSPHRASE_BYTES + 28 {
            return Err(backup_too_large());
        }
        let mut cursor = FrameCursor::new(bytes);
        if cursor.take(4)? != TRANSFER_MAGIC || cursor.u8()? != TRANSFER_VERSION {
            return Err(transfer_invalid());
        }
        let purpose = TransferPurpose::from_byte(cursor.u8()?)?;
        let receiver_id = Uuid::from_slice(cursor.take(16)?).map_err(|_| transfer_invalid())?;
        let passphrase_len = cursor.u16()? as usize;
        let archive_len = cursor.u32()? as usize;
        validate_lengths(purpose, passphrase_len, archive_len)?;
        let passphrase = Zeroizing::new(cursor.take(passphrase_len)?.to_vec());
        std::str::from_utf8(&passphrase).map_err(|_| transfer_invalid())?;
        let archive = Zeroizing::new(cursor.take(archive_len)?.to_vec());
        if !cursor.is_empty() {
            return Err(transfer_invalid());
        }
        Ok(Self {
            purpose,
            receiver_id,
            passphrase,
            archive,
        })
    }
}

fn validate_lengths(
    purpose: TransferPurpose,
    passphrase_len: usize,
    archive_len: usize,
) -> Result<(), PublicError> {
    if !(MIN_PASSPHRASE_BYTES..=MAX_PASSPHRASE_BYTES).contains(&passphrase_len) {
        return Err(transfer_invalid());
    }
    if archive_len > MAX_ARCHIVE_BYTES {
        return Err(backup_too_large());
    }
    if purpose == TransferPurpose::Export && archive_len != 0 {
        return Err(transfer_invalid());
    }
    if purpose == TransferPurpose::Restore && archive_len == 0 {
        return Err(transfer_invalid());
    }
    Ok(())
}

struct FrameCursor<'a> {
    remaining: &'a [u8],
}

impl<'a> FrameCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { remaining: bytes }
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8], PublicError> {
        let value = self.remaining.get(..length).ok_or_else(transfer_invalid)?;
        self.remaining = &self.remaining[length..];
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, PublicError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, PublicError> {
        Ok(u16::from_be_bytes(
            self.take(2)?.try_into().map_err(|_| transfer_invalid())?,
        ))
    }
    fn u32(&mut self) -> Result<u32, PublicError> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| transfer_invalid())?,
        ))
    }
    fn is_empty(&self) -> bool {
        self.remaining.is_empty()
    }
}

pub struct TransferClaim {
    pub passphrase: Zeroizing<Vec<u8>>,
    pub archive: Zeroizing<Vec<u8>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct WalletHistoryAnchor {
    pub wallet_id: String,
    pub rail: String,
    pub core: Option<CoreHistoryAnchor>,
    pub lnd: Option<LndHistoryAnchor>,
    pub captured_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CoreHistoryAnchor {
    pub best_block_hash: String,
    pub transaction_count: u64,
    pub known_outgoing_txids: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LndHistoryAnchor {
    pub last_payment_index: u64,
    pub known_payment_hashes: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct ReceiverBackupV1 {
    version: u32,
    environment_id: Uuid,
    participant_id: Uuid,
    receiver_id: Uuid,
    owner_public_key: String,
    receiver_path: String,
    noise_public_key: String,
    created_at: chrono::DateTime<chrono::Utc>,
    session: crate::receiver::ReceiverSecrets,
    sdk: paykit_sdk::SdkBackupState,
    workspace: ciborium::Value,
    payment_adapter_state: ciborium::Value,
    request_state: ciborium::Value,
    subscriptions: ciborium::Value,
    application_clock: ciborium::Value,
    wallet: WalletBackup,
}

#[derive(Serialize, Deserialize)]
struct WalletBackup {
    receiver_executions: Vec<crate::wallet_execution::Execution>,
    settlements: std::collections::BTreeMap<String, String>,
    anchors: Vec<WalletHistoryAnchor>,
}

#[derive(Serialize, Deserialize)]
struct RecoveryWalletState {
    anchors: Vec<WalletHistoryAnchor>,
}

pub async fn export_receiver(
    config: &crate::config::Config,
    state: &crate::model::AppState,
    receiver_id: Uuid,
    passphrase: &[u8],
) -> Result<Zeroizing<Vec<u8>>, PublicError> {
    let receiver = state
        .receivers
        .iter()
        .find(|value| value.public.id == receiver_id)
        .ok_or_else(backup_invalid)?;
    if receiver.public.status != crate::model::ReceiverStatus::Stopped {
        return Err(PublicError::new(
            "receiver_running",
            "Stop the receiver before exporting a backup.",
        ));
    }
    let owner = state
        .participants
        .iter()
        .find(|value| value.public.id == receiver.public.participant_id)
        .ok_or_else(|| export_failure("receiver_owner"))?;
    let vault = crate::receiver::vault(config, receiver_id)
        .map_err(|_| export_failure("receiver_vault"))?;
    let session: crate::receiver::ReceiverSecrets = vault
        .load("session.cbor")
        .map_err(|_| export_failure("receiver_session_read"))?
        .ok_or_else(|| export_failure("receiver_session_missing"))?;
    validate_receiver_binding(receiver, owner, &session)
        .map_err(|_| export_failure("receiver_binding"))?;
    let storage = crate::storage::ReceiverStorage::open(
        crate::receiver::vault(config, receiver_id)
            .map_err(|_| export_failure("sdk_storage_vault"))?,
    )
    .map_err(|_| export_failure("sdk_storage_open"))?;
    let path = paykit_sdk::PaykitReceiverPath::new(session.path.clone())
        .map_err(|_| export_failure("receiver_path"))?;
    let sdk = paykit_sdk::export_backup_state(&storage, path)
        .await
        .map_err(|_| export_failure("sdk_export"))?;
    let spend_vault = vault
        .shared_wallets(config.environment_id)
        .map_err(|_| export_failure("wallet_vault"))?;
    let spend = crate::wallet_execution::SpendState::open(&spend_vault)
        .map_err(|_| export_failure("wallet_journal"))?;
    let payment_state: crate::wallet_adapter::Ledger = vault
        .load("payments.cbor")
        .map_err(|_| export_failure("payment_state"))?
        .unwrap_or_default();
    let mut anchors = capture_environment_anchors(config, state)
        .await
        .map_err(|_| export_failure("wallet_history"))?;
    if anchors.is_empty() {
        anchors = capture_wallet_anchors(
            config,
            receiver_id,
            owner.public.public_key.as_str(),
            &spend,
            &payment_state,
        )
        .await
        .map_err(|_| export_failure("bound_wallet_history"))?;
    }
    let bundle = ReceiverBackupV1 {
        version: 1,
        environment_id: config.environment_id,
        participant_id: receiver.public.participant_id,
        receiver_id,
        owner_public_key: owner.public.public_key.clone(),
        receiver_path: receiver.public.path.clone(),
        noise_public_key: receiver.public.noise_public_key.clone(),
        created_at: chrono::Utc::now(),
        session,
        sdk,
        workspace: load_value(&vault, "workspace.cbor")
            .map_err(|_| export_failure("workspace_state"))?,
        payment_adapter_state: ciborium::Value::serialized(&payment_state)
            .map_err(|_| export_failure("payment_state_encode"))?,
        request_state: crate::workspace::requests::backup_request_state(&vault)
            .map_err(|_| export_failure("request_state"))?,
        subscriptions: load_value(&vault, "subscriptions.cbor")
            .map_err(|_| export_failure("subscription_state"))?,
        application_clock: load_value(&vault, "clock.cbor")
            .map_err(|_| export_failure("clock_state"))?,
        wallet: WalletBackup {
            receiver_executions: spend
                .executions
                .into_iter()
                .filter(|value| value.receiver_id == receiver_id)
                .collect(),
            settlements: spend.settlements,
            anchors,
        },
    };
    let mut clear = Zeroizing::new(Vec::new());
    ciborium::into_writer(&bundle, &mut *clear).map_err(|_| export_failure("archive_encode"))?;
    encrypt(&clear, passphrase).map_err(|_| export_failure("archive_encrypt"))
}

fn export_failure(stage: &str) -> PublicError {
    eprintln!("Paykit backup export failed at stage: {stage}");
    backup_invalid()
}

async fn capture_environment_anchors(
    config: &crate::config::Config,
    state: &crate::model::AppState,
) -> anyhow::Result<Vec<WalletHistoryAnchor>> {
    let configured = crate::wallet_rpc::configured(config.environment_id)?;
    let mut anchors = Vec::new();
    for funded in &state.funding.wallets {
        let wallet = configured
            .iter()
            .find(|wallet| wallet.id == funded.wallet_id)
            .ok_or_else(|| anyhow::anyhow!("funded wallet configuration missing"))?;
        let owner = resolve_funded_wallet_owner(config, &state.participants, funded)?;
        anchors.push(WalletHistoryAnchor {
            wallet_id: wallet.id.clone(),
            rail: crate::payment_model::ONCHAIN.into(),
            core: Some(capture_core_anchor(wallet, &owner.public.public_key).await?),
            lnd: None,
            captured_at: chrono::Utc::now(),
        });
        if wallet.lightning.is_some() {
            anchors.push(WalletHistoryAnchor {
                wallet_id: wallet.id.clone(),
                rail: crate::payment_model::BOLT11.into(),
                core: None,
                lnd: Some(capture_lnd_anchor(wallet).await?),
                captured_at: chrono::Utc::now(),
            });
        }
    }
    Ok(anchors)
}

fn resolve_funded_wallet_owner<'a>(
    config: &crate::config::Config,
    participants: &'a [crate::model::OwnerRecord],
    funded: &crate::request_model::FundedWallet,
) -> anyhow::Result<&'a crate::model::OwnerRecord> {
    anyhow::ensure!(
        matches!(funded.participant.as_str(), "Alice" | "Bob" | "Carol"),
        "funded wallet preset identity is invalid"
    );
    let participant_id = Uuid::new_v5(
        &config.environment_id,
        format!("preset:{}", funded.participant).as_bytes(),
    );
    participants
        .iter()
        .find(|participant| participant.public.id == participant_id)
        .ok_or_else(|| anyhow::anyhow!("funded wallet owner missing"))
}

async fn capture_wallet_anchors(
    config: &crate::config::Config,
    receiver_id: Uuid,
    owner: &str,
    spend: &crate::wallet_execution::SpendState,
    payments: &crate::wallet_adapter::Ledger,
) -> anyhow::Result<Vec<WalletHistoryAnchor>> {
    let Some(wallet_id) = payments.methods.wallet_id.as_deref() else {
        anyhow::ensure!(
            !spend
                .executions
                .iter()
                .any(|value| value.receiver_id == receiver_id),
            "wallet binding missing for receiver executions"
        );
        return Ok(Vec::new());
    };
    let wallet = crate::wallet_rpc::configured(config.environment_id)?
        .into_iter()
        .find(|value| value.id == wallet_id)
        .ok_or_else(|| anyhow::anyhow!("configured wallet missing"))?;
    let mut anchors = vec![WalletHistoryAnchor {
        wallet_id: wallet.id.clone(),
        rail: crate::payment_model::ONCHAIN.into(),
        core: Some(capture_core_anchor(&wallet, owner).await?),
        lnd: None,
        captured_at: chrono::Utc::now(),
    }];
    if wallet.lightning.is_some() {
        anchors.push(WalletHistoryAnchor {
            wallet_id: wallet.id.clone(),
            rail: crate::payment_model::BOLT11.into(),
            core: None,
            lnd: Some(capture_lnd_anchor(&wallet).await?),
            captured_at: chrono::Utc::now(),
        });
    }
    Ok(anchors)
}

async fn capture_core_anchor(
    wallet: &crate::wallet_rpc::Wallet,
    owner: &str,
) -> anyhow::Result<CoreHistoryAnchor> {
    let wallet_name = format!("paykit-{owner}");
    ensure_history_wallet_loaded(wallet, &wallet_name, owner).await?;
    let info = wallet
        .core(Some(&wallet_name), "getwalletinfo", serde_json::json!([]))
        .await?;
    anyhow::ensure!(
        info["walletname"] == wallet_name,
        "Bitcoin wallet identity mismatch"
    );
    let before = wallet
        .core(
            Some(&wallet_name),
            "getbestblockhash",
            serde_json::json!([]),
        )
        .await?;
    let mut skip = 0usize;
    let mut outgoing = std::collections::BTreeSet::new();
    let mut transaction_count = 0u64;
    loop {
        anyhow::ensure!(skip <= 100_000, "Bitcoin history exceeds backup limit");
        let page = wallet
            .core(
                Some(&wallet_name),
                "listtransactions",
                serde_json::json!(["*", 1000, skip, true]),
            )
            .await?;
        let items = page
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid Bitcoin history"))?;
        transaction_count = transaction_count
            .checked_add(items.len() as u64)
            .ok_or_else(|| anyhow::anyhow!("history overflow"))?;
        for item in items {
            if item["category"] == "send" {
                let txid = item["txid"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Bitcoin history txid missing"))?;
                validate_history_id(txid)?;
                outgoing.insert(txid.to_owned());
            }
        }
        if items.len() < 1000 {
            break;
        }
        skip += items.len();
    }
    let after = wallet
        .core(
            Some(&wallet_name),
            "getbestblockhash",
            serde_json::json!([]),
        )
        .await?;
    anyhow::ensure!(before == after, "Bitcoin history changed during backup");
    Ok(CoreHistoryAnchor {
        best_block_hash: before
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("best block missing"))?
            .into(),
        transaction_count,
        known_outgoing_txids: outgoing.into_iter().collect(),
    })
}

async fn ensure_history_wallet_loaded(
    wallet: &crate::wallet_rpc::Wallet,
    wallet_name: &str,
    owner: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        wallet_name == format!("paykit-{owner}"),
        "Bitcoin wallet identity mismatch"
    );
    let directory = wallet
        .core(None, "listwalletdir", serde_json::json!([]))
        .await?;
    anyhow::ensure!(
        directory["wallets"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|value| value["name"].as_str() == Some(wallet_name))
        }),
        "Bitcoin wallet is missing"
    );
    wallet.load_existing_core_wallet(wallet_name, owner).await
}

async fn capture_lnd_anchor(
    wallet: &crate::wallet_rpc::Wallet,
) -> anyhow::Result<LndHistoryAnchor> {
    let mut offset = 0u64;
    let mut hashes = std::collections::BTreeSet::new();
    loop {
        anyhow::ensure!(
            hashes.len() <= 100_000,
            "Lightning history exceeds backup limit"
        );
        let page = wallet
            .lnd_with_credential(
                "GET",
                &format!("/v1/payments?include_incomplete=true&index_offset={offset}&max_payments=1000&reversed=false"),
                None,
                "payment",
            )
            .await?;
        let items = page["payments"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid Lightning history"))?;
        for item in items {
            let hash = item["payment_hash"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Lightning payment hash missing"))?;
            validate_history_id(hash)?;
            hashes.insert(hash.to_owned());
        }
        let next = page["last_index_offset"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .or_else(|| page["last_index_offset"].as_u64())
            .ok_or_else(|| anyhow::anyhow!("Lightning history index missing"))?;
        if items.is_empty() || next == offset {
            offset = next;
            break;
        }
        anyhow::ensure!(next > offset, "Lightning history index decreased");
        offset = next;
    }
    Ok(LndHistoryAnchor {
        last_payment_index: offset,
        known_payment_hashes: hashes.into_iter().collect(),
    })
}

async fn verify_wallet_history(
    config: &crate::config::Config,
    state: &crate::model::AppState,
    archived: &[WalletHistoryAnchor],
    merged: &crate::wallet_execution::SpendState,
) -> anyhow::Result<usize> {
    if archived.is_empty() {
        return Ok(usize::from(!merged.executions.is_empty()));
    }
    let current = capture_environment_anchors(config, state).await?;
    let known_txids = merged
        .executions
        .iter()
        .filter_map(|value| value.view.txid.as_ref())
        .collect::<std::collections::HashSet<_>>();
    let known_hashes = merged
        .executions
        .iter()
        .filter_map(|value| value.view.payment_hash.as_ref())
        .collect::<std::collections::HashSet<_>>();
    let mut unknown = 0usize;
    for anchor in archived {
        let Some(now) = current
            .iter()
            .find(|value| value.wallet_id == anchor.wallet_id && value.rail == anchor.rail)
        else {
            unknown += 1;
            continue;
        };
        match (&anchor.core, &now.core) {
            (Some(before), Some(after)) => {
                if after.transaction_count < before.transaction_count {
                    unknown += 1;
                }
                let prior = before
                    .known_outgoing_txids
                    .iter()
                    .collect::<std::collections::HashSet<_>>();
                unknown += after
                    .known_outgoing_txids
                    .iter()
                    .filter(|txid| !prior.contains(txid) && !known_txids.contains(txid))
                    .count();
            }
            (None, None) => {}
            _ => unknown += 1,
        }
        match (&anchor.lnd, &now.lnd) {
            (Some(before), Some(after)) => {
                if after.last_payment_index < before.last_payment_index {
                    unknown += 1;
                }
                let prior = before
                    .known_payment_hashes
                    .iter()
                    .collect::<std::collections::HashSet<_>>();
                unknown += after
                    .known_payment_hashes
                    .iter()
                    .filter(|hash| !prior.contains(hash) && !known_hashes.contains(hash))
                    .count();
            }
            (None, None) => {}
            _ => unknown += 1,
        }
    }
    Ok(unknown)
}

pub async fn inspect_receiver(
    config: &crate::config::Config,
    state: &crate::model::AppState,
    receiver_id: Uuid,
    transfer_id: Uuid,
    archive: &[u8],
    passphrase: &[u8],
) -> Result<serde_json::Value, PublicError> {
    let clear = decrypt(archive, passphrase)?;
    let backup: ReceiverBackupV1 =
        ciborium::from_reader(clear.as_slice()).map_err(|_| backup_invalid())?;
    validate_backup_bounds(&backup)?;
    let receiver = state
        .receivers
        .iter()
        .find(|value| value.public.id == receiver_id)
        .ok_or_else(backup_invalid)?;
    let owner = state
        .participants
        .iter()
        .find(|value| value.public.id == receiver.public.participant_id)
        .ok_or_else(backup_invalid)?;
    let receiver_dir = config
        .data_dir
        .join("receivers")
        .join(receiver_id.to_string());
    let current = if receiver_dir.is_dir() {
        crate::receiver::vault(config, receiver_id)
            .and_then(|vault| vault.load::<crate::receiver::ReceiverSecrets>("session.cbor"))
            .map_err(|_| backup_invalid())?
    } else {
        None
    };
    let archived_owner = pubky::Keypair::from_secret(&backup.session.owner)
        .public_key()
        .z32();
    let archived_noise = crate::receiver::noise_public_key(backup.session.noise);
    let identity_matches = backup.environment_id == config.environment_id
        && backup.participant_id == receiver.public.participant_id
        && backup.owner_public_key == owner.public.public_key
        && archived_owner == owner.public.public_key
        && current
            .as_ref()
            .is_none_or(|value| value.owner == backup.session.owner);
    let receiver_matches = backup.receiver_id == receiver_id
        && backup.receiver_path == receiver.public.path
        && backup.noise_public_key == receiver.public.noise_public_key
        && archived_noise == receiver.public.noise_public_key
        && backup.session.path == receiver.public.path
        && backup.sdk.local_receiver_path.as_str() == receiver.public.path
        && current.as_ref().is_none_or(|value| {
            value.noise == backup.session.noise && value.path == backup.session.path
        });
    let wallet_root = config.data_dir.join("receivers/wallet-execution");
    let live_wallet = if wallet_root.is_dir() {
        let vault = crate::storage::Vault::new(
            wallet_root,
            *config.key,
            format!("{}:wallet-execution", config.environment_id),
        )
        .map_err(|_| backup_invalid())?;
        crate::wallet_execution::SpendState::open(&vault).map_err(|_| backup_invalid())?
    } else {
        crate::wallet_execution::SpendState::default()
    };
    let (proposed_wallet, merge) = crate::wallet_execution::merge_backup(
        &live_wallet,
        backup.wallet.receiver_executions.clone(),
        backup.wallet.settlements.clone(),
    )
    .map_err(|_| backup_invalid())?;
    let unknown_after_export =
        verify_wallet_history(config, state, &backup.wallet.anchors, &proposed_wallet)
            .await
            .map_err(|_| backup_invalid())?;
    let terminal = merge.terminal;
    let uncertain = merge.uncertain;
    let history_missing = unknown_after_export != 0;
    let (safe_checkpoint_count, peers_requiring_relink) = checkpoint_diagnostics(&backup.sdk);
    let unsafe_checkpoint_count = peers_requiring_relink.len();
    let grant_valid = crate::receiver::validate_backup_session(&backup.session)
        .await
        .is_ok();
    let marker_valid = crate::receiver::backup_marker_matches(
        &backup.owner_public_key,
        &backup.receiver_path,
        &backup.noise_public_key,
    )
    .await
    .unwrap_or(false);
    let mut blocked = Vec::new();
    if !grant_valid {
        blocked.push("grant_invalid");
    }
    if !marker_valid {
        blocked.push("marker_invalid");
    }
    if history_missing {
        blocked.push("wallet_history_unknown");
    }
    if unsafe_checkpoint_count != 0 {
        blocked.push("peer_relink_required");
    }
    let sdk_counts = serde_json::json!({
        "linkedPeers": backup.sdk.linked_peers.len(),
        "outboundPrivateMessages": backup.sdk.outbound_private_messages.len(),
        "privateStreamItems": backup.sdk.private_stream_items.len(),
        "receipts": backup.sdk.receipt_records.len(),
    });
    Ok(serde_json::json!({
        "receiverId": receiver_id,
        "transferId": transfer_id,
        "archiveVersion": backup.version,
        "createdAt": backup.created_at,
        "byteLength": archive.len(),
        "sha256": hex::encode(digest(archive)),
        "identityFingerprint": hex::encode(digest(backup.owner_public_key.as_bytes())),
        "receiverFingerprint": hex::encode(digest(format!("{}:{}", backup.receiver_path, backup.noise_public_key).as_bytes())),
        "identityMatches": identity_matches,
        "receiverMatches": receiver_matches,
        "grantValid": grant_valid,
        "markerValid": marker_valid,
        "sdkValidationPending": true,
        "sdkCounts": sdk_counts,
        "safeCheckpointCount": safe_checkpoint_count,
        "unsafeCheckpointCount": unsafe_checkpoint_count,
        "peersRequiringRelink": peers_requiring_relink,
        "wallet": {"imported": merge.imported, "retainedLive": merge.retained_live, "terminal": terminal, "uncertain": uncertain, "unknownAfterExport": unknown_after_export},
        "restorable": identity_matches && receiver_matches && grant_valid && marker_valid && !history_missing,
        "blockedReasons": blocked,
    }))
}

fn checkpoint_diagnostics(
    backup: &paykit_sdk::SdkBackupState,
) -> (usize, Vec<crate::model::RecoveryPeer>) {
    let mut safe = 0usize;
    let mut unsafe_peers = Vec::new();
    for peer in &backup.linked_peers {
        let snapshot = backup.encrypted_link_states.iter().find(|value| {
            value.counterparty == peer.counterparty
                && value.counterparty_receiver_path == peer.counterparty_receiver_path
        });
        let usable = match peer.state {
            paykit_sdk::LinkedPeerState::Linked => {
                snapshot.is_some_and(|value| value.link_snapshot.is_some())
            }
            paykit_sdk::LinkedPeerState::Linking => snapshot.is_some_and(|value| {
                value.handshake_snapshot.is_some() && value.handshake_role.is_some()
            }),
            paykit_sdk::LinkedPeerState::Blocked => true,
            paykit_sdk::LinkedPeerState::RecoveryRequired => false,
            _ => false,
        };
        if usable {
            safe += 1;
        } else {
            unsafe_peers.push(crate::model::RecoveryPeer {
                peer_public_key: peer.counterparty.to_string(),
                peer_receiver_path: peer.counterparty_receiver_path.to_string(),
            });
        }
    }
    unsafe_peers.sort_by(|left, right| {
        (&left.peer_public_key, &left.peer_receiver_path)
            .cmp(&(&right.peer_public_key, &right.peer_receiver_path))
    });
    (safe, unsafe_peers)
}

fn validate_receiver_binding(
    receiver: &crate::model::ReceiverRecord,
    owner: &crate::model::OwnerRecord,
    session: &crate::receiver::ReceiverSecrets,
) -> Result<(), PublicError> {
    let noise = crate::receiver::noise_public_key(session.noise);
    let owner_key = pubky::Keypair::from_secret(&session.owner)
        .public_key()
        .z32();
    if session.path != receiver.public.path
        || noise != receiver.public.noise_public_key
        || owner_key != owner.public.public_key
    {
        return Err(backup_invalid());
    }
    Ok(())
}

fn load_value(vault: &crate::storage::Vault, name: &str) -> Result<ciborium::Value, PublicError> {
    Ok(vault
        .load(name)
        .map_err(|_| backup_invalid())?
        .unwrap_or_else(|| ciborium::Value::Map(Vec::new())))
}

fn validate_backup_bounds(backup: &ReceiverBackupV1) -> Result<(), PublicError> {
    let bounded_text = [
        backup.owner_public_key.as_str(),
        backup.receiver_path.as_str(),
        backup.noise_public_key.as_str(),
        backup.session.path.as_str(),
    ]
    .into_iter()
    .all(|value| value.len() <= 4096);
    let sdk_bounded = [
        backup.sdk.linked_peers.len(),
        backup.sdk.contact_records.len(),
        backup.sdk.public_endpoint_records.len(),
        backup.sdk.payment_endpoint_reservations.len(),
        backup.sdk.encrypted_link_states.len(),
        backup.sdk.outbound_private_messages.len(),
        backup.sdk.private_stream_items.len(),
        backup.sdk.event_dedup_records.len(),
        backup.sdk.receipt_access_records.len(),
        backup.sdk.receipt_records.len(),
        backup.sdk.receipt_issuance_records.len(),
    ]
    .into_iter()
    .all(|length| length <= 4096);
    if backup.version != 1
        || !bounded_text
        || !sdk_bounded
        || backup.wallet.receiver_executions.len() > 4096
        || backup.wallet.settlements.len() > 16_384
        || backup.wallet.anchors.len() > 256
    {
        return Err(backup_invalid());
    }
    Ok(())
}

pub async fn restore_receiver(
    config: &crate::config::Config,
    state: &crate::model::AppState,
    receiver_id: Uuid,
    archive: &[u8],
    passphrase: &[u8],
) -> Result<crate::model::Recovery, PublicError> {
    let clear = decrypt(archive, passphrase)?;
    let mut backup: ReceiverBackupV1 =
        ciborium::from_reader(clear.as_slice()).map_err(|_| backup_invalid())?;
    validate_backup_bounds(&backup)?;
    let receiver = state
        .receivers
        .iter()
        .find(|value| value.public.id == receiver_id)
        .ok_or_else(backup_invalid)?;
    if receiver.public.status != crate::model::ReceiverStatus::Stopped {
        return Err(PublicError::new(
            "receiver_running",
            "Stop the receiver before restoring a backup.",
        ));
    }
    let owner = state
        .participants
        .iter()
        .find(|value| value.public.id == receiver.public.participant_id)
        .ok_or_else(backup_invalid)?;
    validate_archive_identity(config, receiver, owner, &backup)?;
    crate::receiver::validate_backup_session(&backup.session)
        .await
        .map_err(|_| backup_invalid())?;
    let marker_valid = crate::receiver::backup_marker_matches(
        &backup.owner_public_key,
        &backup.receiver_path,
        &backup.noise_public_key,
    )
    .await
    .map_err(|_| backup_invalid())?;
    if !marker_valid {
        return Err(backup_invalid());
    }
    if !backup.wallet.receiver_executions.is_empty() && backup.wallet.anchors.is_empty() {
        return Err(PublicError::new(
            "reconciliation_required",
            "Wallet history anchors are required before restoring payment state.",
        ));
    }
    let receiver_parent = config.data_dir.join("receivers");
    std::fs::create_dir_all(&receiver_parent).map_err(|_| backup_invalid())?;
    let live_receiver = receiver_parent.join(receiver_id.to_string());
    let staging_receiver = receiver_parent.join(format!(".restore-{receiver_id}"));
    if staging_receiver.exists() {
        return Err(PublicError::new(
            "activation_incomplete",
            "A prior restore transaction requires startup recovery.",
        ));
    }
    let staging_vault = std::sync::Arc::new(
        crate::storage::Vault::new(
            staging_receiver.clone(),
            *config.key,
            format!("{}:{receiver_id}", config.environment_id),
        )
        .map_err(|_| backup_invalid())?,
    );
    let live_wallet_root = receiver_parent.join("wallet-execution");
    let live_wallet_vault = crate::storage::Vault::new(
        live_wallet_root.clone(),
        *config.key,
        format!("{}:wallet-execution", config.environment_id),
    )
    .map_err(|_| backup_invalid())?;
    let _wallet_lock = live_wallet_vault
        .lock("recovery.lock")
        .map_err(|_| backup_invalid())?;
    let live_wallet = crate::wallet_execution::SpendState::open(&live_wallet_vault)
        .map_err(|_| backup_invalid())?;
    let (merged_wallet, merge) = crate::wallet_execution::merge_backup(
        &live_wallet,
        std::mem::take(&mut backup.wallet.receiver_executions),
        std::mem::take(&mut backup.wallet.settlements),
    )
    .map_err(|_| backup_invalid())?;
    let unknown_after_export =
        verify_wallet_history(config, state, &backup.wallet.anchors, &merged_wallet)
            .await
            .map_err(|_| backup_invalid())?;
    let initial_recovery = recovery_view(
        &backup,
        &merge,
        unknown_after_export,
        Vec::new(),
        crate::model::RecoveryPhase::Activating,
    );
    let gated_workspace =
        crate::workspace::with_recovery_gate(backup.workspace.clone(), initial_recovery)
            .map_err(|_| backup_invalid())?;
    staging_vault
        .save("session.cbor", &backup.session)
        .map_err(|_| backup_invalid())?;
    staging_vault
        .save("workspace.cbor", &gated_workspace)
        .map_err(|_| backup_invalid())?;
    staging_vault
        .save("payments.cbor", &backup.payment_adapter_state)
        .map_err(|_| backup_invalid())?;
    crate::workspace::requests::restore_request_state(&staging_vault, &backup.request_state)
        .map_err(|_| backup_invalid())?;
    staging_vault
        .save("subscriptions.cbor", &backup.subscriptions)
        .map_err(|_| backup_invalid())?;
    staging_vault
        .save("clock.cbor", &backup.application_clock)
        .map_err(|_| backup_invalid())?;
    staging_vault
        .save(
            "recovery-wallet.cbor",
            &RecoveryWalletState {
                anchors: backup.wallet.anchors.clone(),
            },
        )
        .map_err(|_| backup_invalid())?;
    let staging_storage = std::sync::Arc::new(
        crate::storage::ReceiverStorage::open(
            crate::storage::Vault::new(
                staging_receiver.clone(),
                *config.key,
                format!("{}:{receiver_id}", config.environment_id),
            )
            .map_err(|_| backup_invalid())?,
        )
        .map_err(|_| backup_invalid())?,
    );
    let report = crate::receiver::restore_sdk_state(
        config,
        staging_storage.clone(),
        staging_vault.clone(),
        backup.session.clone(),
        backup.sdk.clone(),
    )
    .await
    .map_err(|_| backup_invalid())?;
    drop(staging_storage);
    let peers = report
        .recovery_required_peers
        .into_iter()
        .map(|value| crate::model::RecoveryPeer {
            peer_public_key: value.counterparty.to_string(),
            peer_receiver_path: value.counterparty_receiver_path.to_string(),
        })
        .collect::<Vec<_>>();
    let phase = if merge.uncertain != 0 || unknown_after_export != 0 {
        crate::model::RecoveryPhase::WalletReconciliationRequired
    } else if peers.is_empty() {
        crate::model::RecoveryPhase::Ready
    } else {
        crate::model::RecoveryPhase::RelinkRequired
    };
    let recovery = recovery_view(&backup, &merge, unknown_after_export, peers, phase);
    let gated_workspace = crate::workspace::finalize_staged_recovery(
        staging_vault
            .load("workspace.cbor")
            .map_err(|_| backup_invalid())?
            .ok_or_else(backup_invalid)?,
        recovery.clone(),
    )
    .map_err(|_| backup_invalid())?;
    staging_vault
        .save("workspace.cbor", &gated_workspace)
        .map_err(|_| backup_invalid())?;
    let staging_wallet_root = receiver_parent.join(format!(".restore-wallet-{receiver_id}"));
    let staging_wallet_vault = crate::storage::Vault::new(
        staging_wallet_root.clone(),
        *config.key,
        format!("{}:wallet-execution", config.environment_id),
    )
    .map_err(|_| backup_invalid())?;
    merged_wallet
        .save(&staging_wallet_vault)
        .map_err(|_| backup_invalid())?;
    activate_receiver(
        config,
        receiver_id,
        &live_receiver,
        &staging_receiver,
        &live_wallet_root.join("executions.cbor"),
        &staging_wallet_root.join("executions.cbor"),
    )
    .map_err(|_| {
        PublicError::new(
            "activation_incomplete",
            "Restore activation was interrupted and will be recovered at startup.",
        )
    })?;
    Ok(recovery)
}

pub async fn reconcile_receiver(
    config: &crate::config::Config,
    state: &crate::model::AppState,
    receiver_id: Uuid,
) -> anyhow::Result<crate::model::Recovery> {
    let receiver_root = config
        .data_dir
        .join("receivers")
        .join(receiver_id.to_string());
    let receiver_vault = crate::storage::Vault::new(
        receiver_root,
        *config.key,
        format!("{}:{receiver_id}", config.environment_id),
    )?;
    let metadata: RecoveryWalletState = receiver_vault
        .load("recovery-wallet.cbor")?
        .ok_or_else(|| anyhow::anyhow!("receiver recovery metadata missing"))?;
    let wallet_vault = crate::storage::Vault::new(
        config.data_dir.join("receivers/wallet-execution"),
        *config.key,
        format!("{}:wallet-execution", config.environment_id),
    )?;
    let mut wallet = crate::wallet_execution::SpendState::open(&wallet_vault)?;
    let uncertain = wallet
        .executions
        .iter()
        .enumerate()
        .filter_map(|(index, execution)| {
            (execution.receiver_id == receiver_id && execution.view.status == "uncertain")
                .then_some(index)
        })
        .collect::<Vec<_>>();
    for index in uncertain {
        crate::wallet_execution::execute(&mut wallet, &wallet_vault, index, true).await?;
    }
    wallet = crate::wallet_execution::SpendState::open(&wallet_vault)?;
    let uncertain_execution_count = wallet
        .executions
        .iter()
        .filter(|execution| {
            execution.receiver_id == receiver_id && execution.view.status == "uncertain"
        })
        .count();
    let unknown_after_export_count =
        verify_wallet_history(config, state, &metadata.anchors, &wallet).await?;
    let workspace: ciborium::Value = receiver_vault
        .load("workspace.cbor")?
        .ok_or_else(|| anyhow::anyhow!("receiver workspace missing"))?;
    let mut recovery = recovery_from_workspace(workspace)?;
    recovery.uncertain_execution_count = uncertain_execution_count;
    recovery.unknown_after_export_count = unknown_after_export_count;
    recovery.wallet_reconciled = uncertain_execution_count == 0 && unknown_after_export_count == 0;
    recovery.blocked_reasons.retain(|reason| {
        *reason != crate::model::RecoveryBlockedReason::WalletUncertain
            && *reason != crate::model::RecoveryBlockedReason::WalletHistoryUnknown
    });
    if uncertain_execution_count != 0 {
        recovery
            .blocked_reasons
            .push(crate::model::RecoveryBlockedReason::WalletUncertain);
    }
    if unknown_after_export_count != 0 {
        recovery
            .blocked_reasons
            .push(crate::model::RecoveryBlockedReason::WalletHistoryUnknown);
    }
    recovery.automation_paused =
        !recovery.wallet_reconciled || !recovery.peers_requiring_relink.is_empty();
    recovery.phase = if !recovery.wallet_reconciled {
        crate::model::RecoveryPhase::WalletReconciliationRequired
    } else if recovery.peers_requiring_relink.is_empty() {
        crate::model::RecoveryPhase::Ready
    } else {
        crate::model::RecoveryPhase::RelinkRequired
    };
    crate::workspace::save_recovery(&receiver_vault, recovery.clone())?;
    Ok(recovery)
}

fn recovery_from_workspace(value: ciborium::Value) -> anyhow::Result<crate::model::Recovery> {
    #[derive(Deserialize)]
    struct StoredWorkspace {
        view: crate::workspace_model::Workspace,
    }
    let mut encoded = Vec::new();
    ciborium::into_writer(&value, &mut encoded)?;
    ciborium::from_reader::<StoredWorkspace, _>(encoded.as_slice())?
        .view
        .recovery
        .ok_or_else(|| anyhow::anyhow!("receiver recovery missing"))
}

fn validate_archive_identity(
    config: &crate::config::Config,
    receiver: &crate::model::ReceiverRecord,
    owner: &crate::model::OwnerRecord,
    backup: &ReceiverBackupV1,
) -> Result<(), PublicError> {
    let archived_owner = pubky::Keypair::from_secret(&backup.session.owner)
        .public_key()
        .z32();
    let archived_noise = crate::receiver::noise_public_key(backup.session.noise);
    if backup.version != 1
        || backup.environment_id != config.environment_id
        || backup.participant_id != receiver.public.participant_id
        || backup.receiver_id != receiver.public.id
        || backup.owner_public_key != owner.public.public_key
        || archived_owner != owner.public.public_key
        || backup.receiver_path != receiver.public.path
        || backup.session.path != receiver.public.path
        || backup.sdk.local_receiver_path.as_str() != receiver.public.path
        || backup.noise_public_key != receiver.public.noise_public_key
        || archived_noise != receiver.public.noise_public_key
    {
        return Err(backup_invalid());
    }
    Ok(())
}

fn recovery_view(
    backup: &ReceiverBackupV1,
    merge: &crate::wallet_execution::MergeReport,
    unknown_after_export: usize,
    peers: Vec<crate::model::RecoveryPeer>,
    phase: crate::model::RecoveryPhase,
) -> crate::model::Recovery {
    let peer_blocked = !peers.is_empty();
    let wallet_reconciled = merge.uncertain == 0 && unknown_after_export == 0;
    let mut blocked_reasons = Vec::new();
    if !wallet_reconciled {
        blocked_reasons.push(crate::model::RecoveryBlockedReason::WalletUncertain);
    }
    if unknown_after_export != 0 {
        blocked_reasons.push(crate::model::RecoveryBlockedReason::WalletHistoryUnknown);
    }
    if peer_blocked {
        blocked_reasons.push(crate::model::RecoveryBlockedReason::PeerRelinkRequired);
    }
    crate::model::Recovery {
        phase,
        automation_paused: !wallet_reconciled || peer_blocked,
        sdk_validated: true,
        wallet_reconciled,
        identity_fingerprint: hex::encode(digest(backup.owner_public_key.as_bytes())),
        receiver_fingerprint: hex::encode(digest(
            format!("{}:{}", backup.receiver_path, backup.noise_public_key).as_bytes(),
        )),
        grant_valid: true,
        marker_valid: true,
        terminal_execution_count: merge.terminal,
        uncertain_execution_count: merge.uncertain,
        unknown_after_export_count: unknown_after_export,
        peers_requiring_relink: peers,
        unresolved_execution_ids: Vec::new(),
        blocked_reasons,
        restored_at: Some(chrono::Utc::now().to_rfc3339()),
        last_error: None,
    }
}

#[derive(Serialize, Deserialize)]
struct RestoreJournal {
    receiver_id: Uuid,
    phase: String,
    live_receiver: std::path::PathBuf,
    staging_receiver: std::path::PathBuf,
    rollback_receiver: std::path::PathBuf,
    live_wallet: std::path::PathBuf,
    staging_wallet: std::path::PathBuf,
    rollback_wallet: std::path::PathBuf,
    live_receiver_existed: bool,
    live_wallet_existed: bool,
}

fn activate_receiver(
    config: &crate::config::Config,
    receiver_id: Uuid,
    live: &std::path::Path,
    staging: &std::path::Path,
    live_wallet: &std::path::Path,
    staging_wallet: &std::path::Path,
) -> anyhow::Result<()> {
    let rollback = config
        .data_dir
        .join("receivers")
        .join(format!(".rollback-{receiver_id}"));
    let journal_path = config.data_dir.join("restore-transaction.cbor");
    let rollback_wallet = live_wallet.with_extension(format!("rollback-{receiver_id}"));
    let mut journal = RestoreJournal {
        receiver_id,
        phase: "prepared".into(),
        live_receiver: live.to_path_buf(),
        staging_receiver: staging.to_path_buf(),
        rollback_receiver: rollback.clone(),
        live_wallet: live_wallet.to_path_buf(),
        staging_wallet: staging_wallet.to_path_buf(),
        rollback_wallet: rollback_wallet.clone(),
        live_receiver_existed: live.exists(),
        live_wallet_existed: live_wallet.exists(),
    };
    save_journal(&journal_path, &journal)?;
    if live.exists() {
        std::fs::rename(live, &rollback)?;
    }
    std::fs::rename(staging, live)?;
    sync_parent(live)?;
    journal.phase = "receiver_swapped".into();
    save_journal(&journal_path, &journal)?;
    if live_wallet.exists() {
        std::fs::rename(live_wallet, &rollback_wallet)?;
    }
    std::fs::rename(staging_wallet, live_wallet)?;
    sync_parent(live_wallet)?;
    journal.phase = "wallet_swapped".into();
    save_journal(&journal_path, &journal)?;
    journal.phase = "committed".into();
    save_journal(&journal_path, &journal)?;
    if rollback.exists() {
        std::fs::remove_dir_all(rollback)?;
    }
    if rollback_wallet.exists() {
        std::fs::remove_file(rollback_wallet)?;
    }
    if let Some(staging_wallet_root) = staging_wallet.parent() {
        let _ = std::fs::remove_dir(staging_wallet_root);
    }
    std::fs::remove_file(journal_path)?;
    Ok(())
}

fn save_journal(path: &std::path::Path, journal: &RestoreJournal) -> anyhow::Result<()> {
    let mut bytes = Vec::new();
    ciborium::into_writer(journal, &mut bytes)?;
    crate::storage::atomic_write(path, &bytes)
}

fn sync_parent(path: &std::path::Path) -> anyhow::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("restore parent missing"))?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub fn recover_restore_transaction(config: &crate::config::Config) -> anyhow::Result<()> {
    let journal_path = config.data_dir.join("restore-transaction.cbor");
    let bytes = match std::fs::read(&journal_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(bytes.len() <= 16 * 1024, "restore journal too large");
    let journal: RestoreJournal = ciborium::from_reader(bytes.as_slice())?;
    validate_journal_paths(config, &journal)?;
    match journal.phase.as_str() {
        "prepared" => rollback_receiver_swap(&journal)?,
        "receiver_swapped" => rollback_receiver_swap(&journal)?,
        "wallet_swapped" | "committed" => finish_committed_restore(&journal)?,
        _ => anyhow::bail!("invalid restore journal phase"),
    }
    if journal_path.exists() {
        std::fs::remove_file(journal_path)?;
    }
    Ok(())
}

fn validate_journal_paths(
    config: &crate::config::Config,
    journal: &RestoreJournal,
) -> anyhow::Result<()> {
    let receivers = config.data_dir.join("receivers");
    let live = receivers.join(journal.receiver_id.to_string());
    let staging = receivers.join(format!(".restore-{}", journal.receiver_id));
    let rollback = receivers.join(format!(".rollback-{}", journal.receiver_id));
    let live_wallet = receivers.join("wallet-execution/executions.cbor");
    let staging_wallet = receivers.join(format!(
        ".restore-wallet-{}/executions.cbor",
        journal.receiver_id
    ));
    anyhow::ensure!(
        journal.live_receiver == live
            && journal.staging_receiver == staging
            && journal.rollback_receiver == rollback
            && journal.live_wallet == live_wallet
            && journal.staging_wallet == staging_wallet
            && journal.rollback_wallet
                == live_wallet.with_extension(format!("rollback-{}", journal.receiver_id)),
        "restore journal paths are invalid"
    );
    Ok(())
}

fn rollback_receiver_swap(journal: &RestoreJournal) -> anyhow::Result<()> {
    if journal.live_receiver_existed && journal.rollback_receiver.exists() {
        if journal.live_receiver.exists() {
            std::fs::remove_dir_all(&journal.live_receiver)?;
        }
        std::fs::rename(&journal.rollback_receiver, &journal.live_receiver)?;
    } else if !journal.live_receiver_existed && journal.live_receiver.exists() {
        std::fs::remove_dir_all(&journal.live_receiver)?;
    }
    if journal.live_wallet_existed && journal.rollback_wallet.exists() {
        if journal.live_wallet.exists() {
            std::fs::remove_file(&journal.live_wallet)?;
        }
        std::fs::rename(&journal.rollback_wallet, &journal.live_wallet)?;
    } else if !journal.live_wallet_existed && journal.live_wallet.exists() {
        std::fs::remove_file(&journal.live_wallet)?;
    }
    if journal.staging_receiver.exists() {
        std::fs::remove_dir_all(&journal.staging_receiver)?;
    }
    if let Some(root) = journal.staging_wallet.parent() {
        if root.exists() {
            std::fs::remove_dir_all(root)?;
        }
    }
    sync_parent(&journal.live_receiver)?;
    sync_existing_parent(&journal.live_wallet)?;
    Ok(())
}

fn sync_existing_parent(path: &std::path::Path) -> anyhow::Result<()> {
    let parent = path
        .ancestors()
        .skip(1)
        .find(|value| value.is_dir())
        .ok_or_else(|| anyhow::anyhow!("restore parent missing"))?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn finish_committed_restore(journal: &RestoreJournal) -> anyhow::Result<()> {
    if journal.rollback_receiver.exists() {
        std::fs::remove_dir_all(&journal.rollback_receiver)?;
    }
    if journal.rollback_wallet.exists() {
        std::fs::remove_file(&journal.rollback_wallet)?;
    }
    if let Some(root) = journal.staging_wallet.parent() {
        if root.exists() {
            std::fs::remove_dir_all(root)?;
        }
    }
    Ok(())
}

/// Scenario-only helper used by the dedicated backup fixture binary.
#[doc(hidden)]
pub fn fixture_prune_post_export_executions(
    config: &crate::config::Config,
    receiver_id: Uuid,
    core_txid: &str,
    lightning_hash: &str,
) -> anyhow::Result<(usize, usize)> {
    validate_history_id(core_txid)?;
    validate_history_id(lightning_hash)?;
    let receiver_root = config
        .data_dir
        .join("receivers")
        .join(receiver_id.to_string());
    anyhow::ensure!(receiver_root.is_dir(), "receiver state missing");
    let receiver_vault = crate::receiver::vault(config, receiver_id)?;
    let wallet_vault = receiver_vault.shared_wallets(config.environment_id)?;
    let _lock = wallet_vault.lock("backup-fixture.lock")?;
    let mut state = crate::wallet_execution::SpendState::open(&wallet_vault)?;
    let matches = state
        .executions
        .iter()
        .filter(|value| fixture_execution_matches(value, receiver_id, core_txid, lightning_hash))
        .count();
    anyhow::ensure!(matches == 2, "expected exactly two matching executions");
    let core_count = state
        .executions
        .iter()
        .filter(|value| {
            value.receiver_id == receiver_id && value.view.txid.as_deref() == Some(core_txid)
        })
        .count();
    let lightning_count = state
        .executions
        .iter()
        .filter(|value| {
            value.receiver_id == receiver_id
                && value.view.payment_hash.as_deref() == Some(lightning_hash)
        })
        .count();
    anyhow::ensure!(
        core_count == 1 && lightning_count == 1,
        "ambiguous execution identity"
    );
    state
        .executions
        .retain(|value| !fixture_execution_matches(value, receiver_id, core_txid, lightning_hash));
    let before_settlements = state.settlements.len();
    let core_prefix = format!("btc:{}:", core_txid.to_lowercase());
    let lightning_key = format!("ln:{}", lightning_hash.to_lowercase());
    state.settlements.retain(|proof, _| {
        !(proof.to_lowercase().starts_with(&core_prefix)
            || proof.eq_ignore_ascii_case(&lightning_key))
    });
    let removed_settlements = before_settlements - state.settlements.len();
    anyhow::ensure!(
        removed_settlements == 2,
        "expected exact settlement bindings"
    );
    state.save_under_lock(&wallet_vault)?;
    Ok((matches, removed_settlements))
}

/// Scenario-only helper used to create a missing-checkpoint recovery case.
#[doc(hidden)]
pub fn fixture_mark_peer_unsafe(
    config: &crate::config::Config,
    receiver_id: Uuid,
    peer_public_key: &str,
    peer_receiver_path: &str,
) -> anyhow::Result<usize> {
    let receiver_root = config
        .data_dir
        .join("receivers")
        .join(receiver_id.to_string());
    anyhow::ensure!(receiver_root.is_dir(), "receiver state missing");
    let vault = crate::receiver::vault(config, receiver_id)?;
    let _lock = vault.lock("receiver.lock")?;
    let mut state: paykit_sdk::storage::StorageState = vault
        .load("sdk.cbor")?
        .ok_or_else(|| anyhow::anyhow!("SDK state missing"))?;
    let peer = paykit_sdk::PubkyPublicKey::new(peer_public_key)?;
    let path = paykit_sdk::PaykitReceiverPath::new(peer_receiver_path)?;
    let key = (peer, path);
    let linked = state
        .linked_peers
        .get(&key)
        .ok_or_else(|| anyhow::anyhow!("linked peer missing"))?;
    anyhow::ensure!(
        matches!(
            linked.state,
            paykit_sdk::LinkedPeerState::Linked | paykit_sdk::LinkedPeerState::Linking
        ),
        "peer is not active"
    );
    anyhow::ensure!(
        state.encrypted_link_states.remove(&key).is_some(),
        "peer checkpoint missing"
    );
    vault.save("sdk.cbor", &state)?;
    Ok(1)
}

/// Return a non-secret digest projection for scenario equality checks.
#[doc(hidden)]
pub fn fixture_journal_projection(
    config: &crate::config::Config,
) -> anyhow::Result<serde_json::Value> {
    let wallet_root = config.data_dir.join("receivers/wallet-execution");
    let vault = crate::storage::Vault::new(
        wallet_root,
        *config.key,
        format!("{}:wallet-execution", config.environment_id),
    )?;
    let _lock = vault.lock("backup-fixture.lock")?;
    let state = crate::wallet_execution::SpendState::open(&vault)?;
    let mut executions = state.executions.iter().collect::<Vec<_>>();
    executions.sort_by(|left, right| left.view.id.cmp(&right.view.id));
    let projection = executions
        .iter()
        .map(|value| {
            serde_json::json!({
                "receiver": value.receiver_id,
                "execution": value.view.id,
                "request": value.view.request_id,
                "period": value.view.period_index,
                "wallet": value.view.wallet_id,
                "rail": value.view.method,
                "amount": value.view.amount_sats,
                "endpointDigest": hex::encode(digest(value.view.endpoint.as_bytes())),
                "txid": value.view.txid,
                "paymentHash": value.view.payment_hash,
                "rawTransactionDigest": value.signed.as_ref().map(|raw| hex::encode(digest(raw.as_bytes()))),
                "inputDigest": hex::encode(digest(&serde_json::to_vec(&value.inputs).unwrap_or_default())),
                "proofDigest": value.proof.as_ref().map(|proof| hex::encode(digest(&serde_json::to_vec(proof).unwrap_or_default()))),
                "outcome": value.view.status,
            })
        })
        .collect::<Vec<_>>();
    let canonical = serde_json::to_vec(&(projection, &state.settlements))?;
    let mut terminal_by_receiver = std::collections::BTreeMap::<String, usize>::new();
    for value in executions
        .into_iter()
        .filter(|value| matches!(value.view.status.as_str(), "succeeded" | "failed"))
    {
        *terminal_by_receiver
            .entry(value.receiver_id.to_string())
            .or_default() += 1;
    }
    Ok(serde_json::json!({
        "digest": hex::encode(digest(&canonical)),
        "executionCount": state.executions.len(),
        "settlementCount": state.settlements.len(),
        "terminalByReceiver": terminal_by_receiver,
    }))
}

fn fixture_execution_matches(
    value: &crate::wallet_execution::Execution,
    receiver_id: Uuid,
    core_txid: &str,
    lightning_hash: &str,
) -> bool {
    value.receiver_id == receiver_id
        && value.view.status == "succeeded"
        && (value.view.txid.as_deref() == Some(core_txid)
            || value.view.payment_hash.as_deref() == Some(lightning_hash))
}

fn validate_history_id(value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        value.len() == 64
            && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            && value == value.to_lowercase(),
        "invalid history identifier"
    );
    Ok(())
}

struct Transfer {
    purpose: TransferPurpose,
    receiver_id: Uuid,
    bearer_binding: [u8; 32],
    expires_at: SystemTime,
    state: TransferState,
    passphrase: Zeroizing<Vec<u8>>,
    archive: Zeroizing<Vec<u8>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TransferState {
    Uploaded,
    Inspected,
    Claimed,
    Output,
}

#[derive(Default)]
pub struct TransferRegistry {
    entries: Mutex<HashMap<Uuid, Transfer>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferCreated {
    pub transfer_id: Uuid,
    pub purpose: TransferPurpose,
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

impl TransferRegistry {
    pub fn create(
        &self,
        upload: TransferUpload,
        bearer: &str,
    ) -> Result<TransferCreated, PublicError> {
        let now = SystemTime::now();
        let mut entries = self.entries.lock().map_err(|_| transfer_invalid())?;
        remove_expired(&mut entries, now);
        let aggregate = entries
            .values()
            .map(|v| v.archive.len() + v.passphrase.len())
            .sum::<usize>();
        if entries.len() >= MAX_TRANSFER_HANDLES
            || aggregate + upload.archive.len() + upload.passphrase.len() > MAX_TRANSFER_BYTES
        {
            return Err(PublicError::new(
                "transfer_capacity",
                "Transfer capacity is exhausted.",
            ));
        }
        let transfer_id = Uuid::new_v4();
        let expires_at = now + UPLOAD_TTL;
        entries.insert(
            transfer_id,
            Transfer {
                purpose: upload.purpose,
                receiver_id: upload.receiver_id,
                bearer_binding: digest(bearer.as_bytes()),
                expires_at,
                state: TransferState::Uploaded,
                passphrase: upload.passphrase,
                archive: upload.archive,
            },
        );
        Ok(TransferCreated {
            transfer_id,
            purpose: upload.purpose,
            expires_at: expires_at.into(),
        })
    }

    pub fn inspect(
        &self,
        id: Uuid,
        receiver: Uuid,
        bearer: &str,
    ) -> Result<TransferClaim, PublicError> {
        self.access(id, receiver, bearer, TransferPurpose::Restore, false)
    }

    pub fn claim_export(
        &self,
        id: Uuid,
        receiver: Uuid,
        bearer: &str,
    ) -> Result<Zeroizing<Vec<u8>>, PublicError> {
        let mut entries = self.entries.lock().map_err(|_| transfer_invalid())?;
        let value = get_transfer(&mut entries, id)?;
        validate_binding(value, receiver, bearer, TransferPurpose::Export)?;
        if value.state != TransferState::Uploaded {
            return Err(transfer_consumed());
        }
        value.state = TransferState::Claimed;
        Ok(Zeroizing::new(value.passphrase.to_vec()))
    }

    pub fn claim_restore(
        &self,
        id: Uuid,
        receiver: Uuid,
        bearer: &str,
    ) -> Result<TransferClaim, PublicError> {
        self.access(id, receiver, bearer, TransferPurpose::Restore, true)
    }

    fn access(
        &self,
        id: Uuid,
        receiver: Uuid,
        bearer: &str,
        purpose: TransferPurpose,
        consume: bool,
    ) -> Result<TransferClaim, PublicError> {
        let mut entries = self.entries.lock().map_err(|_| transfer_invalid())?;
        let value = get_transfer(&mut entries, id)?;
        validate_binding(value, receiver, bearer, purpose)?;
        if matches!(value.state, TransferState::Claimed | TransferState::Output) {
            return Err(transfer_consumed());
        }
        value.state = if consume {
            TransferState::Claimed
        } else {
            TransferState::Inspected
        };
        Ok(TransferClaim {
            passphrase: Zeroizing::new(value.passphrase.to_vec()),
            archive: Zeroizing::new(value.archive.to_vec()),
        })
    }

    pub fn finish_export(
        &self,
        id: Uuid,
        receiver: Uuid,
        bearer: &str,
        archive: Vec<u8>,
    ) -> Result<(), PublicError> {
        if archive.len() > MAX_ARCHIVE_BYTES {
            return Err(backup_too_large());
        }
        let mut entries = self.entries.lock().map_err(|_| transfer_invalid())?;
        let value = get_transfer(&mut entries, id)?;
        validate_binding(value, receiver, bearer, TransferPurpose::Export)?;
        if value.state != TransferState::Claimed {
            return Err(transfer_consumed());
        }
        value.archive = Zeroizing::new(archive);
        value.passphrase.zeroize();
        value.state = TransferState::Output;
        value.expires_at = SystemTime::now() + EXPORT_TTL;
        Ok(())
    }

    pub fn download(&self, id: Uuid, bearer: &str) -> Result<Zeroizing<Vec<u8>>, PublicError> {
        let mut entries = self.entries.lock().map_err(|_| transfer_invalid())?;
        let value = get_transfer(&mut entries, id)?;
        if value.bearer_binding != digest(bearer.as_bytes()) {
            return Err(transfer_mismatch());
        }
        if value.purpose != TransferPurpose::Export {
            return Err(transfer_mismatch());
        }
        if value.state != TransferState::Output {
            return Err(transfer_consumed());
        }
        let mut value = entries.remove(&id).ok_or_else(transfer_expired)?;
        Ok(Zeroizing::new(std::mem::take(&mut *value.archive)))
    }

    pub fn cancel(&self, id: Uuid, bearer: &str) -> Result<(), PublicError> {
        let mut entries = self.entries.lock().map_err(|_| transfer_invalid())?;
        let value = get_transfer(&mut entries, id)?;
        if value.bearer_binding != digest(bearer.as_bytes()) {
            return Err(transfer_mismatch());
        }
        entries.remove(&id);
        Ok(())
    }
}

fn get_transfer(
    entries: &mut HashMap<Uuid, Transfer>,
    id: Uuid,
) -> Result<&mut Transfer, PublicError> {
    let now = SystemTime::now();
    if entries.get(&id).is_some_and(|v| v.expires_at <= now) {
        entries.remove(&id);
        return Err(transfer_expired());
    }
    entries.get_mut(&id).ok_or_else(transfer_expired)
}

fn remove_expired(entries: &mut HashMap<Uuid, Transfer>, now: SystemTime) {
    entries.retain(|_, value| value.expires_at > now);
}

fn validate_binding(
    value: &Transfer,
    receiver: Uuid,
    bearer: &str,
    purpose: TransferPurpose,
) -> Result<(), PublicError> {
    if value.receiver_id != receiver
        || value.purpose != purpose
        || value.bearer_binding != digest(bearer.as_bytes())
    {
        return Err(transfer_mismatch());
    }
    Ok(())
}

pub fn encrypt(cleartext: &[u8], passphrase: &[u8]) -> Result<Zeroizing<Vec<u8>>, PublicError> {
    validate_passphrase(passphrase)?;
    if cleartext.len() + HEADER_BYTES + TAG_BYTES > MAX_ARCHIVE_BYTES {
        return Err(backup_too_large());
    }
    let mut salt = [0u8; 16];
    use chacha20poly1305::aead::rand_core::RngCore;
    OsRng.fill_bytes(&mut salt);
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext_len = cleartext.len() + TAG_BYTES;
    let header = envelope_header(&salt, &nonce, ciphertext_len)?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: cleartext,
                aad: &header,
            },
        )
        .map_err(|_| backup_invalid())?;
    let mut envelope = Zeroizing::new(header);
    envelope.extend_from_slice(&ciphertext);
    Ok(envelope)
}

pub fn decrypt(envelope: &[u8], passphrase: &[u8]) -> Result<Zeroizing<Vec<u8>>, PublicError> {
    validate_passphrase(passphrase)?;
    if envelope.len() > MAX_ARCHIVE_BYTES || envelope.len() < HEADER_BYTES + TAG_BYTES {
        return Err(backup_invalid());
    }
    let header = &envelope[..HEADER_BYTES];
    let mut cursor = FrameCursor::new(header);
    if cursor.take(17)? != ENVELOPE_MAGIC || cursor.u8()? != ENVELOPE_VERSION {
        return Err(backup_invalid());
    }
    if cursor.u32()? != KDF_MEMORY_KIB
        || cursor.u32()? != KDF_ITERATIONS
        || cursor.u32()? != KDF_PARALLELISM
    {
        return Err(backup_invalid());
    }
    let salt = cursor.take(16)?;
    let nonce = cursor.take(24)?;
    let length = cursor.u32()? as usize;
    if length != envelope.len() - HEADER_BYTES {
        return Err(backup_invalid());
    }
    let key = derive_key(passphrase, salt)?;
    let cipher = XChaCha20Poly1305::new((&*key).into());
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: &envelope[HEADER_BYTES..],
                aad: header,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| backup_invalid())
}

fn envelope_header(
    salt: &[u8; 16],
    nonce: &XNonce,
    ciphertext_len: usize,
) -> Result<Vec<u8>, PublicError> {
    let length = u32::try_from(ciphertext_len).map_err(|_| backup_too_large())?;
    let mut header = Vec::with_capacity(HEADER_BYTES);
    header.extend_from_slice(ENVELOPE_MAGIC);
    header.push(ENVELOPE_VERSION);
    header.extend_from_slice(&KDF_MEMORY_KIB.to_be_bytes());
    header.extend_from_slice(&KDF_ITERATIONS.to_be_bytes());
    header.extend_from_slice(&KDF_PARALLELISM.to_be_bytes());
    header.extend_from_slice(salt);
    header.extend_from_slice(nonce);
    header.extend_from_slice(&length.to_be_bytes());
    Ok(header)
}

fn derive_key(passphrase: &[u8], salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, PublicError> {
    let params = Params::new(KDF_MEMORY_KIB, KDF_ITERATIONS, KDF_PARALLELISM, Some(32))
        .map_err(|_| backup_invalid())?;
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase, salt, &mut *key)
        .map_err(|_| backup_invalid())?;
    Ok(key)
}

fn validate_passphrase(value: &[u8]) -> Result<(), PublicError> {
    if !(MIN_PASSPHRASE_BYTES..=MAX_PASSPHRASE_BYTES).contains(&value.len())
        || std::str::from_utf8(value).is_err()
    {
        return Err(transfer_invalid());
    }
    Ok(())
}

fn digest(value: &[u8]) -> [u8; 32] {
    use bitcoin::hashes::{sha256, Hash};
    sha256::Hash::hash(value).to_byte_array()
}

fn transfer_invalid() -> PublicError {
    PublicError::new("transfer_invalid", "The transfer framing is invalid.")
}
fn transfer_expired() -> PublicError {
    PublicError::new(
        "transfer_expired",
        "The transfer does not exist or has expired.",
    )
}
fn transfer_consumed() -> PublicError {
    PublicError::new("transfer_consumed", "The transfer was already consumed.")
}
fn transfer_mismatch() -> PublicError {
    PublicError::new(
        "transfer_mismatch",
        "The transfer does not match this receiver or purpose.",
    )
}
fn backup_too_large() -> PublicError {
    PublicError::new("backup_too_large", "The backup exceeds the size limit.")
}
fn backup_invalid() -> PublicError {
    PublicError::new("backup_invalid", "The backup is invalid.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upload(purpose: TransferPurpose, receiver: Uuid, archive: &[u8]) -> Vec<u8> {
        let passphrase = b"correct horse battery staple";
        let mut frame = Vec::new();
        frame.extend_from_slice(TRANSFER_MAGIC);
        frame.push(TRANSFER_VERSION);
        frame.push(purpose.byte());
        frame.extend_from_slice(receiver.as_bytes());
        frame.extend_from_slice(&(passphrase.len() as u16).to_be_bytes());
        frame.extend_from_slice(&(archive.len() as u32).to_be_bytes());
        frame.extend_from_slice(passphrase);
        frame.extend_from_slice(archive);
        frame
    }

    #[test]
    fn envelope_round_trip_and_tamper_rejection() {
        let passphrase = b"correct horse battery staple";
        let encrypted = encrypt(b"complete typed receiver state", passphrase).unwrap();
        assert_eq!(
            &*decrypt(&encrypted, passphrase).unwrap(),
            b"complete typed receiver state"
        );
        let mut tampered = encrypted.to_vec();
        let index = tampered.len() - 1;
        tampered[index] ^= 1;
        assert_eq!(
            decrypt(&tampered, passphrase).unwrap_err().code,
            "backup_invalid"
        );
        assert_eq!(
            decrypt(&encrypted, b"wrong password").unwrap_err().code,
            "backup_invalid"
        );
    }

    #[test]
    fn archive_rejects_missing_request_state() {
        let owner = pubky::Keypair::random();
        let noise = pubky::Keypair::random();
        let receiver_id = Uuid::new_v4();
        let request_state = ciborium::Value::serialized(&serde_json::json!({
            "claims": {}, "proposals": {}, "transitions": {}, "settlements": []
        }))
        .unwrap();
        let archive = ReceiverBackupV1 {
            version: 1,
            environment_id: Uuid::new_v4(),
            participant_id: Uuid::new_v4(),
            receiver_id,
            owner_public_key: owner.public_key().z32(),
            receiver_path: "receiver/wallet".into(),
            noise_public_key: noise.public_key().z32(),
            created_at: chrono::Utc::now(),
            session: crate::receiver::ReceiverSecrets {
                owner: owner.secret(),
                noise: noise.secret(),
                path: "receiver/wallet".into(),
                session: None,
            },
            sdk: paykit_sdk::SdkBackupState {
                version: paykit_sdk::SDK_BACKUP_VERSION,
                local_receiver_path: paykit_sdk::PaykitReceiverPath::new("receiver/wallet")
                    .unwrap(),
                identity_state: None,
                linked_peers: vec![],
                contact_records: vec![],
                public_endpoint_records: vec![],
                payment_endpoint_reservations: vec![],
                encrypted_link_states: vec![],
                outbound_private_messages: vec![],
                private_stream_items: vec![],
                event_dedup_records: vec![],
                receipt_access_records: vec![],
                receipt_records: vec![],
                receipt_issuance_records: vec![],
                next_outbound_private_message_id: 0,
                next_receive_batch_id: 0,
                next_private_stream_item_id: 0,
            },
            workspace: ciborium::Value::Map(vec![]),
            payment_adapter_state: ciborium::Value::Map(vec![]),
            request_state,
            subscriptions: ciborium::Value::Map(vec![]),
            application_clock: ciborium::Value::Map(vec![]),
            wallet: WalletBackup {
                receiver_executions: vec![],
                settlements: Default::default(),
                anchors: vec![],
            },
        };
        let mut value = ciborium::Value::serialized(&archive).unwrap();
        let ciborium::Value::Map(fields) = &mut value else {
            panic!("archive must serialize as a map");
        };
        fields.retain(|(key, _)| key.as_text() != Some("request_state"));
        let mut encoded = Vec::new();
        ciborium::into_writer(&value, &mut encoded).unwrap();

        assert!(ciborium::from_reader::<ReceiverBackupV1, _>(encoded.as_slice()).is_err());
    }

    #[test]
    fn receiver_binding_uses_sdk_noise_key_and_rejects_each_mismatch() {
        let owner_key = pubky::Keypair::random();
        let owner = crate::model::OwnerRecord {
            public: crate::model::Participant {
                id: Uuid::new_v4(),
                name: "owner".into(),
                public_key: owner_key.public_key().z32(),
            },
            secret: owner_key.secret(),
            registered: true,
        };
        let secrets = crate::receiver::ReceiverSecrets {
            owner: owner.secret,
            noise: pubky::Keypair::random().secret(),
            path: "receiver/wallet".into(),
            session: Some("opaque".into()),
        };
        let receiver = crate::model::ReceiverRecord {
            public: crate::model::Receiver {
                id: Uuid::new_v4(),
                participant_id: owner.public.id,
                name: "wallet".into(),
                path: secrets.path.clone(),
                status: crate::model::ReceiverStatus::Stopped,
                generation: 1,
                noise_public_key: crate::receiver::noise_public_key(secrets.noise),
                last_error: None,
            },
            desired_running: false,
        };
        assert!(validate_receiver_binding(&receiver, &owner, &secrets).is_ok());
        let mut wrong = receiver.clone();
        wrong.public.noise_public_key = paykit_sdk::ReceiverNoiseSecretKey::new(secrets.noise)
            .public_key()
            .to_string();
        assert!(validate_receiver_binding(&wrong, &owner, &secrets).is_err());
        wrong = receiver.clone();
        wrong.public.path.push_str("/other");
        assert!(validate_receiver_binding(&wrong, &owner, &secrets).is_err());
        let mut wrong_secrets = secrets.clone();
        wrong_secrets.owner = pubky::Keypair::random().secret();
        assert!(validate_receiver_binding(&receiver, &owner, &wrong_secrets).is_err());
    }

    #[test]
    fn sdk_noise_key_uses_pubky_z32_wire_encoding() {
        let secret = pubky::Keypair::random().secret();
        let pubky_z32 = pubky::Keypair::from_secret(&secret).public_key().z32();
        let sdk_public = paykit_sdk::ReceiverNoiseSecretKey::new(secret).public_key();
        assert_eq!(sdk_public.z32(), pubky_z32);
        assert_ne!(sdk_public.to_string(), pubky_z32);
        assert_eq!(crate::receiver::noise_public_key(secret), pubky_z32);
    }

    #[test]
    fn funded_owner_resolution_uses_stable_preset_id_after_rename_and_name_reuse() {
        let environment_id = Uuid::new_v4();
        let directory = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            environment_id,
            data_dir: directory.path().into(),
            key: Zeroizing::new([1; 32]),
            token: Zeroizing::new("a".repeat(64)),
            listen: "127.0.0.1:0".into(),
        };
        let preset_key = pubky::Keypair::random();
        let reused_key = pubky::Keypair::random();
        let participants = vec![
            crate::model::OwnerRecord {
                public: crate::model::Participant {
                    id: Uuid::new_v5(&environment_id, b"preset:Bob"),
                    name: "Renamed Bob".into(),
                    public_key: preset_key.public_key().z32(),
                },
                secret: preset_key.secret(),
                registered: true,
            },
            crate::model::OwnerRecord {
                public: crate::model::Participant {
                    id: Uuid::new_v4(),
                    name: "Bob".into(),
                    public_key: reused_key.public_key().z32(),
                },
                secret: reused_key.secret(),
                registered: true,
            },
        ];
        let funded = crate::request_model::FundedWallet {
            participant: "Bob".into(),
            wallet_id: "wallet".into(),
            onchain_balance_sats: "1".into(),
            lightning_balance_sats: "1".into(),
        };
        let resolved = resolve_funded_wallet_owner(&config, &participants, &funded).unwrap();
        assert_eq!(
            resolved.public.id,
            Uuid::new_v5(&environment_id, b"preset:Bob")
        );
        let mut invalid = funded;
        invalid.participant = "Renamed Bob".into();
        assert!(resolve_funded_wallet_owner(&config, &participants, &invalid).is_err());
    }

    #[test]
    fn envelope_rejects_truncation_version_and_attacker_kdf_cost() {
        let passphrase = b"correct horse battery staple";
        let encrypted = encrypt(b"state", passphrase).unwrap();
        assert_eq!(
            decrypt(&encrypted[..encrypted.len() - 1], passphrase)
                .unwrap_err()
                .code,
            "backup_invalid"
        );
        let mut wrong_version = encrypted.to_vec();
        wrong_version[ENVELOPE_MAGIC.len()] = 2;
        assert_eq!(
            decrypt(&wrong_version, passphrase).unwrap_err().code,
            "backup_invalid"
        );
        let mut expensive = encrypted.to_vec();
        expensive[ENVELOPE_MAGIC.len() + 1] ^= 1;
        assert_eq!(
            decrypt(&expensive, passphrase).unwrap_err().code,
            "backup_invalid"
        );
    }

    #[test]
    fn frame_rejects_trailing_and_export_archive() {
        let receiver = Uuid::new_v4();
        let mut trailing = upload(TransferPurpose::Restore, receiver, b"archive");
        trailing.push(0);
        assert_eq!(
            TransferUpload::decode(&trailing).unwrap_err().code,
            "transfer_invalid"
        );
        assert_eq!(
            TransferUpload::decode(&upload(TransferPurpose::Export, receiver, b"archive"))
                .err()
                .unwrap()
                .code,
            "transfer_invalid"
        );
    }

    #[test]
    fn frame_accepts_exact_maximum_restore_size() {
        let receiver = Uuid::new_v4();
        let passphrase = vec![b'a'; MAX_PASSPHRASE_BYTES];
        let archive = vec![0u8; MAX_ARCHIVE_BYTES];
        let mut frame = Vec::with_capacity(28 + passphrase.len() + archive.len());
        frame.extend_from_slice(TRANSFER_MAGIC);
        frame.push(TRANSFER_VERSION);
        frame.push(TransferPurpose::Restore.byte());
        frame.extend_from_slice(receiver.as_bytes());
        frame.extend_from_slice(&(passphrase.len() as u16).to_be_bytes());
        frame.extend_from_slice(&(archive.len() as u32).to_be_bytes());
        frame.extend_from_slice(&passphrase);
        frame.extend_from_slice(&archive);
        let decoded = TransferUpload::decode(&frame).unwrap();
        assert_eq!(decoded.archive.len(), MAX_ARCHIVE_BYTES);
        assert_eq!(decoded.passphrase.len(), MAX_PASSPHRASE_BYTES);
    }

    #[test]
    fn restore_inspection_is_repeatable_but_claim_consumes() {
        let receiver = Uuid::new_v4();
        let registry = TransferRegistry::default();
        let created = registry
            .create(
                TransferUpload::decode(&upload(TransferPurpose::Restore, receiver, b"archive"))
                    .unwrap(),
                "bearer",
            )
            .unwrap();
        assert_eq!(
            &*registry
                .inspect(created.transfer_id, receiver, "bearer")
                .unwrap()
                .archive,
            b"archive"
        );
        assert_eq!(
            &*registry
                .inspect(created.transfer_id, receiver, "bearer")
                .unwrap()
                .archive,
            b"archive"
        );
        registry
            .claim_restore(created.transfer_id, receiver, "bearer")
            .unwrap();
        assert_eq!(
            registry
                .inspect(created.transfer_id, receiver, "bearer")
                .err()
                .unwrap()
                .code,
            "transfer_consumed"
        );
    }

    #[test]
    fn transfer_is_bound_to_bearer_receiver_and_purpose() {
        let receiver = Uuid::new_v4();
        let registry = TransferRegistry::default();
        let created = registry
            .create(
                TransferUpload::decode(&upload(TransferPurpose::Restore, receiver, b"archive"))
                    .unwrap(),
                "bearer",
            )
            .unwrap();
        assert_eq!(
            registry
                .inspect(created.transfer_id, Uuid::new_v4(), "bearer")
                .err()
                .unwrap()
                .code,
            "transfer_mismatch"
        );
        assert_eq!(
            registry
                .inspect(created.transfer_id, receiver, "other")
                .err()
                .unwrap()
                .code,
            "transfer_mismatch"
        );
    }

    #[test]
    fn export_download_is_single_use() {
        let receiver = Uuid::new_v4();
        let registry = TransferRegistry::default();
        let created = registry
            .create(
                TransferUpload::decode(&upload(TransferPurpose::Export, receiver, b"")).unwrap(),
                "bearer",
            )
            .unwrap();
        let passphrase = registry
            .claim_export(created.transfer_id, receiver, "bearer")
            .unwrap();
        assert_eq!(&*passphrase, b"correct horse battery staple");
        registry
            .finish_export(
                created.transfer_id,
                receiver,
                "bearer",
                b"encrypted".to_vec(),
            )
            .unwrap();
        assert_eq!(
            &*registry.download(created.transfer_id, "bearer").unwrap(),
            b"encrypted"
        );
        assert_eq!(
            registry
                .download(created.transfer_id, "bearer")
                .unwrap_err()
                .code,
            "transfer_expired"
        );
    }

    #[test]
    fn startup_rolls_back_interrupted_receiver_swap() {
        let directory = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            environment_id: Uuid::new_v4(),
            data_dir: directory.path().into(),
            key: Zeroizing::new([7; 32]),
            token: Zeroizing::new("a".repeat(64)),
            listen: "127.0.0.1:0".into(),
        };
        let receiver_id = Uuid::new_v4();
        let receivers = directory.path().join("receivers");
        let live = receivers.join(receiver_id.to_string());
        let rollback = receivers.join(format!(".rollback-{receiver_id}"));
        let staging = receivers.join(format!(".restore-{receiver_id}"));
        let wallet = receivers.join("wallet-execution/executions.cbor");
        let staged_wallet =
            receivers.join(format!(".restore-wallet-{receiver_id}/executions.cbor"));
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&rollback).unwrap();
        std::fs::create_dir_all(staged_wallet.parent().unwrap()).unwrap();
        std::fs::create_dir_all(wallet.parent().unwrap()).unwrap();
        std::fs::write(live.join("state"), b"new").unwrap();
        std::fs::write(rollback.join("state"), b"old").unwrap();
        std::fs::write(&wallet, b"old-wallet").unwrap();
        std::fs::write(&staged_wallet, b"new-wallet").unwrap();
        let journal = RestoreJournal {
            receiver_id,
            phase: "receiver_swapped".into(),
            live_receiver: live.clone(),
            staging_receiver: staging,
            rollback_receiver: rollback,
            live_wallet: wallet.clone(),
            staging_wallet: staged_wallet,
            rollback_wallet: wallet.with_extension(format!("rollback-{receiver_id}")),
            live_receiver_existed: true,
            live_wallet_existed: true,
        };
        save_journal(&directory.path().join("restore-transaction.cbor"), &journal).unwrap();

        recover_restore_transaction(&config).unwrap();

        assert_eq!(std::fs::read(live.join("state")).unwrap(), b"old");
        assert_eq!(std::fs::read(wallet).unwrap(), b"old-wallet");
        assert!(!directory.path().join("restore-transaction.cbor").exists());
    }

    #[test]
    fn startup_removes_new_receiver_when_pre_restore_receiver_was_absent() {
        let directory = tempfile::tempdir().unwrap();
        let config = crate::config::Config {
            environment_id: Uuid::new_v4(),
            data_dir: directory.path().into(),
            key: Zeroizing::new([7; 32]),
            token: Zeroizing::new("a".repeat(64)),
            listen: "127.0.0.1:0".into(),
        };
        let receiver_id = Uuid::new_v4();
        let receivers = directory.path().join("receivers");
        let live = receivers.join(receiver_id.to_string());
        let staging = receivers.join(format!(".restore-{receiver_id}"));
        let rollback = receivers.join(format!(".rollback-{receiver_id}"));
        let wallet = receivers.join("wallet-execution/executions.cbor");
        let staged_wallet =
            receivers.join(format!(".restore-wallet-{receiver_id}/executions.cbor"));
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(staged_wallet.parent().unwrap()).unwrap();
        std::fs::create_dir_all(wallet.parent().unwrap()).unwrap();
        std::fs::write(live.join("state"), b"new").unwrap();
        std::fs::write(&wallet, b"old-wallet").unwrap();
        std::fs::write(&staged_wallet, b"new-wallet").unwrap();
        let journal = RestoreJournal {
            receiver_id,
            phase: "prepared".into(),
            live_receiver: live.clone(),
            staging_receiver: staging,
            rollback_receiver: rollback,
            live_wallet: wallet.clone(),
            staging_wallet: staged_wallet,
            rollback_wallet: wallet.with_extension(format!("rollback-{receiver_id}")),
            live_receiver_existed: false,
            live_wallet_existed: true,
        };
        save_journal(&directory.path().join("restore-transaction.cbor"), &journal).unwrap();
        recover_restore_transaction(&config).unwrap();
        assert!(!live.exists());
        assert_eq!(std::fs::read(wallet).unwrap(), b"old-wallet");
        assert!(!directory.path().join("restore-transaction.cbor").exists());
    }

    #[test]
    fn startup_recovers_absent_receiver_and_wallet_at_each_rename_boundary() {
        for (phase, receiver_swapped, wallet_swapped, committed) in [
            ("prepared", false, false, false),
            ("prepared", true, false, false),
            ("receiver_swapped", true, false, false),
            ("receiver_swapped", true, true, false),
            ("wallet_swapped", true, true, true),
            ("committed", true, true, true),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let config = crate::config::Config {
                environment_id: Uuid::new_v4(),
                data_dir: directory.path().into(),
                key: Zeroizing::new([7; 32]),
                token: Zeroizing::new("a".repeat(64)),
                listen: "127.0.0.1:0".into(),
            };
            let receiver_id = Uuid::new_v4();
            let receivers = directory.path().join("receivers");
            let live = receivers.join(receiver_id.to_string());
            let staging = receivers.join(format!(".restore-{receiver_id}"));
            let rollback = receivers.join(format!(".rollback-{receiver_id}"));
            let wallet = receivers.join("wallet-execution/executions.cbor");
            let staged_wallet =
                receivers.join(format!(".restore-wallet-{receiver_id}/executions.cbor"));
            let rollback_wallet = wallet.with_extension(format!("rollback-{receiver_id}"));
            let receiver_location = if receiver_swapped { &live } else { &staging };
            std::fs::create_dir_all(receiver_location).unwrap();
            std::fs::write(receiver_location.join("state"), b"new").unwrap();
            let wallet_location = if wallet_swapped {
                &wallet
            } else {
                &staged_wallet
            };
            std::fs::create_dir_all(wallet_location.parent().unwrap()).unwrap();
            std::fs::write(wallet_location, b"new-wallet").unwrap();
            let journal = RestoreJournal {
                receiver_id,
                phase: phase.into(),
                live_receiver: live.clone(),
                staging_receiver: staging,
                rollback_receiver: rollback,
                live_wallet: wallet.clone(),
                staging_wallet: staged_wallet,
                rollback_wallet,
                live_receiver_existed: false,
                live_wallet_existed: false,
            };
            save_journal(&directory.path().join("restore-transaction.cbor"), &journal).unwrap();
            recover_restore_transaction(&config).unwrap();
            assert_eq!(live.exists(), committed, "receiver phase {phase}");
            assert_eq!(wallet.exists(), committed, "wallet phase {phase}");
        }
    }
}
