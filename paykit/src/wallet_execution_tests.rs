//! Boundary regressions use a local fake transport; real RPC coverage lives in scenarios.
use super::*;
use std::sync::{Arc, Mutex};
const ADDRESS: &str = "bcrt1q2nfxmhd4n3c8834pj72xagvyr9gl57n5r94fsl";
fn entry(owner: &str) -> Execution {
    let wallet = Wallet {
        bitcoin_backend_id: Some("core-0".into()),
        id: "core-0".into(),
        label: "fixture".into(),
        bitcoin: crate::wallet_rpc::Core {
            url: "http://127.0.0.1:1".into(),
            username: "fixture-user".into(),
            password: "fixture-password".into(),
        },
        lightning: None,
    };
    let resolution = crate::payment_model::ResolutionView {
        id: Uuid::new_v4().to_string(),
        peer_public_key: "peer".into(),
        peer_receiver_path: "peer/wallet".into(),
        source: "public".into(),
        amount_sats: "5000".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        method: Some(ONCHAIN.into()),
        endpoint: Some(ADDRESS.into()),
        version: None,
        expires_at: None,
        status: "payable".into(),
        last_error: None,
    };
    let mut e = new_execution(
        Uuid::new_v4(),
        owner.into(),
        wallet,
        Uuid::new_v4().to_string(),
        resolution,
    )
    .unwrap();
    e.authorized = true;
    e
}
fn vault(path: &std::path::Path) -> Vault {
    Vault::new(path.into(), [9; 32], "execution-tests".into()).unwrap()
}
#[test]
fn shared_owner_guard_survives_reopen_and_alias_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let mut s = SpendState::default();
    let mut a = entry("paykit-bob");
    a.view.status = "uncertain".into();
    s.reserve(&store, a).unwrap();
    let mut reopened = SpendState::open(&store).unwrap();
    let mut alias = entry("paykit-bob");
    alias.wallet.id = "lnd-bob-alias".into();
    alias.wallet.bitcoin.url = "http://other-alias:18443".into();
    assert!(reopened.reserve(&store, alias).is_err());
    assert!(reopened.reserve(&store, entry("paykit-alice")).is_ok());
}
#[test]
fn actual_lightning_identity_blocks_alias_even_across_pubky_owners() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let mut s = SpendState::default();
    let mut a = entry("pubky-alice");
    a.lightning_node = Some("same-actual-lnd-node".into());
    s.reserve(&store, a).unwrap();
    let mut b = entry("pubky-bob");
    b.lightning_node = Some("same-actual-lnd-node".into());
    assert!(s.reserve(&store, b).is_err());
}
#[test]
fn failed_commit_never_authorizes_an_execution() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    std::fs::create_dir(dir.path().join(FILE)).unwrap();
    let mut s = SpendState::default();
    assert!(s.reserve(&store, entry("owner")).is_err());
    assert!(store.save("other.cbor", &1u64).is_err());
}
#[test]
fn public_projection_excludes_signing_and_credentials() {
    let mut e = entry("owner");
    e.unsigned = Some("UNSIGNED_PRIVATE".into());
    e.signed = Some("SIGNED_PRIVATE".into());
    e.inputs.push(json!({"privateInput":"selected"}));
    let s = SpendState {
        executions: vec![e.clone()],
        ..Default::default()
    };
    let text = serde_json::to_string(&s.project(e.receiver_id)).unwrap();
    for private in [
        "UNSIGNED_PRIVATE",
        "SIGNED_PRIVATE",
        "fixture-password",
        "privateInput",
    ] {
        assert!(!text.contains(private));
    }
}
#[test]
fn sdk_style_json_numbers_roundtrip_through_encrypted_cbor() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let value: Value =
        serde_json::from_str("{\"amount\":21000000.00000000,\"height\":9007199254740993}").unwrap();
    store.save("numbers.cbor", &value).unwrap();
    assert_eq!(store.load::<Value>("numbers.cbor").unwrap().unwrap(), value);
}
fn transaction() -> bitcoin::Transaction {
    use bitcoin::{absolute, transaction, OutPoint, ScriptBuf, Sequence, TxIn, TxOut, Witness};
    let address = bitcoin::Address::from_str(ADDRESS)
        .unwrap()
        .require_network(bitcoin::Network::Regtest)
        .unwrap();
    bitcoin::Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: bitcoin::Txid::from_str(&"01".repeat(32)).unwrap(),
                vout: 0,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        }],
        output: vec![
            TxOut {
                value: Amount::from_sat(5000),
                script_pubkey: address.script_pubkey(),
            },
            TxOut {
                value: Amount::from_sat(93750),
                script_pubkey: address.script_pubkey(),
            },
        ],
    }
}
#[tokio::test]
async fn lost_broadcast_reopens_and_rebroadcasts_identical_durable_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(vault(dir.path()));
    let calls = Arc::new(Mutex::new(Vec::<(String, Value)>::new()));
    let signed = bitcoin::consensus::encode::serialize_hex(&transaction());
    let hash = transaction().compute_txid().to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handler_calls = calls.clone();
    let handler_store = store.clone();
    let handler_raw = signed.clone();
    let handler_hash = hash.clone();
    let router=axum::Router::new().fallback(axum::routing::post(move |axum::Json(input):axum::Json<Value>|{let calls=handler_calls.clone();let vault=handler_store.clone();let raw=handler_raw.clone();let hash=handler_hash.clone();async move{
  let method=input["method"].as_str().unwrap().to_string();let mut calls=calls.lock().unwrap();calls.push((method.clone(),input["params"].clone()));
  let result=match method.as_str(){"testmempoolaccept"=>json!([{ "allowed":true }]),"listunspent"=>json!([{"txid":"01".repeat(32),"vout":0,"amount":"0.00100000","spendable":true,"safe":true}]),"getrawchangeaddress"=>json!(ADDRESS),"createrawtransaction"=>json!(raw),"signrawtransactionwithwallet"=>json!({"complete":true,"hex":raw}),"sendrawtransaction"=>{let saved=SpendState::open(&vault).unwrap();assert_eq!(saved.executions[0].signed.as_deref(),Some(raw.as_str()));assert_eq!(input["params"][0],raw);if calls.iter().filter(|(m,_)|m=="sendrawtransaction").count()==1{return axum::Json(json!({"error":{"code":-1},"result":null}));}json!(hash)},"gettransaction"=>return axum::Json(json!({"error":{"code":-5},"result":null})),_=>panic!("unexpected method")};axum::Json(json!({"result":result,"error":null}))
 }}));
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut e = entry("owner");
    e.wallet.bitcoin.url = url;
    let id = e.view.id.clone();
    let mut s = SpendState::default();
    s.reserve(&store, e).unwrap();
    assert!(execute(&mut s, &store, 0, false).await.is_err());
    assert_eq!(s.executions[0].view.status, "uncertain");
    let reopened_store = vault(dir.path());
    let mut reopened = SpendState::open(&reopened_store).unwrap();
    let index = reopened.index(&id).unwrap();
    execute(&mut reopened, &reopened_store, index, true)
        .await
        .unwrap();
    assert_eq!(reopened.executions[0].view.status, "succeeded");
    assert_eq!(
        reopened.executions[0].signed.as_deref(),
        Some(signed.as_str())
    );
    let calls = calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|(m, _)| m == "signrawtransactionwithwallet")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|(m, _)| m == "sendrawtransaction")
            .count(),
        2
    );
    task.abort();
}
#[tokio::test]
async fn incomplete_private_consumption_authorization_never_calls_wallet() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let mut e = entry("owner");
    e.authorized = false;
    let mut s = SpendState::default();
    s.reserve(&store, e).unwrap();
    assert!(execute(&mut s, &store, 0, true)
        .await
        .unwrap_err()
        .to_string()
        .contains("authorization"));
    assert_eq!(
        SpendState::open(&store).unwrap().executions[0].view.status,
        "prepared"
    );
}
#[test]
fn output_validation_rejects_wrong_amount_and_index() {
    let tx = transaction();
    assert!(validate_transaction(&tx, ADDRESS, 5000, 0).is_ok());
    assert!(validate_transaction(&tx, ADDRESS, 5001, 0).is_err());
    assert!(validate_transaction(&tx, ADDRESS, 5000, 3).is_err());
}

