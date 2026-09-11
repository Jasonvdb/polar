const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { storageFaults, executionCommitFaults, visibleStorageFaults, readGuestLedger, readGuestExecutionLedger, gateControls, atomicJson, images, receiverStateLoss } = require('./paykit-wallet-fixture');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-wallet-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('wallet images are immutable full digests', () => {
  for (const image of Object.values(images)) assert.match(image, /@sha256:[a-f0-9]{64}$/);
});

test('two receiver losses retain distinct rollback copies', t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-double-loss-')); t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const receiverId = '123e4567-e89b-42d3-a456-426614174000'; const stateRoot = path.join(data, 'state');
  const source = path.join(stateRoot, 'receivers', receiverId); fs.mkdirSync(source, { recursive: true });
  const events = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const complete = receiverStateLoss({ stateRoot, data, receiverId, recordStorage: value => events.push(value) });
    fs.mkdirSync(source); complete();
  }
  const rollbacks = fs.readdirSync(path.join(data, 'backup-fixture-rollbacks'));
  assert.equal(rollbacks.length, 2); assert.equal(new Set(rollbacks).size, 2);
  assert.deepEqual(events.map(value => value.active), [true, false, true, false]);
});
test('exact payment commit failure leaves SDK and original ciphertext untouched and restores in finally', t => {
  const root = temporary(t); const receiverId = randomUUID();
  const directory = path.join(root, 'receivers', receiverId); fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, 'payments.cbor');
  const sdk = path.join(directory, 'sdk.cbor');
  const bytes = Buffer.from([1, 22, 3, 44]); fs.writeFileSync(target, bytes); fs.writeFileSync(sdk, 'untouched');
  const journal = []; const fault = storageFaults(root, event => journal.push(event));
  fault.setLedgerWritable(receiverId, false);
  try {
    const temp = path.join(directory, '.commit-test'); fs.writeFileSync(temp, 'new state');
    assert.throws(() => fs.renameSync(temp, target), error => ['EISDIR', 'ENOTDIR', 'EEXIST'].includes(error.code));
    assert.equal(fs.readFileSync(sdk, 'utf8'), 'untouched');
    assert.throws(() => fault.setLedgerWritable(receiverId, false), /already active/);
  } finally { fault.restoreFaults(); }
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(journal.map(event => event.active), [true, false]);
  fault.restoreFaults();
});
test('first-write faults restore absence and reject escaped receiver paths', t => {
  const root = temporary(t); const receiverId = randomUUID();
  const directory = path.join(root, 'receivers', receiverId); fs.mkdirSync(directory, { recursive: true });
  const fault = storageFaults(root);
  assert.throws(() => fault.setLedgerWritable('../other', false), /scope/);
  fault.setLedgerWritable(receiverId, false); fault.setLedgerWritable(receiverId, true);
  assert.equal(fs.existsSync(path.join(directory, 'payments.cbor')), false);
  const linked = randomUUID(); fs.symlinkSync(directory, path.join(root, 'receivers', linked));
  assert.throws(() => fault.setLedgerWritable(linked, false), /canonical/);
});
test('restoration fails closed if the owned fault target was unexpectedly changed', t => {
  const root = temporary(t); const receiverId = randomUUID();
  const directory = path.join(root, 'receivers', receiverId); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'payments.cbor'), 'original');
  const fault = storageFaults(root); fault.setLedgerWritable(receiverId, false);
  fs.writeFileSync(path.join(directory, 'payments.cbor', 'unexpected'), 'preserve');
  assert.throws(() => fault.restoreFaults(), /restoration failed/);
  assert.equal(fs.readFileSync(path.join(directory, 'payments.cbor', 'unexpected'), 'utf8'), 'preserve');
  fs.unlinkSync(path.join(directory, 'payments.cbor', 'unexpected')); fault.restoreFaults();
  assert.equal(fs.readFileSync(path.join(directory, 'payments.cbor'), 'utf8'), 'original');
});
test('gate controls are private atomic one-shot inputs and counters omit sensitive payloads', async t => {
  const root = temporary(t); const controls = gateControls(root);
  const nonce = controls.arm('core', 'hold');
  const armFile = path.join(root, 'core.arm.json');
  assert.equal(fs.statSync(armFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(armFile)), { nonce, action: 'hold' });
  assert.throws(() => controls.arm('core', 'drop'), /already armed/);
  assert.throws(() => controls.arm('../escape', 'drop'));
  atomicJson(path.join(root, `core.${nonce}.ready.json`), { nonce, successfulIssuance: true });
  assert.equal((await controls.waitReady('core', nonce)).nonce, nonce);
  controls.release('core', nonce, 'relay');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `core.${nonce}.release.json`))), { nonce, action: 'relay' });
  assert.throws(() => controls.release('core', '../bad', 'relay'));
  fs.writeFileSync(path.join(root, 'events.ndjson'), JSON.stringify({ event: 'upstream.completed', channel: 'core', counts: { requests: 4, issuanceSuccess: 1 } }) + '\n' + '{"partial":');
  assert.deepEqual(controls.counts(), { core: { requests: 4, issuanceSuccess: 1 }, lnd: { requests: 0, issuanceSuccess: 0 } });
});

