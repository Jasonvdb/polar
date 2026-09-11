import { promises as fs } from 'fs';
import { EventEmitter } from 'events';
import { request as httpRequest } from 'http';
import { join, resolve, sep } from 'path';
import {
  paykitProxy,
  publicOperation,
  publicState,
  walletBindings,
  fundingWalletIds,
  refreshWalletConfig,
  callService,
  frameTransfer,
  regularArchive,
} from '../../electron/paykitProxy';
import { bakePaykitMacaroon } from '../../electron/paykitWalletAuth';
jest.mock('../../electron/paykitWalletAuth', () => ({
  ...jest.requireActual('../../electron/paykitWalletAuth'),
  bakePaykitMacaroon: jest.fn(),
}));
import { paykitConfig } from './paykitConfig';

jest.mock('fs', () => ({
  constants: jest.requireActual('fs').constants,
  existsSync: () => false,
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    open: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    rm: jest.fn(),
    unlink: jest.fn(),
    rename: jest.fn(),
    realpath: jest.fn(),
    stat: jest.fn(),
    lstat: jest.fn(),
  },
}));
jest.mock('net', () => ({
  createServer: () => ({
    once: jest.fn(),
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    close: (callback: () => void) => callback(),
  }),
}));
jest.mock('http', () => ({ request: jest.fn() }));
const envId = '9b03a782-e2f3-4b7a-8ef5-429628921ee2';
const binding = { apiVersion: 1 as const, environmentId: envId, servicePort: 30091 };
const fsMock = fs as jest.Mocked<typeof fs>;
const httpRequestMock = httpRequest as jest.MockedFunction<typeof httpRequest>;
const network = () => ({
  id: 1,
  path: join(paykitConfig.dataPath, 'networks', '1'),
  nodes: { bitcoin: [], lightning: [], tap: [] },
});

describe('Paykit sensitive transfer framing', () => {
  it('uses the fixed binary frame and rejects short passphrases before transport', () => {
    const receiverId = '9b03a782-e2f3-4b7a-8ef5-429628921ee2';
    const archive = Buffer.from('archive');
    const framed = frameTransfer(2, receiverId, 'twelve-byte-password', archive);
    expect(framed.subarray(0, 4).toString()).toBe('PKTR');
    expect([...framed.subarray(4, 6)]).toEqual([1, 2]);
    expect(framed.readUInt32BE(24)).toBe(archive.length);
    expect(() => frameTransfer(1, receiverId, 'short', Buffer.alloc(0))).toThrow('12');
    framed.fill(0);
  });
  it('rejects symlinks and same-size inode replacement while opening an archive', async () => {
    fsMock.lstat.mockResolvedValueOnce({
      isFile: () => true,
      isSymbolicLink: () => true,
      size: 1,
    } as any);
    await expect(regularArchive('/chosen')).rejects.toThrow('regular file');
    fsMock.lstat.mockResolvedValueOnce({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 2,
      dev: 1,
      ino: 10,
      mtimeMs: 100,
    } as any);
    const close = jest.fn();
    fsMock.open.mockResolvedValueOnce({
      stat: jest.fn().mockResolvedValue({
        isFile: () => true,
        size: 2,
        dev: 1,
        ino: 11,
        mtimeMs: 100,
      }),
      close,
    } as any);
    await expect(regularArchive('/chosen')).rejects.toThrow('changed');
    expect(close).toHaveBeenCalled();
  });

  it('rejects archive growth during a bounded descriptor read', async () => {
    const original = {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 2,
      dev: 1,
      ino: 10,
      mtimeMs: 100,
    };
    fsMock.lstat.mockResolvedValueOnce(original as any);
    const stat = jest
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, size: 3, mtimeMs: 101 });
    const read = jest
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        buffer.write('ab');
        return { bytesRead: 2, buffer };
      })
      .mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
    const close = jest.fn();
    fsMock.open.mockResolvedValueOnce({ stat, read, close } as any);

    await expect(regularArchive('/chosen')).rejects.toThrow('changed while reading');
    expect(read).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('reads a stable small archive without using readFile', async () => {
    const stable = {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: 2,
      dev: 1,
      ino: 10,
      mtimeMs: 100,
    };
    fsMock.lstat.mockResolvedValueOnce(stable as any);
    const read = jest
      .fn()
      .mockImplementationOnce(async (buffer: Buffer) => {
        buffer.write('ab');
        return { bytesRead: 2, buffer };
      })
      .mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) });
    const readFile = jest.fn();
    fsMock.open.mockResolvedValueOnce({
      stat: jest.fn().mockResolvedValue(stable),
      read,
      readFile,
      close: jest.fn(),
    } as any);

    await expect(regularArchive('/chosen')).resolves.toEqual(Buffer.from('ab'));
    expect(readFile).not.toHaveBeenCalled();
    expect(read.mock.calls[0][0]).toHaveLength(3);
  });
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
      if (
        `${path}`.endsWith('network-1.json') ||
        `${path}`.endsWith('wallet-config.json')
      )
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
    expect(writes).toHaveLength(5);
    for (const [path, flags, mode] of writes) {
      expect(`${path}`).toContain('paykit-credentials');
      expect(`${path}`).not.toContain('/networks/');
      expect(flags).toBe('wx');
      expect(mode).toBe(0o600);
    }
  });
});

