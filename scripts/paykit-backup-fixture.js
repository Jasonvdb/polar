/* Narrow one-shot wrapper for the separately built non-shipping backup fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[a-f0-9]{64}$/;

function syncFile(filename) { const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function syncDirectory(filename) { const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function fileHash(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }

function createBackupFixture({ data, secrets, environmentId, runId, uid, docker, recordContainer, serviceContainer, image, recordEvidence }) {
  assert(image, 'PAYKIT_BACKUP_FIXTURE_IMAGE must select the separately built non-shipping target');
  assert.equal(docker('inspect', '-f', '{{index .Config.Labels "polar-paykit.test-run"}}', serviceContainer).trim(), runId);
  docker('exec', serviceContainer, 'sh', '-c', 'test ! -e /usr/local/bin/paykit-backup-fixture && test ! -e /usr/local/bin/paykit-receipt-fixture');
  const stateRoot = path.join(data, 'state'); const journal = path.join(stateRoot, 'receivers/wallet-execution/executions.cbor');
  const rollbackRoot = path.join(data, 'backup-fixture-rollbacks'); fs.mkdirSync(rollbackRoot, { mode: 0o700 });
  const evidence = [];
  const verify = () => {
    assert.equal(docker('inspect', '-f', '{{index .Config.Labels "polar-paykit.test-run"}}', serviceContainer).trim(), runId);
    assert.equal(fs.realpathSync(stateRoot), stateRoot); assert.equal(fs.lstatSync(journal).isFile(), true); assert.equal(fs.lstatSync(journal).isSymbolicLink(), false);
  };
  function invoke(action, args) {
    verify(); const id = docker('run', '-d', '--init', '--read-only', '--name', `polar-paykit-backup-${randomUUID()}`, '--label', `polar-paykit.test-run=${runId}`, '--user', uid,
      '--mount', `type=bind,src=${stateRoot},dst=/data`, '--mount', `type=bind,src=${path.join(secrets, 'master-key')},dst=/run/paykit/master-key,readonly`,
      '--mount', `type=bind,src=${path.join(secrets, 'api-token')},dst=/run/paykit/api-token,readonly`, '-e', `PAYKIT_ENVIRONMENT_ID=${environmentId}`,
      '-e', 'PAYKIT_DATA_DIR=/data', '-e', 'PAYKIT_KEY_FILE=/run/paykit/master-key', '-e', 'PAYKIT_TOKEN_FILE=/run/paykit/api-token', image, action, ...args).trim();
    recordContainer(id); assert.equal(docker('wait', id).trim(), '0', `Backup fixture ${action} failed`);
    return JSON.parse(docker('logs', id));
  }
  return {
    pruneExecutions(receiverId, coreTxid, paymentHash) {
      assert.match(receiverId, uuid); assert.match(coreTxid, hash); assert.match(paymentHash, hash); verify();
      const rollback = path.join(rollbackRoot, `executions-${randomUUID()}.cbor`);
      fs.copyFileSync(journal, rollback, fs.constants.COPYFILE_EXCL); fs.chmodSync(rollback, 0o600); syncFile(rollback); syncDirectory(rollbackRoot);
      const value = invoke('prune-executions', [receiverId, coreTxid, paymentHash]);
      assert.deepEqual(value, { removedExecutions: 2, removedSettlements: 2 });
      evidence.push({ action: 'prune-executions', receiverId, coreTxid, paymentHash, ...value }); recordEvidence(evidence);
      return () => {
        verify(); const replaced = `${journal}.pr8-pruned`;
        fs.renameSync(journal, replaced); fs.renameSync(rollback, journal); syncFile(journal); syncDirectory(path.dirname(journal));
        assert.equal(fs.lstatSync(replaced).isFile(), true);
        evidence.push({ action: 'restore-pruned', receiverId }); recordEvidence(evidence);
      };
    },
    markPeerUnsafe(receiverId, peerPublicKey, peerReceiverPath) {
      assert.match(receiverId, uuid); verify();
      const receiverRoot = path.join(stateRoot, 'receivers', receiverId);
      assert.equal(fs.realpathSync(receiverRoot), receiverRoot, 'Receiver directory must be owned and must not traverse symlinks');
      const sdk = path.join(receiverRoot, 'sdk.cbor'); const sdkStat = fs.lstatSync(sdk);
      assert(sdkStat.isFile() && !sdkStat.isSymbolicLink(), 'SDK state must be a regular non-symlink file');
      const originalHash = fileHash(sdk); const rollback = path.join(rollbackRoot, `sdk-${receiverId}-${randomUUID()}.cbor`);
      fs.copyFileSync(sdk, rollback, fs.constants.COPYFILE_EXCL); fs.chmodSync(rollback, 0o600); syncFile(rollback); syncDirectory(rollbackRoot);
      assert.equal(fileHash(rollback), originalHash, 'SDK rollback copy must exactly match the encrypted source');
      const value = invoke('mark-peer-unsafe', [receiverId, peerPublicKey, peerReceiverPath]);
      assert.deepEqual(value, { unsafeCheckpoints: 1 });
      const mutatedHash = fileHash(sdk); assert.notEqual(mutatedHash, originalHash, 'Unsafe checkpoint fixture must change SDK state');
      let used = false;
      const restore = () => {
        assert.equal(used, false, 'SDK rollback is single-use'); verify();
        assert.equal(fs.realpathSync(rollbackRoot), rollbackRoot, 'SDK rollback directory must remain canonical');
        const rollbackStat = fs.lstatSync(rollback);
        assert(rollbackStat.isFile() && !rollbackStat.isSymbolicLink(), 'SDK rollback must be a regular non-symlink file');
        assert.equal(fs.realpathSync(rollback), rollback, 'SDK rollback path must remain canonical');
        assert.equal(fileHash(rollback), originalHash, 'SDK rollback changed after fixture mutation');
        assert.equal(fs.realpathSync(receiverRoot), receiverRoot, 'Receiver directory must remain owned');
        const liveStat = fs.lstatSync(sdk); assert(liveStat.isFile() && !liveStat.isSymbolicLink(), 'Live SDK state must remain a regular non-symlink file');
        assert.equal(fileHash(sdk), mutatedHash, 'Live SDK state changed after fixture mutation');
        used = true;
        const staged = path.join(receiverRoot, `.sdk-pr8-restore-${randomUUID()}.cbor`);
        fs.copyFileSync(rollback, staged, fs.constants.COPYFILE_EXCL); fs.chmodSync(staged, sdkStat.mode & 0o777); syncFile(staged);
        fs.renameSync(staged, sdk); syncFile(sdk); syncDirectory(receiverRoot);
        assert.equal(fileHash(sdk), originalHash, 'Restored SDK state must exactly match the encrypted original');
        evidence.push({ action: 'restore-peer-checkpoint', receiverId }); recordEvidence(evidence);
      };
      evidence.push({ action: 'mark-peer-unsafe', receiverId, unsafeCheckpoints: 1 }); recordEvidence(evidence);
      return { ...value, restore };
    },
    journalProjection() {
      const value = invoke('journal-projection', []);
      assert.deepEqual(Object.keys(value).sort(), ['digest', 'executionCount', 'settlementCount', 'terminalByReceiver'].sort());
      assert.match(value.digest, hash); assert(Number.isSafeInteger(value.executionCount) && value.executionCount >= 0);
      assert(Number.isSafeInteger(value.settlementCount) && value.settlementCount >= 0);
      assert(value.terminalByReceiver && Object.entries(value.terminalByReceiver).every(([receiverId, count]) => uuid.test(receiverId) && Number.isSafeInteger(count) && count >= 0));
      return value;
    },
    evidence: () => evidence,
  };
}
module.exports = { createBackupFixture };
