import { createStore } from 'easy-peasy';
import { paykitDefinition } from './paykit';
import {
  newPaykitId,
  paykitCommands,
  paykitCommandFields,
  PaykitInput,
} from 'shared/paykitApi';
import { paykitService } from 'lib/paykit/paykitService';
import { createMockRootModel, getNetwork, injections } from 'utils/tests';

jest.mock('lib/paykit/paykitService');
const service = paykitService as jest.Mocked<typeof paykitService>;
describe('Paykit MCP parity', () => {
  it('returns acceptance immediately without polling completion', async () => {
    const store = createStore(createMockRootModel(), { injections });
    store.getActions().network.setNetworks([getNetwork(1, 'test')]);
    const request = {
      commandId: newPaykitId(),
      command: 'preset.create' as const,
      input: {},
    };
    const accepted = { operationId: newPaykitId() };
    service.command.mockResolvedValue(accepted);
    await expect(
      store.getActions().mcp.paykit({ networkId: 1, action: 'command', request }),
    ).resolves.toEqual(accepted);
    expect(service.command).toHaveBeenCalledWith(1, request);
    expect(service.operation).not.toHaveBeenCalled();
    expect(service.state).not.toHaveBeenCalled();
    await expect(
      store.getActions().mcp.paykit({ networkId: 1, action: 'command' }),
    ).rejects.toThrow('required');
    await expect(
      store.getActions().mcp.paykit({ networkId: 2, action: 'state' }),
    ).rejects.toThrow();
  });
  it('exposes public discovery, diagnostics and same-ID guided submission', async () => {
    const store = createStore(createMockRootModel(), { injections });
    store.getActions().network.setNetworks([getNetwork(1, 'test')]);
    const catalog = {
      apiVersion: 1 as const,
      catalogVersion: 1,
      panels: [],
      commands: [],
      scenarios: [],
    };
    service.catalog.mockResolvedValue(catalog);
    service.diagnostics.mockResolvedValue({
      apiVersion: 1,
      environmentId: newPaykitId(),
      ready: true,
      fundingStatus: 'ready',
      receivers: [],
      operations: [],
      lastEventSequence: 0,
    });
    await expect(
      store.getActions().mcp.paykit({ networkId: 1, action: 'catalog' }),
    ).resolves.toEqual(catalog);
    await store.getActions().mcp.paykit({ networkId: 1, action: 'diagnostics' });
    const request = {
      commandId: newPaykitId(),
      command: 'preset.create' as const,
      input: {},
    };
    service.scenarioStep.mockResolvedValue({ operationId: request.commandId });
    await expect(
      store.getActions().mcp.paykit({
        networkId: 1,
        action: 'scenarioStep',
        scenarioId: 'funded-workspace',
        stepId: 'create-preset',
        request,
      }),
    ).resolves.toEqual({ operationId: request.commandId });
    expect(service.scenarioStep).toHaveBeenCalledWith(
      1,
      'funded-workspace',
      'create-preset',
      request,
    );
  });

  it('rejects unknown action fields and secret-bearing transfer-shaped arguments', async () => {
    const store = createStore(createMockRootModel(), { injections });
    store.getActions().network.setNetworks([getNetwork(1, 'test')]);
    await expect(
      store.getActions().mcp.paykit({
        networkId: 1,
        action: 'catalog',
        archivePath: '/tmp/archive',
      } as any),
    ).rejects.toThrow('Invalid Paykit arguments');
    await expect(
      store.getActions().mcp.paykit({
        networkId: 1,
        action: 'scenarioStep',
        scenarioId: '../escape',
        stepId: 'create-preset',
        passphrase: 'secret',
      } as any),
    ).rejects.toThrow('Invalid Paykit arguments');
    expect(JSON.stringify(paykitDefinition)).not.toContain('prepareExport');
    expect(paykitDefinition.inputSchema.additionalProperties).toBe(false);
  });
});

