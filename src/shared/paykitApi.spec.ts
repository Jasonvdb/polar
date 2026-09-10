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
