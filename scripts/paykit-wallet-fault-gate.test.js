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
