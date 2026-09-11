//! One independently restartable SDK runtime per receiver process.
use crate::{
    config::Config,
    storage::{ReceiverStorage, Vault},
};
use async_trait::async_trait;
use paykit_sdk::{
    PaykitReceiverCapabilities, PaykitReceiverPath, PaykitSdk, PaykitSdkConfig,
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
/// Bound individual HTTP requests inside SDK operations so their cleanup can finish.
pub(crate) fn pubky_client() -> pubky::Result<pubky::Pubky> {
    Ok(pubky::Pubky::with_client(pubky_transport()?))
}
fn pubky_transport() -> pubky::Result<pubky::PubkyHttpClient> {
    Ok(pubky::PubkyHttpClient::builder()
        .testnet()
        .request_timeout(std::time::Duration::from_secs(15))
        .build()?)
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReceiverSecrets {
    pub owner: [u8; 32],
    pub noise: [u8; 32],
    pub path: String,
    pub session: Option<String>,
}
pub(crate) fn noise_public_key(secret: [u8; 32]) -> String {
    ReceiverNoiseSecretKey::new(secret).public_key().z32()
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
    let storage = Arc::new(ReceiverStorage::open(vault(&config, id)?)?);
    let mut secrets: ReceiverSecrets = credentials
        .load("session.cbor")?
        .ok_or_else(|| anyhow::anyhow!("receiver not provisioned"))?;
    let mut sdk_config = PaykitSdkConfig::new(PaykitReceiverPath::new(secrets.path.clone())?);
    sdk_config.public_contact_sharing =
        paykit_sdk::PublicContactSharingPolicy::ConfiguredPublicNamespace;
    let receiver_path = sdk_config.receiver_path.clone();
    let noise_public_key = ReceiverNoiseSecretKey::new(secrets.noise).public_key();
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky_client()?, CLIENT_ID)?
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
        access: Arc::new(Mutex::new(Some(session.access))),
        secrets: Arc::new(Mutex::new(secrets)),
        vault: credentials.clone(),
    };
    let payments = crate::wallet_adapter::WalletAdapter::open(
        credentials.clone(),
        config.environment_id,
        owner.public_key().to_string(),
    )?;
    let clock = storage.sdk_clock(payments.clock())?;
    let sdk = PaykitSdk::try_with_clock(
        storage.clone(),
        provider.clone(),
        payments.clone(),
        sdk_config,
        clock.clone(),
    )?;
    anyhow::ensure!(
        sdk.initialize().await?.identity.live_session_available,
        "receiver has no session"
    );
    sdk.publish_paykit_receiver_marker(PaykitReceiverCapabilities {
        private_payments: true,
        payment_requests: true,
        receipts: true,
        outgoing_payments: true,
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
    let mut runtime = crate::workspace::Runtime::new(
        sdk,
        storage,
        credentials,
        id,
        owner.public_key(),
        provider,
        payments,
    )?;
    runtime.refresh().await?;
    println!("{}", serde_json::json!({"ready":true,"receiverId":id}));
    std::io::stdout().flush()?;
    crate::receiver_ipc::run(runtime).await
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

pub(crate) async fn restore_sdk_state(
    config: &Config,
    storage: Arc<ReceiverStorage>,
    credentials: Arc<Vault>,
    secrets: ReceiverSecrets,
    backup: paykit_sdk::SdkBackupState,
) -> anyhow::Result<paykit_sdk::RestoreReport> {
    let mut sdk_config = PaykitSdkConfig::new(PaykitReceiverPath::new(secrets.path.clone())?);
    sdk_config.public_contact_sharing =
        paykit_sdk::PublicContactSharingPolicy::ConfiguredPublicNamespace;
    let exported_session = secrets
        .session
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("backup session missing"))?;
    let owner = PubkyLocalSecretKey::new(secrets.owner);
    let noise = ReceiverNoiseSecretKey::new(secrets.noise);
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky_client()?, CLIENT_ID)?
        .with_auth_relay("http://127.0.0.1:15412/inbox")?;
    let session = bootstrap
        .import_session(
            exported_session,
            Some(owner.clone()),
            noise,
            &sdk_config.required_session_capabilities(),
        )
        .await?;
    anyhow::ensure!(
        session.public_key == owner.public_key(),
        "backup identity mismatch"
    );
    let provider = SessionProvider {
        access: Arc::new(Mutex::new(Some(session.access))),
        secrets: Arc::new(Mutex::new(secrets)),
        vault: credentials.clone(),
    };
    let payments = crate::wallet_adapter::WalletAdapter::open(
        credentials.clone(),
        config.environment_id,
        owner.public_key().to_string(),
    )?;
    let clock = storage.sdk_clock(payments.clock())?;
    let sdk = PaykitSdk::try_with_clock(storage, provider, payments, sdk_config, clock)?;
    Ok(sdk.restore_backup_state(backup).await?)
}

pub(crate) async fn validate_backup_session(secrets: &ReceiverSecrets) -> anyhow::Result<()> {
    let config = PaykitSdkConfig::new(PaykitReceiverPath::new(secrets.path.clone())?);
    let secret = secrets
        .session
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("backup session missing"))?;
    let owner = PubkyLocalSecretKey::new(secrets.owner);
    let noise = ReceiverNoiseSecretKey::new(secrets.noise);
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky_client()?, CLIENT_ID)?
        .with_auth_relay("http://127.0.0.1:15412/inbox")?;
    let session = bootstrap
        .import_session(
            secret,
            Some(owner.clone()),
            noise,
            &config.required_session_capabilities(),
        )
        .await?;
    anyhow::ensure!(
        session.public_key == owner.public_key(),
        "backup identity mismatch"
    );
    Ok(())
}

