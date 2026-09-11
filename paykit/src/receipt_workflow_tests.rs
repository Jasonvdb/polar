use super::*;
use crate::{
    request_model::Proof,
    storage::{ReceiverStorage, Vault},
};
use paykit_sdk::{
    storage::{OutboundPrivateMessageRecord, PrivateStreamItemRecord, StorageState},
    PaykitReceiverPath, PubkyPublicKey,
};
use std::{path::Path, sync::Arc};

fn owner() -> PubkyPublicKey {
    PubkyPublicKey::from_public_key(&pubky::Keypair::from_secret(&[41; 32]).public_key())
}
fn peer() -> PubkyPublicKey {
    PubkyPublicKey::from_public_key(&pubky::Keypair::from_secret(&[42; 32]).public_key())
}
fn path() -> PaykitReceiverPath {
    PaykitReceiverPath::new("receipts/wallet").unwrap()
}
fn proof() -> Proof {
    Proof::Onchain {
        txid: "ab".repeat(32),
        output_index: 0,
    }
}
fn input(receiver: Uuid) -> receipt_input::Prepare {
    receipt_input::Prepare {
        receiver_id: receiver,
        request_id: Uuid::parse_str("00000000-0000-4000-8000-000000000100").unwrap(),
        proof_id: Uuid::parse_str("00000000-0000-4000-8000-000000000101").unwrap(),
        note: "Thank you".into(),
    }
}
fn request(i: &receipt_input::Prepare) -> paykit_sdk::PaymentRequestRecord {
    serde_json::from_value(json!({
        "counterparty": peer(), "counterparty_receiver_path": path(), "payment_request_id":i.request_id.to_string(),
        "local_role":"Payee", "state":"ProofSubmitted", "proposal_event_id":Uuid::parse_str("00000000-0000-4000-8000-000000000102").unwrap(),
        "terms":{"amount":{"value":"5000","asset":"sat"},"payment_reference":"receipt-fixture","accepted_payment_endpoint_identifiers":[payment_model::ONCHAIN],"metadata":{"description":"Coffee"}},
        "payment_proofs":[{"event_id":i.proof_id.to_string(),"payment_reference":"receipt-fixture","payment_endpoint_identifier":payment_model::ONCHAIN,"proof":proof(),"recorded_at":chrono::Utc::now()}]
    })).unwrap()
}
fn open(directory: &Path, receiver: Uuid) -> Runtime {
    let vault = Arc::new(Vault::new(directory.into(), [43; 32], receiver.to_string()).unwrap());
    if !directory.join("sdk.cbor").exists() {
        let i = input(receiver);
        let terms = paykit_lib::PaymentRequestTerms {
            amount: paykit_lib::PaymentAmount::new("5000", "sat").unwrap(),
            payment_reference: paykit_lib::PaymentReference::new("receipt-fixture").unwrap(),
            proposal_expires_at: None,
            recurrence: None,
            accepted_payment_endpoint_identifiers: vec![
                paykit_lib::PaymentEndpointIdentifier::new(payment_model::ONCHAIN).unwrap(),
            ],
            metadata: json!({"description":"Coffee"}).as_object().unwrap().clone(),
        };
        let request_id = paykit_lib::PaymentRequestId::new(i.request_id.to_string()).unwrap();
        let proposal = paykit_lib::PaymentRequestEvent::Request(paykit_lib::PaymentRequest::new(
            paykit_lib::EventId::new_v4(),
            request_id.clone(),
            terms,
        ));
        let acceptance =
            paykit_lib::PaymentRequestEvent::Acceptance(paykit_lib::PaymentRequestAcceptance::new(
                paykit_lib::EventId::new_v4(),
                request_id.clone(),
            ));
        let payment_proof = paykit_lib::PaymentRequestEvent::Proof(paykit_lib::PaymentProof::new(
            paykit_lib::EventId::new(i.proof_id.to_string()).unwrap(),
            request_id,
            paykit_lib::PaymentReference::new("receipt-fixture").unwrap(),
            None,
            paykit_lib::PaymentEndpointIdentifier::new(payment_model::ONCHAIN).unwrap(),
            json!(proof()).as_object().unwrap().clone(),
        ));
        let now = chrono::Utc::now();
        let mut state = StorageState {
            identity_state: Some(paykit_sdk::IdentityState {
                local_pubky_public_key: Some(owner()),
                local_receiver_noise_public_key: Some(owner()),
                initialized_at: now,
                sign_out_generation: 0,
            }),
            ..Default::default()
        };
        let raw = paykit_lib::serialize_payment_request_event(&proposal).unwrap();
        state
            .outbound_private_messages
            .push(OutboundPrivateMessageRecord {
                outbound_message_id: 1,
                counterparty: peer(),
                counterparty_receiver_path: path(),
                kind: serde_json::from_str::<Value>(&raw).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .into(),
                raw_json: raw,
                status: paykit_sdk::OutboundPrivateMessageStatus::Sent,
                attempt_count: 1,
                created_at: now,
                updated_at: now,
                last_attempt_at: Some(now),
                sent_at: Some(now),
                last_error: None,
            });
        state.next_outbound_private_message_id = 2;
        for (n, event) in [acceptance, payment_proof].iter().enumerate() {
            let raw = paykit_lib::serialize_payment_request_event(event).unwrap();
            let kind = serde_json::from_str::<Value>(&raw).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned();
            state.private_stream_items.push(PrivateStreamItemRecord {
                stream_item_id: n as u64 + 1,
                counterparty: peer(),
                counterparty_receiver_path: path(),
                receive_batch_id: 1,
                raw_json: raw,
                parsed_version: Some(1),
                parsed_kind: Some(kind.clone()),
                known_paykit_kind: Some(kind),
                parse_status: paykit_sdk::PrivateStreamParseStatus::Valid,
                parse_error: None,
                received_at: now,
            });
        }
        state.next_private_stream_item_id = 3;
        vault.save("sdk.cbor", &state).unwrap();
        #[derive(serde::Serialize)]
        struct RequestFixture {
            claims: std::collections::BTreeMap<String, String>,
            proposals: std::collections::BTreeMap<String, String>,
            transitions: std::collections::BTreeMap<String, String>,
            settlements: Vec<crate::request_model::SettlementView>,
        }
        vault
            .save(
                "requests.cbor",
                &RequestFixture {
                    claims: Default::default(),
                    proposals: Default::default(),
                    transitions: Default::default(),
                    settlements: vec![crate::request_model::SettlementView {
                        request_id: i.request_id.to_string(),
                        proof_id: i.proof_id.to_string(),
                        status: "verified".into(),
                        required_confirmations: 1,
                        confirmations: 1,
                        verified_at: Some(now.to_rfc3339()),
                        last_error: None,
                    }],
                },
            )
            .unwrap();
    }
    let storage = Arc::new(
        ReceiverStorage::open(
            Vault::new(directory.into(), [43; 32], receiver.to_string()).unwrap(),
        )
        .unwrap(),
    );
    let sessions = crate::receiver::SessionProvider::without_access(vault.clone());
    let payments =
        crate::wallet_adapter::WalletAdapter::open(vault.clone(), receiver, owner().to_string())
            .unwrap();
    let sdk = paykit_sdk::PaykitSdk::new(
        storage.clone(),
        sessions.clone(),
        payments.clone(),
        paykit_sdk::PaykitSdkConfig::new(path()),
    )
    .unwrap();
    Runtime::new(sdk, storage, vault, receiver, owner(), sessions, payments).unwrap()
}

