const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEvidence, validateReceiptEvidence } = require('./paykit-receipt-fixture');
function fixtureEvents() {
  const runId = randomUUID(); const environmentId = randomUUID(); const receiverId = randomUUID();
  return ['delete', 'corrupt', 'wrong-key'].flatMap(action => {
    const receiptId = randomUUID();
    const value = { version: 1, action, runId, environmentId, receiverId, receiptId, accessEventId: randomUUID(), exists: action !== 'delete', bytes: action === 'delete' ? 0 : 20, digest: action === 'delete' ? null : 'a'.repeat(64), originalDigest: 'b'.repeat(64), matchesPrepared: false, restored: false };
    return [value, { ...value, action: 'recover', exists: true, bytes: 30, digest: value.originalDigest, matchesPrepared: true, restored: true }];
  });
}
test('receipt evidence rejects secret fields, missing restoration and reused cached identities', () => {
  const events = fixtureEvents(); validateReceiptEvidence(events);
  assert.throws(() => validateEvidence({ ...events[0], key: 'must not cross boundary' }, events[0]));
  assert.throws(() => validateEvidence({ ...events[0], receiverId: randomUUID() }, events[0]));
  assert.throws(() => validateReceiptEvidence(events.slice(0, -1)));
  const wrongDigest = structuredClone(events); wrongDigest[1].digest = 'c'.repeat(64); assert.throws(() => validateReceiptEvidence(wrongDigest));
  const reused = structuredClone(events); reused[2].receiptId = reused[0].receiptId; reused[3].receiptId = reused[0].receiptId; assert.throws(() => validateReceiptEvidence(reused));
});
test('receipt evidence rejects malformed digest and dishonest absence', () => {
  const value = fixtureEvents()[0];
  assert.throws(() => validateEvidence({ ...value, digest: 'secret' }, value));
  assert.throws(() => validateEvidence({ ...value, bytes: 1 }, value));
  assert.throws(() => validateEvidence({ ...value, matchesPrepared: true }, value));
  assert.throws(() => validateReceiptEvidence([]));
});
module.exports = { fixtureEvents };
