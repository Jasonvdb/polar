const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createBackupFixture } = require('./paykit-backup-fixture');

test('backup fixture image is mandatory before any runtime access', () => {
  let called = false;
  assert.throws(() => createBackupFixture({ docker: () => { called = true; } }), /PAYKIT_BACKUP_FIXTURE_IMAGE/);
  assert.equal(called, false);
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
