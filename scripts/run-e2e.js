const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { prepareEnvironment, cleanupNetworks } = require('./e2e-environment');

function createTestcafeConfig(appRoot, platform, ci) {
  return {
    appPath: appRoot,
    mainWindowUrl: path.join(appRoot, 'build', 'index.html'),
    // Hosted Linux runners restrict Chromium user namespaces. This flag belongs
    // only to disposable CI tests, never to the application launch configuration.
    appArgs: platform === 'linux' && ci ? ['--no-sandbox'] : [],
  };
}

function run() {
  const env = prepareEnvironment(process.env);
  try {
    const configPath = path.join(env.POLAR_PAYKIT_E2E_ROOT, 'testcafe-electron.json');
    const config = createTestcafeConfig(
      path.resolve(__dirname, '..'),
      process.platform,
      env.CI === 'true',
    );
    fs.writeFileSync(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        require.resolve('testcafe/bin/testcafe'),
        `electron:${configPath}`,
        './e2e/**/*.e2e.ts',
        ...process.argv.slice(2),
      ],
      { env, stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status === null ? 1 : result.status;
  } finally {
    cleanupNetworks(env);
  }
}

if (require.main === module) run();
module.exports = { createTestcafeConfig };
