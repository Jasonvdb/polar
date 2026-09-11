//! Durable shared-wallet execution. Unknown outcomes retain their spend reservation.
use crate::{
    payment_model::{self, BOLT11, ONCHAIN},
    request_model::{ExecutionView, Proof},
    storage::Vault,
    wallet_rpc::Wallet,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bitcoin::{
    hashes::{sha256, Hash},
    Amount, Denomination,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, str::FromStr};
use uuid::Uuid;
const FILE: &str = "executions.cbor";
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Execution {
    pub view: ExecutionView,
    pub receiver_id: Uuid,
    pub owner: String,
    pub wallet: Wallet,
    pub unsigned: Option<String>,
    pub signed: Option<String>,
    pub inputs: Vec<Value>,
    pub outputs: Vec<Value>,
    pub authorized: bool,
    pub lightning_node: Option<String>,
    pub proof: Option<Proof>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct SpendState {
    pub executions: Vec<Execution>,
    pub settlements: BTreeMap<String, String>,
}
impl SpendState {
    pub fn open(vault: &Vault) -> anyhow::Result<Self> {
        Ok(vault.load(FILE)?.unwrap_or_default())
    }
    pub fn save(&self, vault: &Vault) -> anyhow::Result<()> {
        vault.save(FILE, self)
    }
    pub fn index(&self, id: &str) -> anyhow::Result<usize> {
        self.executions
            .iter()
            .position(|e| e.view.id == id)
            .ok_or_else(|| anyhow::anyhow!("execution missing"))
    }
    pub fn existing(&self, receiver: Uuid, request: &str) -> Option<&Execution> {
        self.existing_period(receiver, request, None)
    }
    pub fn existing_period(
        &self,
        receiver: Uuid,
        request: &str,
        period: Option<u32>,
    ) -> Option<&Execution> {
        self.executions.iter().find(|e| {
            e.receiver_id == receiver
                && e.view.request_id == request
                && e.view.period_index == period
        })
    }
    pub fn reserve(&mut self, vault: &Vault, execution: Execution) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.existing_period(
                execution.receiver_id,
                &execution.view.request_id,
                execution.view.period_index
            )
            .is_none(),
            "request already has an execution"
        );
        anyhow::ensure!(
            execution.view.period_index.is_none()
                || !self
                    .executions
                    .iter()
                    .any(|e| e.view.endpoint == execution.view.endpoint),
            "Recurring periods cannot reuse an already selected payment endpoint"
        );
        anyhow::ensure!(
            !self.executions.iter().any(|e| same_wallet(e, &execution)
                && !matches!(e.view.status.as_str(), "succeeded" | "failed")),
            "shared wallet has an unresolved execution; reconcile it first"
        );
        self.executions.push(execution);
        self.save(vault)
    }
    pub(crate) fn settlement_conflicts(&self, proof: &str, binding: &str) -> bool {
        self.settlements
            .iter()
            .any(|(claimed_proof, claimed_binding)| {
                (claimed_proof == proof && claimed_binding != binding)
                    || (claimed_binding == binding && claimed_proof != proof)
            })
    }
    pub fn project(&self, receiver: Uuid) -> Vec<ExecutionView> {
        self.executions
            .iter()
            .filter(|e| e.receiver_id == receiver)
            .rev()
            .take(128)
            .map(|e| e.view.clone())
            .collect()
    }
}
fn same_wallet(a: &Execution, b: &Execution) -> bool {
    a.owner == b.owner
        || a.lightning_node
            .as_ref()
            .zip(b.lightning_node.as_ref())
            .is_some_and(|(a, b)| a == b)
}
pub(crate) fn new_execution(
    receiver_id: Uuid,
    owner: String,
    wallet: Wallet,
    request_id: String,
    resolution: crate::payment_model::ResolutionView,
) -> anyhow::Result<Execution> {
    let method = resolution
        .method
        .ok_or_else(|| anyhow::anyhow!("method missing"))?;
    let endpoint = resolution
        .endpoint
        .ok_or_else(|| anyhow::anyhow!("endpoint missing"))?;
    crate::wallet_rpc::validate_endpoint(
        &method,
        &endpoint,
        payment_model::sats(&resolution.amount_sats)?,
    )?;
    if method == ONCHAIN {
        let address =
            bitcoin::Address::from_str(&endpoint)?.require_network(bitcoin::Network::Regtest)?;
        if payment_model::sats(&resolution.amount_sats)?
            < address.script_pubkey().minimal_non_dust().to_sat()
        {
            return Err(crate::model::PublicError::new("onchain_dust","The requested output is below Bitcoin's dust minimum. Create a larger request or choose Lightning.").into());
        }
    }
    let payment_hash = if method == BOLT11 {
        Some(
            lightning_invoice::Bolt11Invoice::from_str(&endpoint)?
                .payment_hash()
                .to_string(),
        )
    } else {
        None
    };
    let now = chrono::Utc::now().to_rfc3339();
    Ok(Execution {
        view: ExecutionView {
            period_index: None,
            billing_period: None,
            id: resolution.id,
            request_id,
            wallet_id: wallet.id.clone(),
            source: resolution.source,
            method,
            endpoint,
            amount_sats: resolution.amount_sats,
            status: "prepared".into(),
            created_at: now.clone(),
            updated_at: now,
            txid: None,
            output_index: None,
            payment_hash,
            last_error: None,
        },
        receiver_id,
        owner,
        wallet,
        unsigned: None,
        signed: None,
        inputs: vec![],
        outputs: vec![],
        authorized: false,
        lightning_node: None,
        proof: None,
    })
}
fn status(state: &mut SpendState, vault: &Vault, index: usize, value: &str) -> anyhow::Result<()> {
    state.executions[index].view.status = value.into();
    state.executions[index].view.updated_at = chrono::Utc::now().to_rfc3339();
    state.executions[index].view.last_error = None;
    state.save(vault)
}
pub(crate) async fn execute(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
    reconcile: bool,
) -> anyhow::Result<()> {
    if matches!(
        state.executions[index].view.status.as_str(),
        "succeeded" | "failed"
    ) {
        return Ok(());
    }
    anyhow::ensure!(
        state.executions[index].authorized,
        "execution authorization checkpoint incomplete; payment remains blocked"
    );
    let result = if state.executions[index].view.method == ONCHAIN {
        onchain(state, vault, index, reconcile).await
    } else {
        lightning(state, vault, index, reconcile).await
    };
    if let Err(error) = result {
        state.executions[index].view.status = "uncertain".into();
        state.executions[index].view.last_error = Some(
            "Wallet outcome uncertain. Reconcile this execution before another payment.".into(),
        );
        state.save(vault)?;
        return Err(error);
    }
    Ok(())
}
pub(crate) fn btc(sats: u64) -> String {
    format!("{}.{:08}", sats / 100_000_000, sats % 100_000_000)
}
pub(crate) fn amount(value: &Value) -> anyhow::Result<u64> {
    let text = value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string());
    Ok(Amount::from_str_in(&text, Denomination::Bitcoin)?.to_sat())
}
async fn onchain(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
    reconcile: bool,
) -> anyhow::Result<()> {
    if state.executions[index].signed.is_none() {
        if state.executions[index].unsigned.is_none() {
            anyhow::ensure!(
                !reconcile
                    || state.executions[index].view.status == "prepared"
                    || !state.executions[index].inputs.is_empty(),
                "unsigned payment needs explicit diagnostics; no replacement transaction"
            );
            prepare_onchain(state, vault, index).await?;
            if state.executions[index].view.status == "failed" {
                return Ok(());
            }
        }
        let e = state.executions[index].clone();
        status(state, vault, index, "signing")?;
        let signed = e
            .wallet
            .core(
                Some(&e.owner),
                "signrawtransactionwithwallet",
                json!([e.unsigned]),
            )
            .await?;
        anyhow::ensure!(signed["complete"] == true, "wallet signature incomplete");
        let raw = signed["hex"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("signed transaction missing"))?
            .to_string();
        let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&hex::decode(&raw)?)?;
        validate_transaction(
            &tx,
            &e.view.endpoint,
            payment_model::sats(&e.view.amount_sats)?,
            0,
        )?;
        state.executions[index].signed = Some(raw);
        state.executions[index].view.txid = Some(tx.compute_txid().to_string());
        state.executions[index].view.output_index = Some(0);
        status(state, vault, index, "signed")?;
    }
    let e = state.executions[index].clone();
    if known_transaction(&e).await {
        return complete_onchain(state, vault, index);
    }
    let acceptance = e
        .wallet
        .core(None, "testmempoolaccept", json!([[e.signed]]))
        .await?;
    let check = acceptance
        .as_array()
        .and_then(|a| a.first())
        .ok_or_else(|| anyhow::anyhow!("mempool acceptance missing"))?;
    if check["allowed"] != true {
        if check["reject-reason"] == "dust" {
            status(state, vault, index, "failed")?;
            state.executions[index].view.last_error=Some("Bitcoin rejected the original signed transaction as dust. No replacement payment was created.".into());
            return state.save(vault);
        }
        anyhow::bail!("original transaction is not currently accepted; outcome remains uncertain");
    }
    status(state, vault, index, "inFlight")?;
    let broadcast = e
        .wallet
        .core(None, "sendrawtransaction", json!([e.signed]))
        .await;
    match broadcast {
        Ok(value) => anyhow::ensure!(
            value == json!(e.view.txid),
            "broadcast returned a different transaction"
        ),
        Err(_) => anyhow::ensure!(
            known_transaction(&e).await,
            "original transaction not found; reconcile exact bytes"
        ),
    }
    complete_onchain(state, vault, index)
}
async fn known_transaction(e: &Execution) -> bool {
    e.wallet
        .core(Some(&e.owner), "gettransaction", json!([e.view.txid]))
        .await
        .ok()
        .is_some_and(|v| {
            v["txid"] == json!(e.view.txid) && v["confirmations"].as_i64().is_some_and(|n| n >= 0)
        })
}
fn complete_onchain(state: &mut SpendState, vault: &Vault, index: usize) -> anyhow::Result<()> {
    let txid = state.executions[index]
        .view
        .txid
        .clone()
        .ok_or_else(|| anyhow::anyhow!("txid missing"))?;
    state.executions[index].proof = Some(Proof::Onchain {
        txid,
        output_index: 0,
    });
    status(state, vault, index, "succeeded")
}

