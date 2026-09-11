const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateEvidence, stages } = require('./paykit-recurring-scenarios');
function sampleEvidence() {
  const hash = 'a'.repeat(64);
  return {
    version: 1,
    rails: ['btc-onchain', 'btc-lightning-bolt11'].map(method => ({
      requestId: randomUUID(), method, source: method === 'btc-onchain' ? 'public' : 'private', amountSats: '701', receiptId: randomUUID(), canceled: true,
      periods: [0, 1, 2].map(index => ({ index, startsAt: `2030-01-01T00:0${index}:00Z`, endsAt: `2030-01-01T00:0${index + 1}:00Z`, executionId: randomUUID(), proofId: randomUUID(), paymentReference: String(index).repeat(64), mode: index === 1 ? 'automatic' : 'manual', verified: true })),
      missedBefore: hash, missedAfter: hash, duplicateBefore: hash, duplicateAfter: hash,
    })),
    persistence: { before: hash, after: hash, clocksRetained: true, receiverIsolated: true },
    failures: { insufficientFunds: true, expiredInvoice: true, uncertainReconciled: true, uncertainPaymentReference: hash, uncertainBefore: hash, uncertainAfter: hash },
    clock: { blockBefore: hash, blockAfter: hash, invoiceTimestamp: 1700000000, invoiceExpiry: 600, applicationNow: '2030-01-01T00:00:00Z', invoicePaid: true, resetRejected: true },
  };
}
test('recurring evidence requires both rails, exact periods and no automatic backlog', () => {
  assert.equal(new Set(stages).size, stages.length);
  assert.doesNotThrow(() => validateEvidence(sampleEvidence()));
  for (const mutate of [
    e => e.rails.pop(),
    e => { e.rails[1].method = 'btc-onchain'; },
    e => { e.rails[1].source = 'public'; },
    e => { e.rails[0].periods[2].mode = 'automatic'; },
    e => { e.rails[0].periods[1].index = 0; },
    e => { e.rails[0].periods[1].startsAt = '2030-01-01T00:00:00Z'; },
    e => { e.rails[0].periods[2].executionId = e.rails[0].periods[1].executionId; },
    e => { e.rails[0].periods[2].paymentReference = e.rails[0].periods[1].paymentReference; },
    e => { e.rails[0].periods[0].verified = false; },
    e => { e.rails[0].missedAfter = 'b'.repeat(64); },
    e => { e.rails[0].duplicateAfter = 'b'.repeat(64); },
    e => { e.rails[0].canceled = false; },
    e => { e.persistence.clocksRetained = false; },
    e => { e.failures.uncertainReconciled = false; },
    e => { e.failures.uncertainAfter = 'b'.repeat(64); },
    e => { e.clock.blockAfter = 'b'.repeat(64); },
    e => { e.clock.applicationNow = '2020-01-01T00:00:00Z'; },
  ]) { const evidence = sampleEvidence(); mutate(evidence); assert.throws(() => validateEvidence(evidence)); }
});
test('recurring diagnostics reject unrecognized or secret-bearing fields at every level', () => {
  for (const select of [e => e, e => e.rails[0], e => e.rails[0].periods[0], e => e.persistence, e => e.failures, e => e.clock]) {
    const evidence = sampleEvidence(); select(evidence).preimage = 'private';
    assert.throws(() => validateEvidence(evidence));
  }
});


test('period commitments authenticate exact endpoint bytes, identity, source and method', () => {
  const { createHash } = require('node:crypto');
  const { assertEndpointCommitment } = require('./paykit-recurring-scenarios');
  const binding = { source: 'private', method: 'btc-lightning-bolt11', reservationId: '95ac94e0-4857-5bea-8454-3b47ba8360dd', endpoint: 'invoice-fixture' };
  const commitment = { source: binding.source, method: binding.method, reservationId: binding.reservationId, endpointHash: createHash('sha256').update(binding.endpoint, 'utf8').digest('hex') };
  const check = (c, b) => assertEndpointCommitment(c, b, binding.source, binding.method);
  assert.doesNotThrow(() => check(commitment, binding));
  for (const patch of [{ endpoint: binding.endpoint + ' ' }, { reservationId: randomUUID() }, { source: 'public' }, { method: 'btc-onchain' }]) assert.throws(() => check(commitment, { ...binding, ...patch }));
  for (const patch of [{ endpointHash: 'a'.repeat(64) }, { endpointHash: commitment.endpointHash.toUpperCase() }, { reservationId: '00000000-0000-0000-0000-000000000000' }, { source: 'public' }, { method: 'btc-onchain' }, { preimage: 'private' }]) assert.throws(() => check({ ...commitment, ...patch }, binding));
});
