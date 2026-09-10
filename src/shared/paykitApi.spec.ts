import {
  isUuid,
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
        command: 'payment.execute' as any,
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
