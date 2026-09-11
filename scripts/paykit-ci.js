#!/usr/bin/env node
/* Disposable CI runtime. Every Docker object has a unique recorded owner label. */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const { execFileSync } = require('child_process');
const { run } = require('./paykit-scenarios');
const { createWalletFixture } = require('./paykit-wallet-fixture');
const { createReceiptFixture, validateReceiptEvidence } = require('./paykit-receipt-fixture');
const { sleep, serviceBase, requestJson, runCli } = require('./paykit-harness');
const requiredStages = ['readiness', 'preset', 'deduplication', 'editable-identities', 'receiver-isolation', 'grant-validation', 'environment-restart', 'receiver-restart', 'database-outage', 'database-recovery', ...require('./paykit-workspace-scenarios').stages, ...require('./paykit-payment-scenarios').stages, ...require('./paykit-request-scenarios').stages, ...require('./paykit-receipt-scenarios').stages, ...require('./paykit-recurring-scenarios').stages, 'complete'];

function validateReport(root) {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'resources.json'), 'utf8'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runId, ledger.runId);
  assert.equal(report.passed, true);
  assert(Number.isFinite(Date.parse(report.completedAt)));
  assert.equal(report.cleanup.completed, true);
  assert.deepEqual(report.cleanup.remainingContainers, []);
  assert.deepEqual(report.cleanup.remainingNetworks, []);
  assert.deepEqual(report.cleanup, ledger.cleanup);
  assert.equal(report.environments.length, 2);
  assert.equal(ledger.environments.length, 2);
  for (const environment of report.environments) {
    assert.equal(environment.passed, true);
    const owned = ledger.environments.find(item => item.environmentId === environment.environmentId);
    assert(owned);
    const wallets = owned.wallets;
    assert(wallets && wallets.lndContainers.length === 3);
    assert.equal(new Set([wallets.coreContainer, ...wallets.lndContainers, wallets.gateContainer]).size, 5);
    assert(wallets.readiness.every(item => item.syncedToChain && item.publicKey && item.version));
    assert.equal(wallets.readiness.length, 3);
    assert(wallets.gateCounts.core.issuanceSuccess >= 2);
    assert(wallets.gateCounts.lnd.issuanceSuccess >= 1);
    for (const channel of ['core', 'lnd']) {
      const dropped = wallets.gateEvents.find(event => event.channel === channel && event.event === 'response.dropped');
      assert(dropped && dropped.nonce);
      assert(wallets.gateEvents.some(event => event.channel === channel && event.nonce === dropped.nonce && event.id === dropped.id && event.event === 'upstream.completed' && event.successfulIssuance));
    }
    const held = wallets.gateEvents.find(event => event.event === 'hold.finished' && event.action === 'relay' && event.reason === 'control');
    assert(held && held.nonce);
    assert(wallets.gateEvents.some(event => event.nonce === held.nonce && event.id === held.id && event.event === 'upstream.completed' && event.successfulIssuance));
    for (const channel of ['core', 'lnd']) {
      assert(wallets.gateCounts[channel].executionSuccess >= 1, 'Missing real execution gate success');
      const completed = wallets.gateEvents.find(event => event.channel === channel && event.event === 'upstream.completed' && event.successfulExecution && wallets.gateEvents.some(drop => drop.event === 'response.dropped' && drop.channel === channel && drop.id === event.id && drop.nonce === event.nonce));
      assert(completed?.nonce, 'Missing lost successful execution response');
    }
    for (const ledger of ['payments', 'workspace', 'requests', 'executions']) {
      assert(wallets.storageFaults.some(event => event.phase === 'host' && event.active && event.boundary === (ledger === 'executions' ? 'executions.cbor commit temp creation' : `${ledger}.cbor atomic rename`)), `Missing ${ledger} commit fault evidence`);
    }
    const finalFaults = new Map(wallets.storageFaults.map(event => [`${event.receiverId}:${event.boundary}`, event.active]));
    assert([...finalFaults.values()].every(active => active === false));
    for (const fault of wallets.storageFaults.filter(event => event.phase === 'host' && event.active)) {
      assert(fault.faultId);
      const events = wallets.storageFaults.filter(event => event.faultId === fault.faultId && event.receiverId === fault.receiverId);
      const execution = fault.boundary === 'executions.cbor commit temp creation';
      const blocked = events.findIndex(event => event.phase === 'guest' && event.active && (execution ? event.observed === 'readableCommitBlocked' && event.uid > 0 && event.writable === false : event.observed === 'directory'));
      const restored = events.findIndex(event => event.phase === 'guest' && !event.active && ['originalFile', 'absent'].includes(event.observed) && (!execution || event.uid > 0 && event.writable === true));
      assert(blocked >= 0 && restored > blocked, 'Missing confirmed guest ledger boundaries');
    }
    assert(wallets.storageFaults.some(event => event.phase === 'host' && event.active));
    assert.deepEqual(wallets.coreLifecycle.map(e => e.action), ['stopIntent','stopped','startIntent','started','stopIntent','stopped','startIntent','started']);
    for (let cycle = 0; cycle < 2; cycle++) {
      const events = wallets.coreLifecycle.slice(cycle * 4, cycle * 4 + 4);
      for (const event of events) { assert.equal(event.identity.id, wallets.coreContainer); assert.equal(event.identity.labels['polar-paykit.test-run'], ledger.runId); }
      assert.deepEqual(events[0].identity, events[1].identity); assert.deepEqual(events[1].identity, events[2].identity);
      assert.notEqual(events[2].identity.startedAt, events[3].identity.startedAt);
      assert.deepEqual({ ...events[3].identity, startedAt: events[2].identity.startedAt }, events[2].identity);
    }
    validateReceiptEvidence(owned.receiptEvidence, { runId: ledger.runId, environmentId: environment.environmentId });
    require('./paykit-recurring-scenarios').validateEvidence(environment.recurringEvidence);
    assert.deepEqual(environment.stages, requiredStages);
    assert.equal(new Set(environment.participantKeys).size, 3);
    assert.equal(new Set(environment.receiverNoiseKeys).size, 4);
  }
  const [a, b] = report.environments;
  assert.notEqual(a.environmentId, b.environmentId);
  assert(!a.participantKeys.some(key => b.participantKeys.includes(key)));
  assert(!a.receiverNoiseKeys.some(key => b.receiverNoiseKeys.includes(key)));
  assert.equal(report.survivingEnvironmentVerified, true);
  assert.equal(report.survivingWalletEnvironmentVerified, true);
  assert(!ledger.environments[0].wallets.readiness.some(aWallet => ledger.environments[1].wallets.readiness.some(bWallet => aWallet.publicKey === bWallet.publicKey)));
  return report;
}

