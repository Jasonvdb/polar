#!/usr/bin/env node
/* Run against an explicitly provisioned local environment. No resources are created. */
const assert = require('assert/strict');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { sleep, serviceBase, requestJson, runCli } = require('./paykit-harness');

async function run({ base, tokenFile, serviceContainer, postgresContainer, signal, progress = stage => console.log(stage) }) {
  const stages = [];
  const stage = name => { signal?.throwIfAborted(); progress(name); stages.push(name); };
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const request = async (path, body) => {
    return requestJson(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    }, signal);
  };
  const state = async () => {
    const response = await request('/v1/state');
    assert.equal(response.status, 200);
    return response.data;
  };
  const waitReady = async () => {
    const deadline = Date.now() + 120000;
    let lastProgress = 0;
    while (Date.now() < deadline) {
      if (Date.now() - lastProgress >= 15000) { progress('readiness:waiting'); lastProgress = Date.now(); }
      try {
        const response = await request('/health');
        if (response.status === 200) return;
      } catch (_) { /* startup can close the old HTTP socket */ }
      await sleep(1000, signal);
    }
    throw new Error('Environment readiness timed out');
  };
  const command = async (name, input, id = randomUUID(), expected = 'succeeded') => {
    signal?.throwIfAborted();
    progress(`command:${name}`);
    const body = { commandId: id, command: name, input };
    const accepted = await request('/v1/commands', body);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.data.operationId, id);
    progress(`command.accepted:${name}:${id}`);
    const deadline = Date.now() + 180000;
    let lastProgress = 0;
    while (Date.now() < deadline) {
      const operation = await request(`/v1/operations/${id}`);
      if (['succeeded', 'failed'].includes(operation.data.status)) {
        assert.equal(operation.data.status, expected, `Unexpected ${name} outcome`);
        return { body, operation: operation.data };
      }
      if (Date.now() - lastProgress >= 15000) { progress(`operation.waiting:${name}:${operation.data.status}`); lastProgress = Date.now(); }
      await sleep(250, signal);
    }
    throw new Error(`Operation ${id} timed out; do not issue a replacement`);
  };
  const docker = (...args) => { signal?.throwIfAborted(); return execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, killSignal: 'SIGTERM' }); };
  const inspectMarker = receiver => {
    const owner = initial.participants.find(p => p.id === receiver.participantId);
    const marker = JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-marker', owner.publicKey, receiver.path));
    assert.equal(marker.noise_public_key, receiver.noisePublicKey);
    assert.equal(marker.receiver_path, receiver.path);
  };

  stage('readiness');
  progress(`readiness:endpoint:${base}`);
  await waitReady();
  stage('preset');
  const preset = await command('preset.create', {});
  const initial = await state();
  assert.equal(initial.participants.length, 3);
  assert.equal(initial.receivers.length, 4);
  assert.equal(new Set(initial.participants.map(p => p.publicKey)).size, 3);
  assert.equal(new Set(initial.receivers.map(r => r.noisePublicKey)).size, 4);
  assert(initial.receivers.every(r => r.status === 'running'));
  stage('deduplication');
  const duplicate = await request('/v1/commands', preset.body);
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.data.operationId, preset.operation.id);
  const conflict = await request('/v1/commands', { ...preset.body, command: 'participant.create', input: { name: 'Other' } });
  assert.equal(conflict.status, 409);
  await command('preset.create', {});
  assert.equal((await state()).receivers.length, 4);
  const bob = initial.participants.find(p => p.name === 'Bob');
  const receivers = initial.receivers.filter(r => r.participantId === bob.id);
  assert.equal(receivers.length, 2);
  const wallet = receivers.find(r => r.path.endsWith('/wallet'));
  const server = receivers.find(r => r.path.endsWith('/server'));
  stage('editable-identities');
  await command('receiver.rename', { receiverId: wallet.id, name: 'Bob editable wallet' });
  await command('participant.rename', { participantId: bob.id, name: 'Bob editable' });
  stage('receiver-isolation');
  await command('receiver.stop', { receiverId: wallet.id });
  let current = await state();
  assert.equal(current.receivers.find(r => r.id === wallet.id).status, 'stopped');
  assert.equal(current.receivers.find(r => r.id === server.id).generation, server.generation);
  if (serviceContainer) {
    stage('grant-validation');
    const diagnostics = JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'diagnose-session', wallet.id));
    assert(diagnostics.validGrant && diagnostics.wrongClientRejected && diagnostics.wrongOwnerRejected && diagnostics.wrongReceiverRejected);
    initial.receivers.forEach(inspectMarker);
    stage('environment-restart');
    progress(`environment-restart:previous-endpoint:${base}`);
    docker('restart', '--timeout', '-1', serviceContainer);
    base = serviceBase(serviceContainer, docker);
    progress(`environment-restart:endpoint:${base}`);
    await waitReady();
    current = await state();
    assert.equal(current.receivers.find(r => r.id === wallet.id).status, 'stopped');
    assert.equal(current.participants.find(p => p.id === bob.id).name, 'Bob editable');
    initial.receivers.forEach(inspectMarker);
  }
  stage('receiver-restart');
  await command('receiver.start', { receiverId: wallet.id });
  await command('receiver.restart', { receiverId: wallet.id });
  current = await state();
  for (const previous of initial.receivers) {
    const restored = current.receivers.find(r => r.id === previous.id);
    assert.equal(restored.noisePublicKey, previous.noisePublicKey);
    assert.equal(restored.path, previous.path);
    assert.equal(restored.status, 'running');
  }
  if (serviceContainer && postgresContainer) {
    stage('database-outage');
    docker('stop', '--timeout', '-1', postgresContainer);
    await command('receiver.restart', { receiverId: wallet.id }, randomUUID(), 'failed');
    stage('database-recovery');
    docker('start', postgresContainer);
    await sleep(3000, signal);
    await command('receiver.restart', { receiverId: wallet.id });
    inspectMarker(wallet);
  }
  await require('./paykit-workspace-scenarios').run({ initial, state, command, request, stage, docker, serviceContainer, signal });
  stage('complete');
  return { stages, environmentId: initial.environmentId, participantKeys: initial.participants.map(p => p.publicKey), receiverNoiseKeys: initial.receivers.map(r => r.noisePublicKey), passed: true };
}
module.exports = { run };
if (require.main === module) {
  runCli(signal => run({ base: process.env.PAYKIT_API_URL, tokenFile: process.env.PAYKIT_TOKEN_FILE, serviceContainer: process.env.PAYKIT_TEST_SERVICE_CONTAINER, postgresContainer: process.env.PAYKIT_TEST_POSTGRES_CONTAINER, signal }), {
    complete: report => console.log(JSON.stringify(report, null, 2)),
  });
}
