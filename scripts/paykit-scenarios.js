#!/usr/bin/env node
/* Run against an explicitly provisioned local environment. No resources are created. */
const assert = require('assert/strict');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run({ base, tokenFile, serviceContainer, postgresContainer }) {
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const request = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    return { status: response.status, data };
  };
  const state = async () => {
    const response = await request('/v1/state');
    assert.equal(response.status, 200);
    return response.data;
  };
  const waitReady = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await request('/health');
        if (response.status === 200) return;
      } catch (_) { /* startup can close the old HTTP socket */ }
      await sleep(1000);
    }
    throw new Error('Environment readiness timed out');
  };
  const command = async (name, input, id = randomUUID(), expected = 'succeeded') => {
    const body = { commandId: id, command: name, input };
    const accepted = await request('/v1/commands', body);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.data.operationId, id);
    for (let attempt = 0; attempt < 720; attempt++) {
      const operation = await request(`/v1/operations/${id}`);
      if (['succeeded', 'failed'].includes(operation.data.status)) {
        assert.equal(operation.data.status, expected, `Unexpected ${name} outcome`);
        return { body, operation: operation.data };
      }
      await sleep(250);
    }
    throw new Error(`Operation ${id} timed out; do not issue a replacement`);
  };
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000 });
  const inspectMarker = receiver => {
    const owner = initial.participants.find(p => p.id === receiver.participantId);
    const marker = JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'inspect-marker', owner.publicKey, receiver.path));
    assert.equal(marker.noise_public_key, receiver.noisePublicKey);
    assert.equal(marker.receiver_path, receiver.path);
  };

  await waitReady();
  const preset = await command('preset.create', {});
  const initial = await state();
  assert.equal(initial.participants.length, 3);
  assert.equal(initial.receivers.length, 4);
  assert.equal(new Set(initial.participants.map(p => p.publicKey)).size, 3);
  assert.equal(new Set(initial.receivers.map(r => r.noisePublicKey)).size, 4);
  assert(initial.receivers.every(r => r.status === 'running'));
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
  await command('receiver.rename', { receiverId: wallet.id, name: 'Bob editable wallet' });
  await command('participant.rename', { participantId: bob.id, name: 'Bob editable' });
  await command('receiver.stop', { receiverId: wallet.id });
  let current = await state();
  assert.equal(current.receivers.find(r => r.id === wallet.id).status, 'stopped');
  assert.equal(current.receivers.find(r => r.id === server.id).generation, server.generation);
  if (serviceContainer) {
    const diagnostics = JSON.parse(docker('exec', serviceContainer, 'polar-paykit', 'diagnose-session', wallet.id));
    assert(diagnostics.validGrant && diagnostics.wrongClientRejected && diagnostics.wrongOwnerRejected && diagnostics.wrongReceiverRejected);
    initial.receivers.forEach(inspectMarker);
    docker('restart', '--timeout', '30', serviceContainer);
    await waitReady();
    current = await state();
    assert.equal(current.receivers.find(r => r.id === wallet.id).status, 'stopped');
    assert.equal(current.participants.find(p => p.id === bob.id).name, 'Bob editable');
    initial.receivers.forEach(inspectMarker);
  }
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
    docker('stop', '--timeout', '30', postgresContainer);
    await command('receiver.restart', { receiverId: wallet.id }, randomUUID(), 'failed');
    docker('start', postgresContainer);
    await sleep(3000);
    await command('receiver.restart', { receiverId: wallet.id });
    inspectMarker(wallet);
  }
  return { environmentId: initial.environmentId, participantKeys: initial.participants.map(p => p.publicKey), receiverNoiseKeys: initial.receivers.map(r => r.noisePublicKey), passed: true };
}
module.exports = { run };
if (require.main === module) {
  run({ base: process.env.PAYKIT_API_URL, tokenFile: process.env.PAYKIT_TOKEN_FILE, serviceContainer: process.env.PAYKIT_TEST_SERVICE_CONTAINER, postgresContainer: process.env.PAYKIT_TEST_POSTGRES_CONTAINER })
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
