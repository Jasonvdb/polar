const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { storageFaults, visibleStorageFaults, readGuestLedger, gateControls, atomicJson, images } = require('./paykit-wallet-fixture');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-wallet-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('wallet images are immutable full digests', () => {
  for (const image of Object.values(images)) assert.match(image, /@sha256:[a-f0-9]{64}$/);
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

test('execution and request commit faults are limited to their exact distinct ledgers', t => {
  const root = temporary(t); const receiverId = randomUUID();
  for (const [ledger, id] of [['executions', 'wallet-execution'], ['requests', receiverId], ['workspace', receiverId]]) {
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
