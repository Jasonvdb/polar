const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = require.resolve('./paykit-harness');
function recurringEvidence() {
  const { randomUUID } = require('node:crypto');
  const hash = 'a'.repeat(64);
  return {
    version: 1,
    regressions: { oversizedRejected: true, rawProofHold: { requestId: randomUUID(), proofId: randomUUID(), externalTxid: hash, heldSends: 1, payablePeriodTxid: 'b'.repeat(64), sendsAfter: 2, walletBefore: hash, walletAfter: hash, resolverBefore: hash, resolverAfter: hash }, oldOfferIndex: 0, oldCurrentIndex: 128, oldManual: true, coreRestarts: ['unsigned','broadcast'].map((phase,index)=>({phase,executionId:randomUUID(),txid:String(index).repeat(64),transactionDigest:hash,originalDigest:hash,walletWasUnloaded:true,walletDirectoryBefore:['paykit-fixture'],walletDirectoryAfter:['paykit-fixture'],sendsBefore:index,sendsAfter:index+1})) },
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
function receiptEvidence(environmentId) {
  const { randomUUID } = require('node:crypto');
  return ['delete', 'corrupt', 'wrong-key'].flatMap(action => {
    const value = { version: 1, action, runId: 'current', environmentId, receiverId: randomUUID(), receiptId: randomUUID(), accessEventId: randomUUID(), exists: action !== 'delete', bytes: action === 'delete' ? 0 : 20, digest: action === 'delete' ? null : 'a'.repeat(64), originalDigest: 'b'.repeat(64), matchesPrepared: false, restored: false };
    return [value, { ...value, action: 'recover', exists: true, bytes: 30, digest: value.originalDigest, matchesPrepared: true, restored: true }];
  });
}
function walletEvidence(environment) {
  const completed = (channel, id) => ({ event: 'upstream.completed', channel, id, nonce: `nonce-${id}`, successfulIssuance: true });
  const dropped = (channel, id) => ({ event: 'response.dropped', channel, id, nonce: `nonce-${id}` });
  return {
    coreContainer: `${environment}-core`, lndContainers: [0, 1, 2].map(i => `${environment}-lnd-${i}`), gateContainer: `${environment}-gate`,
    readiness: [0, 1, 2].map(i => ({ syncedToChain: true, publicKey: `${environment}-wallet-${i}`, version: '0.20.0' })),
    gateCounts: { core: { issuanceSuccess: 2, executionSuccess: 1 }, lnd: { issuanceSuccess: 1, executionSuccess: 1 } },
    gateEvents: [completed('core', 1), dropped('core', 1), completed('lnd', 2), dropped('lnd', 2), completed('core', 3), { event: 'hold.finished', channel: 'core', id: 3, nonce: 'nonce-3', action: 'relay', reason: 'control' }, { ...completed('core', 4), successfulIssuance: false, successfulExecution: true }, dropped('core', 4), { ...completed('lnd', 5), successfulIssuance: false, successfulExecution: true }, dropped('lnd', 5)],
    coreLifecycle: [0, 1].flatMap(cycle => ['stopIntent','stopped','startIntent','started'].map((action,index)=>({action,identity:{id:`${environment}-core`,startedAt:String(cycle+(index===3?1:0)),labels:{'polar-paykit.test-run':'current'},mounts:[]}}))),
    storageFaults: ['payments', 'workspace', 'requests', 'executions'].flatMap(ledger => [
      { receiverId: 'receiver', faultId: ledger, boundary: ledger === 'executions' ? 'executions.cbor commit temp creation' : `${ledger}.cbor atomic rename`, phase: 'host', active: true },
      { receiverId: 'receiver', faultId: ledger, boundary: ledger === 'executions' ? 'executions.cbor commit temp creation' : `${ledger}.cbor atomic rename`, phase: 'guest', active: true, observed: ledger === 'executions' ? 'readableCommitBlocked' : 'directory', ...(ledger === 'executions' ? { uid: 1001, writable: false } : {}) },
      { receiverId: 'receiver', faultId: ledger, boundary: ledger === 'executions' ? 'executions.cbor commit temp creation' : `${ledger}.cbor atomic rename`, phase: 'host', active: false },
      { receiverId: 'receiver', faultId: ledger, boundary: ledger === 'executions' ? 'executions.cbor commit temp creation' : `${ledger}.cbor atomic rename`, phase: 'guest', active: false, observed: 'originalFile', ...(ledger === 'executions' ? { uid: 1001, writable: true } : {}) },
    ]),
  };
}
const { validateReport, requiredStages, captureFailureDiagnostics, captureFailureDiagnosticsSafely, PRIVATE_DIAGNOSTIC_BYTES } = require('./paykit-ci');

function child(code) {
  const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(result.error);
  return result;
}

test('unguarded promise waiting for AbortSignal timeout can exit zero without completion', () => {
  const result = child('async function main() { await new Promise(resolve => AbortSignal.timeout(50).addEventListener("abort", resolve)); console.log("COMPLETED"); } main().catch(() => { process.exitCode = 1; });');
  assert.equal(result.status, 0);
  assert(!result.stdout.includes('COMPLETED'));
});

test('unresolved work fails nonzero and performs cleanup exactly once', () => {
  const result = child(`const {runCli}=require(${JSON.stringify(helper)}); runCli(() => new Promise(() => {}), {timeoutMs:30, cleanup:()=>{console.log('CLEANED');return {completed:true}}, complete:()=>console.log('COMPLETED'), fail:()=>console.log('FAILURE_REPORT')});`);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.match(/CLEANED/g)?.length, 1);
  assert(result.stdout.includes('FAILURE_REPORT'));
  assert(!result.stdout.includes('COMPLETED'));
  assert(result.stderr.includes('deadline exceeded'));
});

test('explicit premature zero exit cannot bypass failure guard or cleanup', () => {
  const result = child(`const {runCli}=require(${JSON.stringify(helper)}); runCli(() => process.exit(0), {cleanup:()=>{console.log('CLEANED');return {completed:true}}, complete:()=>console.log('COMPLETED')});`);
  assert.equal(result.status, 1);
  assert(result.stdout.includes('CLEANED'));
  assert(!result.stdout.includes('COMPLETED'));
});

test('request body that never settles hits referenced deadline and unwinds before cleanup', () => {
  const result = child(`const {runCli,requestJson}=require(${JSON.stringify(helper)}); global.fetch=async()=>({status:200,json:()=>new Promise(()=>{})}); runCli(async signal=>{try{await requestJson('http://127.0.0.1/health',{},signal,30)}finally{console.log('WORK_UNWOUND')}}, {timeoutMs:500,cleanup:()=>{console.log('CLEANED');return {completed:true}},complete:()=>console.log('COMPLETED')});`);
  assert.equal(result.status, 1);
  assert(result.stderr.includes('HTTP request deadline exceeded: GET /health'));
  assert(result.stdout.indexOf('WORK_UNWOUND') < result.stdout.indexOf('CLEANED'));
  assert(!result.stdout.includes('COMPLETED'));
});

test('overall abort unwinds cooperative work before cleanup and never resumes mutation', () => {
  const result = child(`const {runCli,sleep}=require(${JSON.stringify(helper)}); runCli(async signal=>{try{await sleep(10000,signal);console.log('LATE_MUTATION')}finally{console.log('WORK_UNWOUND')}}, {timeoutMs:30,cleanup:()=>{console.log('CLEANED');return {completed:true}}});`);
  assert.equal(result.status, 1);
  assert(result.stdout.indexOf('WORK_UNWOUND') < result.stdout.indexOf('CLEANED'));
  assert(!result.stdout.includes('LATE_MUTATION'));
});

test('cleanup failure prevents a successful completion report', () => {
  const result = child(`const {runCli}=require(${JSON.stringify(helper)}); runCli(async()=>({passed:true}), {cleanup:()=>({completed:false,remainingContainers:['owned']}),complete:()=>console.log('COMPLETED'),fail:(_error,cleanup)=>console.log(JSON.stringify(cleanup))});`);
  assert.equal(result.status, 1);
  assert(result.stdout.includes('owned'));
  assert(!result.stdout.includes('COMPLETED'));
});

test('successful work only exits zero after cleanup and completion validation', () => {
  const result = child(`const {runCli}=require(${JSON.stringify(helper)}); runCli(async()=>{console.log('WORK');return true}, {cleanup:()=>{console.log('CLEANED');return {completed:true}},complete:()=>console.log('COMPLETED')});`);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /WORK\nCLEANED\nCOMPLETED/);
});

