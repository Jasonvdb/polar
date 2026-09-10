const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const helper = require.resolve('./paykit-harness');
function walletEvidence(environment) {
  const completed = (channel, id) => ({ event: 'upstream.completed', channel, id, nonce: `nonce-${id}`, successfulIssuance: true });
  const dropped = (channel, id) => ({ event: 'response.dropped', channel, id, nonce: `nonce-${id}` });
  return {
    coreContainer: `${environment}-core`, lndContainers: [0, 1, 2].map(i => `${environment}-lnd-${i}`), gateContainer: `${environment}-gate`,
    readiness: [0, 1, 2].map(i => ({ syncedToChain: true, publicKey: `${environment}-wallet-${i}`, version: '0.20.0' })),
    gateCounts: { core: { issuanceSuccess: 2 }, lnd: { issuanceSuccess: 1 } },
    gateEvents: [completed('core', 1), dropped('core', 1), completed('lnd', 2), dropped('lnd', 2), completed('core', 3), { event: 'hold.finished', channel: 'core', id: 3, nonce: 'nonce-3', action: 'relay', reason: 'control' }],
    storageFaults: [{ receiverId: 'receiver', active: true }, { receiverId: 'receiver', active: false }],
  };
}
const { validateReport, requiredStages } = require('./paykit-ci');

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
  const ledger = { runId: 'current', cleanup, environments: ['a', 'b'].map(environmentId => ({ environmentId, wallets: walletEvidence(environmentId) })) };
  fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify(ledger));
  assert.throws(() => validateReport(root));
  const report = { schemaVersion: 1, runId: 'current', passed: true, completedAt: new Date().toISOString(), cleanup, survivingEnvironmentVerified: true, survivingWalletEnvironmentVerified: true, environments: ['a', 'b'].map(environmentId => ({ environmentId, passed: true, stages: requiredStages, participantKeys: [1, 2, 3].map(i => `${environmentId}-p${i}`), receiverNoiseKeys: [1, 2, 3, 4].map(i => `${environmentId}-r${i}`) })) };
  const write = value => fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(value));
  write(report); assert.equal(validateReport(root).passed, true);
  assert.equal(requiredStages.length, 35);
  write({ ...report, survivingWalletEnvironmentVerified: false }); assert.throws(() => validateReport(root));
  for (const missing of ['issuance-reconciliation', 'storage-commit-safety']) {
    write({ ...report, environments: report.environments.map(environment => ({ ...environment, stages: environment.stages.filter(stage => stage !== missing) })) });
    assert.throws(() => validateReport(root));
  }
  write(report);
  for (const change of [
    wallets => { wallets.gateEvents = []; },
    wallets => { wallets.gateEvents.find(event => event.event === 'upstream.completed').nonce = 'unrelated'; },
    wallets => { wallets.storageFaults.pop(); },
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
