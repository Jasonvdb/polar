const test = require('node:test');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const { serviceCli, validateCatalog, validateDiagnostics, validateDiagnosticsParity } = require('./paykit-interface-scenarios');

const command = index => ({ id: `command-${index}`, panelId: 'workspace', requiredParameters: [], optionalParameters: [], genericCommandAllowed: true });

test('interface fixtures require the complete unique 58-command catalog', () => {
  const value = { apiVersion: 1, catalogVersion: 1, panels: [{ id: 'workspace', title: 'Workspace' }], commands: Array.from({ length: 58 }, (_, index) => command(index)), scenarios: [{ id: 'demo', title: 'Demo', prerequisites: [], steps: [] }] };
  assert.equal(validateCatalog(value), value);
  assert.throws(() => validateCatalog({ ...value, commands: value.commands.slice(1) }));
  assert.throws(() => validateCatalog({ ...value, commands: value.commands.map(() => command(0)) }));
  assert.throws(() => validateCatalog({ ...value, secret: '/private/key' }));
});

test('diagnostic fixtures reject secret-shaped and unknown fields', () => {
  const environmentId = randomUUID();
  const value = { apiVersion: 1, environmentId, ready: true, fundingStatus: 'ready', receivers: [{ id: randomUUID(), status: 'running', generation: 1 }], operations: [{ id: randomUUID(), command: 'preset.create', status: 'succeeded' }], lastEventSequence: 2 };
  assert.equal(validateDiagnostics(value, environmentId), value);
  assert.throws(() => validateDiagnostics({ ...value, apiToken: 'secret' }, environmentId));
  assert.throws(() => validateDiagnostics({ ...value, operations: [{ ...value.operations[0], preimage: 'a'.repeat(64) }] }, environmentId));
  assert.throws(() => validateDiagnostics({ ...value, receivers: [{ ...value.receivers[0], path: '/data/receiver' }] }, environmentId));
  assert.throws(() => validateDiagnostics({ ...value, operations: [{ ...value.operations[0], errorCode: '/run/paykit/token' }] }, environmentId));
});

test('diagnostic parity accepts successive cursor and status progress', () => {
  const environmentId = randomUUID();
  const receiverId = randomUUID();
  const operationId = randomUUID();
  const earlier = validateDiagnostics({
    apiVersion: 1,
    environmentId,
    ready: false,
    fundingStatus: 'running',
    receivers: [{ id: receiverId, status: 'starting', generation: 1 }],
    operations: [{ id: operationId, command: 'preset.create', status: 'queued' }],
    lastEventSequence: 96,
  }, environmentId);
  const later = validateDiagnostics({
    apiVersion: 1,
    environmentId,
    ready: true,
    fundingStatus: 'ready',
    receivers: [{ id: receiverId, status: 'running', generation: 1 }],
    operations: [{ id: operationId, command: 'preset.create', status: 'succeeded' }],
    lastEventSequence: 97,
  }, environmentId);

  assert.doesNotThrow(() => validateDiagnosticsParity(earlier, later));
});

test('diagnostic parity rejects identity, command, cursor, and terminal-status mismatches', () => {
  const environmentId = randomUUID();
  const operationId = randomUUID();
  const value = validateDiagnostics({
    apiVersion: 1,
    environmentId,
    ready: true,
    fundingStatus: 'ready',
    receivers: [{ id: randomUUID(), status: 'running', generation: 1 }],
    operations: [{ id: operationId, command: 'preset.create', status: 'succeeded' }],
    lastEventSequence: 3,
  }, environmentId);

  assert.throws(() => validateDiagnosticsParity(value, { ...value, environmentId: randomUUID() }));
  assert.throws(() => validateDiagnosticsParity(value, { ...value, lastEventSequence: 2 }));
  assert.throws(() => validateDiagnosticsParity(value, { ...value, receivers: [{ ...value.receivers[0], id: randomUUID() }] }));
  assert.throws(() => validateDiagnosticsParity(value, { ...value, operations: [{ ...value.operations[0], command: 'preset.fund' }] }));
  assert.throws(() => validateDiagnosticsParity(value, { ...value, operations: [{ ...value.operations[0], status: 'failed' }] }));
});

test('service CLI targets the loopback API inside its container', () => {
  const calls = [];
  const docker = (...args) => { calls.push(args); return '{}'; };

  serviceCli(docker, 'service-container', 'scenario', 'funded-workspace');

  assert.deepEqual(calls, [[
    'exec',
    '-e',
    'PAYKIT_API_URL=http://127.0.0.1:10090',
    'service-container',
    'polar-paykit',
    'scenario',
    'funded-workspace',
  ]]);
});

test('service CLI keeps command values as distinct exec arguments', () => {
  const calls = [];
  const docker = (...args) => { calls.push(args); return '{}'; };

  serviceCli(docker, 'service-container', 'scenario', '$(invalid)');

  assert.equal(calls[0].at(-1), '$(invalid)');
  assert.equal(calls[0].filter(value => value === '-e').length, 1);
});
