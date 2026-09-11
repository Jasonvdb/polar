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
const paymentPermissions = ['/lnrpc.Lightning/GetInfo', '/lnrpc.Lightning/SendPaymentSync', '/lnrpc.Lightning/ListPayments'];
const setupPermissions = ['/lnrpc.Lightning/GetInfo', '/lnrpc.Lightning/NewAddress', '/lnrpc.Lightning/WalletBalance', '/lnrpc.Lightning/ConnectPeer', '/lnrpc.Lightning/ListPeers', '/lnrpc.Lightning/OpenChannelSync', '/lnrpc.Lightning/ListChannels', '/lnrpc.Lightning/PendingChannels'];
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
function storageFaults(stateRoot, journal = () => {}, ledger = 'payments') {
  assert(['payments', 'requests', 'workspace'].includes(ledger));
  const boundary = `${ledger}.cbor atomic rename`;
  const pending = new Map();
  const root = fs.realpathSync(stateRoot);
  function setLedgerWritable(receiverId, writable) {
    assert(ledger === 'executions' ? receiverId === 'wallet-execution' : uuid.test(receiverId), 'Invalid receiver storage fault scope');
    const directory = path.join(root, 'receivers', receiverId);
    assert.equal(fs.realpathSync(directory), directory, 'Receiver fault path is not canonical');
    const target = path.join(directory, `${ledger}.cbor`);
    if (writable) {
      const saved = pending.get(receiverId);
      if (!saved) return;
      const blocked = fs.lstatSync(target);
      assert(blocked.isDirectory() && !blocked.isSymbolicLink(), 'Storage fault target changed');
      fs.rmdirSync(target); // Must still be the empty directory created by this fault.
      if (saved.existed) fs.renameSync(saved.backup, target);
      pending.delete(receiverId);
      journal({ receiverId, faultId: saved.faultId, phase: 'host', active: false, boundary });
      return;
    }
    assert(!pending.has(receiverId), 'Storage fault already active');
    const faultId = randomUUID();
    const backup = path.join(directory, `.${ledger}-fixture-${faultId}`);
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
    journal({ receiverId, faultId, phase: 'host', active: true, boundary });
    return saved;
  }
  function restoreFaults() {
    const failures = [];
    for (const receiverId of pending.keys()) {
      try { setLedgerWritable(receiverId, true); } catch (_) { failures.push(receiverId); }
    }
    assert.equal(failures.length, 0, `Storage fault restoration failed for ${failures.join(', ')}`);
  }
  return { setLedgerWritable, restoreFaults, boundary };
}
// Shared execution snapshots are read by every receiver. Deny new commits while
// preserving those reads; replacing this ledger with a directory crashes readers.
function executionCommitFaults(stateRoot, journal = () => {}) {
  const root = fs.realpathSync(stateRoot);
  const directory = path.join(root, 'receivers', 'wallet-execution');
  const target = path.join(directory, 'executions.cbor');
  const boundary = 'executions.cbor commit temp creation';
  let pending;
  const digest = () => {
    const stat = fs.lstatSync(target);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'Expected regular shared execution ledger');
    return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  };
  function setLedgerWritable(receiverId, writable) {
    assert.equal(receiverId, 'wallet-execution', 'Invalid shared execution fault scope');
    if (writable && !pending) return;
    assert.equal(fs.realpathSync(directory), directory, 'Shared execution fault path is not canonical');
    const stat = fs.statSync(directory);
    if (writable) {
      if (!pending) return;
      assert(stat.dev === pending.dev && stat.ino === pending.ino, 'Shared execution directory changed');
      const saved = pending;
      fs.chmodSync(directory, saved.expected.mode);
      pending = undefined;
      journal({ receiverId, faultId: saved.faultId, phase: 'host', active: false, boundary });
      assert.equal(digest(), saved.expected.digest, 'Shared execution snapshot changed during commit fault');
      return;
    }
    assert(!pending, 'Storage fault already active');
    const lock = fs.lstatSync(path.join(directory, 'spending.lock'));
    assert(lock.isFile() && !lock.isSymbolicLink(), 'Existing spending lock required to reach commit boundary');
    const mode = stat.mode & 0o7777;
    assert(mode & 0o200, 'Shared execution directory must initially be writable');
    const expected = { kind: 'file', digest: digest(), mode, writable: true };
    const saved = { faultId: randomUUID(), dev: stat.dev, ino: stat.ino, expected,
      blocked: { ...expected, mode: mode & ~0o222, writable: false } };
    fs.chmodSync(directory, saved.blocked.mode);
    pending = saved;
    journal({ receiverId, faultId: saved.faultId, phase: 'host', active: true, boundary });
    return saved;
  }
  return { setLedgerWritable, restoreFaults: () => setLedgerWritable('wallet-execution', true), boundary };
}
// Bind mounts can publish host rename results asynchronously. The scenario must
// observe each boundary from the same namespace as the receiver before proceeding.
function visibleStorageFaults(faults, readGuest, journal, { timeoutMs = 5000, pollMs = 50 } = {}) {
  const boundary = faults.boundary || 'payments.cbor atomic rename';
  async function confirm(receiverId, expected) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts++;
      try {
        const observed = await readGuest(receiverId);
        if (observed.kind === expected.kind &&
            (expected.kind !== 'file' || observed.digest === expected.digest) &&
            (expected.mode === undefined || observed.mode === expected.mode) &&
            (expected.writable === undefined || observed.writable === expected.writable)) return { attempts, observed };
      } catch (_) { /* Only a matching guest observation permits progression. */ }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Guest payment ledger ${expected.kind} visibility deadline exceeded`);
  }
  async function blockLedgerCommit(receiverId) {
    const saved = faults.setLedgerWritable(receiverId, false);
    const record = (active, observed, confirmation) => journal({
      receiverId, faultId: saved.faultId, phase: 'guest', active,
      observed, attempts: confirmation.attempts, boundary,
      ...(saved.blocked ? { uid: confirmation.observed.uid, mode: confirmation.observed.mode, writable: confirmation.observed.writable } : {}),
    });
    const restore = async () => {
      faults.setLedgerWritable(receiverId, true);
      const attempts = await confirm(receiverId, saved.expected);
      record(false, saved.expected.kind === 'file' ? 'originalFile' : 'absent', attempts);
    };
    try {
      const attempts = await confirm(receiverId, saved.blocked || { kind: 'directory' });
      record(true, saved.blocked ? 'readableCommitBlocked' : 'directory', attempts);
    } catch (error) {
      await restore();
      throw error;
    }
    restore.assertActive = async () => {
      const confirmation = await confirm(receiverId, saved.blocked || { kind: 'directory' });
      record(true, saved.blocked ? 'readableCommitBlocked' : 'directory', confirmation);
    };
    return restore;
  }
  return { blockLedgerCommit };
}
function readGuestLedger(docker, serviceContainer, receiverId, ledger = 'payments') {
  assert(['payments', 'requests', 'workspace', 'executions'].includes(ledger));
  assert(ledger === 'executions' ? receiverId === 'wallet-execution' : uuid.test(receiverId));
  assert.equal(typeof docker.withTimeout, 'function', 'A bounded Docker probe is required');
  const output = docker.withTimeout(1000, 'exec', serviceContainer, 'sh', '-c',
    'if [ -L "$1" ]; then exit 2; elif [ -d "$1" ]; then echo directory; elif [ -f "$1" ]; then sha256sum "$1"; elif [ ! -e "$1" ]; then echo absent; else exit 2; fi',
    'paykit-ledger-visibility', `/data/receivers/${receiverId}/${ledger}.cbor`).trim();
  if (output === 'directory' || output === 'absent') return { kind: output };
  const match = /^([a-f0-9]{64})\s/.exec(output);
  assert(match, 'Invalid guest ledger visibility response');
  // The encrypted-file digest is compared only in memory and never journaled.
  return { kind: 'file', digest: match[1] };
}
function readGuestExecutionLedger(docker, serviceContainer, receiverId) {
  assert.equal(receiverId, 'wallet-execution', 'Invalid shared execution fault scope');
  assert.equal(typeof docker.withTimeout, 'function', 'A bounded Docker probe is required');
  const output = docker.withTimeout(1000, 'exec', serviceContainer, 'sh', '-c',
    "set -eu; uid=$(id -u); test \"$uid\" -gt 0; service_uid=$(awk '/^Uid:/ {print $2}' /proc/1/status); test \"$uid\" = \"$service_uid\"; test ! -L \"$1\"; test -f \"$1\"; test -r \"$1\"; parent=${1%/*}; mode=$(stat -c %a \"$parent\"); digest=$(sha256sum \"$1\"); writable=false; if probe=$(mktemp \"$parent/.paykit-fixture-write-XXXXXX\" 2>/dev/null); then rm -- \"$probe\"; writable=true; fi; printf \"%s %s %s %s\\n\" \"$uid\" \"$mode\" \"${digest%% *}\" \"$writable\"",
    'paykit-execution-commit-visibility', '/data/receivers/wallet-execution/executions.cbor').trim();
  const match = /^([1-9][0-9]*) ([0-7]{3,4}) ([a-f0-9]{64}) (true|false)$/.exec(output);
  assert(match, 'Invalid non-root shared execution commit observation');
  return { kind: 'file', uid: Number(match[1]), mode: parseInt(match[2], 8), digest: match[3], writable: match[4] === 'true' };
}
function gateControls(controlDir, signal) {
  function arm(channel, action = 'drop', operation) {
    assert(operation === undefined || (channel === 'core' && ['sendrawtransaction', 'signrawtransactionwithwallet'].includes(operation)) || (channel === 'lnd' && ['sendpayment', 'openchannel'].includes(operation)));
    assert(['core', 'lnd'].includes(channel) && ['drop', 'hold'].includes(action));
    const file = path.join(controlDir, `${channel}.arm.json`);
    assert(!fs.existsSync(file), 'A gate control is already armed');
    const nonce = randomUUID();
    atomicJson(file, { nonce, action, ...(operation ? { operation } : {}) });
    return nonce;
  }
  function controlPath(channel, nonce, ending) {
    assert(['core', 'lnd'].includes(channel) && uuid.test(nonce));
    return path.join(controlDir, `${channel}.${nonce}.${ending}.json`);
  }
  async function waitReady(channel, nonce) {
    return waitFor(() => {
      const result = JSON.parse(fs.readFileSync(controlPath(channel, nonce, 'ready')));
      assert(result.successfulIssuance === true || result.successfulExecution === true || result.successfulSigning === true || result.successfulChannel === true);
      assert.equal(result.nonce, nonce);
      if (result.successfulSigning) { assert.equal(channel, 'core'); assert.equal(result.operation, 'signrawtransactionwithwallet'); assert.match(result.signedTransactionDigest, /^[a-f0-9]{64}$/); }
      if (result.successfulChannel) {
        assert.equal(channel, 'lnd');
        assert.equal(result.operation, 'openchannel');
        assert.match(result.fundingTxid, /^[a-f0-9]{64}$/);
        assert(Number.isInteger(result.outputIndex) && result.outputIndex >= 0 && result.outputIndex <= 4294967295);
      }
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

function coreLifecycle({ docker, coreContainer, runId, core, signal, record }) {
  const inspect = () => JSON.parse(docker('inspect', coreContainer))[0];
  const identity = value => ({ id: value.Id, name: value.Name, image: value.Image, labels: value.Config.Labels, mounts: [...value.Mounts].sort((a, b) => a.Destination.localeCompare(b.Destination)), startedAt: value.State.StartedAt });
  let expected = identity(inspect());
  assert.equal(expected.labels['polar-paykit.test-run'], runId);
  const verify = () => { const actual = inspect(); assert.deepEqual(identity(actual), expected, 'Owned Core identity changed'); return actual; };
  return {
    stopCore: async () => {
      const actual = verify(); assert(actual.State.Running && !actual.State.Paused);
      record({ action: 'stopIntent', identity: expected });
      docker('stop', '--timeout', '-1', coreContainer);
      assert.equal(verify().State.Running, false); record({ action: 'stopped', identity: expected });
    },
    startCore: async () => {
      assert.equal(verify().State.Running, false);
      record({ action: 'startIntent', identity: expected });
      docker('start', coreContainer);
      const started = inspect(); const refreshed = identity(started);
      assert.deepEqual({ ...refreshed, startedAt: expected.startedAt }, expected, 'Core restart changed ownership');
      assert(started.State.Running && !started.State.Paused); assert.notEqual(refreshed.startedAt, expected.startedAt);
      expected = refreshed; record({ action: 'started', identity: expected });
      await waitFor(() => core('getblockchaininfo').chain === 'regtest', signal, 'Bitcoin Core restart readiness');
    },
  };
}

async function createWalletFixture({ data, secrets, prefix, environmentId, uid, runId, docker, recordContainer, recordWallets, signal, setupGate = false }) {
  assert.equal(typeof setupGate, 'boolean');
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
    for (const [kind, permissions] of [['payment', paymentPermissions], ['setup', setupPermissions]]) {
      const filename = `paykit-${kind}.macaroon`;
      lnd(index, 'bakemacaroon', `--save_to=/home/lnd/.lnd/${filename}`, ...permissions.map(uri => `uri:${uri}`));
      privateWrite(path.join(target, `${kind}.macaroon`), fs.readFileSync(path.join(data, 'lnd', names[index], filename)));
    }
  }
  const gateRoot = path.join(data, 'gate');
  const controlDir = path.join(gateRoot, 'control');
  mkdir(controlDir);
  privateWrite(path.join(gateRoot, 'core-user'), coreUser);
  privateWrite(path.join(gateRoot, 'core-password'), corePassword);
  privateWrite(path.join(gateRoot, 'source.js'), fs.readFileSync(path.join(__dirname, 'paykit-wallet-fault-gate.js')));
  privateWrite(path.join(gateRoot, 'bob-tls.cert'), fs.readFileSync(path.join(secrets, 'wallets', walletIds.bob, 'tls.cert')));
  privateWrite(path.join(gateRoot, 'invoices.macaroon'), fs.readFileSync(path.join(secrets, 'wallets', walletIds.bob, 'invoices.macaroon')));
  privateWrite(path.join(gateRoot, 'payment.macaroon'), fs.readFileSync(path.join(secrets, 'wallets', walletIds.bob, 'payment.macaroon')));
  privateWrite(path.join(gateRoot, 'setup.macaroon'), fs.readFileSync(path.join(secrets, 'wallets', walletIds.bob, 'setup.macaroon')));
  privateWrite(path.join(gateRoot, 'openssl.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=wallet-fault-gate\n[ext]\nsubjectAltName=DNS:wallet-fault-gate\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', path.join(gateRoot, 'tls.key'), '-out', path.join(gateRoot, 'tls.cert'), '-config', path.join(gateRoot, 'openssl.cnf')], { stdio: 'ignore', timeout: 30000, killSignal: 'SIGTERM' });
  fs.chmodSync(path.join(gateRoot, 'tls.key'), 0o600);
  privateWrite(path.join(gateRoot, 'config.json'), JSON.stringify({
    apiVersion: 1, controlDir: '/gate/control', requestTimeoutMs: 10000, holdTimeoutMs: 45000,
    core: { listenPort: 18443, url: 'http://core:18443', usernameFile: '/gate/core-user', passwordFile: '/gate/core-password' },
    lnd: { listenPort: 8080, url: 'https://lnd-bob:8080', macaroonFile: '/gate/invoices.macaroon', paymentMacaroonFile: '/gate/payment.macaroon', ...(setupGate ? { setupMacaroonFile: '/gate/setup.macaroon' } : {}), upstreamCertFile: '/gate/bob-tls.cert', gateCertFile: '/gate/tls.cert', gateKeyFile: '/gate/tls.key' },
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
  privateWrite(path.join(faultSecrets, 'payment.macaroon'), fs.readFileSync(path.join(gateRoot, 'payment.macaroon')));
  const bitcoin = { url: 'http://core:18443', username: coreUser, password: corePassword };
  const wallets = [{ id: walletIds.core, bitcoinBackendId: walletIds.core, label: 'Core', bitcoin }, ...names.map(name => ({
    id: walletIds[name], bitcoinBackendId: walletIds.core, label: `${name} / Core`, bitcoin,
    lightning: { url: `https://lnd-${name}:8080`, tlsCertPath: `/run/paykit/wallets/${walletIds[name]}/tls.cert`, macaroonPath: `/run/paykit/wallets/${walletIds[name]}/invoices.macaroon`, paymentMacaroonPath: `/run/paykit/wallets/${walletIds[name]}/payment.macaroon`, setupMacaroonPath: `/run/paykit/wallets/${walletIds[name]}/setup.macaroon`, peerAddress: `lnd-${name}:9735` },
  })), { id: walletIds.fault, bitcoinBackendId: walletIds.core, label: 'Disposable fault gate / Bob / Core', bitcoin: { ...bitcoin, url: 'http://wallet-fault-gate:18443' },
    lightning: { url: 'https://wallet-fault-gate:8080', tlsCertPath: `/run/paykit/wallets/${walletIds.fault}/tls.cert`, macaroonPath: `/run/paykit/wallets/${walletIds.fault}/invoices.macaroon`, paymentMacaroonPath: `/run/paykit/wallets/${walletIds.fault}/payment.macaroon` } }];
  privateWrite(path.join(secrets, 'wallet-config.json'), JSON.stringify({ apiVersion: 1, environmentId, wallets }));
  const details = { coreContainer, lndContainers, gateContainer, walletIds, readiness, coreVersion: core('getnetworkinfo').version, images };
  recordWallets(details);
  const coreLifecycleJournal = [];
  const lifecycle = coreLifecycle({ docker, coreContainer, runId, core, signal, record: event => { coreLifecycleJournal.push({ ...event, at: new Date().toISOString() }); recordWallets({ ...details, coreLifecycle: coreLifecycleJournal }); } });
  const storageJournal = [];
  const recordStorage = entry => { storageJournal.push(entry); recordWallets({ ...details, storageFaults: storageJournal }); };
  const faults = storageFaults(stateRoot, recordStorage);
  const executionFaults = executionCommitFaults(stateRoot, recordStorage);
  const requestFaults = storageFaults(stateRoot, recordStorage, 'requests');
  const workspaceFaults = storageFaults(stateRoot, recordStorage, 'workspace');
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
    return { ...details, gateCounts: controls.counts(), gateEvents: events, storageFaults: storageJournal, coreLifecycle: coreLifecycleJournal };
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
  return { ...details, ...lifecycle, core, lnd, stateRoot, stopLnd, startLnd, walletSnapshot, evidence, ...controls, ...faults,
    restoreFaults: () => {
      const failures = [];
      for (const fault of [faults, executionFaults, requestFaults, workspaceFaults]) {
        try { fault.restoreFaults(); } catch (_) { failures.push(fault.boundary); }
      }
      assert.equal(failures.length, 0, `Storage fault restoration failed at ${failures.join(', ')}`);
    },
    blockExecutionCommit: serviceContainer => {
      verifyOwned(serviceContainer);
      return visibleStorageFaults(executionFaults, id => readGuestExecutionLedger(docker, serviceContainer, id), recordStorage).blockLedgerCommit('wallet-execution');
    },
    blockWorkspaceCommit: (receiverId, serviceContainer) => {
      verifyOwned(serviceContainer);
      return visibleStorageFaults(workspaceFaults, id => readGuestLedger(docker, serviceContainer, id, 'workspace'), recordStorage).blockLedgerCommit(receiverId);
    },
    blockRequestCommit: (receiverId, serviceContainer) => {
      verifyOwned(serviceContainer);
      return visibleStorageFaults(requestFaults, id => readGuestLedger(docker, serviceContainer, id, 'requests'), recordStorage).blockLedgerCommit(receiverId);
    },
    blockLedgerCommit: (receiverId, serviceContainer) => {
      verifyOwned(serviceContainer);
      return visibleStorageFaults(faults, id => readGuestLedger(docker, serviceContainer, id), recordStorage).blockLedgerCommit(receiverId);
    } };

}
module.exports = { coreLifecycle, createWalletFixture, storageFaults, executionCommitFaults, visibleStorageFaults, readGuestLedger, readGuestExecutionLedger, gateControls, atomicJson, images, paymentPermissions, setupPermissions };