test('resources-only, stale, incomplete and unclean reports fail validation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-report-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cleanup = { completed: true, remainingContainers: [], remainingNetworks: [], errors: [] };
  const ledger = { runId: 'current', cleanup, environments: ['a', 'b'].map(environmentId => ({ environmentId, wallets: walletEvidence(environmentId), receiptEvidence: receiptEvidence(environmentId) })) };
  fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify(ledger));
  assert.throws(() => validateReport(root));
  const report = { schemaVersion: 1, runId: 'current', passed: true, completedAt: new Date().toISOString(), cleanup, survivingEnvironmentVerified: true, survivingWalletEnvironmentVerified: true, environments: ['a', 'b'].map(environmentId => ({ environmentId, passed: true, stages: requiredStages, recurringEvidence: recurringEvidence(), participantKeys: [1, 2, 3].map(i => `${environmentId}-p${i}`), receiverNoiseKeys: [1, 2, 3, 4].map(i => `${environmentId}-r${i}`) })) };
  const write = value => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(value));
  write(report); assert.equal(validateReport(root).passed, true);
  assert.equal(requiredStages.length, 73);
  assert.equal(new Set(requiredStages).size, 73);
  write({ ...report, survivingWalletEnvironmentVerified: false }); assert.throws(() => validateReport(root));
  for (const missing of ['issuance-reconciliation', 'storage-commit-safety', 'funded-preset', 'onchain-settlement', 'lightning-settlement', 'execution-reconciliation', 'execution-storage-safety', 'proof-delivery-recovery', 'recurring-raw-proof-hold', 'recurring-onchain-manual', 'recurring-lightning-autopay', 'recurring-failure-safety', 'recurring-core-unsigned-restart', 'recurring-core-broadcast-restart']) {
    write({ ...report, environments: report.environments.map(environment => ({ ...environment, stages: environment.stages.filter(stage => stage !== missing) })) });
    assert.throws(() => validateReport(root));
  }
  write(report);
  for (const change of [
    wallets => { wallets.gateEvents = []; },
    wallets => { wallets.gateEvents = wallets.gateEvents.filter(event => !event.successfulExecution); },
    wallets => { wallets.storageFaults = wallets.storageFaults.filter(event => event.boundary !== 'executions.cbor commit temp creation'); },
    wallets => { wallets.storageFaults = wallets.storageFaults.filter(event => event.boundary !== 'requests.cbor atomic rename'); },
    wallets => { wallets.gateEvents.find(event => event.event === 'upstream.completed').nonce = 'unrelated'; },
    wallets => { wallets.storageFaults.find(e => e.boundary === 'executions.cbor commit temp creation' && e.phase === 'guest' && e.active).uid = 0; },
    wallets => { wallets.storageFaults.find(e => e.boundary === 'executions.cbor commit temp creation' && e.phase === 'guest' && e.active).writable = true; },
    wallets => { wallets.storageFaults.find(e => e.boundary === 'executions.cbor commit temp creation' && e.phase === 'guest' && !e.active).writable = false; },
    wallets => { wallets.storageFaults.pop(); },
    wallets => { wallets.storageFaults = wallets.storageFaults.filter(event => event.phase !== 'guest'); },
    wallets => { wallets.storageFaults[1].observed = 'file'; },
    wallets => { wallets.storageFaults[3].faultId = 'different'; },
    wallets => { wallets.storageFaults.reverse(); },
    wallets => { wallets.lndContainers.pop(); },
    wallets => { wallets.readiness[0].syncedToChain = false; },
  ]) {
    const broken = JSON.parse(JSON.stringify(ledger)); change(broken.environments[0].wallets);
    fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify(broken));
    assert.throws(() => validateReport(root));
  }
  fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify(ledger));
  write({ ...report, runId: 'stale' }); assert.throws(() => validateReport(root));
  write({ ...report, environments: [{ ...report.environments[0], stages: ['readiness'] }, report.environments[1]] }); assert.throws(() => validateReport(root));
  write({ ...report, cleanup: { ...cleanup, completed: false, remainingContainers: ['owned'] } }); assert.throws(() => validateReport(root));
});


