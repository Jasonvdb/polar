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
  result?: PaykitOperationResult;
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
  funding?: PaykitFunding;
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
  'preset.fund',
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
  'method.configure',
  'method.prefer',
  'paymentList.publish',
  'paymentList.unpublish',
  'reservation.create',
  'reservation.rotate',
  'reservation.cancel',
  'reservation.reconcile',
  'paymentList.resolve',
  'paymentList.consume',
  'request.create',
  'request.accept',
  'request.reject',
  'request.cancel',
  'subscription.prepare',
  'subscription.authorize',
  'subscription.disable',
  'clock.set',
  'clock.reset',
  'payment.execute',
  'payment.reconcile',
  'proof.submit',
  'proof.verify',
  'receipt.prepare',
  'receipt.process',
  'receipt.retrieve',
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
export type PaykitInput = Record<
  string,
  string | string[] | number | PaykitProofMaterial | PaykitRecurrence | null
>;
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
export const paykitMethods = ['btc-onchain', 'btc-lightning-bolt11'] as const;
export type PaykitMethod = (typeof paykitMethods)[number];
export interface PaykitPaymentMethods {
  walletId?: string;
  enabledMethods: string[];
  preference: string[];
  wallets: {
    id: string;
    label: string;
    supportedMethods: string[];
    status: 'configured';
  }[];
}
export type PaykitDeliveryStatus = 'pending' | 'published' | 'queued' | 'sent' | 'failed';
export type PaykitCleanupStatus = 'notRequired' | 'pending' | 'complete' | 'failed';
export interface PaykitPublicPaymentList {
  id: string;
  amountSats: string;
  createdAt: string;
  expiresAt: string;
  status: 'issuing' | 'active' | 'withdrawn' | 'expired' | 'superseded' | 'uncertain';
  deliveryStatus: PaykitDeliveryStatus;
  cleanupStatus: PaykitCleanupStatus;
  lastError?: string;
  reservationIds: string[];
}
export interface PaykitReservation {
  id: string;
  listId: string;
  walletId: string;
  source: 'public' | 'private';
  peerPublicKey?: string;
  peerReceiverPath?: string;
  method: string;
  endpoint?: string;
  amountSats: string;
  createdAt: string;
  expiresAt: string;
  status: 'issuing' | 'active' | 'cancelled' | 'expired' | 'superseded' | 'uncertain';
  deliveryStatus: PaykitDeliveryStatus;
  cleanupStatus: PaykitCleanupStatus;
  outboundMessageId?: string;
  lastError?: string;
}
export interface PaykitResolution {
  id: string;
  peerPublicKey: string;
  peerReceiverPath: string;
  source: 'public' | 'private';
  amountSats: string;
  createdAt: string;
  method?: string;
  endpoint?: string;
  version?: string;
  expiresAt?: string;
  status:
    | 'payable'
    | 'noEndpoint'
    | 'unsupportedEndpoint'
    | 'waitingForUpdatedPaymentList'
    | 'recoveryPending'
    | 'consumed';
  lastError?: string;
}
export type PaykitProofMaterial =
  | { method: 'btc-onchain'; txid: string; outputIndex: number }
  | { method: 'btc-lightning-bolt11'; paymentHash: string; preimage: string };
