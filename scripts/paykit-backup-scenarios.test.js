const test = require('node:test');
const assert = require('node:assert/strict');
const { transferFrame, publicSnapshot, recoveryView, MAX_ARCHIVE } = require('./paykit-backup-scenarios');

const receiverId = '123e4567-e89b-42d3-a456-426614174000';
test('PKTR frame uses exact binary fields and big-endian lengths', () => {
  const passphrase = Buffer.from('correct horse battery staple'); const archive = Buffer.from([1, 2, 3]);
  const frame = transferFrame({ purpose: 2, receiverId, passphrase, archive });
  assert.equal(frame.subarray(0, 4).toString(), 'PKTR'); assert.equal(frame[4], 1); assert.equal(frame[5], 2);
  assert.equal(frame.subarray(6, 22).toString('hex'), receiverId.replaceAll('-', ''));
  assert.equal(frame.readUInt16BE(22), passphrase.length); assert.equal(frame.readUInt32BE(24), archive.length);
  assert.deepEqual(frame.subarray(28), Buffer.concat([passphrase, archive]));
});
test('frame rejects invalid scope, secrets and archive bounds', () => {
  assert.throws(() => transferFrame({ purpose: 3, receiverId, passphrase: Buffer.alloc(12) }));
  assert.throws(() => transferFrame({ purpose: 1, receiverId: 'bad', passphrase: Buffer.alloc(12) }));
  assert.throws(() => transferFrame({ purpose: 1, receiverId, passphrase: Buffer.alloc(11) }));
  assert.throws(() => transferFrame({ purpose: 2, receiverId, passphrase: Buffer.alloc(12), archive: Buffer.alloc(MAX_ARCHIVE + 1) }));
});
test('public state oracle selects only the receiver and its recovery view', () => {
  const snapshot = { receivers: [{ id: receiverId, status: 'stopped' }, { id: 'other' }], receiverWorkspaces: [{ receiverId, recovery: { phase: 'ready' } }, { receiverId: 'other' }] };
  assert.equal(recoveryView(snapshot, receiverId).phase, 'ready');
  assert.deepEqual(JSON.parse(publicSnapshot(snapshot, receiverId)), { receivers: [snapshot.receivers[0]], workspaces: [snapshot.receiverWorkspaces[0]] });
  assert.equal(JSON.parse(publicSnapshot(snapshot)).receivers.length, 2);
});
