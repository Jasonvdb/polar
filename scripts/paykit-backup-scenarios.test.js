const test = require('node:test');
const assert = require('node:assert/strict');
const { transferFrame, randomPassphrase, createTransfer, downloadArchive, publicSnapshot, recoveryView, MAX_ARCHIVE } = require('./paykit-backup-scenarios');

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
