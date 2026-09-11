/* Encrypted receiver backup/recovery scenarios over the authenticated HTTP API. */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ARCHIVE = 24 * 1024 * 1024;
const stages = ['backup-export', 'backup-invalid-archives', 'backup-local-loss', 'backup-wallet-survivors', 'backup-empty-oracle', 'backup-relink', 'backup-ready'];

function uuidBytes(value) {
  assert.match(value, UUID);
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function transferFrame({ purpose, receiverId, passphrase, archive = Buffer.alloc(0) }) {
  assert([1, 2].includes(purpose));
  const secret = Buffer.isBuffer(passphrase) ? passphrase : Buffer.from(passphrase);
  assert(secret.length >= 12 && secret.length <= 1024);
  assert(Buffer.isBuffer(archive) && archive.length <= MAX_ARCHIVE);
  const header = Buffer.alloc(28);
  header.write('PKTR', 0, 'ascii'); header[4] = 1; header[5] = purpose;
  uuidBytes(receiverId).copy(header, 6);
  header.writeUInt16BE(secret.length, 22); header.writeUInt32BE(archive.length, 24 - 0);
  return Buffer.concat([header, secret, archive]);
}

async function boundedFetch(url, options, signal, timeoutMs = 30000) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`HTTP deadline exceeded: ${new URL(url).pathname}`)), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

async function createTransfer({ base, token, purpose, receiverId, passphrase, archive, signal }) {
  const frame = transferFrame({ purpose, receiverId, passphrase, archive });
  try {
    const response = await boundedFetch(`${base}/v1/transfers`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: frame }, signal);
    const data = await response.json();
    assert.equal(response.status, 201, `Transfer upload failed: ${data.error?.code || response.status}`);
    assert.match(data.transferId, UUID); return data.transferId;
  } finally { frame.fill(0); }
}

async function downloadArchive({ base, token, transferId, signal }) {
  assert.match(transferId, UUID);
  const response = await boundedFetch(`${base}/v1/transfers/${transferId}/archive`, { headers: { authorization: `Bearer ${token}` } }, signal);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  const archive = Buffer.from(await response.arrayBuffer());
  assert(archive.length > 0 && archive.length <= MAX_ARCHIVE); return archive;
}

function recoveryView(snapshot, receiverId) {
  return snapshot.receiverWorkspaces.find(value => value.receiverId === receiverId)?.recovery || null;
}

function publicSnapshot(snapshot, receiverId) {
  const receivers = receiverId ? snapshot.receivers.filter(value => value.id === receiverId) : snapshot.receivers;
  const workspaces = receiverId ? snapshot.receiverWorkspaces.filter(value => value.receiverId === receiverId) : snapshot.receiverWorkspaces;
  return JSON.stringify({ receivers, workspaces });
}

