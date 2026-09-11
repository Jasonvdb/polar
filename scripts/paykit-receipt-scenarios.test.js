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
