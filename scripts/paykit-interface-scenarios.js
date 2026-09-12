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
  assert(value.receivers.every(receiver => Object.keys(receiver).every(key => ['id', 'status', 'generation'].includes(key))));
  assert(value.operations.every(operation => Object.keys(operation).every(key => ['id', 'command', 'status', 'errorCode'].includes(key))));
  const serialized = JSON.stringify(value);
  for (const forbidden of ['token', 'passphrase', 'preimage', 'privateKey', '/run/paykit', '/data/']) assert(!serialized.includes(forbidden));
  return value;
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
  assert.deepEqual(cliDiagnostics, apiDiagnostics);
}

module.exports = { run, stages, serviceCli, validateCatalog, validateDiagnostics };
