import { thunk } from 'easy-peasy';
import { PaykitCommandRequest, paykitCommands } from 'shared/paykitApi';
import { RootModel } from 'store/models';
import { StoreInjections } from 'types';
import { paykitService } from 'lib/paykit/paykitService';
import { validateNetworkId } from './helpers';
import { McpToolDefinition } from './types';

interface PaykitArgs {
  networkId: number;
  action: 'enable' | 'state' | 'operation' | 'command';
  operationId?: string;
  request?: PaykitCommandRequest;
}
export const paykitDefinition: McpToolDefinition = {
  name: 'paykit',
  description:
    'Enable a persistent Paykit environment on a stopped network, query public state or an operation, or submit a command. Commands return an operationId immediately; poll operation/state for completion. Reuse commandId when retrying an uncertain submission. Secrets are never returned.',
  inputSchema: {
    type: 'object',
    required: ['networkId', 'action'],
    properties: {
      networkId: { type: 'number' },
      action: { type: 'string', enum: ['enable', 'state', 'operation', 'command'] },
      operationId: { type: 'string', format: 'uuid' },
      request: {
        type: 'object',
        required: ['commandId', 'command', 'input'],
        properties: {
          commandId: { type: 'string', format: 'uuid' },
          command: { type: 'string', enum: [...paykitCommands] },
          input: {
            type: 'object',
            description:
              'participant.create: name; participant.rename: participantId,name; receiver.create: participantId,name,kind(wallet|server); receiver.rename: receiverId,name; receiver.start/stop/restart: receiverId; preset.create: empty object.',
          },
        },
      },
    },
  },
};
export const paykitTool = thunk<
  Record<string, never>,
  PaykitArgs,
  StoreInjections,
  RootModel,
  Promise<unknown>
>(async (_, args, { getStoreState, getStoreActions }): Promise<unknown> => {
  validateNetworkId(args.networkId);
  getStoreState().network.networkById(args.networkId);
  switch (args.action) {
    case 'enable':
      return getStoreActions().network.enablePaykit(args.networkId);
    case 'state':
      return paykitService.state(args.networkId);
    case 'operation':
      if (!args.operationId) throw new Error('An operationId is required');
      return paykitService.operation(args.networkId, args.operationId);
    case 'command':
      if (!args.request) throw new Error('A command request is required');
      return paykitService.command(args.networkId, args.request);
    default:
      throw new Error('Unsupported Paykit action');
  }
});
