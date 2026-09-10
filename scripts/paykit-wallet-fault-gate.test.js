'use strict';
// Pure checks only: importing the helper does not start listeners or read config.
const assert = require('node:assert/strict');
const { issuanceSucceeded, headersWithoutHop, safeRoute } = require('./paykit-wallet-fault-gate');
const result = (status, body) => ({ status, body: Buffer.from(JSON.stringify(body)) });
assert.equal(issuanceSucceeded('core', result(200, { result: 'bcrt1example', error: null })), true);
assert.equal(issuanceSucceeded('core', result(200, { result: null, error: { code: -1 } })), false);
assert.equal(issuanceSucceeded('lnd', result(200, { payment_request: 'lnbcrt1example', r_hash: 'test' })), true);
assert.equal(issuanceSucceeded('lnd', result(500, { payment_request: 'lnbcrt1example', r_hash: 'test' })), false);
assert.equal(issuanceSucceeded('lnd', result(200, { error: 'failure' })), false);
assert.equal(issuanceSucceeded('lnd', { status: 200, body: Buffer.from('not-json') }), false);
assert.deepEqual(headersWithoutHop({ connection: 'x-private-hop, close', 'x-private-hop': 'removed', 'content-type': 'application/json', host: 'removed', 'transfer-encoding': 'chunked' }), { 'content-type': 'application/json' });
assert.deepEqual(safeRoute('core', { method: 'POST', url: '/wallet/paykit-owner' }, Buffer.from('{"method":"getnewaddress"}')), { operation: 'getnewaddress', issuance: true });
assert.equal(safeRoute('core', { method: 'POST', url: '/wallet/' }, Buffer.from('{"method":"getaddressesbylabel"}')).issuance, false);
assert.equal(safeRoute('lnd', { method: 'POST', url: '/v1/invoices' }, Buffer.from('{}')).issuance, true);
assert.deepEqual(safeRoute('lnd', { method: 'GET', url: '/v1/invoice/PRIVATE_HASH' }, Buffer.alloc(0)), { operation: 'other-rest', issuance: false });
assert.throws(() => safeRoute('core', { method: 'POST', url: '/' }, Buffer.from('[{"method":"getnewaddress"}]')));
assert.throws(() => safeRoute('lnd', { method: 'GET', url: '//external.example/' }, Buffer.alloc(0)));
console.log('13 pure fault-gate assertions passed; no listeners, upstreams or runtime files created.');
const { executionSucceeded } = require('./paykit-wallet-fault-gate');
assert.equal(safeRoute('core', { method: 'POST', url: '/wallet/' }, Buffer.from('{"method":"sendrawtransaction"}')).execution, true);
assert.equal(safeRoute('lnd', { method: 'POST', url: '/v1/channels/transactions' }, Buffer.from('{}')).operation, 'sendpayment');
assert.equal(executionSucceeded('core', result(200, { result: 'a'.repeat(64), error: null })), true);
assert.equal(executionSucceeded('core', result(200, { result: 'address', error: null })), false);
assert.equal(executionSucceeded('core', result(500, { result: 'a'.repeat(64), error: null })), false);
assert.equal(executionSucceeded('lnd', result(200, { payment_hash: require('node:crypto').createHash('sha256').update(Buffer.alloc(32, 1)).digest('base64'), payment_preimage: Buffer.alloc(32, 1).toString('base64'), payment_error: '' })), true);
assert.equal(executionSucceeded('lnd', result(200, { payment_hash: 'hash', payment_preimage: '', payment_error: 'no route' })), false);
const { channelPoint, channelSucceeded, lndCredentialKind } = require('./paykit-wallet-fault-gate');
assert.deepEqual(safeRoute('lnd', { method: 'POST', url: '/v1/channels' }, Buffer.from('{}')), { operation: 'openchannel', issuance: false, channel: true });
assert.equal(safeRoute('lnd', { method: 'GET', url: '/v1/channels' }, Buffer.alloc(0)).channel, undefined);
const fundingTxid = '0123456789abcdef'.repeat(4);
const fundingBytes = Buffer.from(fundingTxid, 'hex').reverse().toString('base64');
assert.deepEqual(channelPoint(result(200, { funding_txid_str: fundingTxid, output_index: 2 })), { fundingTxid, outputIndex: 2 });
assert.deepEqual(channelPoint(result(200, { funding_txid_bytes: fundingBytes, output_index: 0 })), { fundingTxid, outputIndex: 0 });
assert.equal(channelSucceeded(result(200, { funding_txid_bytes: fundingBytes, output_index: 4294967295 })), true);
for (const body of [{ funding_txid_str: fundingTxid }, { funding_txid_str: 'short', output_index: 0 }, { funding_txid_bytes: 'not base64', output_index: 0 }, { funding_txid_str: fundingTxid, output_index: -1 }, { funding_txid_str: fundingTxid, output_index: 4294967296 }, { funding_txid_str: fundingTxid, output_index: '1' }, { funding_txid_str: fundingTxid, output_index: 0.5 }, { funding_txid_str: fundingTxid, funding_txid_bytes: fundingBytes, output_index: 0 }]) assert.equal(channelSucceeded(result(200, body)), false);
assert.equal(channelSucceeded(result(500, { funding_txid_str: fundingTxid, output_index: 0 })), false);
assert.equal(channelSucceeded({ status: 200, body: Buffer.from('bad JSON') }), false);
for (const route of ['GET /v1/newaddress?type=0', 'GET /v1/balance/blockchain', 'GET /v1/peers', 'POST /v1/peers', 'GET /v1/channels', 'POST /v1/channels', 'GET /v1/channels/pending']) {
  const [method, url] = route.split(' '); assert.equal(lndCredentialKind({ method, url }), 'setup');
}
for (const route of ['GET /v1/getinfo', 'POST /v1/channels/transactions', 'GET /v1/payments?include_incomplete=true']) {
  const [method, url] = route.split(' '); assert.equal(lndCredentialKind({ method, url }), 'payment');
}
for (const route of ['DELETE /v1/channels', 'POST /v1/newaddress', 'POST /v1/macaroon', 'GET /v1/channels/other', 'POST /v1/balance/blockchain', 'POST /v1/invoices']) {
  const [method, url] = route.split(' '); assert.equal(lndCredentialKind({ method, url }), 'invoices');
}
console.log('Channel response and exact credential routing assertions passed.');
