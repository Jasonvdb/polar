const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const markerName = '.polar-paykit-e2e-owner.json';

function validateRoot(env) {
  const root = env.POLAR_PAYKIT_E2E_ROOT;
  if (!root || !path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) {
    throw new Error('Supply an absolute, dedicated POLAR_PAYKIT_E2E_ROOT');
  }
  const canonical = fs.realpathSync(root);
  if (canonical !== path.resolve(root) || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('Test root must be a canonical directory, not a symlink');
  }
  return canonical;
}

function prepareEnvironment(env) {
  const root = validateRoot(env);
  const instance = env.POLAR_PAYKIT_INSTANCE;
  if (
    !instance ||
    instance === 'default' ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/.test(instance)
  ) {
    throw new Error(
      'Supply a unique non-default POLAR_PAYKIT_INSTANCE for this test run',
    );
  }
  if (fs.readdirSync(root).length) {
    throw new Error('Test root must be empty; an existing installation cannot be used');
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(
    path.join(root, markerName),
    JSON.stringify({ root, instance, token }),
    { flag: 'wx', mode: 0o600 },
  );
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  return {
    ...env,
    NODE_ENV: 'production',
    POLAR_PAYKIT_DATA_ROOT: dataRoot,
    POLAR_PAYKIT_E2E_TOKEN: token,
  };
}

function cleanupNetworks(env = process.env) {
  const root = validateRoot(env);
  const owner = JSON.parse(fs.readFileSync(path.join(root, markerName), 'utf8'));
  if (
    !env.POLAR_PAYKIT_E2E_TOKEN ||
    owner.token !== env.POLAR_PAYKIT_E2E_TOKEN ||
    owner.root !== root ||
    owner.instance !== env.POLAR_PAYKIT_INSTANCE
  ) {
    throw new Error('Test ownership marker does not match this run');
  }
  const dataRoot = path.join(root, 'data');
  if (
    env.POLAR_PAYKIT_DATA_ROOT !== dataRoot ||
    fs.realpathSync(dataRoot) !== dataRoot ||
    fs.lstatSync(dataRoot).isSymbolicLink()
  ) {
    throw new Error('Test data root escaped its owned directory');
  }
  // rm removes symlinks themselves; it never traverses a symlink at networks.
  fs.rmSync(path.join(dataRoot, 'networks'), { recursive: true, force: true });
}

module.exports = { prepareEnvironment, cleanupNetworks };
