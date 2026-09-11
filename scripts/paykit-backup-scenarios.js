/* Encrypted receiver backup/recovery scenarios over the authenticated HTTP API. */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  assert(Buffer.from(secret.toString('utf8'), 'utf8').equals(secret), 'Passphrase must be valid UTF-8');
  assert(Buffer.isBuffer(archive) && archive.length <= MAX_ARCHIVE);
  const header = Buffer.alloc(28);
  header.write('PKTR', 0, 'ascii'); header[4] = 1; header[5] = purpose;
  uuidBytes(receiverId).copy(header, 6);
  header.writeUInt16BE(secret.length, 22); header.writeUInt32BE(archive.length, 24 - 0);
  return Buffer.concat([header, secret, archive]);
}

function randomPassphrase() { return Buffer.from(randomBytes(32).toString('hex'), 'utf8'); }

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
    assert.match(data.transferId, UUID_V4); return data.transferId;
  } finally { frame.fill(0); }
}

async function downloadArchive({ base, token, transferId, signal }) {
  assert.match(transferId, UUID_V4);
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
  const selected = receiverId ? snapshot.receiverWorkspaces.filter(value => value.receiverId === receiverId) : snapshot.receiverWorkspaces;
  const workspaces = selected.map(workspace => ({ ...workspace,
    ...(workspace.applicationClock?.mode === 'system' ? { applicationClock: { ...workspace.applicationClock, now: '<derived-system-time>' } } : {}),
  }));
  return JSON.stringify({ receivers, workspaces });
}

function changedPaths(actual, expected, path = '', changes = []) {
  if (changes.length >= 12 || Object.is(actual, expected)) return changes;
  if (typeof actual !== typeof expected || actual === null || expected === null || typeof actual !== 'object') {
    changes.push(path || '<root>'); return changes;
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) changedPaths(actual[key], expected[key], `${path}${Array.isArray(actual) ? `[${key}]` : `${path ? '.' : ''}${key}`}`, changes);
  return changes;
}

function assertPublicSnapshot(snapshot, expected, receiverId, label) {
  const actual = publicSnapshot(snapshot, receiverId);
  if (actual === expected) return;
  const paths = changedPaths(JSON.parse(actual), JSON.parse(expected));
  throw new Error(`${label} changed public state at ${paths.join(', ') || '<unknown>'}`);
}

function assertWrongReceiverPreview(result, receiverId, transferId) {
  assert.equal(result.receiverId, receiverId); assert.equal(result.transferId, transferId);
  assert.equal(result.identityMatches, true);
  assert.equal(result.receiverMatches, false); assert.equal(result.restorable, false);
}

function receiverForPeer(initial, peer) {
  return initial.receivers.find(receiver => receiver.path === peer.peerReceiverPath
    && initial.participants.find(participant => participant.id === receiver.participantId)?.publicKey === peer.peerPublicKey);
}

async function forceExactRelink(requests, initial, local, remote) {
  const owner = receiver => initial.participants.find(participant => participant.id === receiver.participantId).publicKey;
  const exact = (workspace, peer) => workspace.links.find(link => link.peerPublicKey === owner(peer) && link.peerReceiverPath === peer.path);
  await requests.unlinkLocally(local, remote);
  await requests.relinkAfterRestart(local, remote);
  assert.equal(exact(await requests.view(local), remote)?.state, 'linked');
  assert.equal(exact(await requests.view(remote), local)?.state, 'linked');
}

