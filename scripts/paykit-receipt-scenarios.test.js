const test = require('node:test');
const assert = require('node:assert/strict');
const { assertReceipt } = require('./paykit-receipt-scenarios');
test('receipt comparison rejects changed amount, proof, identity and secret-bearing fields', () => {
  const issuance = { id: 'receipt', requestId: 'request', proofId: 'proof', paymentReference: 'reference', method: 'btc-onchain', amountSats: '9007199254740991', description: 'Immutable description', note: 'Note', accessEventId: 'event' };
  const receipt = { ...issuance, recipientPublicKey: 'alice', issuerPublicKey: 'bob', issuerReceiverPath: 'test/wallet', retrievedAt: '2026-09-11T00:00:00Z' };
  assertReceipt(receipt, issuance, 'alice');
  for (const field of ['amountSats', 'proofId', 'recipientPublicKey']) assert.throws(() => assertReceipt({ ...receipt, [field]: 'different' }, issuance, 'alice'));
  for (const field of ['key', 'accessKey', 'location', 'metadata', 'encryptedReceipt']) assert.throws(() => assertReceipt({ ...receipt, [field]: 'private' }, issuance, 'alice'));
});

test('payment setup failure retains identifiers and codes without raw wallet or SDK data', () => {
  const { assertPaidExecution } = require('./paykit-request-scenarios');
  const result = { op: { id: 'operation-id', status: 'succeeded', error: { code: 'public_code', message: 'secret-error' }, result: { signedTransaction: 'secret-transaction' } }, execution: { id: 'execution-id', status: 'failed', lastError: 'Insufficient confirmed funds including transaction fee.', preimage: 'secret-preimage' } };
  assert.throws(() => assertPaidExecution(result), error => {
    assert.match(error.message, /operation-id/); assert.match(error.message, /execution-id/);
    assert.match(error.message, /insufficient_confirmed_funds/); assert.match(error.message, /public_code/);
    assert(!error.message.includes('secret-')); return true;
  });
  assert.doesNotThrow(() => assertPaidExecution({ ...result, execution: { status: 'succeeded' } }));
});