export interface PaykitRequestEndpointBinding {
  source: 'public' | 'private';
  method: PaykitMethod;
  endpoint: string;
  reservationId: string;
}
export const isPaykitRequestEndpointBinding = (
  value: unknown,
): value is PaykitRequestEndpointBinding => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return (
    Object.keys(binding).length === 4 &&
    (binding.source === 'public' || binding.source === 'private') &&
    paykitMethods.includes(binding.method as PaykitMethod) &&
    typeof binding.endpoint === 'string' &&
    binding.endpoint.length > 0 &&
    Buffer.byteLength(binding.endpoint, 'utf8') <= 16384 &&
    !/[\u0000-\u0020\u007f-\u009f]/.test(binding.endpoint) &&
    isUuid(binding.reservationId)
  );
};
export const paykitRecurrenceUnits = [
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'year',
] as const;
export interface PaykitBillingPeriod {
  startsAt: string;
  endsAt: string;
}
export interface PaykitRecurrence {
  every: number;
  unit: (typeof paykitRecurrenceUnits)[number];
  startsAt: string;
  anchor: string;
  endsAt: string | null;
}
export interface PaykitSubscriptionPeriod extends PaykitBillingPeriod {
  index: number;
  status:
    | 'future'
    | 'due'
    | 'missed'
    | 'prepared'
    | 'executed'
    | 'proofSubmitted'
    | 'verified';
  offerId: string | null;
  endpointBindings: PaykitRequestEndpointBinding[];
  executionId: string | null;
  proofId: string | null;
  lastError: string | null;
}
export interface PaykitSubscription {
  requestId: string;
  currentPeriodIndex: number | null;
  autopay: {
    enabled: boolean;
    walletId: string | null;
    source: string | null;
    method: string | null;
    status: 'disabled' | 'waiting' | 'ready' | 'attempted' | 'blocked';
    lastError: string | null;
  };
  periods: PaykitSubscriptionPeriod[];
}
export interface PaykitPaymentRequest {
  recurrence?: PaykitRecurrence | null;
  id: string;
  peerPublicKey: string;
  peerReceiverPath: string;
  role: 'payer' | 'payee';
  lifecycle:
    | 'proposed'
    | 'proposalExpired'
    | 'accepted'
    | 'activeRecurring'
    | 'rejected'
    | 'canceled'
    | 'proofSubmitted'
    | 'recoveryRequired'
    | 'invalidConflict';
  amountSats: string;
  description: string;
  paymentReference: string;
  endpointBindings: PaykitRequestEndpointBinding[];
  proposalExpiresAt: string | null;
  acceptedMethods: string[];
  deliveryStatus: string;
  createdAt: string;
}
export interface PaykitExecution {
  billingPeriod?: PaykitBillingPeriod | null;
  periodIndex?: number | null;
  id: string;
  requestId: string;
  walletId: string;
  source: 'public' | 'private';
  method: string;
  endpoint: string;
  amountSats: string;
  status:
    | 'prepared'
    | 'signing'
    | 'signed'
    | 'inFlight'
    | 'succeeded'
    | 'failed'
    | 'uncertain';
  createdAt: string;
  updatedAt: string;
  txid: string | null;
  outputIndex: number | null;
  paymentHash: string | null;
  lastError: string | null;
}
export interface PaykitProof {
  billingPeriod?: PaykitBillingPeriod | null;
  periodIndex?: number | null;
  id: string;
  requestId: string;
  method: string;
  proof: PaykitProofMaterial;
  deliveryStatus: string;
  recordedAt: string;
}
export interface PaykitSettlement {
  billingPeriod?: PaykitBillingPeriod | null;
  periodIndex?: number | null;
  proofId: string;
  requestId: string;
  status: 'pending' | 'verified' | 'invalid' | 'failed';
  requiredConfirmations: number;
  confirmations: number;
  verifiedAt: string | null;
  lastError: string | null;
}
export interface PaykitReceiptIssuance {
  billingPeriod?: PaykitBillingPeriod | null;
  id: string;
  requestId: string;
  proofId: string;
  peerPublicKey: string;
  peerReceiverPath: string;
  paymentReference: string;
  method: PaykitMethod;
  amountSats: string;
  description: string;
  note: string;
  status: 'pendingStorage' | 'stored' | 'accessQueued' | 'failed';
  deliveryStatus:
    | 'notQueued'
    | 'pending'
    | 'sending'
    | 'sent'
    | 'failed'
    | 'invalid'
    | 'recoveryRequired'
    | 'superseded'
    | 'unknown';
  accessEventId: string;
  outboundMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  storedAt: string | null;
  accessQueuedAt: string | null;
  lastError: string | null;
}
export interface PaykitReceiptAccess {
  billingPeriod?: PaykitBillingPeriod | null;
  receiptId: string;
  peerPublicKey: string;
  peerReceiverPath: string;
  accessEventId: string;
  requestId: string | null;
  paymentReference: string;
  retrievalStatus: 'pending' | 'retrieved' | 'notFound' | 'failed';
  receivedAt: string;
  attemptedAt: string | null;
  retrievedAt: string | null;
  lastError: string | null;
}
export interface PaykitDecryptedReceipt {
  billingPeriod?: PaykitBillingPeriod | null;
  id: string;
  issuerPublicKey: string;
  issuerReceiverPath: string;
  recipientPublicKey: string;
  requestId: string | null;
  proofId: string | null;
  paymentReference: string;
  method: PaykitMethod | null;
  amountSats: string | null;
  description: string | null;
  note: string | null;
  accessEventId: string;
  retrievedAt: string;
}
export interface PaykitFunding {
  status: 'notStarted' | 'running' | 'ready' | 'uncertain' | 'failed';
  funded: boolean;
  step: string;
  wallets: {
    participant: string;
    walletId: string;
    onchainBalanceSats: string;
    lightningBalanceSats: string;
  }[];
  channelPoints: string[];
  lastError: string | null;
}
export interface PaykitOperationResult {
  receiptId?: string;
  participantId?: string;
  receiverId?: string;
  preset?: string;
  funded?: boolean;
  funding?: PaykitFunding;
  peerPublicKey?: string;
  peerReceiverPath?: string;
  outboundMessageId?: string;
  deliveryPaused?: boolean;
  status?: string;
  path?: string;
  imageUri?: string;
  workspace?: PaykitReceiverWorkspace;
  resolution?: PaykitResolution;
}
export interface PaykitReceiverWorkspace {
  applicationClock?: { mode: 'system' | 'controlled'; now: string };
  subscriptions?: PaykitSubscription[];
  receiverId: string;
  deliveryPaused: boolean;
  links: PaykitLink[];
  profile?: PaykitProfile;
  profiles: PaykitProfile[];
  contacts: PaykitContact[];
  discoveries: PaykitDiscovery[];
  paymentMethods?: PaykitPaymentMethods;
  publicPaymentList?: PaykitPublicPaymentList;
  reservations?: PaykitReservation[];
  resolutions?: PaykitResolution[];
  requests?: PaykitPaymentRequest[];
  executions?: PaykitExecution[];
  proofs?: PaykitProof[];
  settlements?: PaykitSettlement[];
  receiptIssuances?: PaykitReceiptIssuance[];
  receiptAccess?: PaykitReceiptAccess[];
  receipts?: PaykitDecryptedReceipt[];
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
  'preset.fund': [],
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
  'method.configure': ['receiverId', 'walletId', 'enabledMethods', 'preference'],
  'method.prefer': ['receiverId', 'preference'],
  'paymentList.publish': ['receiverId', 'amountSats', 'expirySeconds'],
  'paymentList.unpublish': ['receiverId'],
  'reservation.create': [...peerFields, 'amountSats', 'expirySeconds'],
  'reservation.rotate': [...peerFields, 'amountSats', 'expirySeconds'],
  'reservation.cancel': ['receiverId', 'reservationId'],
  'reservation.reconcile': ['receiverId', 'reservationId'],
  'paymentList.resolve': [...peerFields, 'source', 'amountSats', 'method'],
  'paymentList.consume': ['receiverId', 'resolutionId'],
  'request.create': [
    ...peerFields,
    'amountSats',
    'description',
    'expirySeconds',
    'acceptedMethods',
    'recurrence',
  ],
  'request.accept': ['receiverId', 'requestId'],
  'request.reject': ['receiverId', 'requestId'],
  'request.cancel': ['receiverId', 'requestId'],
  'subscription.prepare': [
    'receiverId',
    'requestId',
    'periodIndex',
    'source',
    'expirySeconds',
  ],
  'subscription.authorize': ['receiverId', 'requestId', 'walletId', 'source', 'method'],
  'subscription.disable': ['receiverId', 'requestId'],
  'clock.set': ['receiverId', 'now'],
  'clock.reset': ['receiverId'],
  'payment.execute': [
    'receiverId',
    'requestId',
    'walletId',
    'source',
    'method',
    'periodIndex',
  ],
  'payment.reconcile': ['receiverId', 'executionId'],
  'proof.submit': ['receiverId', 'requestId', 'executionId', 'proof', 'periodIndex'],
  'proof.verify': ['receiverId', 'requestId', 'proofId', 'requiredConfirmations'],
  'receipt.prepare': ['receiverId', 'requestId', 'proofId', 'note'],
  'receipt.process': ['receiverId', 'receiptId'],
  'receipt.retrieve': [...peerFields, 'receiptId'],
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
export const validatePaykitProof = (value: unknown): void => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Paykit proof');
  const proof = value as Record<string, unknown>;
  const hex = (input: unknown) =>
    typeof input === 'string' && /^[a-fA-F0-9]{64}$/.test(input);
  const valid =
    proof.method === 'btc-onchain'
      ? Object.keys(proof).length === 3 &&
        hex(proof.txid) &&
        typeof proof.outputIndex === 'number' &&
        Number.isSafeInteger(proof.outputIndex) &&
        proof.outputIndex >= 0 &&
        proof.outputIndex <= 4294967295
      : proof.method === 'btc-lightning-bolt11' &&
        Object.keys(proof).length === 3 &&
        hex(proof.paymentHash) &&
        hex(proof.preimage);
  if (!valid) throw new Error('Invalid Paykit proof');
};

