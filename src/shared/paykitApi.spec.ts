import {
  isUuid,
  isPaykitRequestEndpointBinding,
  newPaykitId,
  PaykitCommandRequest,
  validatePaykitCommand,
} from './paykitApi';

describe('Paykit public commands', () => {
  it('creates distinct RFC4122 version 4 command IDs', () => {
    const ids = Array.from({ length: 100 }, newPaykitId);
    expect(ids.every(id => isUuid(id) && id[14] === '4')).toBe(true);
    expect(new Set(ids).size).toBe(100);
  });
  it('validates scoped receiver creation and rejects unknown fields', () => {
    const request: PaykitCommandRequest = {
      commandId: newPaykitId(),
      command: 'receiver.create',
      input: { participantId: newPaykitId(), name: 'Bob wallet', kind: 'wallet' },
    };
    expect(() => validatePaykitCommand(request)).not.toThrow();
    expect(() =>
      validatePaykitCommand({
        ...request,
        input: { ...request.input, path: '/other/receiver' },
      }),
    ).toThrow('input');
    expect(() =>
      validatePaykitCommand({ ...request, input: { ...request.input, kind: 'shared' } }),
    ).toThrow('kind');
    expect(() =>
      validatePaykitCommand({
        ...request,
        input: { ...request.input, participantId: '../other' },
      }),
    ).toThrow('participantId');
    expect(() =>
      validatePaykitCommand({ ...request, input: { ...request.input, name: ' ' } }),
    ).toThrow('name');
  });
  it('rejects unsupported commands and malformed IDs', () => {
    expect(() =>
      validatePaykitCommand({ commandId: 'no', command: 'preset.create', input: {} }),
    ).toThrow();
    expect(() =>
      validatePaykitCommand({
        commandId: newPaykitId(),
        command: 'unsupported.command' as any,
        input: {},
      }),
    ).toThrow();
  });
});

describe('Paykit receiver command validation', () => {
  const receiverId = newPaykitId();
  const peer = {
    receiverId,
    peerPublicKey: 'y'.repeat(52),
    peerReceiverPath: 'test/wallet',
  };
  const validate = (
    command: PaykitCommandRequest['command'],
    input: PaykitCommandRequest['input'],
  ) => validatePaykitCommand({ commandId: newPaykitId(), command, input });
  it('requires canonical scoped peer inputs and exact string arrays', () => {
    expect(() => validate('link.initiate', peer)).not.toThrow();
    for (const path of [
      'private/wallet',
      '../wallet',
      'Test/wallet',
      'test/other',
      'test/wallet/child',
    ])
      expect(() => validate('link.accept', { ...peer, peerReceiverPath: path })).toThrow(
        'peerReceiverPath',
      );
    expect(() =>
      validate('link.block', { ...peer, peerPublicKey: 'z'.repeat(52) }),
    ).toThrow('peerPublicKey');
    expect(() =>
      validate('contact.save', {
        receiverId,
        peerPublicKey: peer.peerPublicKey,
        label: '',
        receiverPaths: ['a/wallet', 'a/server'],
      }),
    ).not.toThrow();
    for (const receiverPaths of [
      [],
      ['a/wallet', 'a/wallet'],
      ['../../secret'],
      'a/wallet',
    ])
      expect(() =>
        validate('contact.save', {
          receiverId,
          peerPublicKey: peer.peerPublicKey,
          label: '',
          receiverPaths,
        }),
      ).toThrow('receiverPaths');
  });
  it('validates text byte limits and avatar retention, removal, signature and size', () => {
    const profile = { receiverId, displayName: 'Alice', about: 'First\nsecond' };
    expect(() => validate('profile.publish', profile)).not.toThrow();
    expect(() =>
      validate('profile.publish', { ...profile, avatarBase64: '', avatarMime: '' }),
    ).not.toThrow();
    expect(() =>
      validate('profile.publish', { ...profile, displayName: '🌍'.repeat(21) }),
    ).toThrow('displayName');
    expect(() =>
      validate('profile.publish', { ...profile, avatarMime: 'image/png' }),
    ).toThrow('Both');
    expect(() =>
      validate('profile.publish', {
        ...profile,
        avatarBase64: 'c2VjcmV0',
        avatarMime: 'image/png',
      }),
    ).toThrow('content');
    expect(() =>
      validate('profile.publish', {
        ...profile,
        avatarBase64: 'A'.repeat(349532),
        avatarMime: 'image/jpeg',
      }),
    ).toThrow('256');
    expect(() =>
      validate('profile.publish', {
        ...profile,
        avatarBase64: 'abc=',
        avatarMime: 'image/svg+xml',
      }),
    ).toThrow('PNG');
  });
});

