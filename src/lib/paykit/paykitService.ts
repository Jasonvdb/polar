import { ipcChannels } from 'shared';
import {
  PaykitCommandRequest,
  PaykitEnvironment,
  PaykitOperation,
  PaykitRequest,
  PaykitState,
  PaykitTransfer,
  PaykitTransferRequest,
} from 'shared/paykitApi';
import { PaykitImageRequest, PaykitImageSetupState } from 'shared/paykitRuntime';
import {
  PaykitDiagnostics,
  PaykitGuideCatalog,
  PaykitGuideScenario,
} from 'shared/paykitGuides';
import { createIpcSender } from 'lib/ipc/ipcService';

const ipc = createIpcSender('Paykit', 'app');
const send = <T>(request: PaykitRequest) => ipc<T>(ipcChannels.paykit, request);
const transfer = <T>(request: PaykitTransferRequest) =>
  ipc<T>(ipcChannels.paykitTransfer, request);
const image = (request: PaykitImageRequest) =>
  ipc<PaykitImageSetupState>(ipcChannels.paykitImage, request);
export const paykitService = {
  imageStatus: () => image({ action: 'status' }),
  buildImage: () => image({ action: 'build' }),
  cancelImageBuild: (jobId: string) => image({ action: 'cancel', jobId }),
  provision: (networkId: number) =>
    send<PaykitEnvironment>({ networkId, action: 'provision' }),
  state: (networkId: number) => send<PaykitState>({ networkId, action: 'state' }),
  catalog: (networkId: number) =>
    send<PaykitGuideCatalog>({ networkId, action: 'catalog' }),
  scenario: (networkId: number, scenarioId: string) =>
    send<PaykitGuideScenario>({ networkId, action: 'scenario', scenarioId }),
  diagnostics: (networkId: number) =>
    send<PaykitDiagnostics>({ networkId, action: 'diagnostics' }),
  operation: (networkId: number, operationId: string) =>
    send<PaykitOperation>({ networkId, action: 'operation', operationId }),
  command: (networkId: number, request: PaykitCommandRequest) =>
    send<{ operationId: string }>({ networkId, action: 'command', request }),
  scenarioStep: (
    networkId: number,
    scenarioId: string,
    stepId: string,
    request: PaykitCommandRequest,
  ) =>
    send<{ operationId: string }>({
      networkId,
      action: 'scenarioStep',
      scenarioId,
      stepId,
      request,
    }),
  prepareExport: (networkId: number, receiverId: string, passphrase: string) =>
    transfer<PaykitTransfer>({
      networkId,
      action: 'prepareExport',
      receiverId,
      passphrase,
    }),
  prepareRestore: (networkId: number, receiverId: string, passphrase: string) =>
    transfer<PaykitTransfer>({
      networkId,
      action: 'prepareRestore',
      receiverId,
      passphrase,
    }),
  downloadExport: (networkId: number, transferId: string) =>
    transfer<boolean>({ networkId, action: 'downloadExport', transferId }),
  cancelTransfer: (networkId: number, transferId: string) =>
    transfer<boolean>({ networkId, action: 'cancel', transferId }),
  checkPort: (networkId: number) => send<boolean>({ networkId, action: 'checkPort' }),
  remove: (networkId: number) => send<boolean>({ networkId, action: 'remove' }),
};
