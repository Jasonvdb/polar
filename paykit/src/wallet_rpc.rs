//! Trusted wallet transport. Credentials and reconciliation identities stay private.
use crate::payment_model::{self, WalletView, BOLT11, ONCHAIN};
use base64::{engine::general_purpose::STANDARD, Engine};
use bitcoin::{
    hashes::{sha256, Hash},
    Address, Network,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, str::FromStr, time::Duration};
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletConfig {
    pub api_version: u8,
    pub environment_id: Uuid,
    pub wallets: Vec<Wallet>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wallet {
    #[serde(default)]
    pub bitcoin_backend_id: Option<String>,
    pub id: String,
    pub label: String,
    pub bitcoin: Core,
    pub lightning: Option<Lightning>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Core {
    pub url: String,
    pub username: String,
    pub password: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lightning {
    pub url: String,
    pub tls_cert_path: PathBuf,
    pub macaroon_path: PathBuf,
    #[serde(default)]
    pub payment_macaroon_path: Option<PathBuf>,
    #[serde(default)]
    pub setup_macaroon_path: Option<PathBuf>,
    #[serde(default)]
    pub peer_address: Option<String>,
}

pub fn configured(environment: Uuid) -> anyhow::Result<Vec<Wallet>> {
    let Some(path) = std::env::var_os("PAYKIT_WALLET_CONFIG_FILE") else {
        return Ok(vec![]);
    };
    let bytes =
        std::fs::read(path).map_err(|_| anyhow::anyhow!("wallet configuration unavailable"))?;
    anyhow::ensure!(bytes.len() <= 128 * 1024, "wallet configuration too large");
    let config: WalletConfig = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid wallet configuration"))?;
    anyhow::ensure!(
        config.api_version == 1
            && config.environment_id == environment
            && config.wallets.len() <= 128,
        "wallet configuration scope mismatch"
    );
    let mut ids = std::collections::HashSet::new();
    for wallet in &config.wallets {
        anyhow::ensure!(
            !wallet.id.is_empty() && wallet.id.len() <= 128 && ids.insert(&wallet.id),
            "invalid wallet identifier"
        );
        url(&wallet.bitcoin.url, "http")?;
        if let Some(lnd) = &wallet.lightning {
            url(&lnd.url, "https")?;
        }
    }
    Ok(config.wallets)
}
fn url(value: &str, scheme: &str) -> anyhow::Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(value).map_err(|_| anyhow::anyhow!("invalid wallet URL"))?;
    anyhow::ensure!(
        parsed.scheme() == scheme
            && parsed.host_str().is_some()
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none()
            && matches!(parsed.path(), "" | "/"),
        "invalid wallet URL"
    );
    Ok(parsed)
}
#[derive(Debug)]
struct InvoiceMissing;
impl std::fmt::Display for InvoiceMissing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("invoice not found")
    }
}
impl std::error::Error for InvoiceMissing {}