it('documents every command and forwards receiver path arrays without changing them', async () => {
  const definition = JSON.stringify(paykitDefinition);
  for (const command of paykitCommands) {
    expect(definition).toContain(command);
    for (const field of paykitCommandFields[command]) expect(definition).toContain(field);
  }
  const store = createStore(createMockRootModel(), { injections });
  store.getActions().network.setNetworks([getNetwork(1, 'test')]);
  const request = {
    commandId: newPaykitId(),
    command: 'contact.save' as const,
    input: {
      receiverId: newPaykitId(),
      peerPublicKey: 'y'.repeat(52),
      label: 'Bob',
      receiverPaths: ['bob/wallet', 'bob/server'],
    },
  };
  service.command.mockResolvedValue({ operationId: request.commandId });
  await store.getActions().mcp.paykit({ networkId: 1, action: 'command', request });
  expect(service.command).toHaveBeenCalledWith(1, request);
});

it('forwards editable proof objects unchanged and returns only command acceptance', async () => {
  const store = createStore(createMockRootModel(), { injections });
  store.getActions().network.setNetworks([getNetwork(1, 'test')]);
  const request = {
    commandId: newPaykitId(),
    command: 'proof.submit' as const,
    input: {
      receiverId: newPaykitId(),
      requestId: newPaykitId(),
      proof: { method: 'btc-onchain' as const, txid: 'a'.repeat(64), outputIndex: 0 },
    },
  };
  service.command.mockResolvedValue({ operationId: request.commandId });
  await expect(
    store.getActions().mcp.paykit({ networkId: 1, action: 'command', request }),
  ).resolves.toEqual({ operationId: request.commandId });
  expect(service.command).toHaveBeenCalledWith(1, request);
});

it.each(['receipt.prepare', 'receipt.process', 'receipt.retrieve'] as const)(
  'forwards %s unchanged and returns immediately with an operation ID',
  async command => {
    const store = createStore(createMockRootModel(), { injections });
    store.getActions().network.setNetworks([getNetwork(1, 'test')]);
    const input: PaykitInput =
      command === 'receipt.prepare'
        ? {
            receiverId: newPaykitId(),
            requestId: newPaykitId(),
            proofId: newPaykitId(),
            note: '  original note  ',
          }
        : command === 'receipt.process'
        ? { receiverId: newPaykitId(), receiptId: newPaykitId() }
        : {
            receiverId: newPaykitId(),
            receiptId: newPaykitId(),
            peerPublicKey: 'y'.repeat(52),
            peerReceiverPath: 'bob/server',
          };
    const request = { commandId: newPaykitId(), command, input };
    service.command.mockResolvedValue({ operationId: request.commandId });
    await expect(
      store.getActions().mcp.paykit({ networkId: 1, action: 'command', request }),
    ).resolves.toEqual({ operationId: request.commandId });
    expect(service.command).toHaveBeenCalledWith(1, request);
    expect(service.operation).not.toHaveBeenCalled();
  },
);

it.each([
  'subscription.prepare',
  'subscription.authorize',
  'subscription.disable',
  'clock.set',
  'clock.reset',
] as const)(
  'forwards %s through the shared asynchronous command boundary',
  async command => {
    const store = createStore(createMockRootModel(), { injections });
    store.getActions().network.setNetworks([getNetwork(1, 'test')]);
    const receiverId = newPaykitId();
    const requestId = newPaykitId();
    const inputs: Record<string, PaykitInput> = {
      'subscription.prepare': {
        receiverId,
        requestId,
        periodIndex: 0,
        source: 'private',
        expirySeconds: 3600,
      },
      'subscription.authorize': {
        receiverId,
        requestId,
        walletId: 'wallet',
        source: 'private',
        method: 'btc-onchain',
      },
      'subscription.disable': { receiverId, requestId },
      'clock.set': { receiverId, now: '2099-01-01T00:00:00Z' },
      'clock.reset': { receiverId },
    };
    const request = { commandId: newPaykitId(), command, input: inputs[command] };
    service.command.mockResolvedValue({ operationId: request.commandId });
    await expect(
      store.getActions().mcp.paykit({ networkId: 1, action: 'command', request }),
    ).resolves.toEqual({ operationId: request.commandId });
    expect(service.command).toHaveBeenCalledWith(1, request);
  },
);