describe('Payment method and reservation command validation', () => {
  const receiverId = newPaykitId();
  const peer = {
    receiverId,
    peerPublicKey: 'y'.repeat(52),
    peerReceiverPath: 'bob/wallet',
  };
  const validate = (
    command: PaykitCommandRequest['command'],
    input: PaykitCommandRequest['input'],
  ) => validatePaykitCommand({ commandId: newPaykitId(), command, input });
  it('keeps exact satoshis as strings and expiry as bounded integers', () => {
    expect(() =>
      validate('paymentList.publish', {
        receiverId,
        amountSats: '2100000000000000',
        expirySeconds: 604800,
      }),
    ).not.toThrow();
    for (const amountSats of ['0', '-1', '1.5', '01', '1e3', '2100000000000001', 1000]) {
      expect(() =>
        validate('paymentList.publish', { receiverId, amountSats, expirySeconds: 3600 }),
      ).toThrow('amountSats');
    }
    for (const expirySeconds of [0, 604801, 1.5, '3600']) {
      expect(() =>
        validate('reservation.create', { ...peer, amountSats: '1000', expirySeconds }),
      ).toThrow('expirySeconds');
    }
  });
  it('requires an explicit discovery source and rejects overrides and secret configuration', () => {
    const input = { ...peer, source: 'private', amountSats: '1000' };
    expect(() => validate('paymentList.resolve', input)).not.toThrow();
    expect(() => validate('paymentList.resolve', { ...input, source: '' })).toThrow(
      'source',
    );
    expect(() => validate('paymentList.resolve', { ...input, method: 'bolt12' })).toThrow(
      'method',
    );
    expect(() =>
      validate('paymentList.resolve', { ...input, url: 'https://other' }),
    ).toThrow('input');
    expect(() =>
      validate('paymentList.consume', { receiverId, resolutionId: newPaykitId() }),
    ).not.toThrow();
  });
  it('requires unique supported rails and a preference subset when configuring', () => {
    const input = {
      receiverId,
      walletId: 'lnd-0-core-0',
      enabledMethods: ['btc-onchain'],
      preference: [],
    };
    expect(() => validate('method.configure', input)).not.toThrow();
    for (const enabledMethods of [[], ['btc-onchain', 'btc-onchain'], ['bolt12']]) {
      expect(() => validate('method.configure', { ...input, enabledMethods })).toThrow(
        'enabledMethods',
      );
    }
    expect(() =>
      validate('method.configure', { ...input, preference: ['btc-lightning-bolt11'] }),
    ).toThrow('Preference');
    expect(() =>
      validate('method.prefer', {
        receiverId,
        preference: ['btc-onchain', 'btc-onchain'],
      }),
    ).toThrow('preference');
    expect(() =>
      validate('method.configure', { ...input, macaroonPath: '/secret' }),
    ).toThrow('input');
  });
});