impl Wallet {
    pub fn view(&self) -> WalletView {
        WalletView {
            id: self.id.clone(),
            label: self.label.clone(),
            supported_methods: if self.lightning.is_some() {
                vec![ONCHAIN.into(), BOLT11.into()]
            } else {
                vec![ONCHAIN.into()]
            },
            status: "configured".into(),
        }
    }
    pub async fn ensure_core_wallet(&self, owner: &str) -> anyhow::Result<String> {
        let name = format!("paykit-{owner}");
        let loaded = self.core(None, "listwallets", json!([])).await?;
        if !loaded
            .as_array()
            .is_some_and(|items| items.iter().any(|v| v == &name))
        {
            let load = self.core(None, "loadwallet", json!([name])).await;
            if load.is_err() {
                let create = self.core(None, "createwallet", json!([name])).await;
                if create.is_err() {
                    let loaded = self.core(None, "listwallets", json!([])).await?;
                    anyhow::ensure!(
                        loaded
                            .as_array()
                            .is_some_and(|items| items.iter().any(|v| v == &name)),
                        "participant wallet unavailable"
                    );
                }
            }
        }
        Ok(name)
    }
    /// Reconciliation may load the recorded wallet but must never replace missing wallet state.
    pub async fn load_existing_core_wallet(&self, name: &str, owner: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            name == format!("paykit-{owner}"),
            "persisted execution wallet identity mismatch"
        );
        let loaded = self.core(None, "listwallets", json!([])).await?;
        if !loaded
            .as_array()
            .is_some_and(|items| items.iter().any(|v| v == name))
        {
            // A concurrent load may win; getwalletinfo below still verifies the exact wallet.
            let _ = self.core(None, "loadwallet", json!([name])).await;
        }
        let info = self.core(Some(name), "getwalletinfo", json!([])).await?;
        anyhow::ensure!(
            info["walletname"] == name,
            "loaded wallet differs from persisted execution wallet"
        );
        Ok(())
    }
    pub async fn address(&self, owner: &str, label: &str) -> anyhow::Result<String> {
        let name = self.ensure_core_wallet(owner).await?;
        let result = self
            .core(Some(&name), "getnewaddress", json!([label, "bech32"]))
            .await?;
        let address = result
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("wallet returned no address"))?;
        validate_endpoint(ONCHAIN, address, 1)?;
        Ok(address.into())
    }
    pub async fn lookup_address(&self, owner: &str, label: &str) -> anyhow::Result<String> {
        let name = self.ensure_core_wallet(owner).await?;
        let result = self
            .core(Some(&name), "getaddressesbylabel", json!([label]))
            .await?;
        let addresses = result
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("address reconciliation failed"))?;
        anyhow::ensure!(addresses.len() == 1, "address issuance remains uncertain");
        let address = addresses
            .keys()
            .next()
            .ok_or_else(|| anyhow::anyhow!("address not found"))?;
        validate_endpoint(ONCHAIN, address, 1)?;
        Ok(address.clone())
    }
    pub(crate) async fn core(
        &self,
        wallet: Option<&str>,
        method: &str,
        params: Value,
    ) -> anyhow::Result<Value> {
        let mut endpoint = url(&self.bitcoin.url, "http")?;
        if let Some(name) = wallet {
            endpoint
                .path_segments_mut()
                .map_err(|_| anyhow::anyhow!("invalid wallet path"))?
                .extend(["wallet", name]);
        }
        let response = client()?
            .post(endpoint)
            .basic_auth(&self.bitcoin.username, Some(&self.bitcoin.password))
            .json(&json!({"jsonrpc":"2.0","id":"paykit","method":method,"params":params}))
            .send()
            .await
            .map_err(|_| {
                anyhow::anyhow!("Bitcoin RPC unavailable; reconcile before retrying issuance")
            })?;
        let body: Value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("invalid Bitcoin RPC response"))?;
        anyhow::ensure!(
            body.get("error").is_none_or(Value::is_null),
            "Bitcoin RPC rejected request"
        );
        body.get("result")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Bitcoin RPC result missing"))
    }
    pub async fn invoice(
        &self,
        preimage: &[u8; 32],
        amount: u64,
        expiry: u32,
    ) -> anyhow::Result<String> {
        let value=self.lnd("POST","/v1/invoices",Some(json!({"r_preimage":STANDARD.encode(preimage),"value":amount.to_string(),"expiry":expiry.to_string(),"memo":"Polar Paykit reservation"}))).await?;
        invoice_text(&value, amount)
    }
    pub async fn lookup_invoice(&self, preimage: &[u8; 32], amount: u64) -> anyhow::Result<String> {
        let hash = sha256::Hash::hash(preimage);
        let value = self
            .lnd("GET", &format!("/v1/invoice/{hash}"), None)
            .await?;
        anyhow::ensure!(value["state"] == "OPEN", "invoice is no longer open");
        invoice_text(&value, amount)
    }
    pub async fn reconcile_invoice(
        &self,
        preimage: &[u8; 32],
        amount: u64,
        expiry: u32,
    ) -> anyhow::Result<String> {
        match self.lookup_invoice(preimage, amount).await {
            Ok(invoice) => Ok(invoice),
            Err(error) if error.is::<InvoiceMissing>() => {
                self.invoice(preimage, amount, expiry).await
            }
            Err(error) => Err(error),
        }
    }
    pub async fn cancel_invoice(&self, preimage: &[u8; 32]) -> anyhow::Result<()> {
        let hash = sha256::Hash::hash(preimage);
        let current = self.lnd("GET", &format!("/v1/invoice/{hash}"), None).await;
        if invoice_needs_cancellation(current)? {
            self.lnd(
                "POST",
                "/v2/invoices/cancel",
                Some(json!({"payment_hash":STANDARD.encode(hash.to_byte_array())})),
            )
            .await?;
        }
        Ok(())
    }
    pub(crate) async fn lnd(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        self.lnd_with_credential(method, path, body, "invoice")
            .await
    }
    pub(crate) async fn lnd_with_credential(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        credential: &str,
    ) -> anyhow::Result<Value> {
        let lnd = self
            .lightning
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("wallet has no Lightning binding"))?;
        let cert = std::fs::read(&lnd.tls_cert_path)
            .map_err(|_| anyhow::anyhow!("Lightning TLS certificate not ready"))?;
        let credential_path = match credential {
            "payment" => lnd.payment_macaroon_path.as_ref(),
            "setup" => lnd.setup_macaroon_path.as_ref(),
            "invoice" => Some(&lnd.macaroon_path),
            _ => None,
        }
        .ok_or_else(|| anyhow::anyhow!("required restricted Lightning credential unavailable"))?;
        let macaroon = std::fs::read(credential_path)
            .map_err(|_| anyhow::anyhow!("Lightning invoice credential not ready"))?;
        let cert = reqwest::Certificate::from_pem(&cert)
            .map_err(|_| anyhow::anyhow!("invalid Lightning TLS certificate"))?;
        let client = reqwest::Client::builder()
            .use_native_tls()
            .timeout(Duration::from_secs(15))
            .add_root_certificate(cert)
            .build()?;
        let mut endpoint = url(&lnd.url, "https")?;
        let (path, query) = path
            .split_once('?')
            .map_or((path, None), |(p, q)| (p, Some(q)));
        endpoint.set_path(path);
        endpoint.set_query(query);
        let mut request = client
            .request(method.parse()?, endpoint)
            .header("Grpc-Metadata-macaroon", hex::encode(macaroon));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| {
            anyhow::anyhow!("Lightning RPC unavailable; reconcile before retrying issuance")
        })?;
        let status = response.status();
        let value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("invalid Lightning RPC response"))?;
        lnd_response(status, value)
    }
}
fn lnd_response(status: reqwest::StatusCode, value: Value) -> anyhow::Result<Value> {
    if status == reqwest::StatusCode::NOT_FOUND && value["code"] == 5 {
        return Err(InvoiceMissing.into());
    }
    anyhow::ensure!(status.is_success(), "Lightning RPC rejected request");
    Ok(value)
}
fn invoice_needs_cancellation(current: anyhow::Result<Value>) -> anyhow::Result<bool> {
    match current {
        Err(error) if error.is::<InvoiceMissing>() => Ok(false),
        Err(error) => Err(error),
        Ok(value) => match value["state"].as_str() {
            Some("CANCELED") => Ok(false),
            Some("OPEN" | "ACCEPTED") => Ok(true),
            _ => anyhow::bail!("invoice is settled or its state is unknown"),
        },
    }
}
fn client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?)
}
fn invoice_text(value: &Value, amount: u64) -> anyhow::Result<String> {
    let text = value["payment_request"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("invoice response missing BOLT11"))?;
    validate_endpoint(BOLT11, text, amount)?;
    Ok(text.into())
}
pub fn validate_endpoint(
    method: &str,
    endpoint: &str,
    amount: u64,
) -> anyhow::Result<Option<String>> {
    anyhow::ensure!(
        amount > 0 && amount <= payment_model::MAX_SATS && endpoint.len() <= 16384,
        "invalid endpoint input"
    );
    match method {
        ONCHAIN => {
            Address::from_str(endpoint)?.require_network(Network::Regtest)?;
            Ok(None)
        }
        BOLT11 => {
            let invoice = lightning_invoice::Bolt11Invoice::from_str(endpoint)?;
            invoice.check_signature()?;
            anyhow::ensure!(
                invoice.currency() == lightning_invoice::Currency::Regtest
                    && invoice.amount_milli_satoshis() == amount.checked_mul(1000)
                    && !invoice.is_expired(),
                "invoice network, amount or expiry rejected"
            );
            let expires = invoice
                .expires_at()
                .ok_or_else(|| anyhow::anyhow!("invalid invoice expiry"))?;
            Ok(Some(
                chrono::DateTime::from_timestamp(expires.as_secs().try_into()?, 0)
                    .ok_or_else(|| anyhow::anyhow!("invoice expiry overflow"))?
                    .to_rfc3339(),
            ))
        }
        _ => anyhow::bail!("unsupported endpoint method"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn invoice(currency: lightning_invoice::Currency, created: u64) -> String {
        use bitcoin::secp256k1::{Secp256k1, SecretKey};
        lightning_invoice::InvoiceBuilder::new(currency)
            .description("regression".into())
            .payment_hash(sha256::Hash::hash(&[42; 32]))
            .payment_secret(lightning_invoice::PaymentSecret([1; 32]))
            .duration_since_epoch(Duration::from_secs(created))
            .expiry_time(Duration::from_secs(60))
            .amount_milli_satoshis(123000)
            .min_final_cltv_expiry_delta(18)
            .build_signed(|hash| {
                Secp256k1::new()
                    .sign_ecdsa_recoverable(hash, &SecretKey::from_slice(&[2; 32]).unwrap())
            })
            .unwrap()
            .to_string()
    }
    #[test]
    fn endpoint_validation_checks_network_checksum_signature_amount_and_wallet_clock() {
        let now = chrono::Utc::now().timestamp() as u64;
        let good = invoice(lightning_invoice::Currency::Regtest, now);
        assert!(validate_endpoint(BOLT11, &good, 123).unwrap().is_some());
        assert!(validate_endpoint(BOLT11, &good, 124).is_err());
        assert!(validate_endpoint(
            BOLT11,
            &invoice(lightning_invoice::Currency::Bitcoin, now),
            123
        )
        .is_err());
        assert!(validate_endpoint(
            BOLT11,
            &invoice(lightning_invoice::Currency::Regtest, now - 120),
            123
        )
        .is_err());
        assert!(validate_endpoint(BOLT11, &format!("{}x", good), 123).is_err());
        assert!(
            validate_endpoint(ONCHAIN, "bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsl", 1).is_ok()
        );
        assert!(
            validate_endpoint(ONCHAIN, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", 1).is_err()
        );
        assert!(
            validate_endpoint(ONCHAIN, "bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsx", 1).is_err()
        );
        assert!(validate_endpoint("bolt12", &good, 123).is_err());
    }
    #[test]
    fn absent_invoice_cleanup_is_complete_without_cancellation_or_issuance() {
        let missing = lnd_response(
            reqwest::StatusCode::NOT_FOUND,
            json!({"code":5,"message":"unable to locate invoice"}),
        );
        assert!(!invoice_needs_cancellation(missing).unwrap());
        assert!(!invoice_needs_cancellation(Ok(json!({"state":"CANCELED"}))).unwrap());
    }
    #[test]
    fn cleanup_preserves_auth_transport_server_and_settled_failures() {
        for (status, code) in [(401, 16), (403, 7), (500, 2), (404, 2)] {
            let result = lnd_response(
                reqwest::StatusCode::from_u16(status).unwrap(),
                json!({"code":code}),
            );
            assert!(invoice_needs_cancellation(result).is_err());
        }
        assert!(invoice_needs_cancellation(Err(anyhow::anyhow!("transport failed"))).is_err());
        for value in [
            json!({"state":"SETTLED"}),
            json!({"state":"unknown"}),
            json!({}),
        ] {
            assert!(invoice_needs_cancellation(Ok(value)).is_err());
        }
    }
    #[test]
    fn existing_unsettled_invoice_still_requires_wallet_cancellation() {
        for state in ["OPEN", "ACCEPTED"] {
            assert!(invoice_needs_cancellation(Ok(json!({"state":state}))).unwrap());
        }
    }
    #[test]
    fn wallet_urls_cannot_smuggle_auth_paths_or_disable_tls() {
        assert!(url("http://core:18443", "http").is_ok());
        assert!(url("https://lnd:8080", "https").is_ok());
        for invalid in [
            "http://lnd:8080",
            "https://user:pass@lnd:8080",
            "https://lnd/wallet",
            "https://lnd?auth=secret",
            "https://lnd#secret",
        ] {
            assert!(url(invalid, "https").is_err());
        }
    }
}
