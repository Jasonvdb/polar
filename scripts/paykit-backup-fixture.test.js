const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackupFixture } = require('./paykit-backup-fixture');

test('backup fixture image is mandatory before any runtime access', () => {
  let called = false;
  assert.throws(() => createBackupFixture({ docker: () => { called = true; } }), /PAYKIT_BACKUP_FIXTURE_IMAGE/);
  assert.equal(called, false);
});

function realFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-backup-fixture-')));
  const data = path.join(root, 'data'); const secrets = path.join(root, 'secrets');
  const receiverId = 'af9f976d-b4ff-5feb-af0e-4fad185109f1';
  const receiverRoot = path.join(data, 'state/receivers', receiverId); const otherRoot = path.join(data, 'state/receivers/123e4567-e89b-42d3-a456-426614174000');
  fs.mkdirSync(path.join(data, 'state/receivers/wallet-execution'), { recursive: true }); fs.mkdirSync(receiverRoot); fs.mkdirSync(otherRoot); fs.mkdirSync(secrets);
  fs.writeFileSync(path.join(data, 'state/receivers/wallet-execution/executions.cbor'), 'journal');
  fs.writeFileSync(path.join(receiverRoot, 'sdk.cbor'), 'encrypted-original'); fs.writeFileSync(path.join(otherRoot, 'sdk.cbor'), 'unrelated');
  fs.writeFileSync(path.join(secrets, 'master-key'), 'key'); fs.writeFileSync(path.join(secrets, 'api-token'), 'token');
  let action;
  const docker = (...args) => {
    if (args[0] === 'inspect') return 'run-id'; if (args[0] === 'exec') return '';
    if (args[0] === 'run') { action = args.find(value => value === 'mark-peer-unsafe'); return 'fixture-id'; }
    if (args[0] === 'wait') { if (action === 'mark-peer-unsafe') fs.writeFileSync(path.join(receiverRoot, 'sdk.cbor'), 'encrypted-mutated'); return '0'; }
    if (args[0] === 'logs') return JSON.stringify({ unsafeCheckpoints: 1 });
    throw new Error(`Unexpected docker call ${args[0]}`);
  };
  const fixture = createBackupFixture({ data, secrets, environmentId: 'environment', runId: 'run-id', uid: '1', docker, recordContainer: () => {}, serviceContainer: 'service', image: 'fixture', recordEvidence: () => {} });
  return { root, data, receiverId, receiverRoot, otherRoot, rollbackRoot: path.join(data, 'backup-fixture-rollbacks'), fixture };
}