describe('Request, payment and proof boundary validation', () => {
  const receiverId = newPaykitId();
  const requestId = newPaykitId();
  const validate = (command: PaykitCommandRequest['command'], input: any) =>
    validatePaykitCommand({ commandId: newPaykitId(), command, input });
  it('preserves exact satoshi terms, caps text and denies caller changes to accepted terms', () => {
    const input = {
      receiverId,
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'alice/wallet',
      amountSats: '2100000000000000',
      description: 'Exact request',
      expirySeconds: 60,
      acceptedMethods: ['btc-onchain'],
    };
    expect(() => validate('request.create', input)).not.toThrow();
    for (const patch of [
      { amountSats: '1.5' },
      { amountSats: 1 },
      { acceptedMethods: [] },
      { acceptedMethods: ['btc-onchain', 'btc-onchain'] },
      { description: 'é'.repeat(251) },
      { description: 'a\u0000b' },
      { expirySeconds: 0 },
    ])
      expect(() => validate('request.create', { ...input, ...patch })).toThrow();
    expect(() =>
      validate('payment.execute', {
        receiverId,
        requestId,
        walletId: 'trusted',
        source: 'private',
        method: 'btc-onchain',
      }),
    ).not.toThrow();
    for (const patch of [
      { amountSats: '1' },
      { endpoint: 'other' },
      { source: undefined },
      { source: 'automatic' },
    ])
      expect(() =>
        validate('payment.execute', {
          receiverId,
          requestId,
          walletId: 'trusted',
          source: 'private',
          ...patch,
        }),
      ).toThrow();
  });
  it('requires exactly one proof source and strict rail-specific public proof material', () => {
    const proof = { method: 'btc-onchain', txid: 'a'.repeat(64), outputIndex: 0 };
    expect(() =>
      validate('proof.submit', { receiverId, requestId, proof }),
    ).not.toThrow();
    expect(() =>
      validate('proof.submit', { receiverId, requestId, executionId: newPaykitId() }),
    ).not.toThrow();
    expect(() => validate('proof.submit', { receiverId, requestId })).toThrow(
      'exactly one',
    );
    expect(() =>
      validate('proof.submit', {
        receiverId,
        requestId,
        proof,
        executionId: newPaykitId(),
      }),
    ).toThrow('exactly one');
    for (const invalid of [
      { ...proof, outputIndex: -1 },
      { ...proof, outputIndex: 4294967296 },
      { ...proof, outputIndex: 0.5 },
      { ...proof, sessionSecret: 'hidden' },
      { method: 'btc-lightning-bolt11', paymentHash: 'a'.repeat(64), preimage: 'bad' },
      JSON.stringify(proof),
    ])
      expect(() =>
        validate('proof.submit', { receiverId, requestId, proof: invalid }),
      ).toThrow();
    expect(() =>
      validate('proof.submit', {
        receiverId,
        requestId,
        proof: {
          method: 'btc-lightning-bolt11',
          paymentHash: 'A'.repeat(64),
          preimage: 'b'.repeat(64),
        },
      }),
    ).not.toThrow();
  });
  it('bounds independent verification confirmations and exposes compatible preset commands', () => {
    const input = { receiverId, requestId, proofId: newPaykitId() };
    expect(() => validate('proof.verify', input)).not.toThrow();
    expect(() =>
      validate('proof.verify', { ...input, requiredConfirmations: 144 }),
    ).not.toThrow();
    for (const value of [0, 145, 1.5, '2'])
      expect(() =>
        validate('proof.verify', { ...input, requiredConfirmations: value }),
      ).toThrow();
    expect(() => validate('preset.create', {})).not.toThrow();
    expect(() => validate('preset.fund', {})).not.toThrow();
    expect(() => validate('preset.fund', { walletUrl: 'caller' })).toThrow();
  });
});

it('validates immutable request endpoint metadata without accepting nested or extra fields', () => {
  const binding = {
    source: 'private',
    method: 'btc-onchain',
    endpoint: 'bcrt1public',
    reservationId: newPaykitId(),
  };
  expect(isPaykitRequestEndpointBinding(binding)).toBe(true);
  for (const invalid of [
    null,
    [],
    { ...binding, source: 'automatic' },
    { ...binding, method: 'bolt12' },
    { ...binding, endpoint: { secret: 'hidden' } },
    { ...binding, endpoint: 'bad\nendpoint' },
    { ...binding, reservationId: '../other' },
    { ...binding, walletAuth: 'hidden' },
  ])
    expect(isPaykitRequestEndpointBinding(invalid)).toBe(false);
});
