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
              '. receipt.prepare requires a payee request with the exact independently verified proof; optional note is at most 500 UTF-8 bytes with no control characters. Prepared drafts are immutable. receipt.process publishes the original encrypted receipt and queues access; access sent is not retrieval acknowledgment. Retry a terminal failure with a fresh commandId and the original receiptId; retry uncertain command acceptance with the original commandId. receipt.retrieve requires the exact issuer peerPublicKey and peerReceiverPath from indexed access; no receipt keys or URLs are accepted. receiverPaths, enabledMethods, acceptedMethods and preference are string arrays; expirySeconds is an integer from 1 to 604800; requiredConfirmations is an optional integer 1..144, default 1. proof.submit requires exactly one executionId or a strict proof object: {method: btc-onchain, txid: 64 hex, outputIndex: uint32} or {method: btc-lightning-bolt11, paymentHash: 64 hex, preimage: 64 hex}. Other fields are strings. request.create description is 1..500 UTF-8 bytes and requires fresh unclaimed own receiving reservations matching every accepted method and exact amount; publish/rotate first. Private reservations must target the intended payer. Request endpointBindings are immutable and constrain payment source/method/endpoint and settlement proofs. preset.fund creates and funds Alice/Bob/Carol using three configured LND wallets on one Core backend. payment.execute pays immutable accepted terms using explicit public/private source and method or saved preference. payment.reconcile inspects the original execution; an uncertain payment blocks another execution. proof.verify runs as payee and verifies settlement independently; proof submission alone does not mean settlement. amountSats is a canonical positive decimal string up to 2100000000000000. Methods are btc-onchain and btc-lightning-bolt11. paymentList.resolve requires explicit public/private source and optional method override, otherwise a saved nonempty preference. Private never falls back to public. paymentList.consume consumes a private version without paying. Wallet IDs come from the safe state catalog; wallet URLs and credentials are never accepted. profile.publish avatar fields are optional together: absent retains, both empty removes; otherwise PNG/JPEG base64 up to 256 KiB. Peer paths must be explicit. link.sendEmptyList queues an encrypted list without payment endpoints. delivery.sync respects pause. Public contact sharing is explicit via contact.publish; unpublish before removing a shared contact or path. Unblock requires explicit relinking.',
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
