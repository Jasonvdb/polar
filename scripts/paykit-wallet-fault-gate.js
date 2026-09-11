#!/usr/bin/env node
'use strict';
// Test-only real-wallet forwarding gate. Used exclusively by the disposable CI fixture.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHmac, createHash } = require('node:crypto');

const LIMIT = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secret = randomBytes(32); // Digest correlation within this process; never written.
const sockets = new Set();
const upstreams = new Set();
const holds = new Set();
const servers = [];
const counts = { core: { requests: 0, issuanceSuccess: 0, executionSuccess: 0, channelSuccess: 0 }, lnd: { requests: 0, issuanceSuccess: 0, executionSuccess: 0, channelSuccess: 0 } };
let sequence = 0;
let stopping = false;
let config;

function privateFile(file) {
  if (!path.isAbsolute(file)) throw new Error('Expected absolute private file path');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Expected private regular file');
  }
  return fs.readFileSync(file);
}
function integer(value, fallback, maximum) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error('Invalid bound');
  return result;
}
function save(file, value) {
  const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function evidence(event, detail = {}) {
  // detail is constructed only from explicit safe fields below. Never log errors,
  // headers, URLs with parameters, bodies, credentials or upstream responses.
  fs.appendFileSync(path.join(config.controlDir, 'events.ndjson'), `${JSON.stringify({
    at: new Date().toISOString(), event, ...detail,
  })}\n`, { mode: 0o600 });
}
function targetSettings(value, protocol) {
  const url = new URL(value.url);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Expected origin-only upstream URL');
  }
  return url;
}
function loadConfig() {
  const value = JSON.parse(privateFile(process.env.PAYKIT_FAULT_GATE_CONFIG || ''));
  if (value.apiVersion !== 1 || !path.isAbsolute(value.controlDir)) throw new Error('Invalid config');
  const dir = fs.lstatSync(value.controlDir);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw new Error('Expected private control directory');
  value.coreUrl = targetSettings(value.core, 'http:');
  value.lndUrl = targetSettings(value.lnd, 'https:');
  value.corePort = integer(value.core.listenPort, 18444, 65535);
  value.lndPort = integer(value.lnd.listenPort, 8443, 65535);
  if (value.corePort === value.lndPort) throw new Error('Listeners must differ');
  value.requestTimeoutMs = integer(value.requestTimeoutMs, 30000, 60000);
  value.holdTimeoutMs = integer(value.holdTimeoutMs, 60000, 300000);
  value.coreAuth = `Basic ${Buffer.from(`${privateFile(value.core.usernameFile).toString().trim()}:${privateFile(value.core.passwordFile).toString().trim()}`).toString('base64')}`;
  value.lndMacaroon = privateFile(value.lnd.macaroonFile).toString('hex');
  value.lndPaymentMacaroon = value.lnd.paymentMacaroonFile ? privateFile(value.lnd.paymentMacaroonFile).toString('hex') : undefined;
  value.lndSetupMacaroon = value.lnd.setupMacaroonFile ? privateFile(value.lnd.setupMacaroonFile).toString('hex') : undefined;
  value.lndCa = fs.readFileSync(value.lnd.upstreamCertFile);
  value.gateCert = fs.readFileSync(value.lnd.gateCertFile);
  value.gateKey = privateFile(value.lnd.gateKeyFile);
  return value;
}
function signingEvidence(result) {
  if (result.status !== 200) return undefined;
  try {
    const response = JSON.parse(result.body);
    if (response.error || response.result?.complete !== true || !/^(?:[a-f0-9]{2})+$/.test(response.result.hex)) return undefined;
    return { signedTransactionDigest: require('crypto').createHash('sha256').update(Buffer.from(response.result.hex, 'hex')).digest('hex') };
  } catch (_) { return undefined; }
}
function safeRoute(channel, request, body) {
  const pathname = request.url.split('?')[0];
  if (!request.url.startsWith('/') || request.url.startsWith('//') || request.url.includes('#')) throw new Error('Invalid request path');
  if (channel === 'core') {
    if (request.method !== 'POST' || !/^\/(?:wallet\/[^/?]*)?$/.test(request.url)) throw new Error('Invalid Core route');
    let rpc;
    try { rpc = JSON.parse(body); } catch (_) { throw new Error('Invalid Core JSON'); }
    if (!rpc || Array.isArray(rpc) || typeof rpc.method !== 'string') throw new Error('Expected single Core RPC');
    if (rpc.method === 'signrawtransactionwithwallet') return { operation: 'signrawtransactionwithwallet', issuance: false, signing: true };
    if (rpc.method === 'sendrawtransaction') return { operation: 'sendrawtransaction', issuance: false, execution: true };
    return { operation: rpc.method === 'getnewaddress' ? 'getnewaddress' : 'other-rpc', issuance: rpc.method === 'getnewaddress' };
  }
  if (request.method === 'POST' && pathname === '/v1/channels') return { operation: 'openchannel', issuance: false, channel: true };
  if (request.method === 'POST' && pathname === '/v1/channels/transactions') return { operation: 'sendpayment', issuance: false, execution: true };
  // Origin is fixed; lookup hashes and query values are deliberately not logged.
  return { operation: request.method === 'POST' && pathname === '/v1/invoices' ? 'addinvoice' : 'other-rest', issuance: request.method === 'POST' && pathname === '/v1/invoices' };
}
function claim(channel, route) {
  if (!route.issuance && !route.execution && !route.channel) return undefined;
  const file = path.join(config.controlDir, `${channel}.arm.json`);
  let arm;
  try { arm = JSON.parse(privateFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!arm || !UUID.test(arm.nonce) || !['hold', 'drop'].includes(arm.action) || Object.keys(arm).some(k => !['nonce', 'action', 'operation'].includes(k))) {
    throw new Error('Invalid arm control');
  }
  if (arm.operation !== undefined && !(channel === 'core' ? ['sendrawtransaction', 'signrawtransactionwithwallet'] : ['sendpayment', 'openchannel']).includes(arm.operation)) throw new Error('Invalid arm operation');
  if (arm.operation ? arm.operation !== route.operation : !route.issuance) return undefined;
  const prefix = path.join(config.controlDir, `${channel}.${arm.nonce}`);
  if (fs.existsSync(`${prefix}.claimed.json`)) throw new Error('Nonce already claimed');
  fs.renameSync(file, `${prefix}.claimed.json`); // Synchronous atomic one-shot claim.
  return { ...arm, prefix };
}
function readBounded(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', chunk => {
      size += chunk.length;
      if (size > LIMIT) { reject(new Error('Body limit')); stream.destroy(); }
      else chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
    stream.once('aborted', () => reject(new Error('Stream aborted')));
  });
}
function headersWithoutHop(headers) {
  const ignored = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
  for (const token of String(headers.connection || '').split(',')) ignored.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !ignored.has(key.toLowerCase())));
}
function lndCredentialKind(request) {
  const route = `${request.method} ${request.url.split('?')[0]}`;
  // Keep GetInfo on its existing payment grant for actual wallet identity checks.
  if (['POST /v1/channels/transactions', 'GET /v1/payments', 'GET /v1/getinfo'].includes(route)) return 'payment';
  if (['GET /v1/newaddress', 'GET /v1/balance/blockchain', 'GET /v1/peers', 'POST /v1/peers', 'GET /v1/channels', 'POST /v1/channels', 'GET /v1/channels/pending'].includes(route)) return 'setup';
  return 'invoices';
}
function forward(channel, req, body) {
  const isLnd = channel === 'lnd';
  const target = isLnd ? config.lndUrl : config.coreUrl;
  const headers = headersWithoutHop(req.headers);
  headers.host = target.host;
  headers['content-length'] = String(body.length);
  // Replace supplied credentials with fixture-local credentials. They never leave
  // the selected real wallet's fixed origin.
  delete headers.authorization;
  delete headers['grpc-metadata-macaroon'];
  if (isLnd) {
    const kind = lndCredentialKind(req);
    const macaroon = kind === 'payment' ? config.lndPaymentMacaroon : kind === 'setup' ? config.lndSetupMacaroon : config.lndMacaroon;
    if (!macaroon) throw new Error('Requested restricted grant unavailable');
    headers['grpc-metadata-macaroon'] = macaroon;
  }
  else headers.authorization = config.coreAuth;
  return new Promise((resolve, reject) => {
    const transport = isLnd ? https : http;
    const upstream = transport.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      method: req.method, path: req.url, headers, agent: false,
      ...(isLnd ? { ca: config.lndCa, rejectUnauthorized: true } : {}),
    }, async response => {
      try { resolve({ status: response.statusCode, headers: response.headers, body: await readBounded(response) }); }
      catch (error) { reject(error); }
    });
    upstreams.add(upstream);
    const timer = setTimeout(() => upstream.destroy(new Error('Upstream deadline')), config.requestTimeoutMs);
    upstream.once('close', () => { clearTimeout(timer); upstreams.delete(upstream); });
    upstream.once('error', reject);
    upstream.end(body);
  });
}
function issuanceSucceeded(channel, response) {
  if (response.status < 200 || response.status >= 300) return false;
  let value;
  try { value = JSON.parse(response.body); } catch (_) { return false; }
  return channel === 'core'
    ? value && value.error == null && typeof value.result === 'string' && value.result.length > 0
    : value && typeof value.payment_request === 'string' && value.payment_request.length > 0 && typeof value.r_hash === 'string';
}
function executionSucceeded(channel, response) {
  if (response.status < 200 || response.status >= 300) return false;
  let value;
  try { value = JSON.parse(response.body); } catch (_) { return false; }
  if (channel === 'core') return value?.error == null && typeof value?.result === 'string' && /^[a-fA-F0-9]{64}$/.test(value.result);
  if (!value || value.payment_error || typeof value.payment_preimage !== 'string' || typeof value.payment_hash !== 'string') return false;
  const preimage = Buffer.from(value.payment_preimage, 'base64');
  const hash = Buffer.from(value.payment_hash, 'base64');
  return preimage.length === 32 && hash.length === 32 && preimage.some(byte => byte !== 0) && createHash('sha256').update(preimage).digest().equals(hash);
}
function channelPoint(response) {
  if (response.status < 200 || response.status >= 300) return undefined;
  let value;
  try { value = JSON.parse(response.body); } catch (_) { return undefined; }
  if (!value || !Number.isInteger(value.output_index) || value.output_index < 0 || value.output_index > 4294967295) return undefined;
  const hex = value.funding_txid_str;
  const base64 = value.funding_txid_bytes;
  let txid;
  if (typeof hex === 'string' && /^[a-fA-F0-9]{64}$/.test(hex) && !base64) txid = hex.toLowerCase();
  else if (!hex && typeof base64 === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(base64)) {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== base64) return undefined;
    txid = Buffer.from(bytes).reverse().toString('hex');
  } else return undefined;
  return { fundingTxid: txid, outputIndex: value.output_index };
}
function channelSucceeded(response) { return channelPoint(response) !== undefined; }
function relay(response, result) {
  const headers = headersWithoutHop(result.headers);
  headers['content-length'] = String(result.body.length);
  response.writeHead(result.status, headers);
  response.end(result.body);
}
function hold(response, result, arm, detail) {
  return new Promise(resolve => {
    let finished = false;
    let polling;
    let timeout;
    function finish(action, reason) {
      if (finished) return;
      finished = true;
      clearInterval(polling); clearTimeout(timeout);
      response.removeListener('close', closed);
      holds.delete(stop);
      evidence('hold.finished', { ...detail, action, reason });
      if (action === 'relay' && !response.destroyed) relay(response, result);
      else response.destroy();
      resolve();
    }
    function closed() { finish('drop', 'client-closed'); }
    const stop = () => finish('drop', 'shutdown');
    holds.add(stop);
    response.once('close', closed);
    polling = setInterval(() => {
      const releaseFile = `${arm.prefix}.release.json`;
      let release;
      try { release = JSON.parse(privateFile(releaseFile)); }
      catch (error) {
        if (error.code !== 'ENOENT') finish('drop', 'invalid-release');
        return;
      }
      if (!release || release.nonce !== arm.nonce || !['relay', 'drop'].includes(release.action) || Object.keys(release).some(k => !['nonce', 'action'].includes(k))) {
        finish('drop', 'invalid-release'); return;
      }
      fs.renameSync(releaseFile, `${arm.prefix}.released.json`);
      finish(release.action, 'control');
    }, 50);
    timeout = setTimeout(() => finish('drop', 'hold-deadline'), config.holdTimeoutMs);
    if (response.destroyed) closed();
  });
}
async function handle(channel, req, res) {
  const id = ++sequence;
  counts[channel].requests++;
  let initialTimer = setTimeout(() => { req.destroy(); res.destroy(); }, config.requestTimeoutMs);
  try {
    const body = await readBounded(req);
    clearTimeout(initialTimer); initialTimer = undefined;
    const route = safeRoute(channel, req, body);
    const identityDigest = createHmac('sha256', secret).update(body).digest('hex');
    const arm = claim(channel, route);
    const detail = { channel, id, operation: route.operation, identityDigest, ...(arm ? { nonce: arm.nonce } : {}) };
    evidence('request.forwarded', detail);
    const result = await forward(channel, req, body);
    const successfulIssuance = route.issuance && issuanceSucceeded(channel, result);
    if (successfulIssuance) counts[channel].issuanceSuccess++;
    const successfulExecution = !!route.execution && executionSucceeded(channel, result);
    if (successfulExecution) counts[channel].executionSuccess++;
    const signing = route.signing ? signingEvidence(result) : undefined;
    const successfulSigning = signing !== undefined;
    const point = route.channel ? channelPoint(result) : undefined;
    const successfulChannel = point !== undefined;
    if (successfulChannel) counts[channel].channelSuccess++;
    evidence('upstream.completed', { ...detail, status: result.status, successfulIssuance, successfulExecution, successfulSigning, ...(signing || {}), successfulChannel, ...(point || {}), counts: counts[channel] });
    if (!arm || (!successfulIssuance && !successfulExecution && !successfulSigning && !successfulChannel)) {
      if (arm) evidence('arm.not-triggered', { ...detail, reason: 'upstream-not-successful' });
      relay(res, result); return;
    }
    // This file proves a complete successful REAL wallet response was received
    // before any response bytes were sent to the calling Paykit adapter.
    save(`${arm.prefix}.ready.json`, { ...detail, upstreamCompletedAt: new Date().toISOString(), successfulIssuance, successfulExecution, successfulSigning, ...(signing || {}), successfulChannel, ...(point || {}), action: arm.action, counts: counts[channel] });
    if (arm.action === 'drop') { evidence('response.dropped', detail); res.destroy(); return; }
    await hold(res, result, arm, detail);
  } catch (_) {
    evidence('request.failed', { channel, id });
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{"error":"Disposable wallet gate request failed"}');
    } else res.destroy();
  } finally { clearTimeout(initialTimer); }
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (config) evidence('shutdown', { counts });
  for (const stop of [...holds]) stop();
  for (const upstream of upstreams) upstream.destroy();
  for (const server of servers) server.close();
  for (const socket of sockets) socket.destroy();
}
async function main() {
  config = loadConfig();
  // Never append one run's evidence to another process's log.
  const log = path.join(config.controlDir, 'events.ndjson');
  fs.closeSync(fs.openSync(log, 'wx', 0o600));
  const core = http.createServer((req, res) => { void handle('core', req, res); });
  const lnd = https.createServer({ cert: config.gateCert, key: config.gateKey }, (req, res) => { void handle('lnd', req, res); });
  servers.push(core, lnd);
  for (const server of servers) {
    server.maxConnections = 32;
    server.headersTimeout = config.requestTimeoutMs;
    server.requestTimeout = config.requestTimeoutMs;
    server.keepAliveTimeout = 1000;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('error', () => { process.exitCode = 1; shutdown(); });
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  await Promise.all([[core, config.corePort], [lnd, config.lndPort]].map(([server, port]) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  })));
  if (!stopping) {
    save(path.join(config.controlDir, 'listening.json'), { pid: process.pid, corePort: config.corePort, lndPort: config.lndPort, requestTimeoutMs: config.requestTimeoutMs, holdTimeoutMs: config.holdTimeoutMs });
    evidence('listening');
  }
}
if (require.main === module) main().catch(() => { process.exitCode = 1; shutdown(); });
module.exports = { signingEvidence, channelPoint, channelSucceeded, lndCredentialKind, executionSucceeded, issuanceSucceeded, headersWithoutHop, safeRoute };
