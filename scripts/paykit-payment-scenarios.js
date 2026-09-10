/* Real Core/LND/Pubky receiving scenarios; no payments are executed here. */
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { sleep } = require('./paykit-harness');
const ONCHAIN = 'btc-onchain';
const BOLT11 = 'btc-lightning-bolt11';
const stages = ['wallet-bindings', 'public-receiving', 'explicit-method-resolution', 'private-reservations', 'private-version-consumption', 'reservation-rotation', 'delivered-cancellation', 'paused-expiry', 'wallet-cleanup-recovery', 'reservation-persistence', 'issuance-reconciliation', 'storage-commit-safety'];

async function run({ initial, state, command, request, stage, docker, serviceContainer, signal, walletFixture: fixture }) {
  assert(fixture, 'Real wallet fixture is required for cumulative payment scenarios');
  const participant = name => initial.participants.find(p => p.name === name);
  const receiver = (name, kind = 'wallet') => initial.receivers.find(r => r.participantId === participant(name).id && r.path.endsWith(`/${kind}`));
  const alice = receiver('Alice'); const bob = receiver('Bob'); const server = receiver('Bob', 'server'); const carol = receiver('Carol');
  const owner = r => initial.participants.find(p => p.id === r.participantId).publicKey;
  const peer = (local, remote) => ({ receiverId: local.id, peerPublicKey: owner(remote), peerReceiverPath: remote.path });
  const workspace = (snapshot, r) => snapshot.receiverWorkspaces.find(w => w.receiverId === r.id);
  const view = async r => workspace(await state(), r);
  const active = w => w.reservations.filter(r => r.status === 'active');
  const terms = { amountSats: '123', expirySeconds: 600 };
  const wait = async predicate => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await sleep(250, signal); }
    throw new Error('Payment scenario state condition timed out');
  };
  const configure = async (r, walletId, enabledMethods = [ONCHAIN, BOLT11], preference = []) => command('method.configure', { receiverId: r.id, walletId, enabledMethods, preference });
  const resolve = async (remote, source, method, expected = 'payable') => {
    const deadline = Date.now() + 30000;
    let resolution;
    do {
      const result = await command('paymentList.resolve', { ...peer(alice, remote), source, amountSats: terms.amountSats, ...(method ? { method } : {}) });
      resolution = result.operation.result.resolution;
      assert.equal(resolution.source, source);
      if (resolution.status === expected) return resolution;
      await sleep(400, signal);
    } while (Date.now() < deadline);
    assert.equal(resolution.status, expected);
    return resolution;
  };
  const published = remote => JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-payment-endpoints', owner(remote), remote.path)).paymentEndpoints;
  const inspect = async (local, remote) => {
    await command('receiver.stop', { receiverId: local.id });
    try { return JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-private-list', local.id, owner(remote), remote.path)); }
    finally { await command('receiver.start', { receiverId: local.id }); }
  };
  const verifyWallet = async (r, records, index) => {
    for (const record of records) {
      assert.equal(record.amountSats, terms.amountSats);
      if (record.method === ONCHAIN) {
        const owned = await fixture.core('getaddressinfo', [record.endpoint], `paykit-${owner(r)}`);
        assert.equal(owned.ismine, true);
        assert(owned.labels.some(label => (typeof label === 'string' ? label : label.name) === `paykit-reservation-${record.id}`));
      } else {
        const decoded = await fixture.lnd(index, 'decodepayreq', record.endpoint);
        assert.equal(decoded.num_satoshis, terms.amountSats);
        assert(BigInt(decoded.expiry) >= 1n);
        const invoice = await fixture.lnd(index, 'lookupinvoice', decoded.payment_hash);
        assert.equal(invoice.payment_request, record.endpoint);
        assert.equal(invoice.state, 'OPEN');
      }
    }
  };
  await configure(alice, fixture.walletIds.alice);
  await configure(bob, fixture.walletIds.bob);
  await configure(server, fixture.walletIds.bob);
  await configure(carol, fixture.walletIds.carol, [ONCHAIN], [ONCHAIN]);
  await command('method.configure', { receiverId: bob.id, walletId: fixture.walletIds.core, enabledMethods: [BOLT11], preference: [] }, randomUUID(), 'failed');
  for (const input of [{ receiverId: bob.id, amountSats: '1.1', expirySeconds: 60 }, { receiverId: bob.id, amountSats: '9007199254740993', expirySeconds: 60 }]) {
    assert.equal((await request('/v1/commands', { commandId: randomUUID(), command: 'paymentList.publish', input })).status, 400);
  }
  stage('wallet-bindings');

  const publication = await command('paymentList.publish', { receiverId: bob.id, ...terms });
  assert.equal((await request('/v1/commands', publication.body)).data.operationId, publication.operation.id);
  let bobView = await view(bob); const publicRecords = active(bobView).filter(r => r.source === 'public');
  assert.equal(publicRecords.length, 2); await verifyWallet(bob, publicRecords, 1);
  const publicEndpoints = published(bob);
  assert.equal(publicEndpoints.length, 2);
  for (const record of publicRecords) assert(publicEndpoints.some(p => p.method === record.method && p.endpoint === record.endpoint));
  assert.equal(published(server).length, 0);
  stage('public-receiving');

  await command('paymentList.resolve', { ...peer(alice, bob), source: 'public', amountSats: terms.amountSats }, randomUUID(), 'failed');
  await command('method.prefer', { receiverId: alice.id, preference: [BOLT11, ONCHAIN] });
  assert.equal((await resolve(bob, 'public')).method, BOLT11);
  assert.equal((await resolve(bob, 'public', ONCHAIN)).method, ONCHAIN);
  await resolve(bob, 'private', ONCHAIN, 'noEndpoint');
  await command('paymentList.resolve', { ...peer(alice, bob), source: 'public', amountSats: '124', method: BOLT11 }).then(result => assert.equal(result.operation.result.resolution.status, 'unsupportedEndpoint'));
  await configure(server, fixture.walletIds.bob, [ONCHAIN], [ONCHAIN]);
  await command('paymentList.publish', { receiverId: server.id, ...terms });
  await resolve(server, 'public', BOLT11, 'unsupportedEndpoint');
  await command('paymentList.unpublish', { receiverId: server.id });
  await configure(server, fixture.walletIds.bob);
  stage('explicit-method-resolution');

  await command('reservation.create', { ...peer(bob, alice), ...terms });
  await wait(s => active(workspace(s, bob)).filter(r => r.source === 'private').every(r => r.deliveryStatus === 'sent'));
  let resolved = await resolve(bob, 'private', ONCHAIN);
  assert.equal(typeof resolved.version, 'string');
  const privateRecords = active(await view(bob)).filter(r => r.source === 'private');
  assert.equal(privateRecords.length, 2); await verifyWallet(bob, privateRecords, 1);
  const decrypted = await inspect(alice, bob);
  assert.equal(decrypted.endpointCount, 2);
  for (const record of privateRecords) assert(decrypted.paymentEndpoints.some(p => p.method === record.method && p.endpoint === record.endpoint));
  await command('reservation.create', { ...peer(server, alice), ...terms });
  await wait(s => active(workspace(s, server)).filter(r => r.source === 'private').every(r => r.deliveryStatus === 'sent'));
  const sibling = await resolve(server, 'private', ONCHAIN);
  assert.notEqual(sibling.endpoint, resolved.endpoint);
  stage('private-reservations');

  const secondResolution = await resolve(bob, 'private', BOLT11);
  const consume = await command('paymentList.consume', { receiverId: alice.id, resolutionId: resolved.id });
  assert.equal((await request('/v1/commands', consume.body)).data.operationId, consume.operation.id);
  await command('paymentList.consume', { receiverId: alice.id, resolutionId: secondResolution.id }, randomUUID(), 'failed');
  await command('receiver.restart', { receiverId: alice.id });
  await resolve(bob, 'private', BOLT11, 'waitingForUpdatedPaymentList');
  await resolve(server, 'private', ONCHAIN);
  await resolve(bob, 'public', ONCHAIN);
  stage('private-version-consumption');

  await command('reservation.rotate', { ...peer(bob, alice), ...terms });
  await wait(s => active(workspace(s, bob)).filter(r => r.source === 'private').every(r => r.deliveryStatus === 'sent'));
  const rotated = await resolve(bob, 'private', ONCHAIN);
  assert(BigInt(rotated.version) > BigInt(resolved.version)); assert.notEqual(rotated.endpoint, resolved.endpoint);
  for (const old of privateRecords) { const retained = (await view(bob)).reservations.find(r => r.id === old.id); assert.equal(retained.status, 'superseded'); assert.equal(retained.cleanupStatus, 'complete'); }
  const replacementRecords = active(await view(bob)).filter(r => r.source === 'private');
  const assertStaleCancellationSafe = async oldRecords => {
    for (const old of oldRecords) await command('reservation.cancel', { receiverId: bob.id, reservationId: old.id }, randomUUID());
    // Drain the sender and receive at the peer before resolving: an immediate read
    // could incorrectly pass while an erroneous empty list is still in transit.
    await command('delivery.sync', { receiverId: bob.id });
    await command('delivery.sync', { receiverId: alice.id });
    for (const record of replacementRecords) {
      const currentResolution = await resolve(bob, 'private', record.method);
      assert.equal(currentResolution.version, rotated.version);
      assert.equal(currentResolution.endpoint, record.endpoint);
    }
    const afterCancellation = await view(bob);
    for (const record of replacementRecords) {
      const retainedReplacement = afterCancellation.reservations.find(r => r.id === record.id);
      assert.equal(retainedReplacement.status, 'active');
      assert.equal(retainedReplacement.endpoint, record.endpoint);
      assert.equal(retainedReplacement.cleanupStatus, 'notRequired');
    }
    await verifyWallet(bob, replacementRecords, 1);
    for (const old of oldRecords) {
      const currentOld = (await view(bob)).reservations.find(r => r.id === old.id);
      assert.equal(currentOld.status, old.status);
      assert.equal(currentOld.cleanupStatus, 'complete');
      if (old.method === BOLT11) {
        const oldInvoice = await fixture.lnd(1, 'decodepayreq', old.endpoint);
        assert.equal((await fixture.lnd(1, 'lookupinvoice', oldInvoice.payment_hash)).state, 'CANCELED');
      }
    }
  };
  const superseded = (await view(bob)).reservations.filter(r => privateRecords.some(old => old.id === r.id));
  await assertStaleCancellationSafe(superseded);
  await command('receiver.restart', { receiverId: bob.id });
  await assertStaleCancellationSafe(superseded);
  stage('reservation-rotation');

  const current = active(await view(bob)).find(r => r.source === 'private' && r.method === BOLT11);
  const invoice = await fixture.lnd(1, 'decodepayreq', current.endpoint);
  await command('reservation.cancel', { receiverId: bob.id, reservationId: current.id });
  await wait(s => workspace(s, bob).reservations.filter(r => r.listId === current.listId).every(r => r.deliveryStatus === 'sent'));
  assert.equal((await fixture.lnd(1, 'lookupinvoice', invoice.payment_hash)).state, 'CANCELED');
  await resolve(bob, 'private', ONCHAIN, 'noEndpoint');
  await command('paymentList.consume', { receiverId: alice.id, resolutionId: rotated.id }, randomUUID(), 'failed');
  const retained = (await view(bob)).reservations.find(r => r.listId === current.listId && r.method === ONCHAIN);
  assert.equal(retained.endpoint, rotated.endpoint); assert.equal(retained.status, 'cancelled');
  stage('delivered-cancellation');

  await command('delivery.pause', { receiverId: bob.id });
  await command('reservation.create', { ...peer(bob, alice), ...terms, expirySeconds: 3 });
  const expiring = active(await view(bob)).find(r => r.source === 'private');
  await wait(s => workspace(s, bob).reservations.filter(r => r.listId === expiring.listId).every(r => r.status === 'expired' && r.cleanupStatus === 'complete'));
  await command('receiver.restart', { receiverId: bob.id });
  assert.equal((await view(bob)).deliveryPaused, true);
  await command('delivery.resume', { receiverId: bob.id });
  await wait(s => workspace(s, bob).reservations.filter(r => r.listId === expiring.listId).every(r => r.deliveryStatus === 'sent'));
  await resolve(bob, 'private', ONCHAIN, 'noEndpoint');
  stage('paused-expiry');

  await command('reservation.create', { ...peer(bob, alice), ...terms });
  const cleanupRecord = active(await view(bob)).find(r => r.source === 'private' && r.method === BOLT11);
  await fixture.stopLnd(1);
  try {
    await command('reservation.cancel', { receiverId: bob.id, reservationId: cleanupRecord.id }, randomUUID(), 'failed');
    const failed = (await view(bob)).reservations.find(r => r.id === cleanupRecord.id);
    assert.equal(failed.status, 'cancelled'); assert.equal(failed.cleanupStatus, 'failed'); assert(failed.lastError);
  } finally { await fixture.startLnd(1); }
  // A repeated semantic cancellation must retry failed wallet cleanup without
  // starting a second withdrawal; explicit reconciliation remains idempotent.
  await command('reservation.cancel', { receiverId: bob.id, reservationId: cleanupRecord.id }, randomUUID());
  await command('reservation.reconcile', { receiverId: bob.id, reservationId: cleanupRecord.id });
  await wait(s => workspace(s, bob).reservations.find(r => r.id === cleanupRecord.id).cleanupStatus === 'complete');
  stage('wallet-cleanup-recovery');

  const before = (await view(bob)).reservations.map(r => ({ id: r.id, endpoint: r.endpoint, status: r.status }));
  await command('receiver.restart', { receiverId: bob.id });
  assert.deepEqual((await view(bob)).reservations.map(r => ({ id: r.id, endpoint: r.endpoint, status: r.status })), before);
  await command('reservation.create', { ...peer(bob, alice), ...terms });
  const fresh = active(await view(bob)).find(r => r.source === 'private' && r.method === ONCHAIN);
  assert(!before.some(r => r.endpoint === fresh.endpoint));
  await wait(s => active(workspace(s, bob)).filter(r => r.source === 'private').every(r => r.deliveryStatus === 'sent'));
  const replacementAfterCancel = await resolve(bob, 'private', ONCHAIN);
  for (const old of [current, cleanupRecord]) await command('reservation.cancel', { receiverId: bob.id, reservationId: old.id }, randomUUID());
  await command('delivery.sync', { receiverId: bob.id });
  await command('delivery.sync', { receiverId: alice.id });
  const unchanged = await resolve(bob, 'private', ONCHAIN);
  assert.equal(unchanged.version, replacementAfterCancel.version);
  assert.equal(unchanged.endpoint, fresh.endpoint);
  await verifyWallet(bob, active(await view(bob)).filter(r => r.source === 'private'), 1);
  stage('reservation-persistence');

  await configure(carol, fixture.walletIds.fault, [ONCHAIN], [ONCHAIN]);
  const countsBefore = await fixture.counts();
  const lost = await fixture.arm('core', 'drop');
  const lostCommand = await command('paymentList.publish', { receiverId: carol.id, ...terms }, randomUUID(), 'failed');
  await fixture.waitReady('core', lost);
  let uncertain = (await view(carol)).reservations.find(r => r.status === 'uncertain');
  assert(uncertain); assert.equal(uncertain.endpoint, undefined); assert.equal(published(carol).length, 0);
  assert.equal((await request('/v1/commands', lostCommand.body)).data.operationId, lostCommand.operation.id);
  await command('reservation.reconcile', { receiverId: carol.id, reservationId: uncertain.id });
  let recovered = (await view(carol)).reservations.find(r => r.id === uncertain.id);
  assert.equal(recovered.status, 'active');
  await verifyWallet(carol, [recovered], 2);
  let countsAfter = await fixture.counts(); assert.equal(countsAfter.core.issuanceSuccess, countsBefore.core.issuanceSuccess + 1);
  await command('paymentList.unpublish', { receiverId: carol.id });
  await configure(carol, fixture.walletIds.fault, [BOLT11], [BOLT11]);
  const lostInvoice = await fixture.arm('lnd', 'drop');
  await command('paymentList.publish', { receiverId: carol.id, ...terms }, randomUUID(), 'failed');
  await fixture.waitReady('lnd', lostInvoice);
  uncertain = (await view(carol)).reservations.find(r => r.status === 'uncertain'); assert(uncertain);
  await command('reservation.reconcile', { receiverId: carol.id, reservationId: uncertain.id });
  recovered = (await view(carol)).reservations.find(r => r.id === uncertain.id);
  await verifyWallet(carol, [recovered], 1);
  assert.equal((await fixture.counts()).lnd.issuanceSuccess, countsAfter.lnd.issuanceSuccess + 1);
  countsAfter = await fixture.counts();
  stage('issuance-reconciliation');

  await command('paymentList.unpublish', { receiverId: carol.id });
  await configure(carol, fixture.walletIds.fault, [ONCHAIN], [ONCHAIN]);
  const held = await fixture.arm('core', 'hold');
  const intent = command('paymentList.publish', { receiverId: carol.id, ...terms }, randomUUID(), 'failed');
  // Attach a handler while awaiting the independent response boundary; errors are
  // still asserted by await intent below. A boundary failure cannot leak a rejection.
  intent.catch(() => {});
  let restore;
  let released = false;
  try {
    await fixture.waitReady('core', held);
    restore = await fixture.blockLedgerCommit(carol.id, serviceContainer);
    await fixture.release('core', held, 'relay');
    released = true;
    await intent;
    assert.equal(published(carol).length, 0, 'A failed endpoint commit must prevent publication');
  } finally {
    try { if (restore) await restore(); }
    finally { if (!released) await fixture.release('core', held, 'drop'); }
  }
  await command('receiver.restart', { receiverId: carol.id });
  uncertain = (await view(carol)).reservations.find(r => r.status === 'uncertain'); assert(uncertain);
  await command('reservation.reconcile', { receiverId: carol.id, reservationId: uncertain.id });
  recovered = (await view(carol)).reservations.find(r => r.id === uncertain.id);
  await verifyWallet(carol, [recovered], 2);
  assert.equal((await fixture.counts()).core.issuanceSuccess, countsAfter.core.issuanceSuccess + 1);
  stage('storage-commit-safety');
}
module.exports = { stages, run };
