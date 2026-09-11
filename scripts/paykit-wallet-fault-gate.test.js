'use strict';
// Import is inert; the final regression starts and cleans an isolated loopback HTTP fixture.
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
console.log('13 pure fault-gate assertions passed.');
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

const { signingEvidence } = require('./paykit-wallet-fault-gate');
const signedFixture = { hex: '001122', complete: true };
assert.deepEqual(safeRoute('core', {method:'POST',url:'/wallet/owner'},Buffer.from('{"method":"signrawtransactionwithwallet"}')), {operation:'signrawtransactionwithwallet',issuance:false,signing:true});
const signedEvidence = signingEvidence(result(200,{result:signedFixture,error:null}));
assert.match(signedEvidence.signedTransactionDigest,/^[a-f0-9]{64}$/);
assert.deepEqual(Object.keys(signedEvidence),['signedTransactionDigest']);
for(const response of [result(500,{result:signedFixture}),result(200,{result:{...signedFixture,complete:false}}),result(200,{result:{...signedFixture,hex:'invalid'}}),result(200,{result:signedFixture,error:{message:'private'}})]) assert.equal(signingEvidence(response),undefined);
console.log('Signing response evidence validates successful bytes and exposes only a digest.');


const { broadcastEvidence } = require('./paykit-wallet-fault-gate');
assert.deepEqual(broadcastEvidence(result(200, { result: fundingTxid, error: null })), { transactionId: fundingTxid });
for (const response of [result(500, { result: fundingTxid }), result(200, { result: fundingTxid.toUpperCase(), error: null }), result(200, { result: fundingTxid, error: { code: -1 } }), result(200, { result: signedFixture }), result(200, { result: 'short' })]) assert.equal(broadcastEvidence(response), undefined);

async function signingArmHttpRegression() {
  const http = require('node:http');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { once } = require('node:events');
  const { spawn, execFileSync } = require('node:child_process');
  const { randomUUID, createHash } = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-signing-gate-test-'));
  const write = (name, text) => { const file = path.join(root, name); fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); return file; };
  const wait = async condition => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) { const value = condition(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Signing gate regression timed out');
  };
  const freePort = async () => {
    const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
  };
  const signedHex = '0123456789abcdef'.repeat(16);
  const unsignedHex = 'fedcba9876543210'.repeat(16);
  const transactionId = '0123456789abcdef'.repeat(4);
  let upstreamCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    assert(['signrawtransactionwithwallet', 'sendrawtransaction'].includes(input.method));
    assert.equal(input.params[0], input.method === 'signrawtransactionwithwallet' ? unsignedHex : signedHex);
    upstreamCalls++; res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: input.method === 'signrawtransactionwithwallet' ? { complete: true, hex: signedHex } : transactionId, error: input.id === 'failed' ? { code: -1, message: signedHex } : null }));
  });
  let child;
  const clients = new Set();
  try {
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const key = path.join(root, 'key.pem'); const cert = path.join(root, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore', timeout: 10000 });
    fs.chmodSync(key, 0o600);
    const username = write('username', 'fixture-user'); const password = write('password', 'fixture-secret'); const macaroon = write('macaroon', 'fixture-macaroon');
    const corePort = await freePort(); let lndPort = await freePort(); while (lndPort === corePort) lndPort = await freePort();
    const configFile = write('config.json', JSON.stringify({ apiVersion: 1, controlDir: root, requestTimeoutMs: 5000, holdTimeoutMs: 5000,
      core: { url: `http://127.0.0.1:${upstream.address().port}`, listenPort: corePort, usernameFile: username, passwordFile: password },
      lnd: { url: 'https://127.0.0.1:1', listenPort: lndPort, macaroonFile: macaroon, upstreamCertFile: cert, gateCertFile: cert, gateKeyFile: key },
    }));
    child = spawn(process.execPath, [path.join(__dirname, 'paykit-wallet-fault-gate.js')], { env: { ...process.env, PAYKIT_FAULT_GATE_CONFIG: configFile }, stdio: 'ignore' });
    const exited = once(child, 'exit');
    await wait(() => { assert.equal(child.exitCode, null); return fs.existsSync(path.join(root, 'listening.json')); });
    for (const [operation, action] of [['signrawtransactionwithwallet', 'hold'], ['signrawtransactionwithwallet', 'drop'], ['sendrawtransaction', 'hold']]) {
      const nonce = randomUUID(); write('core.arm.json', JSON.stringify({ nonce, action, operation }));
      let settled = false;
      const outcome = new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port: corePort, method: 'POST', path: '/wallet/paykit-alice' }, res => {
          const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ body: Buffer.concat(chunks).toString() }));
        });
        clients.add(req); req.on('close', () => clients.delete(req)); req.on('error', () => resolve({ dropped: true }));
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 'paykit', method: operation, params: [operation === 'signrawtransactionwithwallet' ? unsignedHex : signedHex] }));
      }).then(value => { settled = true; return value; });
      const prefix = path.join(root, `core.${nonce}`);
      await wait(() => fs.existsSync(`${prefix}.ready.json`));
      assert(!fs.existsSync(path.join(root, 'core.arm.json'))); assert(fs.existsSync(`${prefix}.claimed.json`));
      const ready = JSON.parse(fs.readFileSync(`${prefix}.ready.json`));
      assert.equal(ready.nonce, nonce);
      if (operation === 'signrawtransactionwithwallet') {
        assert.equal(ready.successfulSigning, true); assert.equal(ready.transactionId, undefined);
        assert.equal(ready.signedTransactionDigest, createHash('sha256').update(Buffer.from(signedHex, 'hex')).digest('hex'));
        assert.equal(ready.counts.executionSuccess, 0);
      } else {
        assert.equal(ready.successfulExecution, true); assert.equal(ready.transactionId, transactionId);
        assert.equal(ready.signedTransactionDigest, undefined); assert.equal(ready.counts.executionSuccess, 1);
      }
      if (action === 'hold') {
        await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false, 'Signing response must remain held');
        write(`core.${nonce}.release.json`, JSON.stringify({ nonce, action: 'drop' }));
      }
      await wait(() => settled); assert.deepEqual(await outcome, { dropped: true });
      const publicEvidence = fs.readFileSync(path.join(root, 'events.ndjson'), 'utf8') + fs.readFileSync(`${prefix}.ready.json`, 'utf8');
      for (const secret of [signedHex, unsignedHex, 'fixture-secret', 'fixture-macaroon']) assert(!publicEvidence.includes(secret));
    }
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: corePort, method: 'POST', path: '/' }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 'failed', method: 'sendrawtransaction', params: [signedHex] }));
    });
    const events = fs.readFileSync(path.join(root, 'events.ndjson'), 'utf8');
    const failed = events.trim().split('\n').map(JSON.parse).filter(e => e.event === 'upstream.completed').at(-1);
    assert.equal(failed.successfulExecution, false); assert.equal(failed.transactionId, undefined); assert(!events.includes(signedHex));
    assert.equal(upstreamCalls, 4);
    child.kill('SIGTERM'); await exited; assert.equal(child.exitCode, 0);
    console.log('Actual HTTP signing/broadcast arms checkpoint, hold/drop, filter transaction IDs and redact material.');
  } finally {
    for (const client of clients) client.destroy();
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
signingArmHttpRegression().catch(error => { console.error(error); process.exitCode = 1; });
