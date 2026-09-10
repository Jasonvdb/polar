import { thunk } from 'easy-peasy';
import {
  PaykitCommandRequest,
  paykitCommands,
  paykitCommandFields,
} from 'shared/paykitApi';
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
              Object.entries(paykitCommandFields)
                .map(
                  ([command, fields]) =>
                    `${command}: ${fields.join(', ') || 'empty object'}`,
                )
                .join('; ') +
              '. receiverPaths is a string array; other fields are strings. profile.publish avatar fields are optional together: absent retains, both empty removes; otherwise PNG/JPEG base64 up to 256 KiB. Peer paths must be explicit. link.sendEmptyList queues an encrypted list without payment endpoints. delivery.sync respects pause. Public contact sharing is explicit via contact.publish; unpublish before removing a shared contact or path. Unblock requires explicit relinking.',
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
