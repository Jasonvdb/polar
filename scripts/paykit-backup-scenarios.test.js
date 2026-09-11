const test = require('node:test');
const assert = require('node:assert/strict');
const { transferFrame, randomPassphrase, createTransfer, downloadArchive, publicSnapshot, assertPublicSnapshot, recoveryView, assertWrongReceiverPreview, receiverForPeer, withUnsafePeerArchive, prepareExactRecovery, MAX_ARCHIVE } = require('./paykit-backup-scenarios');

const receiverId = '123e4567-e89b-42d3-a456-426614174000';
const presetReceiverId = 'af9f976d-b4ff-5feb-af0e-4fad185109f1';
test('PKTR frame uses exact binary fields and big-endian lengths', () => {
  const passphrase = Buffer.from('correct horse battery staple'); const archive = Buffer.from([1, 2, 3]);
  const frame = transferFrame({ purpose: 2, receiverId, passphrase, archive });
  assert.equal(frame.subarray(0, 4).toString(), 'PKTR'); assert.equal(frame[4], 1); assert.equal(frame[5], 2);
  assert.equal(frame.subarray(6, 22).toString('hex'), receiverId.replaceAll('-', ''));
  assert.equal(frame.readUInt16BE(22), passphrase.length); assert.equal(frame.readUInt32BE(24), archive.length);
  assert.deepEqual(frame.subarray(28), Buffer.concat([passphrase, archive]));
});
test('PKTR frame accepts a deterministic UUIDv5 receiver', () => {
  const frame = transferFrame({ purpose: 1, receiverId: presetReceiverId, passphrase: Buffer.alloc(12) });
  assert.equal(frame.subarray(6, 22).toString('hex'), presetReceiverId.replaceAll('-', ''));
});
test('frame rejects invalid scope, secrets and archive bounds', () => {
  assert.throws(() => transferFrame({ purpose: 3, receiverId, passphrase: Buffer.alloc(12) }));
  assert.throws(() => transferFrame({ purpose: 1, receiverId: 'bad', passphrase: Buffer.alloc(12) }));
  assert.throws(() => transferFrame({ purpose: 1, receiverId, passphrase: Buffer.alloc(11) }));
  assert.throws(() => transferFrame({ purpose: 1, receiverId, passphrase: Buffer.alloc(12, 0xff) }), /valid UTF-8/);
  assert.throws(() => transferFrame({ purpose: 2, receiverId, passphrase: Buffer.alloc(12), archive: Buffer.alloc(MAX_ARCHIVE + 1) }));
});
test('random passphrases are bounded UTF-8 bytes accepted by framing', () => {
  for (let attempt = 0; attempt < 32; attempt++) {
    const passphrase = randomPassphrase();
    assert.equal(passphrase.length, 64); assert.match(passphrase.toString('utf8'), /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => transferFrame({ purpose: 1, receiverId, passphrase }));
    passphrase.fill(0);
  }
});
test('transfer IDs remain UUIDv4-only', async () => {
  await assert.rejects(
    downloadArchive({ base: 'http://127.0.0.1', token: 'token', transferId: presetReceiverId }),
  );
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    status: 201,
    json: async () => ({ transferId: presetReceiverId }),
  });
  try {
    await assert.rejects(
      createTransfer({ base: 'http://127.0.0.1', token: 'token', purpose: 1, receiverId, passphrase: Buffer.alloc(12) }),
    );
  } finally {
    global.fetch = originalFetch;
  }
});
test('public state oracle selects only the receiver and its recovery view', () => {
  const snapshot = { receivers: [{ id: receiverId, status: 'stopped' }, { id: 'other' }], receiverWorkspaces: [{ receiverId, recovery: { phase: 'ready' } }, { receiverId: 'other' }] };
  assert.equal(recoveryView(snapshot, receiverId).phase, 'ready');
  assert.deepEqual(JSON.parse(publicSnapshot(snapshot, receiverId)), { receivers: [snapshot.receivers[0]], workspaces: [snapshot.receiverWorkspaces[0]] });
  assert.equal(JSON.parse(publicSnapshot(snapshot)).receivers.length, 2);
});
test('public state oracle normalizes only derived system time and reports changed record paths', () => {
  const before = { receivers: [{ id: receiverId, status: 'stopped' }], receiverWorkspaces: [{ receiverId, applicationClock: { mode: 'system', now: '2026-09-11T16:00:00Z' }, requests: [{ id: 'request', lifecycle: 'accepted' }] }] };
  const expected = publicSnapshot(before);
  const later = structuredClone(before); later.receiverWorkspaces[0].applicationClock.now = '2026-09-11T16:01:00Z';
  assert.doesNotThrow(() => assertPublicSnapshot(later, expected, undefined, 'Clock-only query'));
  later.receiverWorkspaces[0].requests[0].lifecycle = 'proofSubmitted';
  assert.throws(() => assertPublicSnapshot(later, expected, undefined, 'Mutation'), error => {
    assert.equal(error.message, 'Mutation changed public state at workspaces[0].requests[0].lifecycle');
    assert(!error.message.includes('proofSubmitted') && !error.message.includes('accepted')); return true;
  });
});
test('wrong receiver preview is diagnostic and never claims restorability', () => {
  const transferId = '123e4567-e89b-42d3-a456-426614174001';
  assert.doesNotThrow(() => assertWrongReceiverPreview({ receiverId, transferId, identityMatches: true, receiverMatches: false, restorable: false }, receiverId, transferId));
  for (const invalid of [
    { receiverId: 'other', transferId, identityMatches: true, receiverMatches: false, restorable: false },
    { receiverId, transferId, identityMatches: false, receiverMatches: false, restorable: false },
    { receiverId, transferId, identityMatches: true, receiverMatches: true, restorable: false },
    { receiverId, transferId, identityMatches: true, receiverMatches: false, restorable: true },
  ]) assert.throws(() => assertWrongReceiverPreview(invalid, receiverId, transferId));
});
test('unsafe checkpoint repair and later relink resolve the exact same configured peer', () => {
  const initial = { participants: [{ id: 'participant', publicKey: 'peer-key' }], receivers: [{ id: receiverId, participantId: 'participant', path: 'peer/wallet' }] };
  const peer = { peerPublicKey: 'peer-key', peerReceiverPath: 'peer/wallet' };
  assert.equal(receiverForPeer(initial, peer), initial.receivers[0]);
  assert.equal(receiverForPeer(initial, { ...peer, peerPublicKey: 'other' }), undefined);
  assert.equal(receiverForPeer(initial, { ...peer, peerReceiverPath: 'other/path' }), undefined);
});
test('unsafe archive fixture restores the live SDK when export fails', async () => {
  const calls = [];
  const fixture = { markPeerUnsafe: (...args) => {
    calls.push(['mark', ...args]);
    return { unsafeCheckpoints: 1, restore: () => calls.push(['restore']) };
  } };
  await assert.rejects(withUnsafePeerArchive(fixture, receiverId, 'peer-key', 'peer/wallet', async () => {
    calls.push(['export']); throw new Error('export failed');
  }), /export failed/);
  assert.deepEqual(calls, [['mark', receiverId, 'peer-key', 'peer/wallet'], ['export'], ['restore']]);
});
test('exact recovery uses the three-step marker protocol before handshake', async () => {
  const local = { id: 'local', participantId: 'local-owner', path: 'local/wallet' };
  const remote = { id: 'remote', participantId: 'remote-owner', path: 'remote/wallet' };
  const initial = { participants: [{ id: 'local-owner', publicKey: 'local-key' }, { id: 'remote-owner', publicKey: 'remote-key' }] };
  const calls = []; let prepared = 0; let repaired = false;
  const links = receiver => [{
    peerPublicKey: receiver === local ? 'remote-key' : 'local-key',
    peerReceiverPath: receiver === local ? remote.path : local.path,
    state: repaired ? 'linked' : 'recoveryRequired',
    recoveryPreparation: { readyForHandshake: prepared === 3 },
  }];
  const requests = {
    wait: async predicate => {
      const snapshot = { receiverWorkspaces: [{ receiverId: local.id, links: links(local) }, { receiverId: remote.id, links: links(remote) }] };
      assert.equal(predicate(snapshot), true); return snapshot;
    },
  };
  const command = async (name, input) => {
    calls.push([name, input.receiverId]);
    if (name === 'link.prepareRecovery') prepared += 1;
    if (name === 'link.accept') repaired = true;
    return { operation: { result: { state: 'recoveryRequired', readyForHandshake: prepared === 3 } } };
  };
  await prepareExactRecovery(command, requests, initial, local, remote);
  assert.deepEqual(calls, [
    ['link.prepareRecovery', 'local'],
    ['link.prepareRecovery', 'remote'],
    ['link.prepareRecovery', 'local'],
    ['link.initiate', 'local'],
    ['link.accept', 'remote'],
  ]);
});