describe('Paykit local request failures', () => {
  beforeEach(() => {
    fsMock.readFile.mockResolvedValue('a'.repeat(64));
    httpRequestMock.mockReset();
  });

  it('reports its local response-size rejection before destroying the request', async () => {
    const response = new EventEmitter() as any;
    response.statusCode = 200;
    const request = new EventEmitter() as any;
    request.destroy = jest.fn(() => {
      response.emit('error', new Error('aborted'));
      request.emit('close');
    });
    request.end = jest.fn(() => {
      response.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    });
    httpRequestMock.mockImplementation(((_options: any, callback: any) => {
      callback(response);
      return request;
    }) as any);

    await expect(callService(binding, '/v1/state')).rejects.toThrow(
      'Paykit response exceeded size limit',
    );
    expect(request.destroy).toHaveBeenCalledWith();
  });

  it('reports its local timeout before destroying the request', async () => {
    jest.useFakeTimers();
    const request = new EventEmitter() as any;
    request.destroy = jest.fn(() => {
      request.emit('error', new Error('aborted'));
      request.emit('close');
    });
    request.end = jest.fn();
    httpRequestMock.mockReturnValue(request);

    const pending = callService(binding, '/v1/state');
    while (!httpRequestMock.mock.calls.length) await Promise.resolve();
    jest.runOnlyPendingTimers();
    await expect(pending).rejects.toThrow('Paykit service request timed out');
    expect(request.destroy).toHaveBeenCalledWith();
    jest.useRealTimers();
  });

  it('keeps actual request socket errors generic without exposing details', async () => {
    const request = new EventEmitter() as any;
    request.destroy = jest.fn();
    request.end = jest.fn(() => {
      request.emit(
        'error',
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:30091'), {
          code: 'ECONNREFUSED',
          syscall: 'connect',
        }),
      );
      request.emit('close');
    });
    httpRequestMock.mockReturnValue(request);

    await expect(callService(binding, '/v1/state')).rejects.toThrow(
      'Paykit service is unavailable. Start the network or check its service logs.',
    );
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

describe('Trusted receiving wallet configuration', () => {
  const walletNetwork = () => ({
    ...network(),
    nodes: {
      bitcoin: [
        { id: 0, networkId: 1, name: 'backend1', implementation: 'bitcoind' },
        { id: 3, networkId: 1, name: 'backend2', implementation: 'bitcoind' },
      ],
      lightning: [
        {
          id: 0,
          networkId: 1,
          name: 'alice',
          implementation: 'LND',
          backendName: 'backend1',
          paths: { tlsCert: '/ignored/untrusted/path' },
        },
      ],
    },
  });
  beforeEach(() => {
    fsMock.readFile.mockRejectedValue(
      Object.assign(new Error('not ready'), { code: 'ENOENT' }),
    );
    fsMock.realpath.mockImplementation(async path => resolve(`${path}`));
    fsMock.stat.mockResolvedValue({ isFile: () => true, size: 32 } as any);
    fsMock.open.mockResolvedValue({
      writeFile: jest.fn(),
      sync: jest.fn(),
      close: jest.fn(),
    } as any);
  });
  it('uses stable zero-based IDs and exact backend bindings independently of order or labels', () => {
    const input = walletNetwork();
    const original = walletBindings(input);
    expect(original.map(wallet => wallet.id)).toEqual([
      'core-0',
      'core-3',
      'lnd-0-core-0',
    ]);
    expect(original[2].lightning?.url).toMatch(
      /^https:\/\/polar-paykit.*-n1-alice:8080$/,
    );
    expect(original[2].bitcoin.url).toMatch(/-n1-backend1:18443$/);
    input.nodes.bitcoin.reverse();
    input.nodes.bitcoin[1].name = 'renamed';
    input.nodes.lightning[0].backendName = 'renamed';
    expect(walletBindings(input)[2].id).toBe(original[2].id);
    input.nodes.lightning[0].backendName = 'missing';
    expect(walletBindings(input)).toHaveLength(2);
  });
  it('rejects path injection, duplicate IDs and cross-network nodes', () => {
    for (const change of [
      { name: '../escape' },
      { name: 'bad:8080' },
      { networkId: 2 },
      { id: -1 },
    ]) {
      const input = walletNetwork();
      Object.assign(input.nodes.lightning[0], change);
      expect(() => walletBindings(input)).toThrow('identity');
    }
    const input = walletNetwork();
    input.nodes.bitcoin[1].id = 0;
    expect(() => walletBindings(input)).toThrow('identity');
  });
  it('publishes atomic versioned config while missing LND credentials leave Pubky available', async () => {
    await expect(
      refreshWalletConfig(walletNetwork(), binding as any),
    ).resolves.toBeUndefined();
    const writes = fsMock.open.mock.calls.filter(([, mode]) => mode === 'wx');
    expect(writes).toHaveLength(1);
    expect(`${writes[0][0]}`).toMatch(/wallet-config\.json\..*\.tmp$/);
    expect(writes[0][2]).toBe(0o600);
    expect(fsMock.rename).toHaveBeenCalledWith(
      writes[0][0],
      expect.stringMatching(/wallet-config\.json$/),
    );
    const handle = await fsMock.open.mock.results[0].value;
    const data = JSON.parse(handle.writeFile.mock.calls[0][0]);
    expect(data).toMatchObject({ apiVersion: 1, environmentId: envId });
    expect(data.wallets[2].lightning.macaroonPath).toContain('/invoices.macaroon');
    expect(JSON.stringify(data)).not.toContain('/ignored/untrusted/path');
  });
  it('copies only bounded TLS and invoice authorization files and does not rewrite unchanged files', async () => {
    const sourceRoot = resolve(walletNetwork().path, 'volumes', 'lnd', 'alice');
    const expectedSources = [
      join(sourceRoot, 'tls.cert'),
      join(sourceRoot, 'data', 'chain', 'bitcoin', 'regtest', 'invoices.macaroon'),
    ];
    fsMock.readFile.mockImplementation(async path => {
      if (expectedSources.includes(`${path}`)) return Buffer.from('credential');
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    await refreshWalletConfig(walletNetwork(), binding as any);
    const sources = fsMock.readFile.mock.calls
      .map(([path]) => `${path}`)
      .filter(path => path.startsWith(`${sourceRoot}${sep}`));
    expect(sources).toEqual(expectedSources);
    expect(sources.join()).not.toContain('admin.macaroon');
    expect(fsMock.mkdir).toHaveBeenCalledWith(
      join(paykitConfig.dataPath, 'paykit-credentials', envId, 'wallets', 'lnd-0-core-0'),
      { recursive: true, mode: 0o700 },
    );
    fsMock.rename.mockClear();
    const config = JSON.stringify({
      apiVersion: 1,
      environmentId: envId,
      wallets: walletBindings(walletNetwork()),
    });
    fsMock.readFile.mockImplementation(async path =>
      Buffer.from(`${path}`.endsWith('wallet-config.json') ? config : 'credential'),
    );
    await refreshWalletConfig(walletNetwork(), binding as any);
    expect(fsMock.rename).not.toHaveBeenCalled();
  });
  it('bakes explicit scoped authorizations without copying admin and reuses unchanged credentials', async () => {
    const admin = Buffer.from('test-private-admin');
    const restricted = Buffer.from('restricted-test-grant');
    (bakePaykitMacaroon as jest.Mock).mockResolvedValue(restricted);
    fsMock.readFile.mockImplementation(async path => {
      if (`${path}`.endsWith('admin.macaroon')) return admin;
      if (`${path}`.endsWith('tls.cert')) return Buffer.from('certificate');
      if (`${path}`.endsWith('payment.macaroon') || `${path}`.endsWith('setup.macaroon'))
        return restricted;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    await refreshWalletConfig(walletNetwork(), binding as any, 'lnd-0-core-0');
    expect(bakePaykitMacaroon).toHaveBeenCalledTimes(2);
    const writes = await Promise.all(
      fsMock.open.mock.results.map(result => result.value),
    );
    for (const handle of writes)
      for (const call of handle.writeFile?.mock.calls || [])
        expect(Buffer.from(call[0]).equals(admin)).toBe(false);
    expect(
      fsMock.rename.mock.calls.some(([, target]) =>
        `${target}`.endsWith('admin.macaroon'),
      ),
    ).toBe(false);
    await refreshWalletConfig(walletNetwork(), binding as any, 'lnd-0-core-0');
    expect(bakePaykitMacaroon).toHaveBeenCalledTimes(2);
  });
  it('selects exactly three stable IDs in the first eligible Core group', () => {
    const base = walletBindings(walletNetwork())[2];
    const wallets = [
      ...[9, 2, 1, 0].map(id => ({
        ...base,
        id: `lnd-${id}-core-3`,
        bitcoinBackendId: 'core-3',
      })),
      { ...base, id: 'lnd-7-core-0', bitcoinBackendId: 'core-0' },
    ];
    expect(fundingWalletIds(wallets)).toEqual([
      'lnd-0-core-3',
      'lnd-1-core-3',
      'lnd-2-core-3',
    ]);
    expect(() => fundingWalletIds(wallets.slice(0, 2))).toThrow('three LND');
  });
  it('rejects escaped or oversized credential files before copying', async () => {
    fsMock.realpath.mockImplementation(async path =>
      `${path}`.endsWith('tls.cert') ? '/other/network/tls.cert' : resolve(`${path}`),
    );
    await expect(refreshWalletConfig(walletNetwork(), binding as any)).rejects.toThrow(
      'escaped',
    );
    expect(fsMock.rename).not.toHaveBeenCalled();
    fsMock.realpath.mockImplementation(async path => resolve(`${path}`));
    fsMock.stat.mockResolvedValue({ isFile: () => true, size: 65537 } as any);
    await expect(refreshWalletConfig(walletNetwork(), binding as any)).rejects.toThrow(
      'Invalid',
    );
  });
  it('does not replace valid configuration if the atomic credential write fails', async () => {
    fsMock.open.mockRejectedValue(new Error('Storage unavailable'));
    await expect(refreshWalletConfig(walletNetwork(), binding as any)).rejects.toThrow(
      'Storage unavailable',
    );
    expect(fsMock.rename).not.toHaveBeenCalled();
  });
});

describe('Public payment projections', () => {
  it('recursively drops wallet credentials, private issuance data and injected objects', () => {
    const secret = { secret: 'hidden' };
    const resolution = {
      id: 'resolution',
      amountSats: '2100000000000000',
      version: '18446744073709551615',
      source: 'private',
      status: 'payable',
      endpoint: 'lnbcrt1public',
      preimage: 'hidden',
      lastError: secret,
    };
    const workspace = {
      receiverId: 'receiver',
      paymentMethods: {
        walletId: 'lnd-0-core-0',
        enabledMethods: ['btc-onchain', secret],
        preference: ['btc-onchain'],
        wallets: [
          {
            id: 'lnd-0-core-0',
            label: 'Alice',
            status: 'configured',
            supportedMethods: ['btc-onchain'],
            bitcoin: secret,
            lightning: secret,
          },
        ],
      },
      publicPaymentList: { id: 'list', reservationIds: ['reservation', secret], secret },
      reservations: [
        {
          id: 'reservation',
          amountSats: '2100000000000000',
          endpoint: 'bcrt1public',
          preimage: 'hidden',
          payloadHash: 'hidden',
          walletConfig: secret,
        },
      ],
      resolutions: [resolution],
    };
    const projected = publicOperation({
      id: 'operation',
      result: { receiverId: 'receiver', workspace, resolution, masterKey: 'hidden' },
    });
    expect(JSON.stringify(projected)).not.toContain('hidden');
    expect(projected.result?.resolution).toEqual({
      id: 'resolution',
      amountSats: '2100000000000000',
      version: '18446744073709551615',
      source: 'private',
      status: 'payable',
      endpoint: 'lnbcrt1public',
    });
    expect(projected.result?.workspace?.paymentMethods?.enabledMethods).toEqual([
      'btc-onchain',
    ]);
  });
});

it('projects request, execution, proof, settlement and funding separately without signing state', () => {
  const material = {
    method: 'btc-lightning-bolt11',
    paymentHash: 'a'.repeat(64),
    preimage: 'b'.repeat(64),
  };
  const workspace = {
    requests: [
      {
        id: 'request',
        lifecycle: 'proofSubmitted',
        amountSats: '2100000000000000',
        proposalExpiresAt: null,
        acceptedMethods: ['btc-onchain'],
        correlationSecret: 'hidden',
      },
    ],
    executions: [
      {
        id: 'execution',
        requestId: 'request',
        status: 'uncertain',
        txid: null,
        signedTransaction: 'hidden',
        selectedInputs: ['hidden'],
        preimage: 'hidden',
      },
    ],
    proofs: [
      { id: 'proof', requestId: 'request', proof: material, session: 'hidden' },
      { id: 'invalid', proof: { ...material, receiptKey: 'hidden' } },
    ],
    settlements: [
      {
        proofId: 'proof',
        requestId: 'request',
        status: 'pending',
        confirmations: 0,
        requiredConfirmations: 2,
        lastError: null,
        walletConfig: 'hidden',
      },
    ],
  };
  const funding = {
    status: 'ready',
    funded: true,
    step: 'verified',
    wallets: [
      {
        participant: 'Alice',
        walletId: 'wallet',
        onchainBalanceSats: '123',
        lightningBalanceSats: '456',
        macaroon: 'hidden',
      },
    ],
    channelPoints: ['public:0'],
    lastError: null,
    signingKey: 'hidden',
  };
  const result = publicOperation({ result: { workspace, funding } }).result!;
  expect(JSON.stringify(result)).not.toContain('hidden');
  expect(result.workspace?.requests[0].proposalExpiresAt).toBeNull();
  expect(result.workspace?.executions[0]).toEqual({
    id: 'execution',
    requestId: 'request',
    status: 'uncertain',
    txid: null,
  });
  expect(result.workspace?.proofs[0].proof).toEqual(material);
  expect(result.workspace?.proofs[1]).not.toHaveProperty('proof');
  expect(result.workspace?.settlements[0].status).toBe('pending');
  expect(result.funding?.wallets[0].onchainBalanceSats).toBe('123');
});

it('reports authorization preflight failure as unsubmitted before reading the service token', async () => {
  fsMock.readFile.mockImplementation(async path => {
    if (`${path}`.endsWith(`${sep}networks.json`))
      return JSON.stringify({ networks: [{ ...network(), paykit: binding }] });
    if (`${path}`.endsWith(`${sep}network-1.json`)) return JSON.stringify(binding);
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  await expect(
    paykitProxy({
      networkId: 1,
      action: 'command',
      request: { commandId: envId, command: 'preset.fund', input: {} },
    }),
  ).rejects.toThrow('Paykit command not submitted: The funded preset requires three LND');
  expect(
    fsMock.readFile.mock.calls.some(([path]) => `${path}`.endsWith(`${sep}api-token`)),
  ).toBe(false);
});

it('projects immutable endpoint bindings and rejects malformed request metadata', () => {
  const valid = {
    source: 'private',
    method: 'btc-onchain',
    endpoint: 'bcrt1bound',
    reservationId: envId,
  };
  const result = publicOperation({
    result: {
      workspace: {
        requests: [
          {
            id: 'request',
            acceptedMethods: ['btc-onchain'],
            endpointBindings: [
              valid,
              { ...valid, source: 'fallback' },
              { ...valid, endpoint: { secret: 'hidden' } },
              { ...valid, signingKey: 'hidden' },
              { ...valid, reservationId: 'bad' },
            ],
          },
          { id: 'old', endpointBindings: null },
        ],
      },
    },
  }).result!;
  expect(result.workspace?.requests[0].endpointBindings).toEqual([valid]);
  expect(result.workspace?.requests[1].endpointBindings).toEqual([]);
  expect(JSON.stringify(result)).not.toContain('hidden');
});

it('projects exact receipt DTOs in state and operation results without SDK records or scalar injection', () => {
  const hidden = { receiptKey: 'hidden', session: 'hidden', noiseSecretKey: 'hidden' };
  const issuance = {
    id: envId,
    requestId: 'request',
    proofId: 'proof',
    peerPublicKey: 'public',
    peerReceiverPath: 'bob/server',
    paymentReference: 'reference',
    method: 'btc-onchain',
    amountSats: '2100000000000000',
    description: 'Receipt',
    note: 'Note',
    status: 'stored',
    deliveryStatus: 'notQueued',
    accessEventId: 'event',
    outboundMessageId: '18446744073709551615',
    createdAt: 'created',
    updatedAt: 'updated',
    storedAt: 'stored',
    accessQueuedAt: null,
    lastError: null,
  };
  const access = {
    receiptId: envId,
    peerPublicKey: 'public',
    peerReceiverPath: 'bob/server',
    accessEventId: 'event',
    requestId: null,
    paymentReference: 'reference',
    retrievalStatus: 'failed',
    receivedAt: 'received',
    attemptedAt: 'attempted',
    retrievedAt: null,
    lastError: 'Receipt does not match the known request.',
  };
  const receipt = {
    id: envId,
    issuerPublicKey: 'public',
    issuerReceiverPath: 'bob/server',
    recipientPublicKey: 'recipient',
    requestId: null,
    proofId: null,
    paymentReference: 'reference',
    method: null,
    amountSats: null,
    description: null,
    note: null,
    accessEventId: 'event',
    retrievedAt: 'retrieved',
  };
  const extras = {
    ...hidden,
    location: 'hidden',
    key: 'hidden',
    receipt_access_key_hash: 'hidden',
    encrypted_receipt: hidden,
    access_json: hidden,
    metadata: hidden,
    rawMessage: hidden,
  };
  const workspace = {
    receiverId: 'receiver',
    receiptIssuances: [
      { ...issuance, ...extras },
      { ...issuance, description: hidden, outboundMessageId: 123 },
    ],
    receiptAccess: [
      { ...access, ...extras },
      { ...access, lastError: hidden, requestId: hidden },
    ],
    receipts: [
      { ...receipt, ...extras },
      { ...receipt, note: hidden, method: hidden, amountSats: hidden },
    ],
  };
  const raw = {
    ...binding,
    participants: [],
    receivers: [],
    operations: [],
    receiverWorkspaces: [workspace],
  };
  const result = publicOperation({ result: { receiptId: envId, workspace, ...extras } })
    .result!;
  const projected = publicState(raw, envId);
  for (const current of [result.workspace!, projected.receiverWorkspaces[0]]) {
    expect(JSON.stringify(current)).not.toContain('hidden');
    expect(current.receiptIssuances[0]).toEqual(issuance);
    expect(current.receiptAccess[0]).toEqual(access);
    expect(current.receipts[0]).toEqual(receipt);
    expect(current.receiptIssuances[1]).not.toHaveProperty('description');
    expect(current.receiptIssuances[1]).not.toHaveProperty('outboundMessageId');
    expect(current.receiptAccess[1]).not.toHaveProperty('lastError');
    expect(current.receipts[1]).not.toHaveProperty('note');
  }
  expect(result).toHaveProperty('receiptId', envId);
  expect(publicOperation({ result: { receiptId: 123 } }).result).not.toHaveProperty(
    'receiptId',
  );
  expect(JSON.stringify(result)).not.toContain('hidden');
});

it('projects recurring state through state and operation results without nested SDK secrets', () => {
  const hidden = {
    session: 'hidden-secret',
    noiseKey: 'hidden-secret',
    receiptKey: 'hidden-secret',
  };
  const billingPeriod = {
    startsAt: '2099-01-31T00:00:00Z',
    endsAt: '2099-02-28T00:00:00Z',
  };
  const binding = {
    source: 'private',
    method: 'btc-onchain',
    endpoint: 'bcrt1period',
    reservationId: envId,
  };
  const recurrence = {
    every: 1,
    unit: 'month',
    startsAt: billingPeriod.startsAt,
    anchor: billingPeriod.startsAt,
    endsAt: null,
  };
  const workspace = {
    receiverId: envId,
    applicationClock: { mode: 'controlled', now: billingPeriod.endsAt, ...hidden },
    requests: [
      {
        id: envId,
        recurrence: { ...recurrence, ...hidden },
        acceptedMethods: ['btc-onchain'],
        endpointBindings: [],
      },
    ],
    subscriptions: [
      {
        requestId: envId,
        currentPeriodIndex: 1,
        ...hidden,
        autopay: {
          enabled: true,
          walletId: 'wallet',
          source: 'private',
          method: 'btc-onchain',
          status: 'waiting',
          lastError: null,
          ...hidden,
        },
        periods: [
          {
            index: 0,
            ...billingPeriod,
            status: 'prepared',
            offerId: envId,
            executionId: null,
            proofId: null,
            lastError: null,
            endpointBindings: [binding, { ...binding, ...hidden }],
            offer: hidden,
            encryptedOffer: hidden,
          },
        ],
      },
    ],
    executions: [
      { id: envId, periodIndex: 0, billingPeriod: { ...billingPeriod, ...hidden } },
    ],
    proofs: [
      {
        id: envId,
        periodIndex: 0,
        billingPeriod: { ...billingPeriod, ...hidden },
        proof: { method: 'btc-onchain', txid: 'a'.repeat(64), outputIndex: 0 },
      },
    ],
    settlements: [{ periodIndex: 0, billingPeriod: { ...billingPeriod, ...hidden } }],
    receiptIssuances: [{ id: envId, billingPeriod: { ...billingPeriod, ...hidden } }],
    receiptAccess: [{ receiptId: envId, billingPeriod: { ...billingPeriod, ...hidden } }],
    receipts: [{ id: envId, billingPeriod: { ...billingPeriod, ...hidden } }],
  };
  const state = publicState(
    {
      apiVersion: 1,
      environmentId: envId,
      participants: [],
      receivers: [],
      operations: [],
      receiverWorkspaces: [workspace],
    },
    envId,
  );
  const operation = publicOperation({ result: { workspace } });
  for (const projected of [state.receiverWorkspaces[0], operation.result!.workspace!]) {
    expect(JSON.stringify(projected)).not.toContain('hidden-secret');
    expect(projected.applicationClock).toEqual({
      mode: 'controlled',
      now: billingPeriod.endsAt,
    });
    expect(projected.requests[0].recurrence).toEqual(recurrence);
    expect(projected.subscriptions[0].periods[0].endpointBindings).toEqual([binding]);
    expect(projected.subscriptions[0].autopay.enabled).toBe(true);
    for (const key of [
      'executions',
      'proofs',
      'settlements',
      'receiptIssuances',
      'receiptAccess',
      'receipts',
    ] as const)
      expect(projected[key][0].billingPeriod).toEqual(billingPeriod);
    expect(projected.proofs[0].periodIndex).toBe(0);
  }
  const malformed = publicOperation({
    result: {
      workspace: {
        applicationClock: { mode: 'controlled', now: hidden },
        subscriptions: [
          { autopay: { walletId: hidden }, periods: [{ endpointBindings: [hidden] }] },
        ],
        receipts: [{ billingPeriod: { startsAt: hidden, endsAt: hidden } }],
      },
    },
  }).result!.workspace!;
  expect(malformed).not.toHaveProperty('applicationClock');
  expect(malformed.receipts[0].billingPeriod).toBeNull();
  expect(malformed.subscriptions[0].periods[0].endpointBindings).toEqual([]);
  expect(JSON.stringify(malformed)).not.toContain('hidden-secret');
});

it('projects only valid compact endpoint commitments and preserves absent versus invalid fields', () => {
  const commitment = {
    source: 'private',
    method: 'btc-lightning-bolt11',
    reservationId: envId,
    endpointHash: 'a'.repeat(64),
  };
  const hidden = { sessionKey: 'hidden-secret', receiptKey: 'hidden-secret' };
  const periods = [
    {
      endpointBindings: [],
      endpointCommitments: [
        commitment,
        { ...commitment, ...hidden },
        { ...commitment, endpointHash: 'A'.repeat(64) },
        { ...commitment, endpointHash: 'a'.repeat(63) },
        { ...commitment, endpointHash: hidden },
        { ...commitment, reservationId: hidden },
      ],
    },
    { endpointBindings: [], endpointCommitments: hidden },
    { endpointBindings: [] },
  ];
  const workspace = {
    receiverId: envId,
    subscriptions: [{ requestId: envId, autopay: {}, periods }],
  };
  const projected = publicOperation({ result: { workspace } }).result!.workspace!
    .subscriptions[0].periods;
  expect(projected[0].endpointCommitments).toEqual([commitment]);
  expect(projected[1].endpointCommitments).toEqual([]);
  expect(projected[2]).not.toHaveProperty('endpointCommitments');
  expect(JSON.stringify(projected)).not.toContain('hidden-secret');
});
