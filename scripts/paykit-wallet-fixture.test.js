const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { storageFaults, gateControls, atomicJson, images } = require('./paykit-wallet-fixture');

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
