#!/usr/bin/env node
/* Disposable CI runtime. Every Docker object has a unique recorded owner label. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID, randomBytes } = require('crypto');
const { execFileSync } = require('child_process');
const { run } = require('./paykit-scenarios');
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'polar-paykit-ci-'));
const runId = randomUUID();
const label = `polar-paykit.test-run=${runId}`;
const resources = { root, runId, containers: [], networks: [] };
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000 });
const image = process.env.PAYKIT_TEST_IMAGE || 'polar-paykit/service:pr2';
const postgres = 'postgres:18-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function record() { fs.writeFileSync(path.join(root, 'resources.json'), JSON.stringify(resources, null, 2)); }
async function environment(suffix) {
  const environmentId = randomUUID();
  const prefix = `polar-paykit-ci-${runId.slice(0, 8)}-${suffix}`;
  const data = path.join(root, suffix);
  const secrets = path.join(data, 'credentials');
  fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
  for (const name of ['master-key', 'api-token', 'postgres-password']) fs.writeFileSync(path.join(secrets, name), randomBytes(32).toString('hex'), { mode: 0o600 });
  for (const name of ['state', 'postgres']) fs.mkdirSync(path.join(data, name));
  const network = docker('network', 'create', '--label', label, prefix).trim();
  resources.networks.push(network); record();
  const uid = process.getuid ? `${process.getuid()}:${process.getgid()}` : '1000:1000';
  const database = docker('run', '-d', '--name', `${prefix}-postgres`, '--label', label, '--network', prefix, '--network-alias', 'paykit-postgres', '--user', uid,
    '-v', `${secrets}:/run/paykit:ro`, '-v', `${path.join(data, 'postgres')}:/var/lib/postgresql`,
    '-e', 'POSTGRES_USER=pubky', '-e', 'POSTGRES_DB=pubky', '-e', 'PGDATA=/var/lib/postgresql/18/docker', '-e', 'POSTGRES_PASSWORD_FILE=/run/paykit/postgres-password', postgres).trim();
  resources.containers.push(database); record();
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker('exec', database, 'pg_isready', '-U', 'pubky', '-d', 'pubky'); ready = true; break; } catch (_) { await sleep(1000); }
  }
  if (!ready) throw new Error('PostgreSQL readiness timed out');
  const service = docker('run', '-d', '--init', '--name', `${prefix}-service`, '--label', label, '--network', prefix, '--user', uid,
    '-p', '127.0.0.1::10090', '-v', `${secrets}:/run/paykit:ro`, '-v', `${path.join(data, 'state')}:/data`,
    '-e', `PAYKIT_ENVIRONMENT_ID=${environmentId}`, '-e', 'PAYKIT_DATA_DIR=/data', '-e', 'PAYKIT_KEY_FILE=/run/paykit/master-key',
    '-e', 'PAYKIT_TOKEN_FILE=/run/paykit/api-token', '-e', 'PAYKIT_POSTGRES_PASSWORD_FILE=/run/paykit/postgres-password', '-e', 'PAYKIT_POSTGRES_HOST=paykit-postgres', image).trim();
  resources.containers.push(service); record();
  const address = docker('port', service, '10090/tcp').trim();
  return { base: `http://${address}`, tokenFile: path.join(secrets, 'api-token'), serviceContainer: service, postgresContainer: database };
}
async function main() {
  record(); console.log(`Paykit CI artifact root: ${root}`);
  try {
    const a = await environment('a');
    const b = await environment('b');
    const reportB = await run(b);
    const reportA = await run(a);
    const survivor = await fetch(`${b.base}/v1/state`, { headers: { authorization: `Bearer ${fs.readFileSync(b.tokenFile, 'utf8').trim()}` }, signal: AbortSignal.timeout(10000) }).then(response => response.json());
    if (JSON.stringify(survivor.participants.map(p => p.publicKey)) !== JSON.stringify(reportB.participantKeys) || survivor.receivers.some(r => r.status !== 'running')) throw new Error('Second environment changed during first environment scenarios');
    if (reportA.environmentId === reportB.environmentId || reportA.participantKeys.some(key => reportB.participantKeys.includes(key))) throw new Error('Environments are not isolated');
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ passed: true, environments: [reportA, reportB] }, null, 2));
    console.log('Both persistent Paykit environment scenarios passed.');
  } finally {
    for (const id of resources.containers.reverse()) {
      const owner = docker('inspect', '-f', '{{index .Config.Labels "polar-paykit.test-run"}}', id).trim();
      if (owner !== runId) throw new Error('Cleanup owner mismatch');
      docker('stop', '--timeout', '30', id); docker('rm', id);
    }
    for (const id of resources.networks) {
      const owner = docker('network', 'inspect', '-f', '{{index .Labels "polar-paykit.test-run"}}', id).trim();
      if (owner !== runId) throw new Error('Cleanup network owner mismatch');
      docker('network', 'rm', id);
    }
    for (const suffix of ['a', 'b']) fs.rmSync(path.join(root, suffix), { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
