export type PaykitGuideTransport = 'command' | 'fileDescriptorBackup';

export interface PaykitGuidePanel {
  id: string;
  title: string;
}

export interface PaykitGuideCommandSpec {
  id: string;
  panelId: string;
  requiredParameters: string[];
  optionalParameters: string[];
  genericCommandAllowed: boolean;
}

export interface PaykitGuideStep {
  id: string;
  panelId: string;
  command: string;
  requiredParameters: string[];
  checkpoint: string;
  recoveryHint: string;
  transport: PaykitGuideTransport;
}

export interface PaykitGuideScenario {
  id: string;
  title: string;
  prerequisites: string[];
  steps: PaykitGuideStep[];
}

export interface PaykitGuideCatalog {
  apiVersion: 1;
  catalogVersion: number;
  panels: PaykitGuidePanel[];
  commands: PaykitGuideCommandSpec[];
  scenarios: PaykitGuideScenario[];
}

export interface PaykitReceiverDiagnostic {
  id: string;
  status: 'stopped' | 'starting' | 'running' | 'error';
  generation: number;
}

export interface PaykitOperationDiagnostic {
  id: string;
  command: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  errorCode?: string;
}

export interface PaykitDiagnostics {
  apiVersion: 1;
  environmentId: string;
  ready: boolean;
  fundingStatus:
    | 'notStarted'
    | 'running'
    | 'ready'
    | 'failed'
    | 'uncertain'
    | 'unavailable';
  receivers: PaykitReceiverDiagnostic[];
  operations: PaykitOperationDiagnostic[];
  lastEventSequence: number;
}

/** Renderer-only navigation. Backend state remains the source of operational truth. */
export interface PaykitGuideViewState {
  environmentId: string;
  networkId: number;
  scenarioId: string;
  stepId: string;
}

export interface PaykitGuidePeerFocus {
  receiverId: string;
  publicKey: string;
  receiverPath: string;
}