#[test]
fn strict_receipt_commands_reject_extra_secrets_nil_ids_and_utf8_overflow() {
    let receiver = Uuid::new_v4();
    let valid = json!({"receiverId":receiver,"requestId":Uuid::new_v4(),"proofId":Uuid::new_v4()});
    let command = |v| Command {
        command_id: Uuid::new_v4(),
        command: "receipt.prepare".into(),
        input: v,
    };
    assert!(receipt_input::validate(&command(valid.clone())).is_ok());
    for (key, value) in [
        ("note", json!("é".repeat(251))),
        ("note", json!("line\nsecret")),
        ("key", json!("secret")),
        ("amountSats", json!("1")),
        ("proofId", json!(Uuid::nil())),
    ] {
        let mut changed = valid.clone();
        changed[key] = value;
        assert!(receipt_input::validate(&command(changed)).is_err());
    }
    assert!(receipt_input::text_valid(&"é".repeat(250), true));
}
#[test]
fn receipt_identity_is_stable_per_receiver_request_and_proof() {
    let i = input(Uuid::new_v4());
    let id = receipt_id(i.receiver_id, i.request_id, i.proof_id);
    assert_eq!(id.get_version(), Some(uuid::Version::Random));
    assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
    assert!(paykit_lib::ReceiptId::new(id.to_string()).is_ok());
    assert_eq!(id, receipt_id(i.receiver_id, i.request_id, i.proof_id));
    assert_ne!(id, receipt_id(Uuid::new_v4(), i.request_id, i.proof_id));
    assert_ne!(id, receipt_id(i.receiver_id, Uuid::new_v4(), i.proof_id));
    assert_ne!(id, receipt_id(i.receiver_id, i.request_id, Uuid::new_v4()));
}
#[tokio::test]
async fn pinned_sdk_preparation_survives_reopen_and_changed_note_rejects() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    runtime
        .verified_receipt_request(input(receiver).request_id, input(receiver).proof_id)
        .await
        .unwrap_or_else(|e| panic!("eligibility: {e:?}"));
    let id = runtime.prepare_receipt(input(receiver)).await.unwrap();
    let before = runtime.issuance(id).await.unwrap().unwrap();
    assert_eq!(before.status, ReceiptIssuanceStatus::PendingStorage);
    assert!(before.outbound_message_id.is_none());
    drop(runtime);
    let reopened = open(dir.path(), receiver);
    assert_eq!(reopened.prepare_receipt(input(receiver)).await.unwrap(), id);
    let after = reopened.issuance(id).await.unwrap().unwrap();
    assert!(before == after);
    let mut changed = input(receiver);
    changed.note = "changed".into();
    assert!(reopened
        .prepare_receipt(changed)
        .await
        .unwrap_err()
        .to_string()
        .contains("immutable"));
    assert!(reopened.issuance(id).await.unwrap().unwrap() == before);
}
#[tokio::test]
async fn absent_session_processing_preserves_preparation_and_retries_same_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    let id = runtime.prepare_receipt(input(receiver)).await.unwrap();
    let before = runtime.issuance(id).await.unwrap().unwrap();
    for _ in 0..2 {
        assert!(runtime
            .process_receipt(receipt_input::Process {
                receiver_id: receiver,
                receipt_id: id
            })
            .await
            .is_err());
        assert!(runtime.issuance(id).await.unwrap().unwrap() == before);
    }
}
#[tokio::test]
async fn queued_receipt_acknowledges_without_session_or_another_queue_item() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    let id = runtime.prepare_receipt(input(receiver)).await.unwrap();
    let mut state = runtime
        .storage
        .transaction(|tx| Ok(tx.export_storage_state()))
        .await
        .unwrap();
    let record = state
        .receipt_issuance_records
        .values_mut()
        .find(|r| r.receipt_id == id.to_string())
        .unwrap();
    let now = chrono::Utc::now();
    let outbound = OutboundPrivateMessageRecord {
        outbound_message_id: state.next_outbound_private_message_id,
        counterparty: record.counterparty.clone(),
        counterparty_receiver_path: record.counterparty_receiver_path.clone(),
        kind: "paykit.receipt_access".into(),
        raw_json: record.access_json.clone(),
        status: paykit_sdk::OutboundPrivateMessageStatus::Pending,
        attempt_count: 0,
        created_at: now,
        updated_at: now,
        last_attempt_at: None,
        sent_at: None,
        last_error: None,
    };
    record.status = ReceiptIssuanceStatus::AccessQueued;
    record.outbound_message_id = Some(outbound.outbound_message_id);
    record.stored_at = Some(now);
    record.access_queued_at = Some(now);
    state.next_outbound_private_message_id += 1;
    state.outbound_private_messages.push(outbound);
    runtime.vault.save("sdk.cbor", &state).unwrap();
    drop(runtime);
    let runtime = open(dir.path(), receiver);
    let before = runtime
        .storage
        .transaction(|tx| Ok(tx.export_storage_state()))
        .await
        .unwrap();
    assert_eq!(
        runtime
            .process_receipt(receipt_input::Process {
                receiver_id: receiver,
                receipt_id: id
            })
            .await
            .unwrap(),
        id
    );
    assert!(
        runtime
            .storage
            .transaction(|tx| Ok(tx.export_storage_state()))
            .await
            .unwrap()
            == before
    );
}
#[tokio::test]
async fn unverified_or_wrong_proof_never_prepares_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    let mut wrong = input(receiver);
    wrong.proof_id = Uuid::new_v4();
    assert!(runtime.prepare_receipt(wrong).await.is_err());
    runtime
        .vault
        .save(
            "requests.cbor",
            &json!({"claims":{},"proposals":{},"transitions":{},"settlements":[]}),
        )
        .unwrap();
    assert!(runtime.prepare_receipt(input(receiver)).await.is_err());
    assert!(runtime.sdk.issued_receipts().await.unwrap().is_empty());
}
#[tokio::test]
async fn explicit_issuance_projection_never_serializes_key_location_or_raw_error() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    let id = runtime.prepare_receipt(input(receiver)).await.unwrap();
    runtime
        .storage
        .transaction(|tx| {
            let mut record = tx
                .receipt_issuance_record_by_receipt_id(&id.to_string())
                .unwrap();
            record.last_error = Some("PRIVATE_ERROR_SENTINEL".into());
            tx.save_receipt_issuance_record(record);
            Ok(())
        })
        .await
        .unwrap();
    let mut record = runtime.issuance(id).await.unwrap().unwrap();
    let access = paykit_lib::parse_receipt_access_json(&record.access_json).unwrap();
    record.status = ReceiptIssuanceStatus::Failed;
    record.outbound_message_id = Some(9007199254740993);
    let view = issuance_view(
        receiver,
        &record,
        Some(&paykit_sdk::OutboundPrivateMessageStatus::Failed),
    )
    .unwrap();
    let public = serde_json::to_string(&view).unwrap();
    for secret in [
        access.key.as_str(),
        record.location.as_str(),
        record.access_json.as_str(),
        record.encrypted_receipt.as_str(),
        "PRIVATE_ERROR_SENTINEL",
    ] {
        assert!(!public.contains(secret));
    }
    assert!(public.contains("\"outboundMessageId\":\"9007199254740993\""));
    assert!(issuance_view(Uuid::new_v4(), &record, None).is_err());
}
#[test]
fn drafts_reject_unsupported_terms_and_use_no_changing_timestamp_metadata() {
    let i = input(Uuid::new_v4());
    let mut r = request(&i);
    let id = receipt_id(i.receiver_id, i.request_id, i.proof_id);
    let before = receipt_draft(&r, &proof(), &i, id).unwrap();
    assert_eq!(before.metadata.len(), 4);
    assert!(before == receipt_draft(&r, &proof(), &i, id).unwrap());
    r.terms.as_mut().unwrap().amount.asset = "USD".into();
    assert!(receipt_draft(&r, &proof(), &i, id).is_err());
    r.terms.as_mut().unwrap().amount.asset = "sat".into();
    r.terms.as_mut().unwrap().amount.value = "01".into();
    assert!(receipt_draft(&r, &proof(), &i, id).is_err());
}