function visibilityFixture(t, readGuest, options) {
  const root = temporary(t); const receiverId = randomUUID();
  const directory = path.join(root, 'receivers', receiverId); fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from('original encrypted ledger');
  const target = path.join(directory, 'payments.cbor'); fs.writeFileSync(target, bytes);
  const journal = []; const record = event => journal.push(event);
  const host = storageFaults(root, record);
  const visible = visibleStorageFaults(host, readGuest, record, options);
  return { receiverId, target, bytes, journal, host, visible, digest: createHash('sha256').update(bytes).digest('hex') };
}
test('guest barriers wait for directory then exact restored bytes before allowing continuation', async t => {
  let phase = 'blocking'; let attempts = 0; let fixture;
  fixture = visibilityFixture(t, async () => {
    attempts++;
    if (attempts < 3) return { kind: phase === 'blocking' ? 'file' : 'directory', digest: 'stale' };
    if (phase === 'blocking') return { kind: 'directory' };
    if (attempts === 3) return { kind: 'file', digest: 'wrong bytes' };
    return { kind: 'file', digest: fixture.digest };
  }, { timeoutMs: 100, pollMs: 1 });
  const restore = await fixture.visible.blockLedgerCommit(fixture.receiverId);
  assert.equal(attempts, 3);
  assert(fs.statSync(fixture.target).isDirectory());
  phase = 'restoring'; attempts = 0;
  await restore();
  assert.equal(attempts, 4);
  assert.deepEqual(fs.readFileSync(fixture.target), fixture.bytes);
  const confirmed = fixture.journal.filter(event => event.phase === 'guest');
  assert.deepEqual(confirmed.map(event => event.observed), ['directory', 'originalFile']);
  assert.equal(confirmed[0].faultId, confirmed[1].faultId);
  assert(!JSON.stringify(fixture.journal).includes(fixture.digest));
});
test('failed activation restores host bytes and never claims a guest-confirmed fault', async t => {
  let fixture;
  fixture = visibilityFixture(t, async () => ({ kind: 'file', digest: fixture.digest }), { timeoutMs: 10, pollMs: 1 });
  await assert.rejects(fixture.visible.blockLedgerCommit(fixture.receiverId), /directory visibility deadline/);
  assert.deepEqual(fs.readFileSync(fixture.target), fixture.bytes);
  assert(!fixture.journal.some(event => event.phase === 'guest' && event.active));
  assert(fixture.journal.some(event => event.phase === 'guest' && !event.active));
});
test('restoration deadline fails closed and synchronous cleanup never claims guest visibility', async t => {
  let restoring = false;
  const fixture = visibilityFixture(t, async () => {
    if (restoring) throw new Error('guest exec unavailable');
    return { kind: 'directory' };
  }, { timeoutMs: 10, pollMs: 1 });
  const restore = await fixture.visible.blockLedgerCommit(fixture.receiverId);
  restoring = true;
  await assert.rejects(restore(), /file visibility deadline/);
  fixture.host.restoreFaults();
  assert.deepEqual(fs.readFileSync(fixture.target), fixture.bytes);
  assert(!fixture.journal.some(event => event.phase === 'guest' && !event.active));
});
test('restoration of an initially absent ledger waits for guest absence', async t => {
  let observed = 'directory';
  const fixture = visibilityFixture(t, async () => ({ kind: observed }), { timeoutMs: 100, pollMs: 1 });
  fs.unlinkSync(fixture.target);
  const restore = await fixture.visible.blockLedgerCommit(fixture.receiverId);
  observed = 'absent'; await restore();
  assert.equal(fs.existsSync(fixture.target), false);
  assert.equal(fixture.journal.at(-1).observed, 'absent');
});
test('guest probes use bounded exec in service namespace and keep digests out of arguments', () => {
  const receiverId = randomUUID(); const digest = 'a'.repeat(64); let args;
  const docker = { withTimeout: (...input) => { args = input; return digest + '  /data/receiver/payments.cbor\n'; } };
  assert.deepEqual(readGuestLedger(docker, 'owned-service', receiverId), { kind: 'file', digest });
  assert.deepEqual(args.slice(0, 5), [1000, 'exec', 'owned-service', 'sh', '-c']);
  assert.equal(args.at(-1), `/data/receivers/${receiverId}/payments.cbor`);
  assert(!args.some(value => String(value).includes(digest)));
  assert.throws(() => readGuestLedger(docker, 'owned-service', '../escape'));
});

