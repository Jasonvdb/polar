const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareEnvironment, cleanupNetworks } = require('./e2e-environment');

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(
      process.env.POLAR_PAYKIT_TEST_ARTIFACT_ROOT || fs.realpathSync(os.tmpdir()),
      'paykit-cleanup-',
    ),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const other = path.join(root, 'other-installation');
  fs.mkdirSync(run);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep'), 'other installation');
  return {
    run,
    other,
    env: { POLAR_PAYKIT_E2E_ROOT: run, POLAR_PAYKIT_INSTANCE: 'test-a' },
  };
}

test('cleanup preserves another installation and a concurrent test environment', t => {
  const { run, other, env } = fixture(t);
  const owned = prepareEnvironment(env);
  const concurrentRoot = path.join(path.dirname(run), 'concurrent');
  fs.mkdirSync(concurrentRoot);
  const concurrent = prepareEnvironment({
    POLAR_PAYKIT_E2E_ROOT: concurrentRoot,
    POLAR_PAYKIT_INSTANCE: 'test-b',
  });
  for (const state of [owned, concurrent]) {
    fs.mkdirSync(path.join(state.POLAR_PAYKIT_DATA_ROOT, 'networks'));
    fs.writeFileSync(
      path.join(state.POLAR_PAYKIT_DATA_ROOT, 'networks', 'state'),
      'persist',
    );
  }
  cleanupNetworks(owned);
  assert.equal(fs.existsSync(path.join(owned.POLAR_PAYKIT_DATA_ROOT, 'networks')), false);
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'other installation');
  assert.equal(
    fs.readFileSync(
      path.join(concurrent.POLAR_PAYKIT_DATA_ROOT, 'networks', 'state'),
      'utf8',
    ),
    'persist',
  );
});

test('refuses an existing installation, missing credentials, and a mismatched root', t => {
  const { other, env } = fixture(t);
  assert.throws(
    () => prepareEnvironment({ ...env, POLAR_PAYKIT_E2E_ROOT: other }),
    /empty/,
  );
  const owned = prepareEnvironment(env);
  assert.throws(
    () => cleanupNetworks({ ...owned, POLAR_PAYKIT_E2E_TOKEN: '' }),
    /ownership/,
  );
  assert.throws(
    () => cleanupNetworks({ ...owned, POLAR_PAYKIT_DATA_ROOT: other }),
    /escaped/,
  );
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'other installation');
});

test('refuses symlinked roots and never follows a networks symlink', t => {
  const { run, other, env } = fixture(t);
  const owned = prepareEnvironment(env);
  fs.symlinkSync(other, path.join(owned.POLAR_PAYKIT_DATA_ROOT, 'networks'), 'junction');
  cleanupNetworks(owned);
  assert.equal(fs.existsSync(path.join(other, 'keep')), true);
  fs.rmdirSync(owned.POLAR_PAYKIT_DATA_ROOT);
  fs.symlinkSync(other, owned.POLAR_PAYKIT_DATA_ROOT, 'junction');
  assert.throws(() => cleanupNetworks(owned), /escaped/);
  const alias = path.join(path.dirname(run), 'alias');
  fs.symlinkSync(run, alias, 'junction');
  assert.throws(
    () => cleanupNetworks({ ...owned, POLAR_PAYKIT_E2E_ROOT: alias }),
    /canonical/,
  );
});
