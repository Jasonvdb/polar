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