test('request and workspace commit faults are limited to their exact distinct ledgers', t => {
  const root = temporary(t); const receiverId = randomUUID();
  for (const [ledger, id] of [['requests', receiverId], ['workspace', receiverId]]) {
    const directory = path.join(root, 'receivers', id); fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, `${ledger}.cbor`); fs.writeFileSync(target, `original ${ledger}`);
    const sdk = path.join(directory, 'sdk.cbor'); fs.writeFileSync(sdk, 'untouched');
    const fault = storageFaults(root, () => {}, ledger);
    assert.throws(() => fault.setLedgerWritable(ledger === 'executions' ? receiverId : 'wallet-execution', false), /scope/);
    fault.setLedgerWritable(id, false);
    assert(fs.statSync(target).isDirectory());
    assert.equal(fs.readFileSync(sdk, 'utf8'), 'untouched');
    fault.restoreFaults();
    assert.equal(fs.readFileSync(target, 'utf8'), `original ${ledger}`);
  }
  assert.throws(() => storageFaults(root, () => {}, '../sdk'));
});
test('execution gate controls specify a matching wallet operation and accept proven execution readiness', async t => {
  const root = temporary(t); const controls = gateControls(root);
  const nonce = controls.arm('core', 'drop', 'sendrawtransaction');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'core.arm.json'))), { nonce, action: 'drop', operation: 'sendrawtransaction' });
  assert.throws(() => controls.arm('lnd', 'drop', 'sendrawtransaction'));
  atomicJson(path.join(root, `core.${nonce}.ready.json`), { nonce, successfulIssuance: false, successfulExecution: true });
  assert.equal((await controls.waitReady('core', nonce)).successfulExecution, true);
});
test('shared execution guest probe uses only the fixed coordinator location', () => {
  let args;
  const docker = { withTimeout: (...input) => { args = input; return 'directory'; } };
  assert.deepEqual(readGuestLedger(docker, 'owned-service', 'wallet-execution', 'executions'), { kind: 'directory' });
  assert.equal(args.at(-1), '/data/receivers/wallet-execution/executions.cbor');
  assert.throws(() => readGuestLedger(docker, 'owned-service', '../wallet-execution', 'executions'));
  assert.throws(() => readGuestLedger(docker, 'owned-service', randomUUID(), 'executions'));
});

