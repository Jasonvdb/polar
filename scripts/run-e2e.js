const { spawnSync } = require('child_process');
const { prepareEnvironment, cleanupNetworks } = require('./e2e-environment');

const env = prepareEnvironment(process.env);
try {
  const result = spawnSync(
    process.execPath,
    [
      require.resolve('testcafe/bin/testcafe'),
      'electron:./',
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
