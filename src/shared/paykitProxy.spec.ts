import { promises as fs } from 'fs';
import { join } from 'path';
import { paykitProxy, publicOperation, publicState } from '../../electron/paykitProxy';
import { paykitConfig } from './paykitConfig';

jest.mock('fs', () => ({
  existsSync: () => false,
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    open: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    rm: jest.fn(),
    unlink: jest.fn(),
  },
}));
jest.mock('net', () => ({
  createServer: () => ({
    once: jest.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    close: (callback: () => void) => callback(),
  }),
}));
const envId = '9b03a782-e2f3-4b7a-8ef5-429628921ee2';
const binding = { apiVersion: 1, environmentId: envId, servicePort: 30091 };
const fsMock = fs as jest.Mocked<typeof fs>;
const network = () => ({
  id: 1,
  path: join(paykitConfig.dataPath, 'networks', '1'),
  nodes: { bitcoin: [], lightning: [], tap: [] },
});

describe('Main process Paykit boundary', () => {
  beforeEach(() => {
    fsMock.readdir.mockResolvedValue([] as any);
    fsMock.open.mockResolvedValue({
      writeFile: jest.fn(),
      open: jest.fn(),
      readdir: jest.fn(),
      sync: jest.fn(),
      close: jest.fn(),
    } as any);
  });
  it('projects only public state and rejects a different environment', () => {
    const raw = {
      ...binding,
      ready: true,
      lastEventSequence: 7,
      secret: 'hidden',
      participants: [{ id: 'p', name: 'Bob', publicKey: 'public', session: 'hidden' }],
      receivers: [
        {
          id: 'r',
          participantId: 'p',
          name: 'Wallet',
          noisePublicKey: 'public',
          noiseSecretKey: 'hidden',
        },
      ],
      operations: [
        {
          id: 'o',
          command: 'receiver.create',
          status: 'succeeded',
          result: { receiptKey: 'hidden' },
        },
      ],
    };
    expect(JSON.stringify(publicState(raw, envId))).not.toContain('hidden');
    expect(() => publicState(raw, 'different')).toThrow('mismatch');
    expect(
      publicOperation({
        id: 'o',
        status: 'failed',
        error: { code: 'failed', message: 'Storage unavailable', key: 'hidden' },
      }),
    ).toEqual({
      id: 'o',
      status: 'failed',
      error: { code: 'failed', message: 'Storage unavailable' },
    });
  });
  it('rejects renderer paths, unknown IDs and mismatched bindings before network IO', async () => {
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({ networks: [{ ...network(), path: '/other/network' }] }),
    );
    await expect(paykitProxy({ networkId: 1, action: 'provision' })).rejects.toThrow(
      'invalid',
    );
    await expect(paykitProxy({ networkId: -1, action: 'state' })).rejects.toThrow(
      'Invalid',
    );
    fsMock.readFile
      .mockResolvedValueOnce(
        JSON.stringify({
          networks: [{ ...network(), paykit: { ...binding, servicePort: 1 } }],
        }),
      )
      .mockResolvedValueOnce(JSON.stringify(binding));
    await expect(paykitProxy({ networkId: 1, action: 'state' })).rejects.toThrow(
      'does not match',
    );
  });
  it('does not replace missing credentials for an existing environment', async () => {
    fsMock.readFile
      .mockResolvedValueOnce(
        JSON.stringify({ networks: [{ ...network(), paykit: binding }] }),
      )
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(
        JSON.stringify({ networks: [{ ...network(), paykit: binding }] }),
      );
    await expect(paykitProxy({ networkId: 1, action: 'provision' })).rejects.toThrow(
      'Recovery is required',
    );
    expect(fsMock.open).not.toHaveBeenCalled();
  });
  it('provisions exclusive credential files outside export directories and returns no secrets', async () => {
    fsMock.readFile.mockImplementation(async path => {
      if (`${path}`.endsWith('network-1.json'))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return JSON.stringify({ networks: [network()] });
    });
    const result = await paykitProxy({ networkId: 1, action: 'provision' });
    expect(Object.keys(result).sort()).toEqual([
      'apiVersion',
      'environmentId',
      'servicePort',
    ]);
    const writes = fsMock.open.mock.calls.filter(([, mode]) => mode === 'wx');
    expect(writes).toHaveLength(4);
    for (const [path, flags, mode] of writes) {
      expect(`${path}`).toContain('paykit-credentials');
      expect(`${path}`).not.toContain('/networks/');
      expect(flags).toBe('wx');
      expect(mode).toBe(0o600);
    }
  });
});

describe('Recursive public receiver projection', () => {
  const injected = { secretKey: 'hidden' };
  const workspace = {
    receiverId: 'receiver',
    deliveryPaused: true,
    session: injected,
    links: [
      {
        peerPublicKey: 'peer',
        peerReceiverPath: 'app/wallet',
        state: 'linked',
        pendingMessages: 2,
        latestReceivedListId: '18446744073709551615',
        handshake: injected,
        lastError: injected,
      },
    ],
    profile: {
      displayName: 'Alice',
      about: 'Public bio',
      imageUri: 'pubky://public/avatar',
      avatarDataUrl: 'https://evil.test/tracker',
      session: injected,
    },
    profiles: [
      {
        displayName: 'Bob',
        about: injected,
        avatarDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
        receiptKey: 'hidden',
      },
    ],
    contacts: [
      {
        peerPublicKey: 'peer',
        label: 'Local label',
        publicSharing: 'public',
        receiverPaths: ['app/wallet', injected],
        session: injected,
      },
    ],
    discoveries: [
      { peerPublicKey: 'peer', receiverPaths: ['app/server', injected], raw: injected },
    ],
  };
  it('projects state and operation workspaces recursively, including arrays and scalar injection', () => {
    const raw = {
      apiVersion: 1,
      environmentId: envId,
      participants: [],
      receivers: [],
      operations: [],
      receiverWorkspaces: [workspace],
    };
    const projected = publicState(raw, envId);
    const operation = publicOperation({
      id: 'o',
      result: {
        receiverId: injected,
        outboundMessageId: '18446744073709551615',
        workspace,
        snapshot: injected,
      },
    });
    for (const value of [projected, operation]) {
      const text = JSON.stringify(value);
      expect(text).not.toContain('hidden');
      expect(text).not.toContain('evil.test');
      expect(text).not.toContain('svg');
      expect(text).toContain('18446744073709551615');
    }
    expect(projected.receiverWorkspaces[0].contacts[0].receiverPaths).toEqual([
      'app/wallet',
    ]);
    expect(operation.result).not.toHaveProperty('receiverId');
  });
});
