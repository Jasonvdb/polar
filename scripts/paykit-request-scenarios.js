/* Real requests, wallet execution and independent settlement on the isolated fixture. */
const assert = require('assert/strict');
const { randomUUID, createHash } = require('crypto');
const { sleep } = require('./paykit-harness');
const ONCHAIN = 'btc-onchain'; const BOLT11 = 'btc-lightning-bolt11';
const stages = ['funded-preset', 'request-lifecycle', 'onchain-execution', 'onchain-settlement', 'lightning-execution', 'lightning-settlement', 'invalid-payment-proofs', 'execution-idempotence', 'payment-failures', 'execution-reconciliation', 'execution-storage-safety', 'proof-delivery-recovery', 'request-receiver-isolation'];
async function run({ initial, state, command, request, stage, docker, serviceContainer, signal, walletFixture: fixture }) {
  assert(fixture, 'Real funded wallet fixture required');
  const participant = name => initial.participants.find(p => p.name === name);
  const receiver = (name, kind = 'wallet') => initial.receivers.find(r => r.participantId === participant(name).id && r.path.endsWith(`/${kind}`));
  const alice = receiver('Alice'); const bob = receiver('Bob'); const carol = receiver('Carol'); const server = receiver('Bob', 'server');
  const owner = r => initial.participants.find(p => p.id === r.participantId).publicKey;
  const peer = (local, remote) => ({ receiverId: local.id, peerPublicKey: owner(remote), peerReceiverPath: remote.path });
  const workspace = (s, r) => s.receiverWorkspaces.find(w => w.receiverId === r.id);
  const view = async r => workspace(await state(), r);
  const wait = async predicate => { const deadline = Date.now() + 150000; while (Date.now() < deadline) { const s = await state(); if (predicate(s)) return s; await sleep(300, signal); } throw new Error('Request scenario state condition timed out'); };
  const settleCommand = async (name, input, id = randomUUID()) => {
    const response = await request('/v1/commands', { commandId: id, command: name, input }); assert.equal(response.status, 202);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) { const op = (await request(`/v1/operations/${id}`)).data; if (['succeeded', 'failed'].includes(op.status)) return op; await sleep(250, signal); }
    throw new Error(`${name} operation timed out; no replacement sent`);
  };
  const configure = async (r, walletId, methods = [ONCHAIN, BOLT11]) => command('method.configure', { receiverId: r.id, walletId, enabledMethods: methods, preference: methods });
  const link = async (a, b) => {
    if ((await view(a)).links.some(l => l.peerPublicKey === owner(b) && l.peerReceiverPath === b.path && l.state === 'linked')) return;
    await command('link.initiate', peer(a, b)); await command('link.accept', peer(b, a));
    await wait(s => [a, b].every((r, i) => workspace(s, r).links.some(l => l.peerPublicKey === owner(i ? a : b) && l.state === 'linked')));
  };
  const proposal = async (payee = bob, payer = alice, amountSats = '5000', method = ONCHAIN, expirySeconds = 600, prepare = true) => {
    if (prepare) await publish(payee, method, amountSats);
    const result = await command('request.create', { ...peer(payee, payer), amountSats, description: `Request scenario ${randomUUID()}`, expirySeconds, acceptedMethods: [method] });
    const local = result.operation.result.workspace.requests[0]; assert(local && local.role === 'payee');
    await wait(s => workspace(s, payer).requests.some(r => r.id === local.id)); return local.id;
  };
  const accepted = async (payee = bob, payer = alice, amountSats = '5000', method = ONCHAIN, prepare = true) => {
    const id = await proposal(payee, payer, amountSats, method, 600, prepare); await command('request.accept', { receiverId: payer.id, requestId: id });
    await wait(s => workspace(s, payee).requests.find(r => r.id === id)?.lifecycle === 'accepted'); return id;
  };
  const publish = async (r = bob, method = ONCHAIN, amountSats = '5000', expirySeconds = 600) => {
    await configure(r, r === bob ? fixture.walletIds.bob : fixture.walletIds.carol, [method]);
    await command('paymentList.publish', { receiverId: r.id, amountSats, expirySeconds });
  };
  const execute = async (id, r = alice, walletId = fixture.walletIds.alice, method = ONCHAIN, source = 'public') => {
    const op = await settleCommand('payment.execute', { receiverId: r.id, requestId: id, walletId, source, method });
    return { op, execution: (await view(r)).executions.find(e => e.requestId === id) };
  };
  const submit = async (id, execution, payer = alice, payee = bob) => {
    await command('proof.submit', { receiverId: payer.id, requestId: id, executionId: execution.id });
    const s = await wait(s => workspace(s, payee).proofs.some(p => p.requestId === id)); return workspace(s, payee).proofs.find(p => p.requestId === id);
  };
  const verify = async (id, proof, requiredConfirmations = 1, payee = bob) => {
    await command('proof.verify', { receiverId: payee.id, requestId: id, proofId: proof.id, requiredConfirmations });
    return (await view(payee)).settlements.find(s => s.proofId === proof.id);
  };
  const mine = async count => { const address = await fixture.core('getnewaddress', [], ''); await fixture.core('generatetoaddress', [count, address]); };
  const transactions = async r => (await fixture.core('listtransactions', ['*', 10000, 0, true], `paykit-${owner(r)}`)).filter(t => t.category === 'send').map(t => t.txid).sort();
  await command('preset.fund', {}); let funded = (await state()).funding;
  assert.equal(funded.status, 'ready'); assert.equal(funded.funded, true); assert.equal(funded.wallets.length, 3); assert.equal(funded.channelPoints.length, 2);
  const channelPoints = [...funded.channelPoints];
  await command('preset.fund', {}); assert.deepEqual((await state()).funding.channelPoints, channelPoints);
  // The receiving scenarios leave Carol's recovered public endpoint on the fault wallet.
  // Retire that endpoint through the product before changing its trusted wallet binding.
  await command('paymentList.unpublish', { receiverId: carol.id });
  const inheritedCarol = await view(carol);
  assert(inheritedCarol.reservations.every(r => !['issuing', 'uncertain', 'active'].includes(r.status) && r.cleanupStatus === 'complete'), 'Carol endpoint cleanup must finish before wallet rebinding');
  await configure(alice, fixture.walletIds.alice); await configure(bob, fixture.walletIds.bob); await configure(server, fixture.walletIds.bob); await configure(carol, fixture.walletIds.carol);
  await link(alice, bob); await link(alice, carol); await link(bob, carol); stage('funded-preset');

  let id = await proposal();
  await command('request.accept', { receiverId: bob.id, requestId: id }, randomUUID(), 'failed');
  await command('request.reject', { receiverId: alice.id, requestId: id });
  await wait(s => workspace(s, bob).requests.find(r => r.id === id)?.lifecycle === 'rejected');
  id = await accepted(); await command('request.cancel', { receiverId: bob.id, requestId: id });
  await wait(s => workspace(s, alice).requests.find(r => r.id === id)?.lifecycle === 'canceled');
  await command('payment.execute', { receiverId: alice.id, requestId: id, walletId: fixture.walletIds.alice, source: 'public', method: ONCHAIN }, randomUUID(), 'failed');
  const expiring = await proposal(bob, alice, '5000', ONCHAIN, 1); await sleep(1200, signal);
  await command('request.accept', { receiverId: alice.id, requestId: expiring }, randomUUID(), 'failed');
  for (const amountSats of ['1.5', '-1', '0', 100]) assert.equal((await request('/v1/commands', { commandId: randomUUID(), command: 'request.create', input: { ...peer(bob, alice), amountSats, description: 'invalid', expirySeconds: 60, acceptedMethods: [ONCHAIN] } })).status, 400);
  stage('request-lifecycle');

  await publish(); const chainId = await accepted(); const chain = await execute(chainId); assert.equal(chain.execution.status, 'succeeded');
  let tx = await fixture.core('getrawtransaction', [chain.execution.txid, true]);
  assert.equal(String(tx.vout[chain.execution.outputIndex].value), '0.00005'); assert.equal(tx.vout[chain.execution.outputIndex].scriptPubKey.address, chain.execution.endpoint);
  assert.equal(tx.confirmations || 0, 0); stage('onchain-execution');
  const chainProof = await submit(chainId, chain.execution); assert.equal((await verify(chainId, chainProof)).status, 'pending');
  await mine(1); assert.equal((await verify(chainId, chainProof, 2)).status, 'pending');
  await mine(1); assert.equal((await verify(chainId, chainProof, 2)).status, 'verified');
  await publish(bob, ONCHAIN, '7777');
  await command('reservation.rotate', { ...peer(bob, alice), amountSats: '7777', expirySeconds: 600 });
  await wait(s => workspace(s, bob).reservations.some(r => r.source === 'private' && r.status === 'active' && r.amountSats === '7777' && r.deliveryStatus === 'sent'));
  const privateId = await accepted(bob, alice, '7777', ONCHAIN, false);
  const privatePayment = await execute(privateId, alice, fixture.walletIds.alice, ONCHAIN, 'private'); assert.equal(privatePayment.execution.status, 'succeeded');
  const privateProof = await submit(privateId, privatePayment.execution); await mine(1); assert.equal((await verify(privateId, privateProof)).status, 'verified');
  const consumed = await command('paymentList.resolve', { ...peer(alice, bob), source: 'private', method: ONCHAIN, amountSats: '7777' }); assert.equal(consumed.operation.result.resolution.status, 'waitingForUpdatedPaymentList');
  stage('onchain-settlement');

  await publish(bob, BOLT11, '123'); const lightningId = await accepted(bob, alice, '123', BOLT11); const lightning = await execute(lightningId, alice, fixture.walletIds.alice, BOLT11);
  assert.equal(lightning.execution.status, 'succeeded');
  const invoice = await fixture.lnd(1, 'lookupinvoice', lightning.execution.paymentHash); assert.equal(invoice.state, 'SETTLED'); assert.equal(invoice.amt_paid_sat, '123'); stage('lightning-execution');
  const lightningProof = await submit(lightningId, lightning.execution); const preimage = Buffer.from(lightningProof.proof.preimage, 'hex');
  assert.equal(createHash('sha256').update(preimage).digest('hex'), lightning.execution.paymentHash); assert.equal((await verify(lightningId, lightningProof)).status, 'verified'); stage('lightning-settlement');

  const reuseId = await accepted(bob, alice, '123', BOLT11);
  await command('proof.submit', { receiverId: alice.id, requestId: reuseId, proof: lightningProof.proof });
  let s = await wait(s => workspace(s, bob).proofs.some(p => p.requestId === reuseId)); const reuse = workspace(s, bob).proofs.find(p => p.requestId === reuseId);
  assert.equal((await verify(reuseId, reuse)).status, 'invalid');
  const wrongId = await accepted(); await command('proof.submit', { receiverId: alice.id, requestId: wrongId, proof: { method: ONCHAIN, txid: chain.execution.txid, outputIndex: 999 } });
  s = await wait(s => workspace(s, bob).proofs.some(p => p.requestId === wrongId)); assert.equal((await verify(wrongId, workspace(s, bob).proofs.find(p => p.requestId === wrongId))).status, 'invalid');
  assert.equal((await request('/v1/commands', { commandId: randomUUID(), command: 'proof.submit', input: { receiverId: alice.id, requestId: wrongId, proof: { method: BOLT11, paymentHash: 'invalid', preimage: 'invalid' } } })).status, 400);
  const badPreimageId = await accepted(bob, alice, '123', BOLT11);
  const boundInvoice = (await view(bob)).requests.find(r => r.id === badPreimageId).endpointBindings.find(b => b.method === BOLT11).endpoint;
  const decodedBound = await fixture.lnd(1, 'decodepayreq', boundInvoice);
  await command('proof.submit', { receiverId: alice.id, requestId: badPreimageId, proof: { method: BOLT11, paymentHash: decodedBound.payment_hash, preimage: '00'.repeat(32) } });
  s = await wait(s => workspace(s, bob).proofs.some(p => p.requestId === badPreimageId));
  assert.equal((await verify(badPreimageId, workspace(s, bob).proofs.find(p => p.requestId === badPreimageId))).status, 'invalid');
  await publish(bob, ONCHAIN, '5000');
  const unrelated = (await view(bob)).reservations.find(r => r.status === 'active' && r.source === 'public' && r.method === ONCHAIN);
  await fixture.core('sendtoaddress', [unrelated.endpoint, '0.00005000'], `paykit-${owner(alice)}`);
  await command('request.create', { ...peer(bob, alice), amountSats: '5000', description: 'Old unrelated payment must not bind', expirySeconds: 600, acceptedMethods: [ONCHAIN] }, randomUUID(), 'failed');
  await mine(1);
  stage('invalid-payment-proofs');

  assert.equal((await request('/v1/commands', { commandId: chain.op.id, command: 'payment.execute', input: { receiverId: alice.id, requestId: chainId, walletId: fixture.walletIds.alice, source: 'public', method: ONCHAIN } })).data.operationId, chain.op.id);
  const before = await transactions(alice); const payments = (await fixture.lnd(0, 'listpayments', '--include_incomplete')).payments.map(p => p.payment_hash);
  for (const [requestId, method] of [[chainId, ONCHAIN], [lightningId, BOLT11]]) { await command('payment.execute', { receiverId: alice.id, requestId, walletId: fixture.walletIds.alice, source: 'public', method }); }
  await command('receiver.restart', { receiverId: alice.id }); await command('payment.reconcile', { receiverId: alice.id, executionId: chain.execution.id }); await command('payment.reconcile', { receiverId: alice.id, executionId: lightning.execution.id });
  assert.deepEqual(await transactions(alice), before); assert.deepEqual((await fixture.lnd(0, 'listpayments', '--include_incomplete')).payments.map(p => p.payment_hash), payments); stage('execution-idempotence');

  await publish(bob, ONCHAIN, '20000000'); id = await accepted(bob, alice, '20000000'); const poor = await execute(id); assert.equal(poor.execution.status, 'failed');
  await publish(bob, BOLT11, '123', 3); id = await accepted(bob, alice, '123', BOLT11, false); await sleep(3500, signal); const expired = await execute(id, alice, fixture.walletIds.alice, BOLT11); assert.equal(expired.op.status, 'failed'); assert.equal(expired.execution, undefined);
  await publish(carol, BOLT11, '321'); const noRouteId = await accepted(carol, alice, '321', BOLT11, false);
  await fixture.stopLnd(1);
  try {
    const noRoute = await execute(noRouteId, alice, fixture.walletIds.alice, BOLT11); assert(noRoute.execution);
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await settleCommand('payment.reconcile', { receiverId: alice.id, executionId: noRoute.execution.id });
      const current = (await view(alice)).executions.find(e => e.id === noRoute.execution.id);
      if (current.status === 'failed') break;
      assert.notEqual(current.status, 'succeeded', 'Offline intermediary must not deliver a payment'); await sleep(1000, signal);
    }
    assert.equal((await view(alice)).executions.find(e => e.id === noRoute.execution.id).status, 'failed');
  } finally { await fixture.startLnd(1); }
  stage('payment-failures');

  await publish(bob, ONCHAIN); const lostId = await accepted(); const count = (await fixture.counts()).core.executionSuccess;
  const fault = await fixture.arm('core', 'drop', 'sendrawtransaction'); const lost = await execute(lostId, alice, fixture.walletIds.fault); await fixture.waitReady('core', fault);
  assert(lost.execution); assert(['succeeded', 'uncertain'].includes(lost.execution.status));
  await command('receiver.restart', { receiverId: alice.id }); await command('payment.reconcile', { receiverId: alice.id, executionId: lost.execution.id });
  const recovered = (await view(alice)).executions.find(e => e.id === lost.execution.id); assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.txid, lost.execution.txid); assert.equal((await fixture.counts()).core.executionSuccess >= count + 1, true);
  await publish(carol, BOLT11, '321'); const lostLightningId = await accepted(carol, bob, '321', BOLT11, false);
  const lostLightningCount = (await fixture.counts()).lnd.executionSuccess;
  await configure(bob, fixture.walletIds.bob, [ONCHAIN, BOLT11]);
  const lostLightningFault = await fixture.arm('lnd', 'drop', 'sendpayment');
  const lostLightning = await execute(lostLightningId, bob, fixture.walletIds.fault, BOLT11); await fixture.waitReady('lnd', lostLightningFault);
  assert(lostLightning.execution); assert.equal(lostLightning.execution.status, 'uncertain');
  await command('receiver.restart', { receiverId: bob.id }); await command('payment.reconcile', { receiverId: bob.id, executionId: lostLightning.execution.id });
  const recoveredLightning = (await view(bob)).executions.find(e => e.id === lostLightning.execution.id); assert.equal(recoveredLightning.status, 'succeeded');
  assert.equal((await fixture.counts()).lnd.executionSuccess, lostLightningCount + 1);
  stage('execution-reconciliation');

  await publish(bob, ONCHAIN); const blockedId = await accepted(); const snapshots = await transactions(alice); const executionCount = (await view(alice)).executions.length;
  let restore = await fixture.blockExecutionCommit(serviceContainer);
  try { const failed = await execute(blockedId); assert.equal(failed.op.status, 'failed'); assert.equal(failed.execution, undefined); }
  finally { await restore(); }
  await command('receiver.restart', { receiverId: alice.id }); assert.deepEqual(await transactions(alice), snapshots); assert.equal((await view(alice)).executions.length, executionCount);
  restore = await fixture.blockWorkspaceCommit(alice.id, serviceContainer);
  try { await command('payment.execute', { receiverId: alice.id, requestId: blockedId, walletId: fixture.walletIds.alice, source: 'public', method: ONCHAIN }, randomUUID(), 'failed'); }
  finally { await restore(); }
  await command('receiver.restart', { receiverId: alice.id }); assert.deepEqual(await transactions(alice), snapshots);
  restore = await fixture.blockRequestCommit(bob.id, serviceContainer);
  try { await command('request.create', { ...peer(bob, alice), amountSats: '5000', description: 'Must not queue', expirySeconds: 60, acceptedMethods: [ONCHAIN] }, randomUUID(), 'failed'); }
  finally { await restore(); }
  await command('receiver.restart', { receiverId: bob.id }); stage('execution-storage-safety');

  await command('delivery.pause', { receiverId: alice.id }); await command('proof.submit', { receiverId: alice.id, requestId: lostId, executionId: recovered.id });
  assert(!(await view(bob)).proofs.some(p => p.requestId === lostId));
  await command('receiver.restart', { receiverId: alice.id }); await command('delivery.resume', { receiverId: alice.id });
  await wait(s => workspace(s, bob).proofs.some(p => p.requestId === lostId));
  await command('proof.submit', { receiverId: alice.id, requestId: lostId, executionId: recovered.id }); assert.equal((await view(alice)).proofs.filter(p => p.requestId === lostId).length, 1); stage('proof-delivery-recovery');
  assert.equal((await view(server)).requests.length, 0); assert.equal((await view(server)).executions.length, 0); assert.equal((await view(server)).proofs.length, 0); stage('request-receiver-isolation');
}
module.exports = { stages, run };
