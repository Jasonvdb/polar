const assert = require('assert/strict');
const { randomUUID } = require('crypto');

const stages = ['interface-parity'];
const serviceApiUrl = 'http://127.0.0.1:10090';

function serviceCli(docker, serviceContainer, ...args) {
  return docker('exec', '-e', `PAYKIT_API_URL=${serviceApiUrl}`, serviceContainer, 'polar-paykit', ...args);
}

function validateCatalog(catalog) {
  assert.deepEqual(Object.keys(catalog).sort(), ['apiVersion', 'catalogVersion', 'commands', 'panels', 'scenarios'].sort());
  assert.equal(catalog.apiVersion, 1);
  assert(Number.isSafeInteger(catalog.catalogVersion) && catalog.catalogVersion > 0);
  assert(Array.isArray(catalog.panels) && catalog.panels.length > 0);
  assert(Array.isArray(catalog.commands) && catalog.commands.length === 58);
  assert.equal(new Set(catalog.commands.map(command => command.id)).size, 58);
  assert(catalog.commands.every(command => typeof command.genericCommandAllowed === 'boolean'));
  assert(Array.isArray(catalog.scenarios) && catalog.scenarios.length > 0);
  return catalog;
}

function validateDiagnostics(value, environmentId) {
  assert.deepEqual(Object.keys(value).sort(), ['apiVersion', 'environmentId', 'fundingStatus', 'lastEventSequence', 'operations', 'ready', 'receivers'].sort());
  assert.equal(value.apiVersion, 1);
  assert.equal(value.environmentId, environmentId);
  assert.equal(typeof value.ready, 'boolean');
  assert(['notStarted', 'running', 'ready', 'failed', 'uncertain', 'unavailable'].includes(value.fundingStatus));
  assert(Number.isSafeInteger(value.lastEventSequence) && value.lastEventSequence >= 0);
  assert(Array.isArray(value.receivers));
  assert(Array.isArray(value.operations));
  for (const receiver of value.receivers) {
    assert.deepEqual(Object.keys(receiver).sort(), ['generation', 'id', 'status']);
    assert.equal(typeof receiver.id, 'string');
    assert(['stopped', 'starting', 'running', 'error'].includes(receiver.status));
    assert(Number.isSafeInteger(receiver.generation) && receiver.generation >= 0);
  }
  for (const operation of value.operations) {
    const expectedKeys = operation.errorCode === undefined
      ? ['command', 'id', 'status']
      : ['command', 'errorCode', 'id', 'status'];
    assert.deepEqual(Object.keys(operation).sort(), expectedKeys);
    assert.equal(typeof operation.id, 'string');
    assert.equal(typeof operation.command, 'string');
    assert(['queued', 'running', 'succeeded', 'failed'].includes(operation.status));
    if (operation.errorCode !== undefined) assert.equal(typeof operation.errorCode, 'string');
  }
  const serialized = JSON.stringify(value);
  for (const forbidden of ['token', 'passphrase', 'preimage', 'privateKey', '/run/paykit', '/data/']) assert(!serialized.includes(forbidden));
  return value;
}

function validateDiagnosticsParity(earlier, later) {
  assert.equal(later.apiVersion, earlier.apiVersion);
  assert.equal(later.environmentId, earlier.environmentId);
  assert(later.lastEventSequence >= earlier.lastEventSequence);
  assert.deepEqual(
    later.receivers.map(receiver => receiver.id).sort(),
    earlier.receivers.map(receiver => receiver.id).sort(),
  );
  const earlierOperations = new Map(earlier.operations.map(operation => [operation.id, operation]));
  assert.deepEqual(
    later.operations.map(operation => [operation.id, operation.command]).sort(),
    earlier.operations.map(operation => [operation.id, operation.command]).sort(),
  );
  const progress = { queued: 0, running: 1, succeeded: 2, failed: 2 };
  for (const operation of later.operations) {
    const previous = earlierOperations.get(operation.id);
    assert(previous);
    assert(progress[operation.status] >= progress[previous.status]);
    if (progress[previous.status] === 2) assert.equal(operation.status, previous.status);
  }
}

async function run({ request, state, command, stage, docker, serviceContainer }) {
  stage(stages[0]);
  const catalogResponse = await request('/v1/catalog');
  assert.equal(catalogResponse.status, 200);
  const apiCatalog = validateCatalog(catalogResponse.data);
  const cliCatalog = validateCatalog(JSON.parse(serviceCli(docker, serviceContainer, 'catalog')));
  assert.deepEqual(cliCatalog, apiCatalog);
  const selected = apiCatalog.scenarios.find(scenario => scenario.id === 'funded-workspace');
  assert(selected);
  const scenarioResponse = await request(`/v1/scenarios/${selected.id}`);
  assert.equal(scenarioResponse.status, 200);
  const apiScenario = scenarioResponse.data;
  const cliScenario = JSON.parse(serviceCli(docker, serviceContainer, 'scenario', selected.id));
  assert.deepEqual(apiScenario, selected);
  assert.deepEqual(cliScenario, selected);
  const directId = randomUUID();
  const direct = await command('preset.create', {}, directId);
  assert.equal(direct.operation.id, directId);
  const guidedId = randomUUID();
  const guided = JSON.parse(serviceCli(docker, serviceContainer, 'scenario-step', selected.id, 'create-preset', '{}', guidedId));
  assert.equal(guided.id, guidedId);
  assert.equal(guided.command, 'preset.create');
  assert.equal(guided.status, 'succeeded');
  const current = await state();
  const diagnosticResponse = await request('/v1/diagnostics');
  assert.equal(diagnosticResponse.status, 200);
  const apiDiagnostics = validateDiagnostics(diagnosticResponse.data, current.environmentId);
  const cliDiagnostics = validateDiagnostics(JSON.parse(serviceCli(docker, serviceContainer, 'diagnostics')), current.environmentId);
  validateDiagnosticsParity(apiDiagnostics, cliDiagnostics);
}

module.exports = { run, stages, serviceCli, validateCatalog, validateDiagnostics, validateDiagnosticsParity };
