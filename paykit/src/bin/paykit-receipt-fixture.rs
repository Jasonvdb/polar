//! Non-shipping, testnet-only receipt corruption fixture. Never opens an SDK writer.
use anyhow::{ensure, Context};
use bitcoin::hashes::{sha256, Hash};
use paykit_lib::{Receipt, ReceiptAccess, ReceiptDecryptionKey, ReceiptId};
use paykit_sdk::{
    storage::StorageState, PaykitReceiverPath, PaykitSdkConfig, PubkyLocalSecretKey,
    PubkySessionBootstrap, ReceiverNoiseSecretKey,
};
use polar_paykit::{
    receiver::ReceiverSecrets,
    storage::{atomic_write, Vault},
};
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Action {
    Inspect,
    Delete,
    Corrupt,
    WrongKey,
    Recover,
}
impl Action {
    fn parse(value: &str) -> anyhow::Result<Self> {
        Ok(match value {
            "inspect" => Self::Inspect,
            "delete" => Self::Delete,
            "corrupt" => Self::Corrupt,
            "wrong-key" => Self::WrongKey,
            "recover" => Self::Recover,
            _ => anyhow::bail!("invalid action"),
        })
    }
}
struct Target {
    environment: Uuid,
    receiver: Uuid,
    receipt: String,
    run: Uuid,
    path: PaykitReceiverPath,
    location: String,
    original: String,
    access_json: Zeroizing<String>,
    access_event: String,
    owner: PubkyLocalSecretKey,
    noise: ReceiverNoiseSecretKey,
    session: Zeroizing<String>,
    journal: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    run: Uuid,
    environment: Uuid,
    receiver: Uuid,
    receipt: String,
    action: Action,
    original: String,
    changed_digest: Option<String>,
    restored: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    version: u8,
    action: Action,
    run_id: Uuid,
    environment_id: Uuid,
    receiver_id: Uuid,
    receipt_id: String,
    access_event_id: String,
    exists: bool,
    bytes: usize,
    digest: Option<String>,
    original_digest: String,
    matches_prepared: bool,
    restored: bool,
}