test('optional channel gate control accepts only LND openchannel and proven channel readiness', async t => {
  const root = temporary(t); const controls = gateControls(root);
  assert.throws(() => controls.arm('core', 'hold', 'openchannel'));
  const nonce = controls.arm('lnd', 'hold', 'openchannel');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'lnd.arm.json'))), { nonce, action: 'hold', operation: 'openchannel' });
  atomicJson(path.join(root, `lnd.${nonce}.ready.json`), { nonce, successfulIssuance: false, successfulExecution: false, successfulChannel: true, operation: 'openchannel', fundingTxid: 'a'.repeat(64), outputIndex: 0 });
  const ready = await controls.waitReady('lnd', nonce);
  assert.equal(ready.successfulChannel, true); assert.equal(ready.outputIndex, 0);
});


test('shared execution commit fault preserves reads and lock across repeated ticks and restores exact permissions', async t => {
  assert(process.getuid() > 0, 'Permission-fault verification must run as non-root');
  const root = temporary(t); const directory = path.join(root, 'receivers', 'wallet-execution');
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  fs.chmodSync(directory, 0o750);
  const target = path.join(directory, 'executions.cbor'); const bytes = Buffer.from('original encrypted execution snapshot');
  fs.writeFileSync(target, bytes, { mode: 0o600 }); fs.writeFileSync(path.join(directory, 'spending.lock'), '');
  const journal = []; const fault = executionCommitFaults(root, event => journal.push(event));
  const read = () => {
    let writable = true; const probe = path.join(directory, '.new-commit-probe');
    try { fs.writeFileSync(probe, '', { flag: 'wx' }); fs.unlinkSync(probe); }
    catch (error) { assert.equal(error.code, 'EACCES'); writable = false; }
    return { kind: 'file', digest: createHash('sha256').update(fs.readFileSync(target)).digest('hex'), mode: fs.statSync(directory).mode & 0o7777, writable, uid: process.getuid() };
  };
  const visible = visibleStorageFaults(fault, read, event => journal.push(event), { timeoutMs: 100, pollMs: 5 });
  const restore = await visible.blockLedgerCommit('wallet-execution');
  try {
    assert.throws(() => fault.setLedgerWritable('wallet-execution', false), /already active/);
    for (let tick = 0; tick < 4; tick++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await restore.assertActive();
      assert.deepEqual(fs.readFileSync(target), bytes);
      const lock = fs.openSync(path.join(directory, 'spending.lock'), 'r+'); fs.closeSync(lock);
      assert.throws(() => fs.writeFileSync(path.join(directory, '.execution-commit'), 'new snapshot', { flag: 'wx' }), error => error.code === 'EACCES');
    }
  } finally { await restore(); }
  assert.equal(fs.statSync(directory).mode & 0o7777, 0o750);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.equal(read().writable, true);
  assert(journal.filter(e => e.phase === 'guest' && e.active).every(e => e.observed === 'readableCommitBlocked' && e.uid > 0 && e.writable === false));
  assert(journal.some(e => e.phase === 'guest' && !e.active && e.writable === true));
  assert(!JSON.stringify(journal).includes(createHash('sha256').update(bytes).digest('hex')));
});
test('shared execution fault requires existing ledger and lock and cleanup tolerates unused fault', t => {
  const root = temporary(t); const fault = executionCommitFaults(root); fault.restoreFaults();
  assert.throws(() => fault.setLedgerWritable('../other', false), /scope/);
  const directory = path.join(root, 'receivers', 'wallet-execution'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'executions.cbor'), 'original');
  const mode = fs.statSync(directory).mode;
  assert.throws(() => fault.setLedgerWritable('wallet-execution', false), /ENOENT/);
  assert.equal(fs.statSync(directory).mode, mode);
  assert.throws(() => storageFaults(root, () => {}, 'executions'));
});
test('shared execution guest barrier requires non-root service UID, readable digest and actual write probe', () => {
  const digest = 'c'.repeat(64); let args;
  const docker = { withTimeout: (...input) => { args = input; return `1001 500 ${digest} false`; } };
  assert.deepEqual(readGuestExecutionLedger(docker, 'owned', 'wallet-execution'), { kind: 'file', digest, uid: 1001, mode: 0o500, writable: false });
  assert.equal(args[0], 1000); assert.deepEqual(args.slice(1, 5), ['exec', 'owned', 'sh', '-c']);
  assert(args[5].includes('/proc/1/status')); assert(args[5].includes('mktemp')); assert(args[5].includes('test "$uid" -gt 0'));
  assert.equal(args.at(-1), '/data/receivers/wallet-execution/executions.cbor'); assert(!args.includes(digest));
  docker.withTimeout = () => `0 500 ${digest} false`;
  assert.throws(() => readGuestExecutionLedger(docker, 'owned', 'wallet-execution'), /non-root/);
  assert.throws(() => readGuestExecutionLedger(docker, 'owned', randomUUID()), /scope/);
});


