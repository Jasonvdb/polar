const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackupFixture } = require('./paykit-backup-fixture');

test('backup fixture image is mandatory before any runtime access', () => {
  let called = false;
  assert.throws(() => createBackupFixture({ docker: () => { called = true; } }), /PAYKIT_BACKUP_FIXTURE_IMAGE/);
  assert.equal(called, false);
});
