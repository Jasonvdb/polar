/* Disposable real regtest wallets and fault controls for the CI scenario runner. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { sleep } = require('./paykit-harness');

const images = {
  core: 'polarlightning/bitcoind:30.0@sha256:6b15e7efb79995a18441806f509e40316428a901f1cdc5c54cd25b03ac513cb9',
  lnd: 'polarlightning/lnd:0.20.0-beta@sha256:ad708a2dacccd6ae104e78577f6a724095b80bac76ddf363f4bf8d22fbe0979f',
  gate: 'node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mkdir = directory => fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const privateWrite = (file, value) => fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function cliValue(output) {
  try { return JSON.parse(output); } catch (_) { return output.trim(); }
}
async function waitFor(check, signal, description, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try { const result = check(); if (result) return result; } catch (_) { /* startup */ }
    await sleep(250, signal);
  }
  throw new Error(`${description} timed out`);
}
function storageFaults(stateRoot, journal = () => {}) {
  const pending = new Map();
  const root = fs.realpathSync(stateRoot);
  function setLedgerWritable(receiverId, writable) {
    assert(uuid.test(receiverId), 'Invalid receiver storage fault scope');
    const directory = path.join(root, 'receivers', receiverId);
    assert.equal(fs.realpathSync(directory), directory, 'Receiver fault path is not canonical');
    const target = path.join(directory, 'payments.cbor');
    if (writable) {
      const saved = pending.get(receiverId);
      if (!saved) return;
      const blocked = fs.lstatSync(target);
      assert(blocked.isDirectory() && !blocked.isSymbolicLink(), 'Storage fault target changed');
      fs.rmdirSync(target); // Must still be the empty directory created by this fault.
      if (saved.existed) fs.renameSync(saved.backup, target);
      pending.delete(receiverId);
      journal({ receiverId, faultId: saved.faultId, phase: 'host', active: false, boundary: 'payments.cbor atomic rename' });
      return;
    }
    assert(!pending.has(receiverId), 'Storage fault already active');
    const faultId = randomUUID();
    const backup = path.join(directory, `.payments-fixture-${faultId}`);
    let expected = { kind: 'absent' };
    let existed = false;
    try {
      const stat = fs.lstatSync(target);
      assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected regular payment ledger');
      expected = { kind: 'file', digest: createHash('sha256').update(fs.readFileSync(target)).digest('hex') };
      fs.renameSync(target, backup); existed = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.mkdirSync(target, { mode: 0o700 }); }
    catch (error) { if (existed) fs.renameSync(backup, target); throw error; }
    const saved = { backup, existed, expected, faultId };
    pending.set(receiverId, saved);
    journal({ receiverId, faultId, phase: 'host', active: true, boundary: 'payments.cbor atomic rename' });
    return saved;
  }
  function restoreFaults() {
    const failures = [];
    for (const receiverId of pending.keys()) {
      try { setLedgerWritable(receiverId, true); } catch (_) { failures.push(receiverId); }
    }
    assert.equal(failures.length, 0, `Storage fault restoration failed for ${failures.join(', ')}`);
  }
  return { setLedgerWritable, restoreFaults };
}
// Bind mounts can publish host rename results asynchronously. The scenario must
// observe each boundary from the same namespace as the receiver before proceeding.
function visibleStorageFaults(faults, readGuest, journal, { timeoutMs = 5000, pollMs = 50 } = {}) {
  async function confirm(receiverId, expected) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      try {
        const observed = await readGuest(receiverId);
        if (observed.kind === expected.kind &&
            (expected.kind !== 'file' || observed.digest === expected.digest)) return attempts;
      } catch (_) { /* Only a matching guest observation permits progression. */ }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Guest payment ledger ${expected.kind} visibility deadline exceeded`);
  }
  async function blockLedgerCommit(receiverId) {
    const saved = faults.setLedgerWritable(receiverId, false);
    const record = (active, observed, attempts) => journal({
      receiverId, faultId: saved.faultId, phase: 'guest', active,
      observed, attempts, boundary: 'payments.cbor atomic rename',
    });
    const restore = async () => {
      faults.setLedgerWritable(receiverId, true);
      const attempts = await confirm(receiverId, saved.expected);
      record(false, saved.expected.kind === 'file' ? 'originalFile' : 'absent', attempts);
    };
    try {
      const attempts = await confirm(receiverId, { kind: 'directory' });
      record(true, 'directory', attempts);
    } catch (error) {
      await restore();
      throw error;
    }
    return restore;
  }
  return { blockLedgerCommit };
}
function readGuestLedger(docker, serviceContainer, receiverId) {
  assert(uuid.test(receiverId));
  assert.equal(typeof docker.withTimeout, 'function', 'A bounded Docker probe is required');
  const output = docker.withTimeout(1000, 'exec', serviceContainer, 'sh', '-c',
    'if [ -L "$1" ]; then exit 2; elif [ -d "$1" ]; then echo directory; elif [ -f "$1" ]; then sha256sum "$1"; elif [ ! -e "$1" ]; then echo absent; else exit 2; fi',
    'paykit-ledger-visibility', `/data/receivers/${receiverId}/payments.cbor`).trim();
  if (output === 'directory' || output === 'absent') return { kind: output };
  const match = /^([a-f0-9]{64})\s/.exec(output);
  assert(match, 'Invalid guest ledger visibility response');
  // The encrypted-file digest is compared only in memory and never journaled.
  return { kind: 'file', digest: match[1] };
}
function gateControls(controlDir, signal) {
  function arm(channel, action = 'drop') {
    assert(['core', 'lnd'].includes(channel) && ['drop', 'hold'].includes(action));
    const file = path.join(controlDir, `${channel}.arm.json`);
    assert(!fs.existsSync(file), 'A gate control is already armed');
    const nonce = randomUUID();
    atomicJson(file, { nonce, action });
    return nonce;
  }
  function controlPath(channel, nonce, ending) {
    assert(['core', 'lnd'].includes(channel) && uuid.test(nonce));
    return path.join(controlDir, `${channel}.${nonce}.${ending}.json`);
  }
  async function waitReady(channel, nonce) {
    return waitFor(() => {
      const result = JSON.parse(fs.readFileSync(controlPath(channel, nonce, 'ready')));
      assert.equal(result.successfulIssuance, true);
      assert.equal(result.nonce, nonce);
      return result;
    }, signal, 'Actual wallet issuance response boundary', 45000);
  }
  function release(channel, nonce, action = 'relay') {
    assert(['relay', 'drop'].includes(action));
    atomicJson(controlPath(channel, nonce, 'release'), { nonce, action });
  }
  function counts() {
    const result = { core: { requests: 0, issuanceSuccess: 0 }, lnd: { requests: 0, issuanceSuccess: 0 } };
    const text = fs.readFileSync(path.join(controlDir, 'events.ndjson'), 'utf8');
    // appendFileSync writes whole records. Ignore an incomplete concurrent final line.
    for (const line of text.split('\n').slice(0, -1)) {
      const entry = JSON.parse(line);
      if (entry.event === 'upstream.completed') result[entry.channel] = entry.counts;
    }
    return result;
  }
  return { arm, waitReady, release, counts, controlDir };
}

async function createWalletFixture({ data, secrets, prefix, environmentId, uid, runId, docker, recordContainer, recordWallets, signal }) {
  const [userId, groupId] = uid.split(':');
  const label = `polar-paykit.test-run=${runId}`;
  const names = ['alice', 'bob', 'carol'];
  const walletIds = { core: 'core-0', alice: 'lnd-0-core-0', bob: 'lnd-1-core-0', carol: 'lnd-2-core-0', fault: 'fixture-fault-bob-core' };
  recordWallets({ walletIds, images, plannedNames: [`${prefix}-core`, ...names.map(name => `${prefix}-lnd-${name}`), `${prefix}-wallet-gate`], networkName: prefix });
  const stateRoot = path.join(data, 'state');
  const coreRoot = path.join(data, 'bitcoin');
  mkdir(coreRoot);
  const coreUser = 'paykitfixture';
  const corePassword = randomBytes(32).toString('hex');
  privateWrite(path.join(secrets, 'bitcoin.conf'), [
    'server=1', 'regtest=1', 'txindex=1', 'dnsseed=0', 'listenonion=0',
    'fallbackfee=0.0002', 'blockfilterindex=1', 'peerblockfilters=1',
    `rpcuser=${coreUser}`, `rpcpassword=${corePassword}`, '[regtest]',
    'rpcbind=0.0.0.0', 'rpcallowip=0.0.0.0/0', 'rpcport=18443',
    'zmqpubrawblock=tcp://0.0.0.0:28334', 'zmqpubrawtx=tcp://0.0.0.0:28335',
  ].join('\n'));
  const coreContainer = docker('run', '-d', '--name', `${prefix}-core`, '--label', label,
    '--network', prefix, '--network-alias', 'core', '-e', `USERID=${userId}`, '-e', `GROUPID=${groupId}`,
    '-v', `${coreRoot}:/home/bitcoin/.bitcoin`, '-v', `${path.join(secrets, 'bitcoin.conf')}:/run/bitcoin.conf:ro`,
    images.core, 'bitcoind', '-datadir=/home/bitcoin/.bitcoin', '-conf=/run/bitcoin.conf').trim();
  recordContainer(coreContainer);
  const core = (method, params = [], walletName) => {
    signal?.throwIfAborted();
    return cliValue(docker('exec', coreContainer, 'bitcoin-cli', '-datadir=/home/bitcoin/.bitcoin', '-conf=/run/bitcoin.conf', '-regtest',
      ...(walletName === undefined ? [] : [`-rpcwallet=${walletName}`]), method,
      ...params.map(value => typeof value === 'string' ? value : JSON.stringify(value))));
  };
  await waitFor(() => core('getblockchaininfo'), signal, 'Bitcoin Core readiness');
  core('createwallet', ['']);
  core('generatetoaddress', [1, core('getnewaddress', [], '')]);
  const lndContainers = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const directory = path.join(data, 'lnd', name);
    mkdir(directory);
    const configFile = path.join(secrets, `lnd-${name}.conf`);
    privateWrite(configFile, [
      '[Application Options]', 'noseedbackup=1', `alias=${name}`, `tlsextradomain=lnd-${name}`,
      `tlsextradomain=${prefix}-lnd-${name}`, 'listen=0.0.0.0:9735', 'rpclisten=0.0.0.0:10009', 'restlisten=0.0.0.0:8080',
      '[Bitcoin]', 'bitcoin.active=1', 'bitcoin.regtest=1', 'bitcoin.node=bitcoind',
      '[Bitcoind]', 'bitcoind.rpchost=core:18443', `bitcoind.rpcuser=${coreUser}`, `bitcoind.rpcpass=${corePassword}`,
      'bitcoind.zmqpubrawblock=tcp://core:28334', 'bitcoind.zmqpubrawtx=tcp://core:28335',
    ].join('\n'));
    const id = docker('run', '-d', '--name', `${prefix}-lnd-${name}`, '--label', label,
      '--network', prefix, '--network-alias', `lnd-${name}`, '-e', `USERID=${userId}`, '-e', `GROUPID=${groupId}`,
      '-v', `${directory}:/home/lnd/.lnd`, '-v', `${configFile}:/run/lnd.conf:ro`,
      images.lnd, 'lnd', '--lnddir=/home/lnd/.lnd', '--configfile=/run/lnd.conf').trim();
    lndContainers.push(id); recordContainer(id);
  }
  const lnd = (index, command, ...args) => {
    signal?.throwIfAborted();
    assert(Number.isInteger(index) && index >= 0 && index < lndContainers.length);
    return cliValue(docker('exec', lndContainers[index], 'lncli', '--lnddir=/home/lnd/.lnd', '--network=regtest', command, ...args.map(String)));
  };
  const readiness = [];
  for (let index = 0; index < names.length; index++) {
    const info = await waitFor(() => {
      const result = lnd(index, 'getinfo');
      return result.synced_to_chain && result.chains?.some(chain => chain.network === 'regtest') ? result : false;
    }, signal, `LND ${names[index]} readiness`);
    readiness.push({ name: names[index], version: info.version, publicKey: info.identity_pubkey, blockHeight: info.block_height, syncedToChain: info.synced_to_chain });
    const target = path.join(secrets, 'wallets', walletIds[names[index]]);
    mkdir(target);
    privateWrite(path.join(target, 'tls.cert'), fs.readFileSync(path.join(data, 'lnd', names[index], 'tls.cert')));
    privateWrite(path.join(target, 'invoices.macaroon'), fs.readFileSync(path.join(data, 'lnd', names[index], 'data/chain/bitcoin/regtest/invoices.macaroon')));
  }
  const gateRoot = path.join(data, 'gate');
  const controlDir = path.join(gateRoot, 'control');
  mkdir(controlDir);
  privateWrite(path.join(gateRoot, 'core-user'), coreUser);
  privateWrite(path.join(gateRoot, 'core-password'), corePassword);
  privateWrite(path.join(gateRoot, 'source.js'), fs.readFileSync(path.join(__dirname, 'paykit-wallet-fault-gate.js')));
  privateWrite(path.join(gateRoot, 'bob-tls.cert'), fs.readFileSync(path.join(secrets, 'wallets', walletIds.bob, 'tls.cert')));
  privateWrite(path.join(gateRoot, 'invoices.macaroon'), fs.readFileSync(path.join(secrets, 'wallets', walletIds.bob, 'invoices.macaroon')));
  privateWrite(path.join(gateRoot, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=wallet-fault-gate\n[ext]\nsubjectAltName=DNS:wallet-fault-gate\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(gateRoot, 'tls.key'), '-out', path.join(gateRoot, 'tls.cert'), '-config', path.join(gateRoot, 'openssl.cnf')], { stdio: 'ignore', timeout: 30000, killSignal: 'SIGTERM' });
  fs.chmodSync(path.join(gateRoot, 'tls.key'), 0o600);
  privateWrite(path.join(gateRoot, 'config.json'), JSON.stringify({
    apiVersion: 1, controlDir: '/gate/control', requestTimeoutMs: 10000, holdTimeoutMs: 45000,
    core: { listenPort: 18443, url: 'http://core:18443', usernameFile: '/gate/core-user', passwordFile: '/gate/core-password' },
    lnd: { listenPort: 8080, url: 'https://lnd-bob:8080', macaroonFile: '/gate/invoices.macaroon', upstreamCertFile: '/gate/bob-tls.cert', gateCertFile: '/gate/tls.cert', gateKeyFile: '/gate/tls.key' },
  }));
  const gateContainer = docker('run', '-d', '--init', '--name', `${prefix}-wallet-gate`, '--label', label,
    '--network', prefix, '--network-alias', 'wallet-fault-gate', '--user', uid,
    '-v', `${gateRoot}:/gate:ro`, '-v', `${controlDir}:/gate/control`, '-e', 'PAYKIT_FAULT_GATE_CONFIG=/gate/config.json',
    images.gate, 'node', '/gate/source.js').trim();
  recordContainer(gateContainer);
  await waitFor(() => fs.existsSync(path.join(controlDir, 'listening.json')), signal, 'Wallet response gate readiness');
  const faultSecrets = path.join(secrets, 'wallets', walletIds.fault);
  mkdir(faultSecrets);
  privateWrite(path.join(faultSecrets, 'tls.cert'), fs.readFileSync(path.join(gateRoot, 'tls.cert')));
  privateWrite(path.join(faultSecrets, 'invoices.macaroon'), fs.readFileSync(path.join(gateRoot, 'invoices.macaroon')));
  const bitcoin = { url: 'http://core:18443', username: coreUser, password: corePassword };
  const wallets = [{ id: walletIds.core, label: 'Core', bitcoin }, ...names.map(name => ({
    id: walletIds[name], label: `${name} / Core`, bitcoin,
    lightning: { url: `https://lnd-${name}:8080`, tlsCertPath: `/run/paykit/wallets/${walletIds[name]}/tls.cert`, macaroonPath: `/run/paykit/wallets/${walletIds[name]}/invoices.macaroon` },
  })), { id: walletIds.fault, label: 'Disposable fault gate / Bob / Core', bitcoin: { ...bitcoin, url: 'http://wallet-fault-gate:18443' },
    lightning: { url: 'https://wallet-fault-gate:8080', tlsCertPath: `/run/paykit/wallets/${walletIds.fault}/tls.cert`, macaroonPath: `/run/paykit/wallets/${walletIds.fault}/invoices.macaroon` } }];
  privateWrite(path.join(secrets, 'wallet-config.json'), JSON.stringify({ apiVersion: 1, environmentId, wallets }));
  const details = { coreContainer, lndContainers, gateContainer, walletIds, readiness, coreVersion: core('getnetworkinfo').version, images };
  recordWallets(details);
  const storageJournal = [];
  const recordStorage = entry => { storageJournal.push(entry); recordWallets({ ...details, storageFaults: storageJournal }); };
  const faults = storageFaults(stateRoot, recordStorage);
  function verifyOwned(id) {
    assert.equal(docker('inspect', '-f', '{{index .Config.Labels "polar-paykit.test-run"}}', id).trim(), runId, 'Wallet container owner changed');
  }
  async function stopLnd(index) {
    signal?.throwIfAborted();
    assert(Number.isInteger(index) && index >= 0 && index < lndContainers.length);
    const id = lndContainers[index]; verifyOwned(id);
    docker('stop', '--timeout', '-1', id);
    recordWallets({ ...details, lastLifecycle: { name: names[index], action: 'stopped', at: new Date().toISOString() } });
  }
  async function startLnd(index) {
    assert(Number.isInteger(index) && index >= 0 && index < lndContainers.length);
    const id = lndContainers[index]; verifyOwned(id);
    docker('start', id);
    await waitFor(() => lnd(index, 'getinfo').synced_to_chain, signal, 'LND restart readiness');
    recordWallets({ ...details, lastLifecycle: { name: names[index], action: 'started', at: new Date().toISOString() } });
  }
  const controls = gateControls(controlDir, signal);
  function evidence() {
    const events = fs.readFileSync(path.join(controlDir, 'events.ndjson'), 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line));
    return { ...details, gateCounts: controls.counts(), gateEvents: events, storageFaults: storageJournal };
  }
  function walletSnapshot() {
    return {
      coreWallets: core('listwallets').sort(),
      invoices: names.map((_, index) => {
        const result = lnd(index, 'listinvoices', '--max_invoices=10000');
        return result.invoices.map(invoice => ({ index: invoice.add_index, paymentRequest: invoice.payment_request })).sort((a, b) => Number(BigInt(a.index) - BigInt(b.index)));
      }),
    };
  }
  return { ...details, core, lnd, stateRoot, stopLnd, startLnd, walletSnapshot, evidence, ...controls, ...faults,
    blockLedgerCommit: (receiverId, serviceContainer) => {
      verifyOwned(serviceContainer);
      return visibleStorageFaults(faults, id => readGuestLedger(docker, serviceContainer, id), recordStorage).blockLedgerCommit(receiverId);
    } };

}
module.exports = { createWalletFixture, storageFaults, visibleStorageFaults, readGuestLedger, gateControls, atomicJson, images };