export const isPaykitUtcInstant = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^20[2-9][0-9]-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$|^2100-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(
    value,
  ) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value.replace('Z', '.000Z');

const validatePaykitRecurrence = (value: unknown) => {
  const recurrence = value as PaykitRecurrence;
  if (
    !recurrence ||
    typeof recurrence !== 'object' ||
    Array.isArray(recurrence) ||
    Object.keys(recurrence).some(
      key => !['every', 'unit', 'startsAt', 'anchor', 'endsAt'].includes(key),
    ) ||
    !Number.isInteger(recurrence.every) ||
    recurrence.every < 1 ||
    recurrence.every > 1000 ||
    !paykitRecurrenceUnits.includes(recurrence.unit) ||
    !isPaykitUtcInstant(recurrence.startsAt) ||
    recurrence.anchor !== recurrence.startsAt ||
    (recurrence.endsAt !== null &&
      (!isPaykitUtcInstant(recurrence.endsAt) ||
        recurrence.endsAt <= recurrence.startsAt))
  )
    throw new Error('Invalid Paykit recurrence');
  // The backend validates anchored calendar boundaries, including clamped month/year dates.
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
    if (
      (field === 'note' ||
        field === 'recurrence' ||
        (field === 'periodIndex' && request.command !== 'subscription.prepare') ||
        (field === 'method' && request.command !== 'subscription.authorize') ||
        field === 'requiredConfirmations' ||
        (request.command === 'proof.submit' &&
          ['executionId', 'proof'].includes(field))) &&
      value === undefined
    )
      continue;
    if (field === 'recurrence') {
      if (value !== null) validatePaykitRecurrence(value);
      continue;
    }
    if (field === 'now') {
      if (!isPaykitUtcInstant(value)) throw new Error('Invalid Paykit UTC time');
      continue;
    }
    if (field === 'periodIndex') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 10000
      )
        throw new Error('Invalid Paykit periodIndex');
      continue;
    }
    if (field === 'note') {
      if (
        typeof value !== 'string' ||
        Buffer.byteLength(value, 'utf8') > 500 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(value)
      )
        throw new Error(
          'Receipt note must be at most 500 UTF-8 bytes without control characters',
        );
      continue;
    }
    if (request.command.startsWith('receipt.') && field.endsWith('Id')) {
      if (
        typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ||
        value === '00000000-0000-0000-0000-000000000000' ||
        (field !== 'receiverId' && (value[14] !== '4' || !/[89ab]/.test(value[19])))
      )
        throw new Error(`Invalid Paykit ${field}`);
      continue;
    }
    if (field === 'proof') {
      validatePaykitProof(value);
      continue;
    }
    if (field === 'requiredConfirmations') {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 144
      )
        throw new Error('Invalid Paykit requiredConfirmations');
      continue;
    }
    if (
      field === 'enabledMethods' ||
      field === 'preference' ||
      field === 'acceptedMethods'
    ) {
      if (
        !Array.isArray(value) ||
        value.length > 2 ||
        (field !== 'preference' && !value.length) ||
        new Set(value).size !== value.length ||
        value.some(method => !paykitMethods.includes(method as PaykitMethod))
      )
        throw new Error(`Invalid Paykit ${field}`);
      continue;
    }
    if (field === 'expirySeconds') {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > 604800
      )
        throw new Error('Invalid Paykit expirySeconds');
      continue;
    }
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
      (['name', 'displayName', 'label', 'about', 'description'].includes(field) &&
        (Buffer.byteLength(value, 'utf8') >
          (field === 'about' ? 2000 : field === 'description' ? 500 : 80) ||
          /[\u0000-\u001f\u007f-\u009f]/.test(
            value.replace(field === 'about' ? /[\n\t]/g : /$^/, ''),
          ))) ||
      (field.endsWith('Id') && field !== 'walletId' && !isUuid(value)) ||
      (field === 'walletId' && value.length > 128) ||
      (field === 'amountSats' &&
        (!/^[1-9][0-9]{0,15}$/.test(value) ||
          BigInt(value) > BigInt('2100000000000000'))) ||
      (field === 'source' && !['public', 'private'].includes(value)) ||
      (field === 'method' && !paykitMethods.includes(value as PaykitMethod)) ||
      (field === 'kind' && !['wallet', 'server'].includes(value)) ||
      (field === 'peerPublicKey' && !isPaykitPublicKey(value)) ||
      (field === 'peerReceiverPath' && !isPaykitReceiverPath(value))
    )
      throw new Error(`Invalid Paykit ${field}`);
  }
  if (
    request.command === 'proof.submit' &&
    (request.input.executionId === undefined) === (request.input.proof === undefined)
  )
    throw new Error('Provide exactly one executionId or proof');
  if (
    request.command === 'method.configure' &&
    (request.input.preference as string[]).some(
      method => !(request.input.enabledMethods as string[]).includes(method),
    )
  )
    throw new Error('Preference must contain enabled methods');
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