fn cached_receipt(i: &receipt_input::Prepare) -> paykit_sdk::ReceiptRecord {
    paykit_sdk::ReceiptRecord {
        issuer: peer(), issuer_receiver_path: path(), receipt_access_event_id: Uuid::new_v4().to_string(),
        receipt_access_key_hash: { use bitcoin::hashes::Hash; format!("sha256:{}",bitcoin::hashes::sha256::Hash::hash(b"KEY_SENTINEL")) }, receipt_id: Uuid::new_v4().to_string(),
        payment_reference: "receipt-fixture".into(), payment_request_id: Some(i.request_id.to_string()), billing_period: None,
        recipient_public_key: owner(), payment_endpoint_identifier: Some(payment_model::ONCHAIN.into()),
        amount: Some(paykit_sdk::AmountRecord {value:"5000".into(),asset:"sat".into()}),
        metadata: json!({"polarPaykitReceiptVersion":1,"proofId":i.proof_id.to_string(),"description":"Coffee","note":"Thank you","SECRET_METADATA_SENTINEL":"secret"}).as_object().unwrap().clone(),
        location:"PRIVATE_LOCATION_SENTINEL".into(), retrieved_at:chrono::Utc::now(),
    }
}
#[test]
fn incoming_known_receipt_checks_exact_request_issuer_amount_and_method() {
    let i = input(Uuid::new_v4());
    let mut request = request(&i);
    request.local_role = Some(paykit_sdk::PaymentRequestLocalRole::Payer);
    let receipt = cached_receipt(&i);
    assert!(known_receipt_matches(&receipt, std::slice::from_ref(&request)).is_ok());
    for field in ["amount", "method", "reference", "proof", "issuerPath"] {
        let mut changed = receipt.clone();
        match field {
            "amount" => changed.amount.as_mut().unwrap().value = "5001".into(),
            "method" => changed.payment_endpoint_identifier = Some(payment_model::BOLT11.into()),
            "reference" => changed.payment_reference = "another-reference".into(),
            "proof" => {
                changed
                    .metadata
                    .insert("proofId".into(), json!(Uuid::new_v4()));
            }
            _ => changed.issuer_receiver_path = PaykitReceiverPath::new("other/wallet").unwrap(),
        }
        assert!(
            known_receipt_matches(&changed, std::slice::from_ref(&request)).is_err(),
            "{field}"
        );
    }
    let public = serde_json::to_string(&decrypted_view(&receipt)).unwrap();
    for secret in [
        "KEY_HASH_SENTINEL",
        "PRIVATE_LOCATION_SENTINEL",
        "SECRET_METADATA_SENTINEL",
    ] {
        assert!(!public.contains(secret));
    }
}
#[tokio::test]
async fn contradictory_cached_receipt_retries_fail_and_access_explains_failure() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let mut runtime = open(dir.path(), receiver);
    let mut receipt = cached_receipt(&input(receiver));
    receipt.amount.as_mut().unwrap().value = "5001".into();
    runtime.storage.transaction(|tx| {
        let access=serde_json::from_value(json!({"counterparty":peer(),"counterparty_receiver_path":path(),"stream_item_id":99,"receive_batch_id":1,
            "event_id":receipt.receipt_access_event_id,"receipt_id":receipt.receipt_id,"payment_reference":receipt.payment_reference,"payment_request_id":receipt.payment_request_id,
            "location":receipt.location,"key":"KEY_SENTINEL","retrieval_status":"Retrieved","retrieval_attempted_at":receipt.retrieved_at,"retrieved_at":receipt.retrieved_at,"received_at":receipt.retrieved_at})).unwrap();
        tx.save_receipt_access_record(access);tx.save_receipt_record(receipt.clone());Ok(())
    }).await.unwrap();
    for _ in 0..2 {
        let error = runtime
            .retrieve_receipt(receipt_input::Retrieve {
                receiver_id: receiver,
                peer_public_key: peer().to_string(),
                peer_receiver_path: path().to_string(),
                receipt_id: Uuid::parse_str(&receipt.receipt_id).unwrap(),
            })
            .await
            .unwrap_err();
        assert!(error.to_string().contains("contradicts"), "{error:?}");
    }
    runtime.project_receipts().await.unwrap();
    assert!(runtime.state.view.receipts.is_empty());
    assert_eq!(runtime.state.view.receipt_access.len(), 1);
    assert_eq!(
        runtime.state.view.receipt_access[0].retrieval_status,
        "failed"
    );
    assert!(runtime.state.view.receipt_access[0]
        .last_error
        .as_ref()
        .unwrap()
        .contains("contradicts"));
    assert_eq!(runtime.sdk.receipts().await.unwrap().len(), 1);
}
#[test]
fn foreign_optional_receipt_fields_are_projected_only_when_valid() {
    let mut receipt = cached_receipt(&input(Uuid::new_v4()));
    receipt.amount.as_mut().unwrap().asset = "USD".into();
    receipt.payment_endpoint_identifier = Some("unsupported".into());
    receipt
        .metadata
        .insert("note".into(), json!("a".repeat(501)));
    receipt
        .metadata
        .insert("proofId".into(), json!("not-a-uuid"));
    let view = decrypted_view(&receipt);
    assert!(view.amount_sats.is_none());
    assert!(view.method.is_none());
    assert!(view.note.is_none());
    assert!(view.proof_id.is_none());
}
#[test]
fn receipt_input_requires_sdk_v4_ids_but_accepts_v5_receiver() {
    let valid = "018f1234-5678-4abc-8123-456789abcdef";
    let command = |id: &str| Command {
        command_id: Uuid::new_v4(),
        command: "receipt.process".into(),
        input: json!({"receiverId":Uuid::new_v4(),"receiptId":id}),
    };
    assert!(receipt_input::validate(&command(valid)).is_ok());
    assert!(receipt_input::validate(&command("018f1234-5678-7abc-8123-456789abcdef")).is_err());
    let mut v5_receiver = command(valid);
    v5_receiver.input["receiverId"] = json!(Uuid::new_v5(&Uuid::NAMESPACE_URL, b"receiver"));
    assert!(receipt_input::validate(&v5_receiver).is_ok());
    assert!(receipt_input::validate(&command(&valid.to_uppercase())).is_err());
    assert!(receipt_input::validate(&command(&valid.replace('-', ""))).is_err());
}