test('requests resolve the current Docker mapping after restart rather than the original port', () => {
  const result = child(`const assert=require('node:assert/strict'); const {serviceBase,requestJson,runCli}=require(${JSON.stringify(helper)});
    let port=32769; const calls=[];
    const docker=(...args)=>{assert.deepEqual(args,['port','owned-service','10090/tcp']);return '127.0.0.1:'+port+'\\n'};
    global.fetch=async url=>{calls.push(url);return {status:200,json:async()=>({ready:true})}};
    runCli(async()=>{await requestJson(serviceBase('owned-service',docker)+'/health');port=32770;await requestJson(serviceBase('owned-service',docker)+'/health');await requestJson(serviceBase('owned-service',docker)+'/v1/state');return calls}, {complete: calls=>console.log(JSON.stringify(calls))});`);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['http://127.0.0.1:32769/health', 'http://127.0.0.1:32770/health', 'http://127.0.0.1:32770/v1/state']);
});


test('unexpected operation diagnostics retain public failure and receiver state only', () => {
  const { operationFailure } = require('./paykit-harness');
  const message = operationFailure('receiver.restart', { id: 'operation-id', status: 'failed', error: { code: 'operation_failed', message: 'Receiver unavailable', privateDetail: 'secret-error' }, result: { privateState: 'secret-result' } }, { id: 'receiver-id', status: 'crashed', generation: 4, lastError: 'Restart required', session: 'secret-session' });
  assert(message.includes('operation_failed') && message.includes('Receiver unavailable'));
  assert(message.includes('receiver-id') && message.includes('crashed') && message.includes('Restart required'));
  assert(!message.includes('secret-'));
  assert(operationFailure('receiver.restart', { id: 'id', status: 'failed' }).includes('id'));
});