async fn rejection_case(reason: &'static str) -> (String, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let calls = Arc::new(Mutex::new(Vec::new()));
    let handler_calls = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = axum::Router::new().fallback(axum::routing::post(
        move |axum::Json(v): axum::Json<Value>| {
            let calls = handler_calls.clone();
            async move {
                let method = v["method"].as_str().unwrap().to_string();
                calls.lock().unwrap().push(method.clone());
                let response = match method.as_str() {
                    "gettransaction" => json!({"error":{"code":-5},"result":null}),
                    "testmempoolaccept" => {
                        json!({"error":null,"result":[{"allowed":false,"reject-reason":reason}]})
                    }
                    _ => panic!("rejected signed transaction must never broadcast"),
                };
                axum::Json(response)
            }
        },
    ));
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let mut e = entry("owner");
    e.wallet.bitcoin.url = url;
    e.signed = Some(bitcoin::consensus::encode::serialize_hex(&transaction()));
    e.view.txid = Some(transaction().compute_txid().to_string());
    e.view.output_index = Some(0);
    e.view.status = "uncertain".into();
    let mut state = SpendState::default();
    state.reserve(&store, e).unwrap();
    let _ = execute(&mut state, &store, 0, true).await;
    let status = SpendState::open(&store).unwrap().executions[0]
        .view
        .status
        .clone();
    let calls = calls.lock().unwrap().clone();
    task.abort();
    (status, calls)
}
#[tokio::test]
async fn original_signed_dust_is_definitively_failed_without_broadcast() {
    let (status, calls) = rejection_case("dust").await;
    assert_eq!(status, "failed");
    assert_eq!(calls, vec!["gettransaction", "testmempoolaccept"]);
}
#[tokio::test]
async fn missing_inputs_and_fee_rejections_keep_original_spend_uncertain() {
    for reason in [
        "missing-inputs",
        "min relay fee not met",
        "txn-mempool-conflict",
    ] {
        let (status, calls) = rejection_case(reason).await;
        assert_eq!(status, "uncertain");
        assert!(!calls.iter().any(|m| m == "sendrawtransaction"));
    }
}

