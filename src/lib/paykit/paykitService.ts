import { ipcChannels } from 'shared';
import {
  PaykitCommandRequest,
  PaykitEnvironment,
  PaykitOperation,
  PaykitRequest,
  PaykitState,
} from 'shared/paykitApi';
import { createIpcSender } from 'lib/ipc/ipcService';

const ipc = createIpcSender('Paykit', 'app');
const send = <T>(request: PaykitRequest) => ipc<T>(ipcChannels.paykit, request);
export const paykitService = {
  provision: (networkId: number) =>
    send<PaykitEnvironment>({ networkId, action: 'provision' }),
  state: (networkId: number) => send<PaykitState>({ networkId, action: 'state' }),
  operation: (networkId: number, operationId: string) =>
    send<PaykitOperation>({ networkId, action: 'operation', operationId }),
  command: (networkId: number, request: PaykitCommandRequest) =>
    send<{ operationId: string }>({ networkId, action: 'command', request }),
  checkPort: (networkId: number) => send<boolean>({ networkId, action: 'checkPort' }),
  remove: (networkId: number) => send<boolean>({ networkId, action: 'remove' }),
};