test('shared commit fault fails closed if guest can still write and restores its original directory mode', async t => {
  const root = temporary(t); const directory = path.join(root, 'receivers', 'wallet-execution');
  fs.mkdirSync(directory, { recursive: true }); fs.chmodSync(directory, 0o750);
  const bytes = Buffer.from('readable ciphertext'); fs.writeFileSync(path.join(directory, 'executions.cbor'), bytes);
  fs.writeFileSync(path.join(directory, 'spending.lock'), '');
  const journal = []; const fault = executionCommitFaults(root, event => journal.push(event));
  const read = () => ({ kind: 'file', uid: 1001, mode: fs.statSync(directory).mode & 0o7777, digest: createHash('sha256').update(bytes).digest('hex'), writable: true });
  const visible = visibleStorageFaults(fault, read, event => journal.push(event), { timeoutMs: 30, pollMs: 5 });
  await assert.rejects(visible.blockLedgerCommit('wallet-execution'), /visibility deadline/);
  assert.equal(fs.statSync(directory).mode & 0o7777, 0o750);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'executions.cbor')), bytes);
  assert(!journal.some(event => event.phase === 'guest' && event.active));
  assert(journal.some(event => event.phase === 'guest' && !event.active && event.writable));
});


test('Core restart requires exact identity and records only normal stop then changed start identity', async () => {
  const { coreLifecycle } = require('./paykit-wallet-fixture');
  const current = { Id:'owned-core',Name:'/owned',Image:'sha256:fixture',Config:{Labels:{'polar-paykit.test-run':'run'}},Mounts:[{Destination:'/b',Source:'/owned/b'},{Destination:'/a',Source:'/owned/a'}],State:{StartedAt:'first',Running:true,Paused:false} };
  const calls=[],events=[];
  const docker=(...args)=>{calls.push(args);if(args[0]==='inspect')return JSON.stringify([current]);if(args[0]==='stop'){current.State.Running=false;return 'owned-core';}if(args[0]==='start'){current.State.Running=true;current.State.StartedAt='second';return 'owned-core';}assert.fail('Unexpected Docker action');};
  const lifecycle=coreLifecycle({docker,coreContainer:'owned-core',runId:'run',core:()=>({chain:'regtest'}),record:e=>events.push(e)});
  await lifecycle.stopCore();await lifecycle.startCore();
  assert.deepEqual(calls.filter(c=>c[0]!=='inspect'),[['stop','--timeout','-1','owned-core'],['start','owned-core']]);
  assert.deepEqual(events.map(e=>e.action),['stopIntent','stopped','startIntent','started']);
  assert.equal(events[3].identity.startedAt,'second');assert.deepEqual(events[0].identity.mounts.map(m=>m.Destination),['/a','/b']);
  current.Mounts[0].Source='/another';await assert.rejects(lifecycle.stopCore(),/identity changed/);
  assert.equal(calls.filter(c=>c[0]==='stop').length,1);
});

test('Core lifecycle refuses foreign ownership before accepting actions', () => {
  const { coreLifecycle } = require('./paykit-wallet-fixture');
  assert.throws(()=>coreLifecycle({docker:()=>JSON.stringify([{Id:'core',Name:'/core',Image:'image',Config:{Labels:{'polar-paykit.test-run':'other'}},Mounts:[],State:{StartedAt:'time'}}]),coreContainer:'core',runId:'run'}));
});