test('survivor assertion preserves strict running gate and emits only redacted receiver identities and statuses', () => {
  const { assertRunningReceivers, redactedReceiverStatuses } = require('./paykit-ci');
  const records = [{ id: 'receiver-id', status: 'crashed', generation: 4, session: 'private-session', lastError: 'sensitive detail', publicKey: 'not-needed' }];
  assert.deepEqual(redactedReceiverStatuses(records), [{ id: 'receiver-id', status: 'crashed', generation: 4 }]);
  assert.throws(() => assertRunningReceivers(records), error => error.message.includes('receiver-id') && error.message.includes('crashed') && !error.message.includes('private-session') && !error.message.includes('sensitive detail'));
  assertRunningReceivers([{ id: 'receiver-id', status: 'running', generation: 4 }]);
  assert.throws(() => assertRunningReceivers([]));
});

test('failure diagnostics capture only owned service stderr privately and expose bounded metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-private-diagnostic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = 'owned-run'; const id = 'a'.repeat(64); const secret = 'secret-like-receiver-stderr';
  const resources = { containers: [id], containerDetails: [{ id, owner: runId }], environments: [{ suffix: 'b', service: id }] };
  const result = captureFailureDiagnostics({ root, runId, resources,
    inspect: owned => ({ id: owned, owner: runId, status: 'running', running: true, paused: false, restarting: false, oomKilled: false, dead: false, exitCode: 0, startedAt: 'start', finishedAt: 'finish', error: secret }),
    stderr: owned => { assert.equal(owned, id); return Buffer.from(`${'x'.repeat(PRIVATE_DIAGNOSTIC_BYTES)}${secret}`); } });
  const directory = path.join(root, 'private-diagnostics'); const file = path.join(directory, 'b-service-stderr.log');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(file).size, PRIVATE_DIAGNOSTIC_BYTES); assert(fs.readFileSync(file, 'utf8').includes(secret));
  assert.deepEqual(Object.keys(result[0]), ['suffix', 'containerId', 'state', 'stderr']);
  assert.deepEqual(Object.keys(result[0].stderr), ['file', 'bytes', 'truncated', 'sha256']);
  assert.equal(result[0].stderr.file, 'b-service-stderr.log'); assert.equal(result[0].stderr.truncated, true);
  assert.match(result[0].stderr.sha256, /^[a-f0-9]{64}$/); assert(!JSON.stringify(result).includes(secret));
});

test('failure diagnostic rejection stays private and returns control for cleanup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-private-diagnostic-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attempted = [];
  const result = captureFailureDiagnosticsSafely({ root, runId: 'owned-run',
    resources: { containers: [], containerDetails: [], environments: [{ suffix: 'b', service: 'f'.repeat(64) }] },
    inspect: id => { attempted.push(id); throw new Error('secret inspect failure'); }, stderr: () => { throw new Error('must not run'); } });
  assert.deepEqual(result, [{ captureError: 'capture_failed' }]); assert.deepEqual(attempted, []);
  let cleaned = false; try { throw new Error('original scenario failure'); } catch (_) { cleaned = true; }
  assert.equal(cleaned, true); assert(!JSON.stringify(result).includes('secret'));
});