pub(crate) async fn backup_marker_matches(
    owner: &str,
    path: &str,
    expected_noise: &str,
) -> anyhow::Result<bool> {
    let value = inspect_marker(owner, path).await?;
    Ok(value
        .get("noise_public_key")
        .or_else(|| value.get("noisePublicKey"))
        .and_then(serde_json::Value::as_str)
        == Some(expected_noise))
}
#[derive(Clone)]
pub(crate) struct SessionProvider {
    access: Arc<Mutex<Option<PubkySessionAccess>>>,
    secrets: Arc<Mutex<ReceiverSecrets>>,
    vault: Arc<Vault>,
}
#[async_trait]
impl PubkySessionProvider for SessionProvider {
    async fn load_session_access(&self) -> paykit_sdk::Result<Option<PubkySessionAccess>> {
        Ok(self.access.lock().map_err(|_| session_error())?.clone())
    }
    async fn load_public_storage(&self) -> paykit_sdk::Result<Option<pubky::PublicStorage>> {
        Ok(Some(
            pubky_client()
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

/// Fetch an actual public Pubky marker without opening local application state.
pub async fn inspect_marker(owner: &str, path: &str) -> anyhow::Result<serde_json::Value> {
    let owner = paykit_sdk::PubkyPublicKey::new(owner)?;
    let path = PaykitReceiverPath::new(path)?;
    let client = pubky_client()?;
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
    let bootstrap = PubkySessionBootstrap::with_pubky(pubky_client()?, CLIENT_ID)?;
    let valid = bootstrap
        .import_session(secret, Some(owner.clone()), noise.clone(), &capabilities)
        .await?;
    anyhow::ensure!(valid.public_key == owner.public_key(), "owner mismatch");
    let wrong_client =
        PubkySessionBootstrap::with_pubky(pubky_client()?, "other.polar-paykit.local")?;
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

/// Read-only evidence from a stopped receiver's actual decrypted SDK list store.
/// The exclusive runtime lock prevents a competing writer; payloads are never printed.
pub async fn inspect_private_list(
    config: Config,
    id: Uuid,
    owner: &str,
    path: &str,
) -> anyhow::Result<serde_json::Value> {
    use paykit_sdk::storage::StorageAdapter;
    let storage = ReceiverStorage::open(vault(&config, id)?)?;
    let owner = paykit_sdk::PubkyPublicKey::new(owner)?;
    let path = PaykitReceiverPath::new(path)?;
    storage.transaction(|tx| {
        let mut items=tx.private_stream_items(&owner,&path);
        items.sort_by_key(|i|i.stream_item_id);
        let valid=items.into_iter().filter_map(|item|paykit_lib::parse_private_payment_list_json(&item.raw_json).ok().map(|list|(item.stream_item_id,list))).collect::<Vec<_>>();
        Ok(serde_json::json!({"receiverId":id,"validListCount":valid.len(),"latestStreamItemId":valid.last().map(|(id,_)|id.to_string()),"endpointCount":valid.last().map(|(_,list)|list.payment_endpoints.len()),"paymentEndpoints":valid.last().map(|(_,list)|list.payment_endpoints.iter().map(|(id,payload)|serde_json::json!({"method":id.as_str(),"endpoint":payload.as_str()})).collect::<Vec<_>>())}))
    }).await.map_err(Into::into)
}
/// Independently read the explicit receiver-scoped public contact marker.
pub async fn inspect_contact(
    owner: &str,
    path: &str,
    peer: &str,
    peer_path: &str,
) -> anyhow::Result<serde_json::Value> {
    let owner = paykit_sdk::PubkyPublicKey::new(owner)?;
    let config = PaykitSdkConfig::new(PaykitReceiverPath::new(path)?);
    let peer = paykit_sdk::PubkyPublicKey::new(peer)?;
    let peer_path = PaykitReceiverPath::new(peer_path)?;
    let path = config.public_contact_path(&peer, &peer_path);
    let storage = pubky_client()?.public_storage();
    let resource = format!("pubky://{owner}{path}");
    if !storage.exists(resource.as_str()).await? {
        return Ok(serde_json::json!({"exists":false}));
    }
    let body: serde_json::Value = storage.get(resource.as_str()).await?.json().await?;
    Ok(
        serde_json::json!({"exists":true,"version":body["version"],"kind":body["kind"],"publicKey":body["public_key"],"receiverPath":body["receiver_path"],"hasLocalLabel":body.get("label").is_some()}),
    )
}

#[cfg(test)]
impl SessionProvider {
    pub(crate) fn without_access(vault: Arc<Vault>) -> Self {
        Self {
            access: Arc::new(Mutex::new(None)),
            secrets: Arc::new(Mutex::new(ReceiverSecrets {
                owner: [3; 32],
                noise: [4; 32],
                path: "test/wallet".into(),
                session: None,
            })),
            vault,
        }
    }
}

/// Validate and read one original avatar in an explicit public receiver namespace.
pub async fn inspect_avatar(
    owner: &str,
    path: &str,
    blob_name: &str,
) -> anyhow::Result<serde_json::Value> {
    use base64::Engine;
    let owner = paykit_sdk::PubkyPublicKey::new(owner)?;
    let path = PaykitReceiverPath::new(path)?;
    anyhow::ensure!(
        !blob_name.is_empty()
            && blob_name.len() <= 128
            && blob_name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
            && !blob_name.contains(".."),
        "invalid blob name"
    );
    let uri = format!("pubky://{owner}/pub/paykit/v0/{path}/blobs/{blob_name}");
    let storage = pubky_client()?.public_storage();
    if !storage.exists(uri.as_str()).await? {
        return Ok(serde_json::json!({"exists":false}));
    }
    let bytes = crate::workspace::fetch_avatar(&uri)
        .await?
        .ok_or_else(|| anyhow::anyhow!("avatar missing"))?;
    let mime =
        crate::commands::avatar_mime(&bytes).ok_or_else(|| anyhow::anyhow!("invalid avatar"))?;
    Ok(
        serde_json::json!({"exists":true,"mime":mime,"size":bytes.len(),"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}

/// Read actual public receiving endpoints without opening a receiver SDK snapshot.
pub async fn inspect_payment_endpoints(
    owner: &str,
    path: &str,
) -> anyhow::Result<serde_json::Value> {
    let owner = paykit_sdk::PubkyPublicKey::new(owner)?.to_public_key()?;
    let path = PaykitReceiverPath::new(path)?;
    let storage = pubky_client()?.public_storage();
    let mut endpoints = vec![];
    for method in [crate::payment_model::ONCHAIN, crate::payment_model::BOLT11] {
        if let Some(payload) = paykit_lib::get_payment_endpoint(
            &storage,
            &owner,
            &path,
            &paykit_lib::PaymentEndpointIdentifier::new(method)?,
        )
        .await?
        {
            endpoints.push(serde_json::json!({"method":method,"endpoint":payload.as_str()}));
        }
    }
    Ok(serde_json::json!({"paymentEndpoints":endpoints}))
}

#[cfg(test)]
mod transport_tests {
    #[tokio::test]
    async fn configured_pubky_transport_times_out_an_actual_blocked_http_request() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                axum::Router::new().route(
                    "/inbox/test",
                    axum::routing::post(move || {
                        let observed = observed.clone();
                        async move {
                            observed.fetch_add(1, Ordering::SeqCst);
                            std::future::pending::<String>().await
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let channel = pubky::HttpRelayInboxChannel::new(
            format!("http://{address}/inbox").parse().unwrap(),
            "test".into(),
        )
        .unwrap();
        let client = super::pubky_transport().unwrap();
        let before = std::time::Instant::now();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            channel.produce(&client, b"test"),
        )
        .await;
        server.abort();
        let _ = server.await;
        assert!(outcome.is_ok_and(|result| result.is_err()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(before.elapsed() >= std::time::Duration::from_secs(14));
    }
}
