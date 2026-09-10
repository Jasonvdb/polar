//! One independently restartable SDK runtime per receiver process.
use crate::{
    config::Config,
    storage::{ReceiverStorage, Vault},
};
use async_trait::async_trait;
use paykit_sdk::{
    PaykitReceiverCapabilities, PaykitReceiverPath, PaykitSdk, PaykitSdkConfig, PaymentAdapter,
    PubkyLocalSecretKey, PubkySessionAccess, PubkySessionBootstrap, PubkySessionProvider,
    ReceiverNoiseSecretKey,
};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub const CLIENT_ID: &str = "polar-paykit.local";
#[derive(Clone, Serialize, Deserialize)]
pub struct ReceiverSecrets {
    pub owner: [u8; 32],
    pub noise: [u8; 32],
    pub path: String,
    pub session: Option<String>,
}
pub fn vault(config: &Config, id: Uuid) -> anyhow::Result<Vault> {
    Vault::new(
        config.data_dir.join("receivers").join(id.to_string()),
        *config.key,
        format!("{}:{id}", config.environment_id),
    )
}

pub async fn run(config: Config, id: Uuid) -> anyhow::Result<()> {
    let credentials = Arc::new(vault(&config, id)?);
    let storage = ReceiverStorage::open(vault(&config, id)?)?;
    let mut secrets: ReceiverSecrets = credentials
        .load("session.cbor")?
        .ok_or_else(|| anyhow::anyhow!("receiver not provisioned"))?;
    let sdk_config = PaykitSdkConfig::new(PaykitReceiverPath::new(secrets.path.clone())?);
    let receiver_path = sdk_config.receiver_path.clone();
    let noise_public_key = ReceiverNoiseSecretKey::new(secrets.noise).public_key();
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky::Pubky::testnet()?, CLIENT_ID)?
        .with_auth_relay("http://127.0.0.1:15412/inbox")?;
    let owner = PubkyLocalSecretKey::new(secrets.owner);
    let noise = ReceiverNoiseSecretKey::new(secrets.noise);
    let session = match &secrets.session {
        Some(secret) => {
            bootstrap
                .import_session(
                    secret,
                    Some(owner.clone()),
                    noise,
                    &sdk_config.required_session_capabilities(),
                )
                .await?
        }
        None => {
            bootstrap
                .sign_in(&owner, noise, &sdk_config.required_session_capabilities())
                .await?
        }
    };
    anyhow::ensure!(
        session.public_key == owner.public_key(),
        "receiver identity mismatch"
    );
    secrets.session = Some(session.export_session_secret().await?.into_inner());
    credentials.save("session.cbor", &secrets)?;
    let provider = SessionProvider {
        access: Mutex::new(Some(session.access)),
        secrets: Mutex::new(secrets),
        vault: credentials,
    };
    let sdk = PaykitSdk::new(storage, provider, UnsupportedPayments, sdk_config)?;
    anyhow::ensure!(
        sdk.initialize().await?.identity.live_session_available,
        "receiver has no session"
    );
    sdk.publish_paykit_receiver_marker(PaykitReceiverCapabilities {
        private_payments: false,
        payment_requests: false,
        receipts: false,
        outgoing_payments: false,
    })
    .await?;
    let marker = sdk
        .paykit_receiver_marker(owner.public_key(), receiver_path)
        .await?
        .ok_or_else(|| anyhow::anyhow!("public receiver marker missing"))?;
    anyhow::ensure!(
        marker.noise_public_key == noise_public_key,
        "public receiver marker mismatch"
    );
    println!("{}", serde_json::json!({"ready":true,"receiverId":id}));
    std::io::stdout().flush()?;
    shutdown().await?;
    Ok(())
}
pub async fn shutdown() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result=tokio::signal::ctrl_c()=>{result?;},_=term.recv()=>{} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
struct SessionProvider {
    access: Mutex<Option<PubkySessionAccess>>,
    secrets: Mutex<ReceiverSecrets>,
    vault: Arc<Vault>,
}
#[async_trait]
impl PubkySessionProvider for SessionProvider {
    async fn load_session_access(&self) -> paykit_sdk::Result<Option<PubkySessionAccess>> {
        Ok(self.access.lock().map_err(|_| session_error())?.clone())
    }
    async fn load_public_storage(&self) -> paykit_sdk::Result<Option<pubky::PublicStorage>> {
        Ok(Some(
            pubky::Pubky::testnet()
                .map_err(|_| session_error())?
                .public_storage(),
        ))
    }
    async fn revoke_session_access(&self, access: &PubkySessionAccess) -> paykit_sdk::Result<()> {
        let secret = self
            .secrets
            .lock()
            .map_err(|_| session_error())?
            .session
            .clone()
            .ok_or_else(session_error)?;
        PubkySessionBootstrap::with_pubky(access.outbox_client.clone(), CLIENT_ID)?
            .revoke_grant(&secret, access)
            .await
    }
    async fn clear_session_access(&self) -> paykit_sdk::Result<()> {
        let mut secrets = self.secrets.lock().map_err(|_| session_error())?;
        let mut updated = secrets.clone();
        updated.session = None;
        self.vault
            .save("session.cbor", &updated)
            .map_err(|_| session_error())?;
        *secrets = updated;
        *self.access.lock().map_err(|_| session_error())? = None;
        Ok(())
    }
}
fn session_error() -> paykit_sdk::PaykitSdkError {
    paykit_sdk::PaykitSdkError::Identity {
        context: "receiver session unavailable".into(),
        source: None,
    }
}
struct UnsupportedPayments;
#[async_trait]
impl PaymentAdapter for UnsupportedPayments {}

