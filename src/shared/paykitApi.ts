import { randomBytes } from 'crypto';

/** Public protocol only. Credentials and SDK secrets never cross this boundary. */
export interface PaykitEnvironment {
  apiVersion: 1;
  environmentId: string;
  servicePort: number;
}
export interface PaykitParticipant {
  id: string;
  name: string;
  publicKey: string;
}
export interface PaykitReceiver {
  id: string;
  participantId: string;
  name: string;
  path: string;
  status: 'stopped' | 'starting' | 'running' | 'error';
  generation: number;
  noisePublicKey: string;
  lastError?: string;
}
export interface PaykitOperation {
  id: string;
  command: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result?: unknown;
  error?: { code: string; message: string };
}
export interface PaykitState {
  apiVersion: 1;
  environmentId: string;
  ready: boolean;
  participants: PaykitParticipant[];
  receivers: PaykitReceiver[];
  operations: PaykitOperation[];
  lastEventSequence: number;
}
export const paykitCommands = [
  'participant.create',
  'participant.rename',
  'receiver.create',
  'receiver.rename',
  'receiver.start',
  'receiver.stop',
  'receiver.restart',
  'preset.create',
] as const;
export type PaykitCommand = (typeof paykitCommands)[number];
export interface PaykitCommandRequest {
  commandId: string;
  command: PaykitCommand;
  input: Record<string, string>;
}
export type PaykitRequest = {
  networkId: number;
} & (
  | { action: 'provision' | 'state' | 'checkPort' | 'remove' }
  | { action: 'operation'; operationId: string }
  | { action: 'command'; request: PaykitCommandRequest }
);
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
export const validatePaykitCommand = (request: PaykitCommandRequest) => {
  if (
    !request ||
    !isUuid(request.commandId) ||
    !paykitCommands.includes(request.command)
  ) {
    throw new Error('Invalid Paykit command or command ID');
  }
  const fields: Record<PaykitCommand, string[]> = {
    'participant.create': ['name'],
    'participant.rename': ['participantId', 'name'],
    'receiver.create': ['participantId', 'name', 'kind'],
    'receiver.rename': ['receiverId', 'name'],
    'receiver.start': ['receiverId'],
    'receiver.stop': ['receiverId'],
    'receiver.restart': ['receiverId'],
    'preset.create': [],
  };
  const expected = fields[request.command];
  if (!request.input || Object.keys(request.input).some(key => !expected.includes(key))) {
    throw new Error('Invalid Paykit command input');
  }
  for (const field of expected) {
    const value = request.input[field];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      (field === 'name' &&
        (Buffer.byteLength(value, 'utf8') > 80 ||
          /[\u0000-\u001f\u007f-\u009f]/.test(value))) ||
      (field.endsWith('Id') && !isUuid(value)) ||
      (field === 'kind' && !['wallet', 'server'].includes(value))
    ) {
      throw new Error(`Invalid Paykit ${field}`);
    }
  }
};

/** UUIDv4 compatible with Electron 13's Node runtime. */
export const newPaykitId = () => {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
};