#[tokio::test]
async fn preparation_omits_dust_change_and_keeps_exact_payment_across_reopen() {
    let threshold = bitcoin::Address::from_str(ADDRESS)
        .unwrap()
        .require_network(bitcoin::Network::Regtest)
        .unwrap()
        .script_pubkey()
        .minimal_non_dust()
        .to_sat();
    assert_eq!(threshold, 294);
    for remainder in [0, 1, 150, threshold - 1, threshold, threshold + 1] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(vault(dir.path()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let observed = Arc::new(Mutex::new(Vec::new()));
        let handler_observed = observed.clone();
        let handler_store = store.clone();
        let needed = 100_000 - 1_250 - remainder;
        let router = axum::Router::new().fallback(axum::routing::post(
            move |axum::Json(input): axum::Json<Value>| {
                let store = handler_store.clone();
                let observed = handler_observed.clone();
                async move {
                    let method = input["method"].as_str().unwrap().to_string();
                    observed.lock().unwrap().push(method.clone());
                    let result = match method.as_str() {
                        "listunspent" => json!([{"txid":"01".repeat(32),"vout":0,"amount":"0.00100000","spendable":true,"safe":true}]),
                        "getrawchangeaddress" => json!(ADDRESS),
                        "createrawtransaction" => {
                            let saved = SpendState::open(&store).unwrap();
                            let outputs = input["params"][1].as_array().unwrap();
                            assert_eq!(saved.executions[0].outputs, *outputs);
                            assert_eq!(amount(&outputs[0][ADDRESS]).unwrap(), needed);
                            assert_eq!(outputs.len(), if remainder >= threshold { 2 } else { 1 });
                            if remainder >= threshold {
                                assert_eq!(amount(&outputs[1][ADDRESS]).unwrap(), remainder);
                            }
                            json!("durable-unsigned-fixture")
                        }
                        _ => panic!("preparation must not sign or broadcast"),
                    };
                    axum::Json(json!({"result": result, "error": null}))
                }
            },
        ));
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut e = entry("owner");
        e.wallet.bitcoin.url = endpoint;
        e.view.amount_sats = needed.to_string();
        let mut state = SpendState::default();
        state.reserve(&store, e).unwrap();
        prepare_onchain(&mut state, &store, 0).await.unwrap();
        let mut reopened = SpendState::open(&store).unwrap();
        prepare_onchain(&mut reopened, &store, 0).await.unwrap();
        assert_eq!(
            *observed.lock().unwrap(),
            vec![
                "listunspent",
                "getrawchangeaddress",
                "createrawtransaction",
                "createrawtransaction"
            ]
        );
        assert_eq!(reopened.executions[0].outputs, state.executions[0].outputs);
        task.abort();
    }
}

#[test]
fn recurring_execution_identity_and_endpoint_guards_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let mut state = SpendState::default();
    let mut first = entry("owner");
    first.view.period_index = Some(0);
    first.view.status = "succeeded".into();
    state.reserve(&store, first.clone()).unwrap();
    let mut reopened = SpendState::open(&store).unwrap();
    let mut duplicate = first.clone();
    duplicate.view.id = Uuid::new_v4().to_string();
    duplicate.view.endpoint = "different-endpoint".into();
    assert!(reopened.reserve(&store, duplicate).is_err());
    let mut next = first.clone();
    next.view.id = Uuid::new_v4().to_string();
    next.view.period_index = Some(1);
    assert!(reopened.reserve(&store, next.clone()).is_err());
    next.view.endpoint = "fresh-endpoint".into();
    reopened.reserve(&store, next).unwrap();
    assert_eq!(reopened.executions.len(), 2);
    assert!(reopened
        .existing_period(first.receiver_id, &first.view.request_id, Some(0))
        .is_some());
    assert!(reopened
        .existing(first.receiver_id, &first.view.request_id)
        .is_none());
}

#[test]
fn settled_period_rejects_another_proof_and_original_proof_cannot_pay_another_period() {
    let dir = tempfile::tempdir().unwrap();
    let store = vault(dir.path());
    let mut state = SpendState::default();
    state
        .settlements
        .insert("btc:proof-one:0".into(), "receiver:request:0".into());
    state.save(&store).unwrap();
    let restored = SpendState::open(&store).unwrap();
    assert!(!restored.settlement_conflicts("btc:proof-one:0", "receiver:request:0"));
    assert!(restored.settlement_conflicts("btc:proof-two:0", "receiver:request:0"));
    assert!(restored.settlement_conflicts("btc:proof-one:0", "receiver:request:1"));
    assert!(!restored.settlement_conflicts("btc:proof-two:0", "receiver:request:1"));
}