test('unsafe checkpoint rollback restores exact encrypted SDK and preserves unrelated state', () => {
  const setup = realFixture();
  try {
    const journal = path.join(setup.data, 'state/receivers/wallet-execution/executions.cbor');
    const rollback = setup.fixture.markPeerUnsafe(setup.receiverId, 'peer-key', 'peer/wallet');
    assert.equal(fs.readFileSync(path.join(setup.receiverRoot, 'sdk.cbor'), 'utf8'), 'encrypted-mutated');
    rollback.restore();
    assert.equal(fs.readFileSync(path.join(setup.receiverRoot, 'sdk.cbor'), 'utf8'), 'encrypted-original');
    assert.equal(fs.readFileSync(path.join(setup.otherRoot, 'sdk.cbor'), 'utf8'), 'unrelated');
    assert.equal(fs.readFileSync(journal, 'utf8'), 'journal');
    assert.throws(() => rollback.restore(), /single-use/);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('unsafe checkpoint rollback rejects changed live SDK state', () => {
  const setup = realFixture();
  try {
    const rollback = setup.fixture.markPeerUnsafe(setup.receiverId, 'peer-key', 'peer/wallet');
    fs.writeFileSync(path.join(setup.receiverRoot, 'sdk.cbor'), 'unexpected-change');
    assert.throws(() => rollback.restore(), /changed after fixture mutation/);
    assert.throws(() => rollback.restore(), /changed after fixture mutation/);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('unsafe checkpoint rollback rejects a replaced SDK symlink', () => {
  const setup = realFixture();
  try {
    const rollback = setup.fixture.markPeerUnsafe(setup.receiverId, 'peer-key', 'peer/wallet');
    const sdk = path.join(setup.receiverRoot, 'sdk.cbor'); fs.unlinkSync(sdk); fs.symlinkSync(path.join(setup.otherRoot, 'sdk.cbor'), sdk);
    assert.throws(() => rollback.restore(), /regular non-symlink/);
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('unsafe checkpoint rollback rejects corrupt rollback bytes without changing live SDK', () => {
  const setup = realFixture();
  try {
    const rollback = setup.fixture.markPeerUnsafe(setup.receiverId, 'peer-key', 'peer/wallet');
    const sdk = path.join(setup.receiverRoot, 'sdk.cbor');
    const rollbackFile = path.join(setup.rollbackRoot, fs.readdirSync(setup.rollbackRoot).find(name => name.startsWith('sdk-')));
    fs.writeFileSync(rollbackFile, 'corrupt-rollback');
    assert.throws(() => rollback.restore(), /rollback changed after fixture mutation/);
    assert.equal(fs.readFileSync(sdk, 'utf8'), 'encrypted-mutated');
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('unsafe checkpoint rollback rejects a rollback symlink without changing live SDK', () => {
  const setup = realFixture();
  try {
    const rollback = setup.fixture.markPeerUnsafe(setup.receiverId, 'peer-key', 'peer/wallet');
    const sdk = path.join(setup.receiverRoot, 'sdk.cbor');
    const rollbackFile = path.join(setup.rollbackRoot, fs.readdirSync(setup.rollbackRoot).find(name => name.startsWith('sdk-')));
    fs.unlinkSync(rollbackFile); fs.symlinkSync(path.join(setup.otherRoot, 'sdk.cbor'), rollbackFile);
    assert.throws(() => rollback.restore(), /rollback must be a regular non-symlink/);
    assert.equal(fs.readFileSync(sdk, 'utf8'), 'encrypted-mutated');
  } finally { fs.rmSync(setup.root, { recursive: true, force: true }); }
});

test('backup fixture accepts UUIDv5 receiver IDs for pruning', () => {
  const original = {
    mkdirSync: fs.mkdirSync,
    realpathSync: fs.realpathSync,
    lstatSync: fs.lstatSync,
    copyFileSync: fs.copyFileSync,
    chmodSync: fs.chmodSync,
    openSync: fs.openSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
  };
  let runArgs;
  let action;
  Object.assign(fs, {
    mkdirSync: () => {}, realpathSync: value => value,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    copyFileSync: () => {}, chmodSync: () => {}, openSync: () => 1,
    fsyncSync: () => {}, closeSync: () => {},
  });
  const docker = (...args) => {
    if (args[0] === 'inspect') return 'run-id';
    if (args[0] === 'exec') return '';
    if (args[0] === 'run') {
      runArgs = args;
      action = args.find(value => ['prune-executions', 'journal-projection'].includes(value));
      return 'fixture-id';
    }
    if (args[0] === 'wait') return '0';
    if (action === 'journal-projection')
      return JSON.stringify({ digest: 'c'.repeat(64), executionCount: 2, settlementCount: 2, terminalByReceiver: { 'af9f976d-b4ff-5feb-af0e-4fad185109f1': 2 } });
    return JSON.stringify({ removedExecutions: 2, removedSettlements: 2 });
  };
  try {
    const fixture = createBackupFixture({ data: '/data', secrets: '/secrets', environmentId: 'environment', runId: 'run-id', uid: '1', docker, recordContainer: () => {}, serviceContainer: 'service', image: 'fixture', recordEvidence: () => {} });
    const receiverId = 'af9f976d-b4ff-5feb-af0e-4fad185109f1';
    fixture.pruneExecutions(receiverId, 'a'.repeat(64), 'b'.repeat(64));
    assert(runArgs.includes(receiverId));
    assert.equal(fixture.journalProjection().terminalByReceiver[receiverId], 2);
    assert.throws(() => fixture.pruneExecutions('not-a-uuid', 'a'.repeat(64), 'b'.repeat(64)));
  } finally {
    Object.assign(fs, original);
  }
});