#[tokio::main]
async fn main() {
    match tokio::time::timeout(Duration::from_secs(50), run()).await {
        Ok(Ok(evidence)) => match serde_json::to_string(&evidence) {
            Ok(json) => println!("{json}"),
            Err(_) => fail(),
        },
        _ => fail(),
    }
}
fn fail() {
    eprintln!("Receipt fixture failed; inspect the owned restore journal before retrying.");
    std::process::exit(1);
}
async fn run() -> anyhow::Result<Evidence> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    ensure!(args.len() == 3, "action, receiver and receipt required");
    let action = Action::parse(&args[0])?;
    let target = load_target(&args[1], &args[2])?;
    let client = pubky::Pubky::with_client(
        pubky::PubkyHttpClient::builder()
            .testnet()
            .request_timeout(Duration::from_secs(10))
            .build()?,
    );
    let before = fetch(&client, &target).await?;
    if action == Action::Inspect {
        return Ok(evidence(&target, action, before.as_deref(), false));
    }
    let bootstrap =
        PubkySessionBootstrap::with_pubky(client.clone(), polar_paykit::receiver::CLIENT_ID)?;
    let imported = bootstrap
        .import_session(
            &target.session,
            Some(target.owner.clone()),
            target.noise.clone(),
            &PaykitSdkConfig::new(target.path.clone()).required_session_capabilities(),
        )
        .await?;
    ensure!(
        imported.public_key == target.owner.public_key(),
        "identity mismatch"
    );
    let session = imported.access.session;
    if action == Action::Recover {
        let mut journal = load_journal(&target)?;
        ensure!(
            recovery_matches(&journal, before.as_deref()),
            "unexpected remote content"
        );
        if before.as_deref() != Some(journal.original.as_bytes()) {
            session
                .storage()
                .put(target.location.clone(), journal.original.clone())
                .await?;
        }
        let after = fetch(&client, &target).await?;
        ensure!(
            after.as_deref() == Some(target.original.as_bytes()),
            "restore verification failed"
        );
        journal.restored = true;
        atomic_write(&target.journal, &serde_json::to_vec(&journal)?)?;
        return Ok(evidence(&target, action, after.as_deref(), true));
    }
    ensure!(
        before.as_deref() == Some(target.original.as_bytes()),
        "remote content differs from preparation"
    );
    ensure!(
        !target.journal.try_exists()?,
        "restore existing journal first"
    );
    let changed = replacement(&target, action)?;
    let journal = Journal {
        version: 1,
        run: target.run,
        environment: target.environment,
        receiver: target.receiver,
        receipt: target.receipt.clone(),
        action,
        original: target.original.clone(),
        changed_digest: changed.as_deref().map(digest),
        restored: false,
    };
    create_journal(&target.journal, &journal)?;
    match &changed {
        Some(bytes) => {
            session
                .storage()
                .put(target.location.clone(), bytes.clone())
                .await?;
        }
        None => {
            session.storage().delete(target.location.clone()).await?;
        }
    }
    let after = fetch(&client, &target).await?;
    ensure!(after == changed, "fault verification failed");
    Ok(evidence(&target, action, after.as_deref(), false))
}
fn canonical_uuid(value: &str) -> anyhow::Result<Uuid> {
    let id: Uuid = value.parse()?;
    ensure!(
        !id.is_nil() && id.to_string() == value,
        "invalid canonical UUID"
    );
    Ok(id)
}
fn canonical_existing(path: &Path) -> anyhow::Result<()> {
    ensure!(
        path.is_absolute() && fs::canonicalize(path)? == path,
        "noncanonical path"
    );
    Ok(())
}
fn private_file(path: &Path) -> anyhow::Result<()> {
    canonical_existing(path)?;
    let metadata = fs::metadata(path)?;
    ensure!(metadata.is_file(), "not a file");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "nonprivate file"
        );
    }
    Ok(())
}
fn load_target(receiver: &str, receipt: &str) -> anyhow::Result<Target> {
    let receiver = canonical_uuid(receiver)?;
    let receipt_id = ReceiptId::new(receipt)?;
    let environment = canonical_uuid(&env::var("PAYKIT_ENVIRONMENT_ID")?)?;
    let run = canonical_uuid(&env::var("PAYKIT_FIXTURE_RUN_ID")?)?;
    let data = PathBuf::from(env::var("PAYKIT_DATA_DIR")?);
    let root = data.join("receivers").join(receiver.to_string());
    canonical_existing(&root)?;
    for name in ["session.cbor", "sdk.cbor"] {
        private_file(&root.join(name))?;
    }
    let key_path = PathBuf::from(env::var("PAYKIT_KEY_FILE")?);
    private_file(&key_path)?;
    let key = Zeroizing::new(fs::read_to_string(key_path)?);
    let key: [u8; 32] = hex::decode(key.trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid key"))?;
    let vault = Vault::new(root, key, format!("{environment}:{receiver}"))?;
    let secrets: ReceiverSecrets = vault.load("session.cbor")?.context("missing session")?;
    let state: StorageState = vault.load("sdk.cbor")?.context("missing SDK state")?;
    let path = PaykitReceiverPath::new(secrets.path)?;
    let records = state
        .receipt_issuance_records
        .iter()
        .filter(|(_, record)| record.receipt_id == receipt)
        .collect::<Vec<_>>();
    ensure!(
        records.len() == 1,
        "receipt not uniquely issued by this receiver"
    );
    let (key, record) = records[0];
    ensure!(
        key == &(
            record.counterparty.clone(),
            record.counterparty_receiver_path.clone(),
            receipt.to_owned()
        ),
        "record mismatch"
    );
    ensure!(
        record.location == ReceiptAccess::location(&path, &receipt_id),
        "noncanonical receipt location"
    );
    let access = paykit_lib::parse_receipt_access_json(&record.access_json)?;
    ensure!(
        access.receipt_id == receipt_id
            && access.location == record.location
            && access.event_id.as_str() == record.receipt_access_event_id,
        "access mismatch"
    );
    let clear = Receipt::decrypt(&record.encrypted_receipt, &access.key, &record.location)?;
    ensure!(
        clear.recipient_public_key == record.counterparty.to_public_key()?,
        "recipient mismatch"
    );
    let journal_root = PathBuf::from(env::var("PAYKIT_FIXTURE_JOURNAL_DIR")?);
    canonical_existing(&journal_root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            fs::metadata(&journal_root)?.permissions().mode() & 0o077 == 0,
            "nonprivate journal directory"
        );
    }
    Ok(Target {
        environment,
        receiver,
        receipt: receipt.to_owned(),
        run,
        path,
        location: record.location.clone(),
        original: record.encrypted_receipt.clone(),
        access_json: Zeroizing::new(record.access_json.clone()),
        access_event: record.receipt_access_event_id.clone(),
        owner: PubkyLocalSecretKey::new(secrets.owner),
        noise: ReceiverNoiseSecretKey::new(secrets.noise),
        session: Zeroizing::new(secrets.session.context("missing imported session")?),
        journal: journal_root.join(format!("{receiver}-{receipt}.json")),
    })
}
fn digest(bytes: &[u8]) -> String {
    sha256::Hash::hash(bytes).to_string()
}
async fn fetch(client: &pubky::Pubky, target: &Target) -> anyhow::Result<Option<Vec<u8>>> {
    match client
        .public_storage()
        .get((
            target.owner.public_key().to_public_key()?,
            target.location.clone(),
        ))
        .await
    {
        Ok(response) => {
            ensure!(
                response.content_length().is_none_or(|n| n <= 1024 * 1024),
                "oversized object"
            );
            let bytes = response.bytes().await?;
            ensure!(bytes.len() <= 1024 * 1024, "oversized object");
            Ok(Some(bytes.to_vec()))
        }
        Err(error) if matches!(&error, pubky::Error::Request(pubky::errors::RequestError::Server { status, .. }) if matches!(status.as_u16(), 404 | 410)) => {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}
fn replacement(target: &Target, action: Action) -> anyhow::Result<Option<Vec<u8>>> {
    match action {
        Action::Delete => Ok(None),
        Action::Corrupt => Ok(Some(b"{broken-encrypted-receipt".to_vec())),
        Action::WrongKey => {
            let access = paykit_lib::parse_receipt_access_json(&target.access_json)?;
            let receipt = Receipt::decrypt(&target.original, &access.key, &target.location)?;
            let wrong_key = ReceiptDecryptionKey::generate();
            let encrypted = receipt.encrypt(&target.path, &wrong_key)?;
            ensure!(
                Receipt::decrypt(&encrypted, &access.key, &target.location).is_err(),
                "wrong key accepted"
            );
            Ok(Some(encrypted.into_bytes()))
        }
        _ => anyhow::bail!("invalid mutation"),
    }
}
fn create_journal(path: &Path, journal: &Journal) -> anyhow::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&serde_json::to_vec(journal)?)?;
    file.sync_all()?;
    fs::File::open(path.parent().context("journal parent missing")?)?.sync_all()?;
    Ok(())
}
fn load_journal(target: &Target) -> anyhow::Result<Journal> {
    private_file(&target.journal)?;
    let journal: Journal = serde_json::from_slice(&fs::read(&target.journal)?)?;
    ensure!(
        journal.version == 1
            && journal.run == target.run
            && journal.environment == target.environment
            && journal.receiver == target.receiver
            && journal.receipt == target.receipt
            && journal.original == target.original
            && matches!(
                journal.action,
                Action::Delete | Action::Corrupt | Action::WrongKey
            ),
        "journal mismatch"
    );
    Ok(journal)
}
fn recovery_matches(journal: &Journal, current: Option<&[u8]>) -> bool {
    current == Some(journal.original.as_bytes())
        || (!journal.restored && current.map(digest) == journal.changed_digest)
}
fn evidence(target: &Target, action: Action, bytes: Option<&[u8]>, restored: bool) -> Evidence {
    Evidence {
        version: 1,
        action,
        run_id: target.run,
        environment_id: target.environment,
        receiver_id: target.receiver,
        receipt_id: target.receipt.clone(),
        access_event_id: target.access_event.clone(),
        exists: bytes.is_some(),
        bytes: bytes.map_or(0, <[u8]>::len),
        digest: bytes.map(digest),
        original_digest: digest(target.original.as_bytes()),
        matches_prepared: bytes == Some(target.original.as_bytes()),
        restored,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_rejects_unrelated_remote_content() {
        let journal = Journal {
            version: 1,
            run: Uuid::new_v4(),
            environment: Uuid::new_v4(),
            receiver: Uuid::new_v4(),
            receipt: Uuid::new_v4().to_string(),
            action: Action::Corrupt,
            original: "original".into(),
            changed_digest: Some(digest(b"corrupt")),
            restored: false,
        };
        assert!(recovery_matches(&journal, Some(b"corrupt")));
        assert!(recovery_matches(&journal, Some(b"original")));
        assert!(!recovery_matches(&journal, Some(b"unrelated")));
        assert!(!recovery_matches(&journal, None));
        assert!(!recovery_matches(
            &Journal {
                restored: true,
                ..journal
            },
            Some(b"corrupt")
        ));
    }
    #[test]
    fn journal_is_exclusive_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("journal.json");
        let journal = Journal {
            version: 1,
            run: Uuid::new_v4(),
            environment: Uuid::new_v4(),
            receiver: Uuid::new_v4(),
            receipt: Uuid::new_v4().to_string(),
            action: Action::Delete,
            original: "ciphertext".into(),
            changed_digest: None,
            restored: false,
        };
        create_journal(&path, &journal).unwrap();
        assert!(create_journal(&path, &journal).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(recovery_matches(&journal, None));
        assert!(!recovery_matches(&journal, Some(b"different")));
    }
    #[test]
    fn identifiers_and_actions_cannot_select_arbitrary_paths() {
        for value in [
            "../receipt",
            "inspect/../../",
            "",
            "put",
            "https://example.com",
        ] {
            assert!(Action::parse(value).is_err());
        }
        for value in [
            "../receiver",
            "00000000-0000-0000-0000-000000000000",
            "A4DB37B6-A956-42CF-8DD4-C01448A6A563",
        ] {
            assert!(canonical_uuid(value).is_err());
        }
    }
}