function redactedReceiverStatuses(receivers) {
  return receivers.map(({ id, status, generation }) => ({ id, status, generation }));
}
function assertRunningReceivers(receivers) {
  const statuses = redactedReceiverStatuses(receivers);
  assert(statuses.length > 0 && statuses.every(r => r.status === 'running'), `Survivor receivers unavailable: ${JSON.stringify(statuses)}`);
}

function start() {
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'polar-paykit-ci-'));
  const runId = randomUUID();
  const label = `polar-paykit.test-run=${runId}`;
  const startedAt = new Date().toISOString();
  const resources = { root, runId, nodeVersion: process.version, containers: [], containerDetails: [], networks: [], environments: [] };
  const journal = [];
  const walletFixtures = [];
  const receiptFixtures = [];
  let lastScenarioStage = 'run:started';
  const image = process.env.PAYKIT_TEST_IMAGE || 'polar-paykit/service:pr2';
  const postgres = 'postgres:18-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
  const record = () => fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify(resources, null, 2));
  const boundedDocker = (timeout, ...args) => execFileSync('docker', args, { encoding: 'utf8', timeout, killSignal: 'SIGTERM', stdio: ['ignore', 'pipe', 'pipe'] });
  const docker = (...args) => boundedDocker(60000, ...args);
  docker.withTimeout = boundedDocker;
  function progress(stage) {
    const entry = { at: new Date().toISOString(), stage };
    journal.push(entry);
    if (!stage.startsWith('cleanup:')) lastScenarioStage = stage;
    fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify(journal, null, 2));
    console.log(`[${entry.at}] ${stage}`);
  }
  function recordContainer(id) {
    resources.containers.push(id);
    record();
    const details = JSON.parse(docker('inspect', '--format', '{"id":{{json .Id}},"name":{{json .Name}},"created":{{json .Created}},"startedAt":{{json .State.StartedAt}},"image":{{json .Image}},"owner":{{json (index .Config.Labels "polar-paykit.test-run")}},"mounts":{{json .Mounts}}}', id));
    assert.equal(details.owner, runId);
    resources.containerDetails.push(details); record();
  }
  async function environment(suffix, signal) {
    signal.throwIfAborted(); progress(`${suffix}:provisioning`);
    const environmentId = randomUUID();
    const prefix = `polar-paykit-ci-${runId.slice(0, 8)}-${suffix}`;
    const data = path.join(root, suffix);
    const secrets = path.join(data, 'credentials');
    const entry = { environmentId, suffix, networkName: prefix };
    resources.environments.push(entry); record();
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
    for (const name of ['master-key', 'api-token', 'postgres-password']) fs.writeFileSync(path.join(secrets, name), randomBytes(32).toString('hex'), { mode: 0o600 });
    for (const name of ['state', 'postgres']) fs.mkdirSync(path.join(data, name));
    signal.throwIfAborted();
    const network = docker('network', 'create', '--label', label, prefix).trim();
    resources.networks.push(network); record();
    const uid = process.getuid ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
    signal.throwIfAborted();
    const database = docker('run', '-d', '--name', `${prefix}-postgres`, '--label', label, '--network', prefix, '--network-alias', 'paykit-postgres', '--user', uid,
      '-v', `${secrets}:/run/paykit:ro`, '-v', `${path.join(data, 'postgres')}:/var/lib/postgresql`,
      '-e', 'POSTGRES_USER=pubky', '-e', 'POSTGRES_DB=pubky', '-e', 'PGDATA=/var/lib/postgresql/18/docker', '-e', 'POSTGRES_PASSWORD_FILE=/run/paykit/postgres-password', postgres).trim();
    entry.database = database; recordContainer(database);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      try { docker('exec', database, 'pg_isready', '-U', 'pubky', '-d', 'pubky'); ready = true; break; }
      catch (_) { await sleep(1000, signal); }
    }
    if (!ready) throw new Error('PostgreSQL readiness timed out');
    signal.throwIfAborted();
    const walletFixture = await createWalletFixture({ data, secrets, prefix, environmentId, uid, runId, docker, recordContainer, signal,
      recordWallets: details => { entry.wallets = details; record(); } });
    walletFixtures.push(walletFixture);
    const service = docker('run', '-d', '--init', '--name', `${prefix}-service`, '--label', label, '--network', prefix, '--user', uid,
      '-p', '127.0.0.1::10090', '-v', `${secrets}:/run/paykit:ro`, '-v', `${path.join(data, 'state')}:/data`,
      '-e', `PAYKIT_ENVIRONMENT_ID=${environmentId}`, '-e', 'PAYKIT_DATA_DIR=/data', '-e', 'PAYKIT_KEY_FILE=/run/paykit/master-key',
      '-e', 'PAYKIT_TOKEN_FILE=/run/paykit/api-token', '-e', 'PAYKIT_POSTGRES_PASSWORD_FILE=/run/paykit/postgres-password', '-e', 'PAYKIT_POSTGRES_HOST=paykit-postgres', '-e', 'PAYKIT_WALLET_CONFIG_FILE=/run/paykit/wallet-config.json', image).trim();
    entry.service = service; recordContainer(service);
    const receiptFixture = createReceiptFixture({ data, secrets, environmentId, runId, uid, docker,
      recordContainer, serviceContainer: service, image: process.env.PAYKIT_RECEIPT_FIXTURE_IMAGE,
      recordEvidence: evidence => { entry.receiptEvidence = evidence; record(); } });
    receiptFixtures.push(receiptFixture);
    signal.throwIfAborted();
    const base = serviceBase(service, docker);
    progress(`${suffix}:provisioned`);
    progress(`${suffix}:endpoint:${base}`);
    return { base, tokenFile: path.join(secrets, 'api-token'), serviceContainer: service, postgresContainer: database, walletFixture, receiptFixture };
  }
  async function work(signal) {
    const a = await environment('a', signal);
    const b = await environment('b', signal);
    const reportB = await run({ ...b, signal, progress: stage => progress(`b:${stage}`) });
    const walletSurvivorBefore = b.walletFixture.walletSnapshot();
    const reportA = await run({ ...a, signal, progress: stage => progress(`a:${stage}`) });
    progress('isolation:survivor-check');
    signal.throwIfAborted();
    const survivorBase = serviceBase(b.serviceContainer, docker);
    progress(`isolation:survivor-endpoint:${survivorBase}`);
    const survivor = await requestJson(`${survivorBase}/v1/state`, { headers: { authorization: `Bearer ${fs.readFileSync(b.tokenFile, 'utf8').trim()}` } }, signal);
    assert.equal(survivor.status, 200);
    assert.deepEqual(survivor.data.participants.map(p => p.publicKey), reportB.participantKeys);
    try { assertRunningReceivers(survivor.data.receivers); }
    catch (error) {
      fs.writeFileSync(path.join(root, 'survivor-receiver-statuses.json'), JSON.stringify(redactedReceiverStatuses(survivor.data.receivers), null, 2));
      throw error;
    }
    assert.deepEqual(b.walletFixture.walletSnapshot(), walletSurvivorBefore, 'Environment B wallets changed while A ran');
    return { environments: [reportA, reportB], survivingEnvironmentVerified: true, survivingWalletEnvironmentVerified: true };
  }
  function cleanup() {
    progress('cleanup:started');
    const result = { completed: false, remainingContainers: [], remainingNetworks: [], errors: [] };
    for (const fixture of receiptFixtures) {
      try { fixture.restoreFaults(); }
      catch (_) { result.errors.push('Receipt fault restoration failed; retain the owned restore journal'); }
    }
    for (const fixture of walletFixtures) {
      try {
        fixture.restoreFaults();
        const entry = resources.environments.find(item => item.wallets?.gateContainer === fixture.gateContainer);
        entry.wallets = fixture.evidence(); record();
      } catch (_) { result.errors.push('Wallet fault restoration or evidence capture failed'); }
    }
    // A timed-out Docker create may have committed before its ID reached stdout.
    // Reconcile the unique run label before deciding which resources require cleanup.
    try {
      const containers = docker('ps', '-aq', '--no-trunc', '--filter', `label=${label}`).trim().split(/\s+/).filter(Boolean);
      const networks = docker('network', 'ls', '--no-trunc', '--format', '{{.ID}}', '--filter', `label=${label}`).trim().split(/\s+/).filter(Boolean);
      resources.containers = [...new Set([...resources.containers, ...containers])];
      resources.networks = [...new Set([...resources.networks, ...networks])];
      record();
    } catch (_) { result.errors.push('Owned Docker inventory unavailable; cleanup cannot be confirmed'); }
    for (const id of resources.containers.slice().reverse()) {
      try {
        const owner = docker('inspect', '-f', '{{index .Config.Labels "polar-paykit.test-run"}}', id).trim();
        if (owner !== runId) throw new Error('owner mismatch');
        docker('stop', '--timeout', '-1', id); docker('rm', id);
      } catch (_) { result.remainingContainers.push(id); result.errors.push(`Container ${id} cleanup failed; retained for inspection`); }
    }
    for (const id of resources.networks) {
      try {
        const owner = docker('network', 'inspect', '-f', '{{index .Labels "polar-paykit.test-run"}}', id).trim();
        if (owner !== runId) throw new Error('owner mismatch');
        docker('network', 'rm', id);
      } catch (_) { result.remainingNetworks.push(id); result.errors.push(`Network ${id} cleanup failed; retained for inspection`); }
    }
    if (!result.errors.length) {
      try {
        const containers = docker('ps', '-aq', '--no-trunc', '--filter', `label=${label}`).trim();
        const networks = docker('network', 'ls', '--no-trunc', '--format', '{{.ID}}', '--filter', `label=${label}`).trim();
        if (containers || networks) throw new Error('Owned resources remain');
      } catch (_) { result.errors.push('Final Docker cleanup inventory could not be verified'); }
    }
    if (!result.errors.length) {
      try { for (const suffix of ['a', 'b']) fs.rmSync(path.join(root, suffix), { recursive: true, force: true }); }
      catch (_) { result.errors.push('Owned data cleanup failed; retained for inspection'); }
    }
    result.completed = result.errors.length === 0;
    resources.cleanup = result; record();
    progress(result.completed ? 'cleanup:completed' : 'cleanup:incomplete');
    return result;
  }
  record(); progress('run:started');
  console.log(`Paykit CI artifact root: ${root}; Node ${process.version}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact-root=${root}\n`);
  runCli(work, {
    // Two sequential 72-stage environments exceed the former 20-minute allowance.
    timeoutMs: 1800000,
    cleanup,
    complete(result, cleaned) {
      const report = { schemaVersion: 1, runId, startedAt, completedAt: new Date().toISOString(), passed: true, cleanup: cleaned, ...result };
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
      validateReport(root);
      progress('run:completed');
      console.log('Both persistent Paykit environment scenarios passed.');
    },
    fail(error, cleaned) {
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ schemaVersion: 1, runId, startedAt, completedAt: new Date().toISOString(), passed: false, cleanup: cleaned, error: error.message, lastStage: lastScenarioStage }, null, 2));
    },
  });
}
module.exports = { validateReport, requiredStages, redactedReceiverStatuses, assertRunningReceivers };
if (require.main === module) {
  if (process.argv[2] === '--verify-report') {
    try { validateReport(process.argv[3]); console.log('Required Paykit completion report verified.'); }
    catch (_) { console.error('Missing, incomplete or invalid Paykit completion report'); process.exitCode = 1; }
  } else {
    start();
  }
}
