/* Test-only one-shot clients. The production service has no corruption command. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const receiptUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actions = ['inspect', 'delete', 'corrupt', 'wrong-key', 'recover'];
function validateEvidence(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), ['version', 'action', 'runId', 'environmentId', 'receiverId', 'receiptId', 'accessEventId', 'exists', 'bytes', 'digest', 'originalDigest', 'matchesPrepared', 'restored'].sort());
  assert.equal(value.version, 1);
  for (const key of ['action', 'runId', 'environmentId', 'receiverId', 'receiptId']) assert.equal(value[key], expected[key]);
  assert(receiptUuid.test(value.accessEventId));
  assert(typeof value.exists === 'boolean' && typeof value.matchesPrepared === 'boolean' && typeof value.restored === 'boolean');
  assert(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= 1024 * 1024);
  assert(/^[a-f0-9]{64}$/.test(value.originalDigest));
  assert(value.exists ? /^[a-f0-9]{64}$/.test(value.digest) : value.digest === null && value.bytes === 0);
  assert.equal(value.matchesPrepared, value.digest === value.originalDigest);
  if (value.action === 'recover') assert(value.restored && value.matchesPrepared);
  if (['delete', 'corrupt', 'wrong-key'].includes(value.action)) assert(!value.restored && !value.matchesPrepared);
  return value;
}
function createReceiptFixture({ data, secrets, environmentId, runId, uid, docker, recordContainer, serviceContainer, recordEvidence, image }) {
  assert(image, 'PAYKIT_RECEIPT_FIXTURE_IMAGE must select the separately built non-shipping target');
  const journals = path.join(data, 'receipt-fixture-journals');
  fs.mkdirSync(journals, { mode: 0o700 });
  const evidence = [];
  function verifyService() {
    assert.equal(docker('inspect', '-f', '{{index .Config.Labels "polar-paykit.test-run"}}', serviceContainer).trim(), runId);
  }
  verifyService();
  // Check the actual running production image rather than just its Dockerfile.
  docker('exec', serviceContainer, 'sh', '-c', 'test ! -e /usr/local/bin/paykit-receipt-fixture && polar-paykit 2>&1 | grep -F "Usage: polar-paykit"');
  const fixture = {
    run(action, receiverId, receiptId) {
      assert(actions.includes(action)); assert(uuid.test(receiverId)); assert(receiptUuid.test(receiptId)); verifyService();
      const receiverRoot = path.join(data, 'state', 'receivers', receiverId);
      assert.equal(fs.realpathSync(receiverRoot), receiverRoot);
      const id = docker('run', '-d', '--init', '--read-only', '--name', `polar-paykit-receipt-${randomUUID()}`, '--label', `polar-paykit.test-run=${runId}`,
        '--network', `container:${serviceContainer}`, '--user', uid,
        '--mount', `type=bind,src=${receiverRoot},dst=/data/receivers/${receiverId},readonly`,
        '--mount', `type=bind,src=${path.join(secrets, 'master-key')},dst=/run/paykit/master-key,readonly`,
        '--mount', `type=bind,src=${journals},dst=/fixture-journals`,
        '-e', `PAYKIT_ENVIRONMENT_ID=${environmentId}`, '-e', `PAYKIT_FIXTURE_RUN_ID=${runId}`,
        '-e', 'PAYKIT_DATA_DIR=/data', '-e', 'PAYKIT_KEY_FILE=/run/paykit/master-key',
        '-e', 'PAYKIT_FIXTURE_JOURNAL_DIR=/fixture-journals', image, action, receiverId, receiptId).trim();
      recordContainer(id);
      assert.equal(docker('wait', id).trim(), '0', `Receipt fixture ${action} failed; retain owned restore journal`);
      const value = validateEvidence(JSON.parse(docker('logs', id)), { action, runId, environmentId, receiverId, receiptId });
      evidence.push({ at: new Date().toISOString(), containerId: id, ...value }); recordEvidence(evidence);
      return value;
    },
    evidence: () => evidence,
    restoreFaults() {
      for (const name of fs.readdirSync(journals)) {
        const match = /^([a-f0-9-]{36})-([a-f0-9-]{36})\.json$/.exec(name);
        assert(match, 'Unexpected file in owned receipt restore journal');
        fixture.run('recover', match[1], match[2]);
      }
    },
  };
  return fixture;
}
function validateReceiptEvidence(events, scope) {
  assert(Array.isArray(events) && events.length > 0, 'Missing receipt fixture evidence');
  for (const event of events) {
    validateEvidence(Object.fromEntries(Object.entries(event).filter(([key]) => !['at', 'containerId'].includes(key))), event);
    if (scope) {
      assert.equal(event.runId, scope.runId); assert.equal(event.environmentId, scope.environmentId);
    }
  }
  for (const action of ['delete', 'corrupt', 'wrong-key']) {
    const changed = events.find(e => e.action === action);
    assert(changed, `Missing actual ${action} receipt fault`);
    validateEvidence(Object.fromEntries(Object.entries(changed).filter(([key]) => !['at', 'containerId'].includes(key))), changed);
    const restored = events.find(e => e.action === 'recover' && e.receiverId === changed.receiverId && e.receiptId === changed.receiptId);
    assert(restored && restored.restored && restored.matchesPrepared && restored.digest === changed.originalDigest, 'Receipt fault was not restored');
    assert(events.indexOf(restored) > events.indexOf(changed), 'Receipt restoration precedes fault');
  }
  const faults = events.filter(e => ['delete', 'corrupt', 'wrong-key'].includes(e.action));
  assert.equal(new Set(faults.map(e => `${e.receiverId}:${e.receiptId}`)).size, faults.length, 'Faults require separate uncached receipt identities');
}
module.exports = { createReceiptFixture, validateEvidence, validateReceiptEvidence };