async fn prepare_onchain(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
) -> anyhow::Result<()> {
    if !state.executions[index].inputs.is_empty() {
        return create_unsigned(state, vault, index).await;
    }
    let e = state.executions[index].clone();
    let coins = e
        .wallet
        .core(Some(&e.owner), "listunspent", json!([1]))
        .await?;
    let needed = payment_model::sats(&e.view.amount_sats)?;
    let mut coins = coins
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("wallet coins missing"))?
        .clone();
    coins.sort_by_key(|v| (v["txid"].to_string(), v["vout"].as_u64()));
    let mut selected = vec![];
    let mut total = 0u64;
    for coin in coins {
        if coin["spendable"] != true || coin["safe"] == false {
            continue;
        }
        total = total
            .checked_add(amount(&coin["amount"])?)
            .ok_or_else(|| anyhow::anyhow!("coin sum overflow"))?;
        selected.push(json!({"txid":coin["txid"],"vout":coin["vout"]}));
        if total >= needed + 1000 + 250 * selected.len() as u64 {
            break;
        }
        anyhow::ensure!(selected.len() <= 100, "too many selected inputs");
    }
    let fee = 1000 + 250 * selected.len() as u64;
    if total < needed + fee {
        status(state, vault, index, "failed")?;
        state.executions[index].view.last_error =
            Some("Insufficient confirmed funds including transaction fee.".into());
        state.save(vault)?;
        return Ok(());
    }
    let change = e
        .wallet
        .core(Some(&e.owner), "getrawchangeaddress", json!(["bech32"]))
        .await?;
    let change = change
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("change address missing"))?;
    let mut outputs = vec![json!({e.view.endpoint:btc(needed)})];
    let change_amount = total - needed - fee;
    let change_address =
        bitcoin::Address::from_str(change)?.require_network(bitcoin::Network::Regtest)?;
    if change_amount >= change_address.script_pubkey().minimal_non_dust().to_sat() {
        outputs.push(json!({change:btc(change_amount)}));
    }
    state.executions[index].inputs = selected;
    state.executions[index].outputs = outputs;
    state.save(vault)?;
    create_unsigned(state, vault, index).await
}
async fn create_unsigned(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
) -> anyhow::Result<()> {
    let e = state.executions[index].clone();
    let raw = e
        .wallet
        .core(
            None,
            "createrawtransaction",
            json!([e.inputs, e.outputs, 0, false]),
        )
        .await?;
    state.executions[index].unsigned = Some(
        raw.as_str()
            .ok_or_else(|| anyhow::anyhow!("unsigned transaction missing"))?
            .into(),
    );
    state.save(vault)
}
pub(crate) fn validate_transaction(
    tx: &bitcoin::Transaction,
    endpoint: &str,
    amount: u64,
    index: u32,
) -> anyhow::Result<()> {
    let address =
        bitcoin::Address::from_str(endpoint)?.require_network(bitcoin::Network::Regtest)?;
    let output = tx
        .output
        .get(index as usize)
        .ok_or_else(|| anyhow::anyhow!("proof output missing"))?;
    anyhow::ensure!(
        output.script_pubkey == address.script_pubkey() && output.value.to_sat() == amount,
        "proof output address or amount mismatch"
    );
    Ok(())
}
async fn lightning(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
    reconcile: bool,
) -> anyhow::Result<()> {
    let e = state.executions[index].clone();
    if reconcile || e.view.status != "prepared" {
        let hash = e
            .view
            .payment_hash
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("payment hash missing"))?;
        let p = find_payment(&e.wallet, hash).await?.ok_or_else(|| {
            anyhow::anyhow!("payment hash not yet known; outcome remains uncertain")
        })?;
        return apply_payment(state, vault, index, p).await;
    }
    crate::wallet_rpc::validate_endpoint(
        BOLT11,
        &e.view.endpoint,
        payment_model::sats(&e.view.amount_sats)?,
    )?;
    status(state, vault, index, "inFlight")?;
    let p = e
        .wallet
        .lnd_with_credential(
            "POST",
            "/v1/channels/transactions",
            Some(json!({"payment_request":e.view.endpoint,"fee_limit":{"fixed":"1000"}})),
            "payment",
        )
        .await?;
    if p["payment_error"].as_str().is_some_and(|v| !v.is_empty()) {
        status(state, vault, index, "failed")?;
        state.executions[index].view.last_error =
            Some("Lightning payment failed: no route or insufficient funds.".into());
        return state.save(vault);
    }
    let preimage = STANDARD.decode(
        p["payment_preimage"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("payment preimage missing"))?,
    )?;
    complete_lightning(state, vault, index, hex::encode(preimage))
}
async fn apply_payment(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
    p: Value,
) -> anyhow::Result<()> {
    match p["status"].as_str() {
        Some("SUCCEEDED") => complete_lightning(
            state,
            vault,
            index,
            p["payment_preimage"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("preimage missing"))?
                .into(),
        ),
        Some("FAILED") => status(state, vault, index, "failed"),
        Some("IN_FLIGHT" | "INITIATED") => status(state, vault, index, "inFlight"),
        _ => anyhow::bail!("unknown payment state"),
    }
}
fn complete_lightning(
    state: &mut SpendState,
    vault: &Vault,
    index: usize,
    preimage: String,
) -> anyhow::Result<()> {
    let hash = state.executions[index]
        .view
        .payment_hash
        .clone()
        .ok_or_else(|| anyhow::anyhow!("payment hash missing"))?;
    anyhow::ensure!(
        sha256::Hash::hash(&hex::decode(&preimage)?).to_string() == hash,
        "payment preimage mismatch"
    );
    state.executions[index].proof = Some(Proof::Lightning {
        payment_hash: hash,
        preimage,
    });
    status(state, vault, index, "succeeded")
}
pub(crate) async fn find_payment(wallet: &Wallet, hash: &str) -> anyhow::Result<Option<Value>> {
    let mut offset = 0u64;
    loop {
        let page = wallet
            .lnd_with_credential(
                "GET",
                &format!(
                    "/v1/payments?include_incomplete=true&max_payments=1000&index_offset={offset}"
                ),
                None,
                "payment",
            )
            .await?;
        let payments = page["payments"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("payment history missing"))?;
        if let Some(p) = payments.iter().find(|p| p["payment_hash"] == hash) {
            return Ok(Some(p.clone()));
        }
        if payments.len() < 1000 {
            return Ok(None);
        }
        let next = page["last_index_offset"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("pagination cursor missing"))?
            .parse()?;
        anyhow::ensure!(next > offset, "payment history cursor did not advance");
        offset = next;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_bitcoin_json_preserves_every_satoshi() {
        for sats in [1, 1001, 100_000_001, payment_model::MAX_SATS] {
            let text = btc(sats);
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(amount(&value).unwrap(), sats);
        }
    }
    #[test]
    fn proof_identity_binds_output_and_hash_case() {
        assert_eq!(
            Proof::Onchain {
                txid: "AB".repeat(32),
                output_index: 2
            }
            .identity(),
            format!("btc:{}:2", "ab".repeat(32))
        );
    }
}

#[cfg(test)]
#[path = "wallet_execution_tests.rs"]
mod durability_tests;
