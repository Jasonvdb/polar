/* Real settled payments -> encrypted Pubky receipts -> private access -> decryption. */
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const stages = ['receipt-eligibility', 'onchain-receipt', 'lightning-receipt', 'receipt-idempotence', 'receipt-prepared-restart', 'receipt-access-delivery-recovery', 'receipt-link-recovery', 'receipt-missing-ciphertext', 'receipt-corrupt-ciphertext', 'receipt-invalid-decryption', 'receipt-receiver-isolation', 'receipt-persistence'];
const ONCHAIN = 'btc-onchain'; const BOLT11 = 'btc-lightning-bolt11';
function assertReceipt(receipt, issuance, recipient) {
  assert(receipt);
  for (const key of ['id', 'requestId', 'proofId', 'paymentReference', 'method', 'amountSats', 'description', 'note', 'accessEventId']) assert.equal(receipt[key], issuance[key]);
  assert.equal(receipt.recipientPublicKey, recipient);
  assert(!Object.keys(receipt).some(key => /key$|secret|cipher|encrypt|location|metadata/i.test(key) && !['issuerPublicKey', 'recipientPublicKey'].includes(key)));
}
async function run({ initial, state, command, request, stage, walletFixture, receiptFixture, requests, restartEnvironment }) {
  assert(receiptFixture, 'A separately built non-shipping receipt fixture is required');
  const { alice, bob, carol, server, peer, view, wait, chain, lightning, invalid, unpaidRequestId, createPaid, mine, verify, unlinkLocally, relinkAfterRestart } = requests;
  const owner = r => initial.participants.find(p => p.id === r.participantId).publicKey;
  const issue = async paid => {
    const result = await command('receipt.prepare', { receiverId: bob.id, requestId: paid.requestId, proofId: paid.proof.id, note: 'Verified local payment' });
    return result.operation.result.workspace.receiptIssuances.find(r => r.id === result.operation.result.receiptId);
  };
  const issuance = async id => (await view(bob)).receiptIssuances.find(r => r.id === id);
  const process = receipt => command('receipt.process', { receiverId: bob.id, receiptId: receipt.id });
  const retrieve = receipt => command('receipt.retrieve', { ...peer(alice, bob), receiptId: receipt.id });
  const access = receipt => wait(s => s.receiverWorkspaces.find(w => w.receiverId === alice.id).receiptAccess.some(r => r.receiptId === receipt.id && r.peerPublicKey === owner(bob) && r.peerReceiverPath === bob.path));
  const history = async receipt => (await view(alice)).receipts.find(r => r.id === receipt.id && r.issuerPublicKey === owner(bob) && r.issuerReceiverPath === bob.path);
  const walletHistory = async () => ({
    core: (await walletFixture.core('listtransactions', ['*', 10000, 0, true], `paykit-${owner(alice)}`)).filter(t => t.category === 'send').map(t => ({ txid: t.txid, vout: t.vout, amount: t.amount })).sort((a, b) => `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`)),
    lightning: [0, 1, 2].map(index => walletFixture.lnd(index, 'listpayments', '--include_incomplete').payments.map(p => ({ hash: p.payment_hash, index: p.payment_index, status: p.status, value: p.value_sat }))),
  });
  const pending = await createPaid(ONCHAIN);
  assert.equal((await verify(pending.requestId, pending.proof)).status, 'pending');
  for (const [receiverId, requestId, proofId] of [
    [bob.id, pending.requestId, pending.proof.id], [bob.id, invalid.requestId, invalid.proof.id],
    [bob.id, unpaidRequestId, chain.proof.id], [alice.id, chain.requestId, chain.proof.id],
    [server.id, chain.requestId, chain.proof.id],
  ]) await command('receipt.prepare', { receiverId, requestId, proofId }, randomUUID(), 'failed');
  assert.equal((await view(bob)).receiptIssuances.length, 0);
  await mine(1); assert.equal((await verify(pending.requestId, pending.proof)).status, 'verified');
  const fresh = [pending];
  for (const method of [BOLT11, BOLT11]) {
    const paid = await createPaid(method, '234');
    assert.equal((await verify(paid.requestId, paid.proof)).status, 'verified'); fresh.push(paid);
  }
  const paymentsBefore = await walletHistory();
  stage('receipt-eligibility');

  const chainReceipt = await issue(chain);
  assert.equal(chainReceipt.status, 'pendingStorage'); assert.equal(chainReceipt.deliveryStatus, 'notQueued');
  assert.equal(receiptFixture.run('inspect', bob.id, chainReceipt.id).exists, false);
  await process(chainReceipt); await access(chainReceipt); await retrieve(chainReceipt);
  assertReceipt(await history(chainReceipt), chainReceipt, owner(alice));
  const chainBlob = receiptFixture.run('inspect', bob.id, chainReceipt.id); assert(chainBlob.matchesPrepared);
  stage('onchain-receipt');
  const lightningReceipt = await issue(lightning);
  await process(lightningReceipt); await access(lightningReceipt); await retrieve(lightningReceipt);
  assertReceipt(await history(lightningReceipt), lightningReceipt, owner(alice));
  assert(receiptFixture.run('inspect', bob.id, lightningReceipt.id).matchesPrepared);
  stage('lightning-receipt');

  await wait(s => s.receiverWorkspaces.find(w => w.receiverId === bob.id).receiptIssuances.find(r => r.id === chainReceipt.id)?.deliveryStatus === 'sent');
  const beforeRetry = await issuance(chainReceipt.id);
  const originalRetrievedAt = (await history(chainReceipt)).retrievedAt;
  const duplicateId = randomUUID();
  const input = { receiverId: bob.id, requestId: chain.requestId, proofId: chain.proof.id, note: chainReceipt.note };
  await command('receipt.prepare', input, duplicateId);
  const duplicate = await request('/v1/commands', { commandId: duplicateId, command: 'receipt.prepare', input });
  assert.equal(duplicate.status, 202); assert.equal(duplicate.data.operationId, duplicateId);
  await issue(chain); await process(chainReceipt); await retrieve(chainReceipt);
  assert.deepEqual(await issuance(chainReceipt.id), beforeRetry);
  assert.equal((await history(chainReceipt)).retrievedAt, originalRetrievedAt);
  assert.equal((await view(alice)).receiptAccess.filter(r => r.receiptId === chainReceipt.id).length, 1);
  assert.equal((await view(alice)).receipts.filter(r => r.id === chainReceipt.id).length, 1);
  await command('receipt.prepare', { ...input, note: 'Changed immutable content' }, randomUUID(), 'failed');
  assert.equal(receiptFixture.run('inspect', bob.id, chainReceipt.id).digest, chainBlob.digest);
  stage('receipt-idempotence');

  const offline = await issue(fresh[0]);
  const preparedBlob = receiptFixture.run('inspect', bob.id, offline.id);
  await command('receiver.restart', { receiverId: bob.id });
  await restartEnvironment();
  assert.equal((await issuance(offline.id)).status, 'pendingStorage');
  assert.equal((await issuance(offline.id)).accessEventId, offline.accessEventId);
  const afterRestart = receiptFixture.run('inspect', bob.id, offline.id);
  assert.equal(afterRestart.exists, false); assert.equal(afterRestart.originalDigest, preparedBlob.originalDigest);
  stage('receipt-prepared-restart');

  await command('delivery.pause', { receiverId: bob.id });
  try {
    await process(offline);
    const queued = await issuance(offline.id);
    assert.equal(queued.status, 'accessQueued'); assert(queued.outboundMessageId);
    assert(!(await view(alice)).receiptAccess.some(r => r.receiptId === offline.id));
    await command('receiver.restart', { receiverId: bob.id });
    await process(offline);
    assert.equal((await issuance(offline.id)).outboundMessageId, queued.outboundMessageId);
    assert.equal(receiptFixture.run('inspect', bob.id, offline.id).digest, preparedBlob.originalDigest);
  } finally { await command('delivery.resume', { receiverId: bob.id }); }
  await access(offline);
  assert.equal((await view(alice)).receiptAccess.filter(r => r.receiptId === offline.id).length, 1);
  stage('receipt-access-delivery-recovery');

  const linkRetry = await issue(fresh[1]);
  await unlinkLocally(bob, alice);
  // Already queued receipts remain acknowledged even without a currently usable link.
  await process(offline);
  await command('receipt.process', { receiverId: bob.id, receiptId: linkRetry.id }, randomUUID(), 'failed');
  assert.equal((await issuance(linkRetry.id)).status, 'pendingStorage');
  await relinkAfterRestart(bob, alice);
  await process(linkRetry); await access(linkRetry);
  assert.equal((await issuance(linkRetry.id)).accessEventId, linkRetry.accessEventId);
  stage('receipt-link-recovery');

  const finalFault = await issue(fresh[2]); await process(finalFault); await access(finalFault);
  for (const [receipt, action, failureStage, expectedStatus] of [
    [offline, 'delete', 'receipt-missing-ciphertext', 'notFound'],
    [linkRetry, 'corrupt', 'receipt-corrupt-ciphertext', 'failed'],
    [finalFault, 'wrong-key', 'receipt-invalid-decryption', 'failed'],
  ]) {
    assert.equal(await history(receipt), undefined, 'Fault must exercise uncached network retrieval');
    const original = receiptFixture.run('inspect', bob.id, receipt.id);
    const fault = receiptFixture.run(action, bob.id, receipt.id); assert.equal(fault.originalDigest, original.digest);
    try {
      await command('receipt.retrieve', { ...peer(alice, bob), receiptId: receipt.id }, randomUUID(), 'failed');
      const failed = (await view(alice)).receiptAccess.find(r => r.receiptId === receipt.id);
      assert.equal(failed.retrievalStatus, expectedStatus); assert(failed.lastError);
      assert.equal(await history(receipt), undefined);
    } finally { receiptFixture.run('recover', bob.id, receipt.id); }
    await retrieve(receipt); assertReceipt(await history(receipt), receipt, owner(alice));
    assert.equal(receiptFixture.run('inspect', bob.id, receipt.id).digest, original.digest);
    stage(failureStage);
  }
  for (const receiver of [server, carol]) {
    await command('receipt.retrieve', { ...peer(receiver, bob), receiptId: chainReceipt.id }, randomUUID(), 'failed');
    const workspace = await view(receiver);
    assert.equal(workspace.receiptIssuances.length, 0); assert.equal(workspace.receiptAccess.length, 0); assert.equal(workspace.receipts.length, 0);
  }
  await command('receipt.retrieve', { receiverId: alice.id, peerPublicKey: owner(bob), peerReceiverPath: server.path, receiptId: chainReceipt.id }, randomUUID(), 'failed');
  stage('receipt-receiver-isolation');
  const retained = (await view(alice)).receipts;
  const issued = (await view(bob)).receiptIssuances.map(r => ({ id: r.id, accessEventId: r.accessEventId, outboundMessageId: r.outboundMessageId, createdAt: r.createdAt }));
  await restartEnvironment();
  assert.deepEqual((await view(alice)).receipts, retained);
  assert.deepEqual((await view(bob)).receiptIssuances.map(r => ({ id: r.id, accessEventId: r.accessEventId, outboundMessageId: r.outboundMessageId, createdAt: r.createdAt })), issued);
  assert((await state()).receivers.every(r => r.status === 'running'));
  assert.deepEqual(await walletHistory(), paymentsBefore, 'Receipt work must not replay wallet payments');
  stage('receipt-persistence');
}
module.exports = { stages, run, assertReceipt };