/// Fetch an actual public Pubky marker without opening local application state.
pub async fn inspect_marker(owner: &str, path: &str) -> anyhow::Result<serde_json::Value> {
    let owner = paykit_sdk::PubkyPublicKey::new(owner)?;
    let path = PaykitReceiverPath::new(path)?;
    let client = pubky::Pubky::testnet()?;
    let marker = paykit_lib::get_paykit_receiver_marker(
        &client.public_storage(),
        &owner.to_public_key()?,
        &path,
    )
    .await?
    .ok_or_else(|| anyhow::anyhow!("marker missing"))?;
    Ok(serde_json::from_str(
        &paykit_lib::serialize_paykit_receiver_marker(&marker)?,
    )?)
}

/// Verify persisted grants reject mismatched clients, owners and receiver scopes.
/// The receiver must be stopped; the exclusive runtime lock prevents races.
pub async fn diagnose_session(config: Config, id: Uuid) -> anyhow::Result<serde_json::Value> {
    let credentials = vault(&config, id)?;
    let _lock = credentials.lock("receiver.lock")?;
    let secrets: ReceiverSecrets = credentials
        .load("session.cbor")?
        .ok_or_else(|| anyhow::anyhow!("receiver missing"))?;
    let secret = secrets
        .session
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("session missing"))?;
    let owner = PubkyLocalSecretKey::new(secrets.owner);
    let noise = ReceiverNoiseSecretKey::new(secrets.noise);
    let capabilities = PaykitSdkConfig::new(PaykitReceiverPath::new(secrets.path)?)
        .required_session_capabilities();
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky::Pubky::testnet()?, CLIENT_ID)?;
    let valid = bootstrap
        .import_session(secret, Some(owner.clone()), noise.clone(), &capabilities)
        .await?;
    anyhow::ensure!(valid.public_key == owner.public_key(), "owner mismatch");
    let wrong_client =
        PubkySessionBootstrap::with_pubky(pubky::Pubky::testnet()?, "other.polar-paykit.local")?;
    anyhow::ensure!(
        wrong_client
            .import_session(secret, Some(owner.clone()), noise.clone(), &capabilities)
            .await
            .is_err(),
        "wrong client accepted"
    );
    anyhow::ensure!(
        bootstrap
            .import_session(
                secret,
                Some(PubkyLocalSecretKey::new(pubky::Keypair::random().secret())),
                noise.clone(),
                &capabilities
            )
            .await
            .is_err(),
        "wrong owner accepted"
    );
    let other = PaykitSdkConfig::new(PaykitReceiverPath::new(format!(
        "other-{}/wallet",
        Uuid::new_v4().simple()
    ))?)
    .required_session_capabilities();
    anyhow::ensure!(
        bootstrap
            .import_session(secret, Some(owner), noise, &other)
            .await
            .is_err(),
        "wrong receiver accepted"
    );
    Ok(
        serde_json::json!({"receiverId":id,"validGrant":true,"wrongClientRejected":true,"wrongOwnerRejected":true,"wrongReceiverRejected":true}),
    )
}
