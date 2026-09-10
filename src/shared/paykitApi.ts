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
  receiverWorkspaces?: PaykitReceiverWorkspace[];
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
  'link.initiate',
  'link.accept',
  'link.advance',
  'link.block',
  'link.unblock',
  'link.sendEmptyList',
  'delivery.pause',
  'delivery.resume',
  'delivery.sync',
  'profile.publish',
  'profile.delete',
  'profile.fetch',
  'contact.save',
  'contact.remove',
  'contact.discover',
  'contact.publish',
  'contact.unpublish',
] as const;
export type PaykitCommand = (typeof paykitCommands)[number];
export interface PaykitCommandRequest {
  commandId: string;
  command: PaykitCommand;
  input: PaykitInput;
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
export type PaykitInput = Record<string, string | string[]>;
export interface PaykitLink {
  peerPublicKey: string;
  peerReceiverPath: string;
  state: string;
  generation: number;
  handshakeRole?: string;
  lastSyncAt?: string;
  lastReceiveAt?: string;
  failureCount: number;
  pendingMessages: number;
  latestReceivedListId?: string;
  lastSentMessageId?: string;
  lastError?: string;
}
export interface PaykitProfile {
  peerPublicKey: string;
  peerReceiverPath: string;
  displayName: string;
  about: string;
  imageUri?: string;
  avatarDataUrl?: string;
  path: string;
  updatedAt: string;
}
export interface PaykitContact {
  peerPublicKey: string;
  label: string;
  receiverPaths: string[];
  publicSharing: string;
  publicReceiverPath?: string;
  lastError?: string;
}
export interface PaykitDiscovery {
  peerPublicKey: string;
  receiverPaths: string[];
  updatedAt: string;
}
export interface PaykitReceiverWorkspace {
  receiverId: string;
  deliveryPaused: boolean;
  links: PaykitLink[];
  profile?: PaykitProfile;
  profiles: PaykitProfile[];
  contacts: PaykitContact[];
  discoveries: PaykitDiscovery[];
  lastError?: string;
  updatedAt?: string;
}
const peerFields = ['receiverId', 'peerPublicKey', 'peerReceiverPath'];
export const paykitCommandFields: Record<PaykitCommand, string[]> = {
  'participant.create': ['name'],
  'participant.rename': ['participantId', 'name'],
  'receiver.create': ['participantId', 'name', 'kind'],
  'receiver.rename': ['receiverId', 'name'],
  'receiver.start': ['receiverId'],
  'receiver.stop': ['receiverId'],
  'receiver.restart': ['receiverId'],
  'preset.create': [],
  'link.initiate': peerFields,
  'link.accept': peerFields,
  'link.advance': peerFields,
  'link.block': peerFields,
  'link.unblock': peerFields,
  'link.sendEmptyList': peerFields,
  'delivery.pause': ['receiverId'],
  'delivery.resume': ['receiverId'],
  'delivery.sync': ['receiverId'],
  'profile.publish': ['receiverId', 'displayName', 'about', 'avatarBase64', 'avatarMime'],
  'profile.delete': ['receiverId'],
  'profile.fetch': peerFields,
  'contact.save': ['receiverId', 'peerPublicKey', 'label', 'receiverPaths'],
  'contact.remove': ['receiverId', 'peerPublicKey'],
  'contact.discover': ['receiverId', 'peerPublicKey'],
  'contact.publish': peerFields,
  'contact.unpublish': peerFields,
};
export const isPaykitPublicKey = (value: string) =>
  /^[ybndrfg8ejkmcpqxot1uwisza345h769]{51}[yo]$/.test(value);
export const isPaykitReceiverPath = (value: string) =>
  /^[a-z0-9-]{1,64}\/(wallet|server)$/.test(value) && !value.startsWith('private/');
export const validatePaykitAvatar = (base64: string, mime: string) => {
  if (
    !['image/png', 'image/jpeg'].includes(mime) ||
    base64.length > 349528 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  )
    throw new Error('Avatar must be a PNG or JPEG up to 256 KiB');
  const data = Buffer.from(base64, 'base64');
  const valid =
    mime === 'image/png'
      ? data.length >= 8 &&
        data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (!valid || data.length > 256 * 1024)
    throw new Error('Avatar content does not match a supported PNG or JPEG');
};
export const safePaykitAvatar = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return;
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) return;
  try {
    validatePaykitAvatar(match[2], match[1]);
    return value;
  } catch {
    return;
  }
};
export const validatePaykitCommand = (request: PaykitCommandRequest) => {
  if (!request || !isUuid(request.commandId) || !paykitCommands.includes(request.command))
    throw new Error('Invalid Paykit command or command ID');
  const expected = paykitCommandFields[request.command];
  if (
    !request.input ||
    Array.isArray(request.input) ||
    typeof request.input !== 'object' ||
    Object.keys(request.input).some(key => !expected.includes(key))
  )
    throw new Error('Invalid Paykit command input');
  for (const field of expected) {
    const value = request.input[field];
    if (field === 'avatarBase64' || field === 'avatarMime') continue;
    if (field === 'receiverPaths') {
      if (
        !Array.isArray(value) ||
        !value.length ||
        value.length > 16 ||
        new Set(value).size !== value.length ||
        value.some(path => typeof path !== 'string' || !isPaykitReceiverPath(path))
      )
        throw new Error('Invalid Paykit receiverPaths');
      continue;
    }
    if (
      typeof value !== 'string' ||
      (!['label', 'about'].includes(field) && !value.trim()) ||
      (['name', 'displayName', 'label', 'about'].includes(field) &&
        (Buffer.byteLength(value, 'utf8') > (field === 'about' ? 2000 : 80) ||
          /[\u0000-\u001f\u007f-\u009f]/.test(
            value.replace(field === 'about' ? /[\n\t]/g : /$^/, ''),
          ))) ||
      (field.endsWith('Id') && !isUuid(value)) ||
      (field === 'kind' && !['wallet', 'server'].includes(value)) ||
      (field === 'peerPublicKey' && !isPaykitPublicKey(value)) ||
      (field === 'peerReceiverPath' && !isPaykitReceiverPath(value))
    )
      throw new Error(`Invalid Paykit ${field}`);
  }
  if (request.command === 'profile.publish') {
    const { avatarBase64, avatarMime } = request.input;
    if (avatarBase64 !== undefined || avatarMime !== undefined) {
      if (typeof avatarBase64 !== 'string' || typeof avatarMime !== 'string')
        throw new Error('Both avatar fields are required');
      if (avatarBase64 !== '' || avatarMime !== '')
        validatePaykitAvatar(avatarBase64, avatarMime);
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
