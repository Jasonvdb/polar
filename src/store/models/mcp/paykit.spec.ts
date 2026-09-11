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