async function run({ initial, state, command, stage, signal, walletFixture: fixture, base, token, requests }) {
  assert(fixture?.loseReceiverState && fixture?.pruneBackupExecutions && fixture?.markPeerUnsafe && fixture?.backupJournalProjection, 'PR8 backup fixture capabilities are required');
  const bobParticipant = initial.participants.find(value => value.name === 'Bob');
  const bob = initial.receivers.find(value => value.participantId === bobParticipant.id && value.path.endsWith('/wallet'));
  const server = initial.receivers.find(value => value.participantId === bobParticipant.id && value.path.endsWith('/server'));
  const ownerKeys = ['Alice', 'Bob', 'Carol'].map(name => initial.participants.find(value => value.name === name).publicKey);
  const alice = requests.alice;
  const passphrase = randomPassphrase(); const alicePassphrase = randomPassphrase(); let archive; let aliceArchive;
  try {
    await requests.link(bob, requests.carol);
    const bobLinks = (await requests.view(bob)).links;
    const alicePeer = { peerPublicKey: initial.participants.find(value => value.id === alice.participantId).publicKey, peerReceiverPath: alice.path };
    const carol = requests.carol;
    const carolPeer = { peerPublicKey: initial.participants.find(value => value.id === carol.participantId).publicKey, peerReceiverPath: carol.path };
    const linkedPeer = bobLinks.find(value => value.state === 'linked' && value.peerPublicKey === alicePeer.peerPublicKey && value.peerReceiverPath === alicePeer.peerReceiverPath);
    const safePeer = bobLinks.find(value => value.state === 'linked' && value.peerPublicKey === carolPeer.peerPublicKey && value.peerReceiverPath === carolPeer.peerReceiverPath);
    assert(linkedPeer && safePeer, 'Backup recovery requires Bob linked to the exact Alice and Carol wallet peers');
    await command('receiver.stop', { receiverId: bob.id });
    const unsafe = fixture.markPeerUnsafe(bob.id, linkedPeer.peerPublicKey, linkedPeer.peerReceiverPath);
    assert.equal(unsafe.unsafeCheckpoints, 1);
    const exportId = await createTransfer({ base, token, purpose: 1, receiverId: bob.id, passphrase, signal });
    const exported = await command('backup.export', { receiverId: bob.id, transferId: exportId });
    assert.equal(exported.operation.result.receiverId, bob.id);
    archive = await downloadArchive({ base, token, transferId: exportId, signal });
    stage('backup-export');

    const receiversBeforeNegatives = (await state()).receivers;
    const serverBefore = receiversBeforeNegatives.find(value => value.id === server.id);
    assert.equal(serverBefore.status, 'running');
    const resumeAfterNegatives = receiversBeforeNegatives.filter(value => value.status === 'running');
    for (const receiver of resumeAfterNegatives) await command('receiver.stop', { receiverId: receiver.id });
    try {
      const histories = fixture.paymentHistory(ownerKeys);
      for (const candidate of [
        { receiverId: bob.id, password: randomPassphrase(), bytes: archive },
        { receiverId: bob.id, password: passphrase, bytes: Buffer.from(archive).fill(archive[archive.length - 1] ^ 1, archive.length - 1) },
      ]) {
        try {
          const beforeAll = publicSnapshot(await state()); const beforeTarget = publicSnapshot(await state(), candidate.receiverId);
          const transferId = await createTransfer({ base, token, purpose: 2, receiverId: candidate.receiverId, passphrase: candidate.password, archive: candidate.bytes, signal });
          const failed = await command('backup.inspect', { receiverId: candidate.receiverId, transferId }, undefined, 'failed');
          assert.equal(failed.operation.error.code, 'backup_invalid');
          const after = await state(); assertPublicSnapshot(after, beforeAll, undefined, 'Invalid backup inspect'); assertPublicSnapshot(after, beforeTarget, candidate.receiverId, 'Invalid backup target inspect');
          assert.deepEqual(fixture.paymentHistory(ownerKeys), histories);
        } finally {
          if (candidate.password !== passphrase) candidate.password.fill(0);
        }
      }
      const beforeAll = publicSnapshot(await state()); const beforeTarget = publicSnapshot(await state(), server.id);
      const beforeJournal = fixture.backupJournalProjection(); const beforeHistories = fixture.paymentHistory(ownerKeys);
      const transferId = await createTransfer({ base, token, purpose: 2, receiverId: server.id, passphrase, archive, signal });
      const inspected = await command('backup.inspect', { receiverId: server.id, transferId });
      assertWrongReceiverPreview(inspected.operation.result, server.id, transferId);
      let after = await state(); assertPublicSnapshot(after, beforeAll, undefined, 'Wrong-receiver preview'); assertPublicSnapshot(after, beforeTarget, server.id, 'Wrong-receiver target preview');
      assert.deepEqual(fixture.backupJournalProjection(), beforeJournal); assert.deepEqual(fixture.paymentHistory(ownerKeys), beforeHistories);
      const rejected = await command('backup.restore', { receiverId: server.id, transferId }, undefined, 'failed');
      assert.equal(rejected.operation.error.code, 'backup_invalid');
      after = await state(); assertPublicSnapshot(after, beforeAll, undefined, 'Wrong-receiver restore rejection'); assertPublicSnapshot(after, beforeTarget, server.id, 'Wrong-receiver target restore rejection');
      assert.deepEqual(fixture.backupJournalProjection(), beforeJournal); assert.deepEqual(fixture.paymentHistory(ownerKeys), beforeHistories);
    } finally {
      for (const receiver of resumeAfterNegatives) await command('receiver.start', { receiverId: receiver.id });
    }
    const receiversAfterNegatives = (await state()).receivers;
    for (const before of receiversBeforeNegatives) {
      const after = receiversAfterNegatives.find(value => value.id === before.id);
      assert.equal(after.status, before.status); assert.equal(after.path, before.path);
      assert.equal(after.noisePublicKey, before.noisePublicKey); assert.equal(after.participantId, before.participantId);
    }
    const serverAfter = receiversAfterNegatives.find(value => value.id === server.id);
    assert.equal(serverAfter.status, 'running'); assert.equal(serverAfter.path, serverBefore.path);
    assert.equal(serverAfter.noisePublicKey, serverBefore.noisePublicKey); assert.equal(serverAfter.participantId, serverBefore.participantId);
    stage('backup-invalid-archives');

    await command('receiver.start', { receiverId: bob.id });
    const unsafeRemote = receiverForPeer(initial, linkedPeer);
    assert(unsafeRemote, 'Unsafe checkpoint peer no longer resolves to one configured receiver');
    await forceExactRelink(requests, initial, bob, unsafeRemote);
    await command('receiver.stop', { receiverId: alice.id });
    const aliceExportId = await createTransfer({ base, token, purpose: 1, receiverId: alice.id, passphrase: alicePassphrase, signal });
    await command('backup.export', { receiverId: alice.id, transferId: aliceExportId });
    aliceArchive = await downloadArchive({ base, token, transferId: aliceExportId, signal });
    const journalBeforePayments = fixture.backupJournalProjection();
    await command('receiver.start', { receiverId: alice.id });
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

    await command('receiver.stop', { receiverId: alice.id });
    const completeAliceLoss = fixture.loseReceiverState(alice.id);
    const aliceTransfer = await createTransfer({ base, token, purpose: 2, receiverId: alice.id, passphrase: alicePassphrase, archive: aliceArchive, signal });
    const ownPreview = await command('backup.inspect', { receiverId: alice.id, transferId: aliceTransfer });
    assert.equal(ownPreview.operation.result.restorable, true); assert.equal(ownPreview.operation.result.sdkValidationPending, true);
    await command('backup.restore', { receiverId: alice.id, transferId: aliceTransfer }); completeAliceLoss();
    const restoredAlice = (await state()).receivers.find(value => value.id === alice.id);
    assert.equal(restoredAlice.path, alice.path); assert.equal(restoredAlice.noisePublicKey, alice.noisePublicKey);
    assert.deepEqual(fixture.backupJournalProjection(), paidJournal, 'Own-receiver restore changed immutable executions, survivors, or settlements');
    assert.deepEqual(fixture.paymentHistory(ownerKeys), paidHistory, 'Own-receiver restore replayed a financial send');

    for (const receiver of initial.receivers) {
      if ((await state()).receivers.find(value => value.id === receiver.id).status !== 'stopped') await command('receiver.stop', { receiverId: receiver.id });
    }
    const restoreJournal = fixture.pruneBackupExecutions(alice.id, coreExecution.txid, lightningExecution.paymentHash);
    const secondLoss = fixture.loseReceiverState(alice.id);
    const emptyTransfer = await createTransfer({ base, token, purpose: 2, receiverId: alice.id, passphrase: alicePassphrase, archive: aliceArchive, signal });
    await command('backup.restore', { receiverId: alice.id, transferId: emptyTransfer }); secondLoss();
    const unknown = recoveryView(await state(), alice.id);
    assert.equal(unknown.unknownAfterExportCount, 2); assert.equal(unknown.walletReconciled, false); assert.equal(unknown.automationPaused, true);
    assert(unknown.blockedReasons.includes('wallet_history_unknown'));
    assert.deepEqual(fixture.paymentHistory(ownerKeys), paidHistory);
    restoreJournal(); stage('backup-empty-oracle');

    for (const receiver of initial.receivers.filter(value => value.id !== alice.id)) await command('receiver.start', { receiverId: receiver.id });
    const beforeAliceReconcile = fixture.paymentHistory(ownerKeys);
    await command('recovery.reconcile', { receiverId: alice.id });
    assert.deepEqual(fixture.paymentHistory(ownerKeys), beforeAliceReconcile, 'Own-receiver reconciliation replayed a financial send');
    const aliceReady = recoveryView(await state(), alice.id);
    assert.equal(aliceReady.unknownAfterExportCount, 0); assert.equal(aliceReady.phase, 'ready'); assert.equal(aliceReady.automationPaused, false);
    await command('receiver.start', { receiverId: alice.id });
    const beforeReplay = fixture.paymentHistory(ownerKeys); const journalBeforeReplay = fixture.backupJournalProjection();
    await command('payment.execute', core.executionInput); await command('payment.execute', lightning.executionInput);
    assert.deepEqual(fixture.paymentHistory(ownerKeys), beforeReplay, 'Replayed durable execution intent sent another payment');
    assert.deepEqual(fixture.backupJournalProjection(), journalBeforeReplay, 'Replayed durable execution intent duplicated journal state');
    await command('receiver.stop', { receiverId: bob.id });
    await command('recovery.reconcile', { receiverId: bob.id });
    restored = await state(); const recovery = recoveryView(restored, bob.id);
    assert.equal(recovery.sdkValidated, true); assert.equal(recovery.walletReconciled, true);
    assert(recovery.peersRequiringRelink.some(value => value.peerPublicKey === linkedPeer.peerPublicKey && value.peerReceiverPath === linkedPeer.peerReceiverPath));
    assert(!recovery.peersRequiringRelink.some(value => value.peerPublicKey === safePeer.peerPublicKey && value.peerReceiverPath === safePeer.peerReceiverPath));
    await command('receiver.start', { receiverId: bob.id });
    const safeLink = (await requests.view(bob)).links.find(value => value.peerPublicKey === safePeer.peerPublicKey && value.peerReceiverPath === safePeer.peerReceiverPath);
    assert.equal(safeLink.state, 'linked');
    const safeReservation = { receiverId: bob.id, peerPublicKey: safePeer.peerPublicKey, peerReceiverPath: safePeer.peerReceiverPath, amountSats: '123', expirySeconds: 600 };
    const beforeBlockedSafePeer = fixture.paymentHistory(ownerKeys);
    const blockedSafePeer = await command('reservation.create', safeReservation, undefined, 'failed');
    assert.equal(blockedSafePeer.operation.error.code, 'recovery_required');
    assert.deepEqual(fixture.paymentHistory(ownerKeys), beforeBlockedSafePeer, 'Global recovery gate triggered a financial action');
    assert.equal(recovery.automationPaused, true); stage('backup-relink');
    await forceExactRelink(requests, initial, bob, unsafeRemote);
    await command('receiver.stop', { receiverId: bob.id });
    await command('recovery.reconcile', { receiverId: bob.id });
    const ready = recoveryView(await state(), bob.id);
    assert.equal(ready.phase, 'ready'); assert.equal(ready.automationPaused, false); assert.equal(ready.unknownAfterExportCount, 0); assert.deepEqual(ready.peersRequiringRelink, []);
    await command('receiver.start', { receiverId: bob.id });
    const beforeReadySafePeer = fixture.paymentHistory(ownerKeys);
    await command('delivery.resume', { receiverId: bob.id });
    await command('reservation.create', safeReservation); await command('delivery.sync', { receiverId: bob.id });
    assert.equal((await requests.view(bob)).links.find(value => value.peerPublicKey === safePeer.peerPublicKey && value.peerReceiverPath === safePeer.peerReceiverPath).state, 'linked');
    assert.deepEqual(fixture.paymentHistory(ownerKeys), beforeReadySafePeer, 'Ready safe-peer workflow changed outgoing wallet history');
    assert.deepEqual(fixture.paymentHistory(ownerKeys), paidHistory);
    assert((await state()).receivers.every(value => value.status === 'running')); stage('backup-ready');
    return { restoredReceiverId: bob.id, preservedCoreTxid: coreExecution.txid, preservedLightningHash: lightningExecution.paymentHash };
  } finally { passphrase.fill(0); alicePassphrase.fill(0); archive?.fill(0); aliceArchive?.fill(0); }
}

module.exports = { stages, run, transferFrame, randomPassphrase, createTransfer, downloadArchive, recoveryView, publicSnapshot, assertPublicSnapshot, assertWrongReceiverPreview, receiverForPeer, forceExactRelink, MAX_ARCHIVE };
