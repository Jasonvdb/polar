import { createStore } from 'easy-peasy';
import { newPaykitId } from 'shared/paykitApi';
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
