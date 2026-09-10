//! Resumable local regtest preset provisioning with durable transfer/channel intents.
use crate::{
    config::Config,
    repository::Repository,
    request_model::{FundedWallet, FundingView},
    storage::Vault,
    wallet_execution::{self, SpendState},
    wallet_rpc::{self, Wallet},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;
#[derive(Clone, Serialize, Deserialize)]
struct Binding {
    participant: String,
    owner: String,
    wallet: Wallet,
    node: String,
    core_address: Option<String>,
    lightning_address: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Channel {
    from: usize,
    to: usize,
    attempted: bool,
    point: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct State {
    bindings: Vec<Binding>,
    channels: Vec<Channel>,
    mining_address: Option<String>,
    view: FundingView,
}
fn publish(state: &State, vault: &Vault, repo: &Repository) -> anyhow::Result<()> {
    vault.save("funding.cbor", state)?;
    repo.update(|s| {
        s.funding = state.view.clone();
        s.event(
            "funding.updated",
            json!({"status":state.view.status,"step":state.view.step}),
        );
        Ok(())
    })
}
fn progress(state: &mut State, vault: &Vault, repo: &Repository, step: &str) -> anyhow::Result<()> {
    state.view.status = "running".into();
    state.view.step = step.into();
    state.view.last_error = None;
    publish(state, vault, repo)
}
pub async fn fund(config: &Config, repo: &Repository) -> anyhow::Result<Value> {
    let vault = Vault::new(
        config.data_dir.join("receivers/wallet-execution"),
        *config.key,
        format!("{}:wallet-execution", config.environment_id),
    )?;
    let _lock = vault.lock("spending.lock")?;
    let mut state: State = vault.load("funding.cbor")?.unwrap_or_default();
    let result = provision(config, repo, &vault, &mut state).await;
    if result.is_err() {
        state.view.status = "uncertain".into();
        state.view.last_error=Some("Preset setup is incomplete. Retry funding to reconcile its original transfers and channels.".into());
        publish(&state, &vault, repo)?;
    }
    result?;
    Ok(json!({"funding":state.view}))
}
async fn provision(
    config: &Config,
    repo: &Repository,
    vault: &Vault,
    state: &mut State,
) -> anyhow::Result<()> {
    if state.bindings.is_empty() {
        progress(state, vault, repo, "selectingWallets")?;
        state.bindings = select_bindings(config, repo).await?;
        state.channels = vec![
            Channel {
                from: 0,
                to: 1,
                attempted: false,
                point: None,
            },
            Channel {
                from: 1,
                to: 2,
                attempted: false,
                point: None,
            },
        ];
        publish(state, vault, repo)?;
    }
    let core = state.bindings[0].wallet.clone();
    let owner = core
        .ensure_core_wallet(&format!("funding-{}", config.environment_id))
        .await?;
    if !state.view.funded {
        progress(state, vault, repo, "maturingFunds")?;
        if state.mining_address.is_none() {
            state.mining_address = Some(
                core.address(
                    &format!("funding-{}", config.environment_id),
                    "preset-mining",
                )
                .await?,
            );
            publish(state, vault, repo)?;
        }
        let balance =
            wallet_execution::amount(&core.core(Some(&owner), "getbalance", json!([])).await?)?;
        if balance < 30_000_000 {
            mine(&core, state, 101).await?;
        }
        for n in 0..state.bindings.len() {
            progress(
                state,
                vault,
                repo,
                &format!("funding{}", state.bindings[n].participant),
            )?;
            if state.bindings[n].core_address.is_none() {
                let binding = &state.bindings[n];
                state.bindings[n].core_address = Some(
                    binding
                        .wallet
                        .address(&binding.owner, "preset-funding")
                        .await?,
                );
                publish(state, vault, repo)?;
            }
            if state.bindings[n].lightning_address.is_none() {
                let address = state.bindings[n]
                    .wallet
                    .lnd_with_credential("GET", "/v1/newaddress?type=0", None, "setup")
                    .await?;
                state.bindings[n].lightning_address = Some(
                    address["address"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Lightning funding address missing"))?
                        .into(),
                );
                publish(state, vault, repo)?;
            }
            transfer(
                config,
                vault,
                &core,
                &owner,
                &format!("core:{n}"),
                state.bindings[n]
                    .core_address
                    .as_deref()
                    .expect("saved address"),
                1_000_000,
            )
            .await?;
            mine(&core, state, 1).await?;
            transfer(
                config,
                vault,
                &core,
                &owner,
                &format!("lightning:{n}"),
                state.bindings[n]
                    .lightning_address
                    .as_deref()
                    .expect("saved address"),
                5_000_000,
            )
            .await?;
            mine(&core, state, 1).await?;
        }
        for n in 0..state.channels.len() {
            progress(state, vault, repo, &format!("channel{}", n + 1))?;
            open_channel(state, vault, repo, n).await?;
            mine(&core, state, 6).await?;
        }
    }
    progress(state, vault, repo, "verifyingBalancesAndChannels")?;
    verify(state).await?;
    state.view.funded = true;
    state.view.status = "ready".into();
    state.view.step = "complete".into();
    publish(state, vault, repo)
}
async fn select_bindings(config: &Config, repo: &Repository) -> anyhow::Result<Vec<Binding>> {
    let wallets = wallet_rpc::configured(config.environment_id)?;
    let mut groups: BTreeMap<String, Vec<Wallet>> = BTreeMap::new();
    for wallet in wallets {
        if wallet.lightning.as_ref().is_some_and(|l| {
            l.setup_macaroon_path.is_some()
                && l.payment_macaroon_path.is_some()
                && l.peer_address.is_some()
        }) {
            if let Some(id) = wallet.bitcoin_backend_id.clone() {
                groups.entry(id).or_default().push(wallet);
            }
        }
    }
    let participants = repo.snapshot()?.participants;
    let mut chosen = None;
    for (_, mut wallets) in groups {
        wallets.sort_by(|a, b| a.id.cmp(&b.id));
        let mut unique = BTreeSet::new();
        let mut selected = vec![];
        for wallet in wallets {
            let info = wallet
                .lnd_with_credential("GET", "/v1/getinfo", None, "setup")
                .await?;
            let node = info["identity_pubkey"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Lightning identity missing"))?
                .to_string();
            anyhow::ensure!(
                info["chains"].as_array().is_some_and(|c| c
                    .iter()
                    .any(|v| v["chain"] == "bitcoin" && v["network"] == "regtest")),
                "preset requires Bitcoin regtest Lightning nodes"
            );
            if unique.insert(node.clone()) {
                selected.push((wallet, node));
            }
            if selected.len() == 3 {
                chosen = Some(selected);
                break;
            }
        }
        if chosen.is_some() {
            break;
        }
    }
    let selected = chosen.ok_or_else(|| {
        anyhow::anyhow!(
            "three distinct setup-capable Lightning nodes on one trusted Core backend required"
        )
    })?;
    let mut bindings = vec![];
    let mut chain = None;
    for ((wallet, node), name) in selected.into_iter().zip(["Alice", "Bob", "Carol"]) {
        let info = wallet.core(None, "getblockchaininfo", json!([])).await?;
        anyhow::ensure!(info["chain"] == "regtest", "preset requires regtest Core");
        let tip = info["bestblockhash"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Core tip missing"))?
            .to_string();
        if let Some(ref prior) = chain {
            anyhow::ensure!(
                prior == &tip,
                "wallet bindings do not share the same Core chain tip"
            );
        } else {
            chain = Some(tip);
        }
        let id = Uuid::new_v5(&config.environment_id, format!("preset:{name}").as_bytes());
        let participant = participants
            .iter()
            .find(|p| p.public.id == id)
            .ok_or_else(|| anyhow::anyhow!("preset participant missing"))?;
        bindings.push(Binding {
            participant: name.into(),
            owner: participant.public.public_key.clone(),
            wallet,
            node,
            core_address: None,
            lightning_address: None,
        });
    }
    Ok(bindings)
}
async fn transfer(
    config: &Config,
    vault: &Vault,
    wallet: &Wallet,
    owner: &str,
    label: &str,
    address: &str,
    amount: u64,
) -> anyhow::Result<()> {
    let id = Uuid::new_v5(
        &config.environment_id,
        format!("funding:{label}").as_bytes(),
    );
    let mut state = SpendState::open(vault)?;
    if state
        .existing(config.environment_id, &id.to_string())
        .is_none()
    {
        let now = chrono::Utc::now().to_rfc3339();
        let resolution = crate::payment_model::ResolutionView {
            id: id.to_string(),
            peer_public_key: String::new(),
            peer_receiver_path: String::new(),
            source: "public".into(),
            amount_sats: amount.to_string(),
            created_at: now,
            method: Some(crate::payment_model::ONCHAIN.into()),
            endpoint: Some(address.into()),
            version: None,
            expires_at: None,
            status: "payable".into(),
            last_error: None,
        };
        let mut e = wallet_execution::new_execution(
            config.environment_id,
            owner.into(),
            wallet.clone(),
            id.to_string(),
            resolution,
        )?;
        e.authorized = true;
        state.reserve(vault, e)?;
    }
    let index = state.index(&id.to_string())?;
    let reconcile = state.executions[index].view.status != "prepared";
    wallet_execution::execute(&mut state, vault, index, reconcile).await?;
    anyhow::ensure!(
        state.executions[index].view.status == "succeeded",
        "funding transfer incomplete"
    );
    Ok(())
}
async fn mine(core: &Wallet, state: &State, blocks: u32) -> anyhow::Result<()> {
    core.core(
        None,
        "generatetoaddress",
        json!([blocks, state.mining_address]),
    )
    .await?;
    Ok(())
}
async fn channel_point(from: &Binding, to: &Binding) -> anyhow::Result<Option<String>> {
    let open = from
        .wallet
        .lnd_with_credential("GET", "/v1/channels", None, "setup")
        .await?;
    let pending = from
        .wallet
        .lnd_with_credential("GET", "/v1/channels/pending", None, "setup")
        .await?;
    let mut matches = vec![];
    for c in open["channels"].as_array().into_iter().flatten() {
        if c["remote_pubkey"] == to.node {
            matches.push(
                c["channel_point"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("channel point missing"))?
                    .to_string(),
            );
        }
    }
    for c in pending["pending_open_channels"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let c = &c["channel"];
        if c["remote_node_pub"] == to.node {
            matches.push(
                c["channel_point"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("pending channel point missing"))?
                    .to_string(),
            );
        }
    }
    matches.sort();
    matches.dedup();
    anyhow::ensure!(matches.len() <= 1, "ambiguous channel setup");
    Ok(matches.pop())
}
async fn open_channel(
    state: &mut State,
    vault: &Vault,
    repo: &Repository,
    index: usize,
) -> anyhow::Result<()> {
    let channel = state.channels[index].clone();
    let from = state.bindings[channel.from].clone();
    let to = state.bindings[channel.to].clone();
    if let Some(point) = channel_point(&from, &to).await? {
        if let Some(existing) = &channel.point {
            anyhow::ensure!(existing == &point, "channel identity changed");
        }
        state.channels[index].point = Some(point);
        return publish(state, vault, repo);
    }
    anyhow::ensure!(
        !channel.attempted,
        "channel open outcome remains uncertain; no second funding transaction"
    );
    for _ in 0..90 {
        let balance = from
            .wallet
            .lnd_with_credential("GET", "/v1/balance/blockchain", None, "setup")
            .await?;
        if balance["confirmed_balance"]
            .as_str()
            .unwrap_or("0")
            .parse::<u64>()?
            >= 2_000_000
        {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    let peers = from
        .wallet
        .lnd_with_credential("GET", "/v1/peers", None, "setup")
        .await?;
    if !peers["peers"]
        .as_array()
        .is_some_and(|p| p.iter().any(|p| p["pub_key"] == to.node))
    {
        from.wallet.lnd_with_credential("POST","/v1/peers",Some(json!({"addr":{"pubkey":to.node,"host":to.wallet.lightning.as_ref().and_then(|l|l.peer_address.clone())},"perm":true})),"setup").await?;
    }
    state.channels[index].attempted = true;
    publish(state, vault, repo)?;
    let result=from.wallet.lnd_with_credential("POST","/v1/channels",Some(json!({"node_pubkey":STANDARD.encode(hex::decode(&to.node)?),"local_funding_amount":"1000000","push_sat":"500000","sat_per_vbyte":"5"})),"setup").await;
    if let Ok(response) = result {
        let point = if let Some(txid) = response["funding_txid_str"].as_str() {
            txid.to_string()
        } else {
            let mut bytes = STANDARD.decode(
                response["funding_txid_bytes"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("channel funding txid missing"))?,
            )?;
            bytes.reverse();
            hex::encode(bytes)
        };
        state.channels[index].point = Some(format!(
            "{}:{}",
            point,
            response["output_index"]
                .as_u64()
                .ok_or_else(|| anyhow::anyhow!("channel output missing"))?
        ));
        publish(state, vault, repo)?;
    } else {
        state.channels[index].point = channel_point(&from, &to).await?;
        anyhow::ensure!(
            state.channels[index].point.is_some(),
            "channel funding outcome uncertain"
        );
        publish(state, vault, repo)?;
    }
    Ok(())
}
async fn verify(state: &mut State) -> anyhow::Result<()> {
    for _ in 0..90 {
        let mut all = true;
        let mut points = vec![];
        for channel in &state.channels {
            let from = &state.bindings[channel.from];
            let list = from
                .wallet
                .lnd_with_credential("GET", "/v1/channels", None, "setup")
                .await?;
            let point = channel
                .point
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("funded channel missing"))?;
            let ready = list["channels"].as_array().is_some_and(|v| {
                v.iter().any(|c| {
                    c["channel_point"] == point
                        && c["active"] == true
                        && c["local_balance"]
                            .as_str()
                            .and_then(|v| v.parse::<u64>().ok())
                            .is_some_and(|v| v > 0)
                        && c["remote_balance"]
                            .as_str()
                            .and_then(|v| v.parse::<u64>().ok())
                            .is_some_and(|v| v > 0)
                })
            });
            all &= ready;
            points.push(point.to_string());
        }
        if all {
            state.view.channel_points = points;
            state.view.wallets = vec![];
            for b in &state.bindings {
                let owner = b.wallet.ensure_core_wallet(&b.owner).await?;
                let core = wallet_execution::amount(
                    &b.wallet.core(Some(&owner), "getbalance", json!([])).await?,
                )?;
                let lnd = b
                    .wallet
                    .lnd_with_credential("GET", "/v1/balance/blockchain", None, "setup")
                    .await?;
                let balance = lnd["confirmed_balance"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("Lightning balance missing"))?;
                anyhow::ensure!(
                    core > 0 && balance.parse::<u64>()? > 0,
                    "preset wallet has no confirmed funds"
                );
                state.view.wallets.push(FundedWallet {
                    participant: b.participant.clone(),
                    wallet_id: b.wallet.id.clone(),
                    onchain_balance_sats: core.to_string(),
                    lightning_balance_sats: balance.into(),
                });
            }
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    anyhow::bail!("channels not yet active and bidirectional")
}