#[tokio::test]
async fn sdk_commit_failure_leaves_no_receipt_and_retry_uses_same_identity() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    let before = runtime
        .storage
        .transaction(|tx| Ok(tx.export_storage_state()))
        .await
        .unwrap();
    std::fs::rename(dir.path().join("sdk.cbor"), dir.path().join("sdk.saved")).unwrap();
    std::fs::create_dir(dir.path().join("sdk.cbor")).unwrap();
    assert!(runtime
        .prepare_receipt(input(receiver))
        .await
        .unwrap_err()
        .to_string()
        .contains("committed"));
    assert!(
        runtime
            .storage
            .transaction(|tx| Ok(tx.export_storage_state()))
            .await
            .unwrap()
            == before
    );
    std::fs::remove_dir(dir.path().join("sdk.cbor")).unwrap();
    std::fs::rename(dir.path().join("sdk.saved"), dir.path().join("sdk.cbor")).unwrap();
    assert!(runtime.prepare_receipt(input(receiver)).await.is_err());
    drop(runtime);
    let runtime = open(dir.path(), receiver);
    let i = input(receiver);
    assert_eq!(
        runtime.prepare_receipt(i).await.unwrap(),
        receipt_id(
            receiver,
            input(receiver).request_id,
            input(receiver).proof_id
        )
    );
    assert_eq!(runtime.sdk.issued_receipts().await.unwrap().len(), 1);
}
#[tokio::test]
async fn uncertain_link_does_not_poison_prepared_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let mut runtime = open(dir.path(), receiver);
    let id = runtime.prepare_receipt(input(receiver)).await.unwrap();
    let before = runtime.issuance(id).await.unwrap().unwrap();
    runtime
        .state
        .uncertain_peers
        .push((peer().to_string(), path().to_string()));
    assert!(runtime
        .process_receipt(receipt_input::Process {
            receiver_id: receiver,
            receipt_id: id
        })
        .await
        .unwrap_err()
        .to_string()
        .contains("relink"));
    assert!(runtime.issuance(id).await.unwrap().unwrap() == before);
    runtime.state.uncertain_peers.clear();
    assert_eq!(runtime.prepare_receipt(input(receiver)).await.unwrap(), id);
}
#[tokio::test]
async fn new_command_ids_return_original_receipt_without_regenerating_access() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let mut runtime = open(dir.path(), receiver);
    let i = input(receiver);
    let command = || Command {
        command_id: Uuid::new_v4(),
        command: "receipt.prepare".into(),
        input: json!({"receiverId":receiver,"requestId":i.request_id,"proofId":i.proof_id,"note":i.note}),
    };
    let first = runtime.execute(command()).await.unwrap().unwrap();
    let second = runtime.execute(command()).await.unwrap().unwrap();
    assert_eq!(first["receiptId"], second["receiptId"]);
    assert_eq!(runtime.sdk.issued_receipts().await.unwrap().len(), 1);
    let original = runtime
        .issuance(Uuid::parse_str(first["receiptId"].as_str().unwrap()).unwrap())
        .await
        .unwrap()
        .unwrap();
    drop(runtime);
    let mut reopened = open(dir.path(), receiver);
    assert_eq!(
        reopened.execute(command()).await.unwrap().unwrap()["receiptId"],
        first["receiptId"]
    );
    assert!(
        reopened
            .issuance(Uuid::parse_str(first["receiptId"].as_str().unwrap()).unwrap())
            .await
            .unwrap()
            .unwrap()
            == original
    );
}
#[tokio::test]
async fn payer_role_cannot_issue_a_receipt_for_its_own_proof() {
    let dir = tempfile::tempdir().unwrap();
    let receiver = Uuid::new_v4();
    let runtime = open(dir.path(), receiver);
    let mut state = runtime
        .storage
        .transaction(|tx| Ok(tx.export_storage_state()))
        .await
        .unwrap();
    let proposal = state.outbound_private_messages.remove(0);
    state.private_stream_items.clear();
    state.private_stream_items.push(PrivateStreamItemRecord {
        stream_item_id: 1,
        counterparty: proposal.counterparty,
        counterparty_receiver_path: proposal.counterparty_receiver_path,
        receive_batch_id: 1,
        raw_json: proposal.raw_json,
        parsed_version: Some(1),
        parsed_kind: Some(proposal.kind.clone()),
        known_paykit_kind: Some(proposal.kind),
        parse_status: paykit_sdk::PrivateStreamParseStatus::Valid,
        parse_error: None,
        received_at: chrono::Utc::now(),
    });
    runtime.vault.save("sdk.cbor", &state).unwrap();
    drop(runtime);
    let runtime = open(dir.path(), receiver);
    assert_eq!(
        runtime.sdk.payment_requests().await.unwrap()[0].local_role,
        Some(paykit_sdk::PaymentRequestLocalRole::Payer)
    );
    assert!(runtime.prepare_receipt(input(receiver)).await.is_err());
    assert!(runtime.sdk.issued_receipts().await.unwrap().is_empty());
}