async function run({ initial, state, command, stage, signal, walletFixture: fixture, base, token, requests }) {
  assert(fixture?.loseReceiverState && fixture?.pruneBackupExecutions && fixture?.markPeerUnsafe && fixture?.backupJournalProjection, 'PR8 backup fixture capabilities are required');
  const bobParticipant = initial.participants.find(value => value.name === 'Bob');
  const bob = initial.receivers.find(value => value.participantId === bobParticipant.id && value.path.endsWith('/wallet'));
  const server = initial.receivers.find(value => value.participantId === bobParticipant.id && value.path.endsWith('/server'));
  const ownerKeys = ['Alice', 'Bob', 'Carol'].map(name => initial.participants.find(value => value.name === name).publicKey);
  const alice = requests.alice;
  const passphrase = randomBytes(32); let archive;
  try {
    await requests.link(bob, requests.carol);
    const linkedPeers = (await requests.view(bob)).links.filter(value => value.state === 'linked');
    assert(linkedPeers.length >= 2, 'Backup recovery requires two existing linked peers');
    const linkedPeer = linkedPeers[0]; const safePeer = linkedPeers[1];
    await command('receiver.stop', { receiverId: bob.id });
    const unsafe = fixture.markPeerUnsafe(bob.id, linkedPeer.peerPublicKey, linkedPeer.peerReceiverPath);
    assert.equal(unsafe.unsafeCheckpoints, 1);
    const exportId = await createTransfer({ base, token, purpose: 1, receiverId: bob.id, passphrase, signal });
    const exported = await command('backup.export', { receiverId: bob.id, transferId: exportId });
    assert.equal(exported.operation.result.receiverId, bob.id);
    archive = await downloadArchive({ base, token, transferId: exportId, signal });
    stage('backup-export');

    const histories = fixture.paymentHistory(ownerKeys);
    for (const candidate of [
      { receiverId: bob.id, password: randomBytes(32), bytes: archive },
      { receiverId: bob.id, password: passphrase, bytes: Buffer.from(archive).fill(archive[archive.length - 1] ^ 1, archive.length - 1) },
      { receiverId: server.id, password: passphrase, bytes: archive },
    ]) {
      const beforeAll = publicSnapshot(await state());
      const beforeTarget = publicSnapshot(await state(), candidate.receiverId);
      const transferId = await createTransfer({ base, token, purpose: 2, receiverId: candidate.receiverId, passphrase: candidate.password, archive: candidate.bytes, signal });
      const failed = await command('backup.inspect', { receiverId: candidate.receiverId, transferId }, undefined, 'failed');
      assert.equal(failed.operation.error.code, 'backup_invalid');
      const after = await state(); assert.equal(publicSnapshot(after), beforeAll); assert.equal(publicSnapshot(after, candidate.receiverId), beforeTarget);
      assert.deepEqual(fixture.paymentHistory(ownerKeys), histories);
      if (candidate.password !== passphrase) candidate.password.fill(0);
    }
    stage('backup-invalid-archives');

    const journalBeforePayments = fixture.backupJournalProjection();
    await command('receiver.start', { receiverId: bob.id });
    const core = await requests.createPaid('btc-onchain');
    const lightning = await requests.createPaid('btc-lightning-bolt11');
    const payer = await requests.view(alice);
    const coreExecution = payer.executions.find(value => value.requestId === core.requestId);
    const lightningExecution = payer.executions.find(value => value.requestId === lightning.requestId);
    assert.match(coreExecution.txid, /^[a-f0-9]{64}$/); assert.match(lightningExecution.paymentHash, /^[a-f0-9]{64}$/);
    const paidJournal = fixture.backupJournalProjection();
    assert.equal(paidJournal.executionCount, journalBeforePayments.executionCount + 2);
    assert.equal(paidJournal.settlementCount, journalBeforePayments.settlementCount + 2);
    assert.equal(paidJournal.terminalByReceiver[alice.id], (journalBeforePayments.terminalByReceiver[alice.id] || 0) + 2);
    const paidHistory = fixture.paymentHistory(ownerKeys);
    await command('receiver.stop', { receiverId: bob.id });
    const completeLoss = fixture.loseReceiverState(bob.id);
    const validTransfer = await createTransfer({ base, token, purpose: 2, receiverId: bob.id, passphrase, archive, signal });
    const preview = await command('backup.inspect', { receiverId: bob.id, transferId: validTransfer });
    assert.equal(preview.operation.result.restorable, true); assert.equal(preview.operation.result.sdkValidationPending, true);
    assert.equal(preview.operation.result.unsafeCheckpointCount, 1);
    assert(preview.operation.result.safeCheckpointCount >= 1);
    assert.deepEqual(preview.operation.result.peersRequiringRelink, [{ peerPublicKey: linkedPeer.peerPublicKey, peerReceiverPath: linkedPeer.peerReceiverPath }]);
    await command('backup.restore', { receiverId: bob.id, transferId: validTransfer }); completeLoss();
    assert.deepEqual(fixture.backupJournalProjection(), paidJournal, 'Restore changed immutable executions, survivors, or settlements');
    assert.deepEqual(fixture.paymentHistory(ownerKeys), paidHistory, 'Recovery changed real wallet history');
    let restored = await state();
    assert.equal(restored.receivers.find(value => value.id === bob.id).path, bob.path);
    assert.equal(restored.receivers.find(value => value.id === bob.id).noisePublicKey, bob.noisePublicKey);
    assert.equal(recoveryView(restored, bob.id).automationPaused, true);
    await command('receiver.start', { receiverId: bob.id });
    await command('delivery.resume', { receiverId: bob.id }, undefined, 'failed');
    await command('receiver.stop', { receiverId: bob.id });
    stage('backup-local-loss'); stage('backup-wallet-survivors');

    for (const receiver of initial.receivers) {
      if ((await state()).receivers.find(value => value.id === receiver.id).status !== 'stopped') await command('receiver.stop', { receiverId: receiver.id });
    }
    const restoreJournal = fixture.pruneBackupExecutions(alice.id, coreExecution.txid, lightningExecution.paymentHash);
    const secondLoss = fixture.loseReceiverState(bob.id);
    const emptyTransfer = await createTransfer({ base, token, purpose: 2, receiverId: bob.id, passphrase, archive, signal });
    await command('backup.restore', { receiverId: bob.id, transferId: emptyTransfer }); secondLoss();
    const unknown = recoveryView(await state(), bob.id);
    assert.equal(unknown.unknownAfterExportCount, 2); assert.equal(unknown.walletReconciled, false); assert.equal(unknown.automationPaused, true);
    assert(unknown.blockedReasons.includes('wallet_history_unknown'));
    assert.deepEqual(fixture.paymentHistory(ownerKeys), paidHistory);
    restoreJournal(); stage('backup-empty-oracle');

    for (const receiver of initial.receivers) await command('receiver.start', { receiverId: receiver.id });
    await command('recovery.reconcile', { receiverId: bob.id });
    restored = await state(); const recovery = recoveryView(restored, bob.id);
    assert.equal(recovery.sdkValidated, true); assert.equal(recovery.walletReconciled, true);
    assert(recovery.peersRequiringRelink.some(value => value.peerPublicKey === linkedPeer.peerPublicKey && value.peerReceiverPath === linkedPeer.peerReceiverPath));
    assert(!recovery.peersRequiringRelink.some(value => value.peerPublicKey === safePeer.peerPublicKey && value.peerReceiverPath === safePeer.peerReceiverPath));
    const safeLink = (await requests.view(bob)).links.find(value => value.peerPublicKey === safePeer.peerPublicKey && value.peerReceiverPath === safePeer.peerReceiverPath);
    assert.equal(safeLink.state, 'linked');
    await command('reservation.create', { receiverId: bob.id, peerPublicKey: safePeer.peerPublicKey, peerReceiverPath: safePeer.peerReceiverPath, amountSats: '123', expirySeconds: 600 });
    await command('delivery.sync', { receiverId: bob.id });
    assert.equal((await requests.view(bob)).links.find(value => value.peerPublicKey === safePeer.peerPublicKey && value.peerReceiverPath === safePeer.peerReceiverPath).state, 'linked');
    assert.equal(recovery.automationPaused, true); stage('backup-relink');
    const remote = initial.receivers.find(value => value.path === linkedPeer.peerReceiverPath && initial.participants.find(p => p.id === value.participantId)?.publicKey === linkedPeer.peerPublicKey);
    assert(remote); await requests.relinkAfterRestart(bob, remote);
    await command('recovery.reconcile', { receiverId: bob.id });
    const ready = recoveryView(await state(), bob.id);
    assert.equal(ready.phase, 'ready'); assert.equal(ready.automationPaused, false); assert.equal(ready.unknownAfterExportCount, 0);
    assert.deepEqual(fixture.paymentHistory(ownerKeys), paidHistory); stage('backup-ready');
    return { restoredReceiverId: bob.id, preservedCoreTxid: coreExecution.txid, preservedLightningHash: lightningExecution.paymentHash };
  } finally { passphrase.fill(0); archive?.fill(0); }
}

module.exports = { stages, run, transferFrame, createTransfer, downloadArchive, recoveryView, publicSnapshot, MAX_ARCHIVE };
