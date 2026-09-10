import os from 'os';
import { CLightningNode, LitdNode, LndNode, TapdNode } from 'shared/types';
import { bitcoinCredentials, defaultRepoState } from 'utils/constants';
import { createNetwork } from 'utils/network';
import { testManagedImages } from 'utils/tests';
import ComposeFile from './composeFile';

jest.mock('os');

const mockOS = os as jest.Mocked<typeof os>;

describe('ComposeFile', () => {
  let composeFile = new ComposeFile(1);
  const network = createNetwork({
    id: 1,
    name: 'test network',
    description: 'network description',
    lndNodes: 1,
    clightningNodes: 1,
    eclairNodes: 1,
    bitcoindNodes: 1,
    tapdNodes: 1,
    litdNodes: 1,
    repoState: defaultRepoState,
    managedImages: testManagedImages,
    customImages: [],
    manualMineCount: 6,
  });
  const btcNode = network.nodes.bitcoin[0];
  const lndNode = network.nodes.lightning[0] as LndNode;
  const clnNode = network.nodes.lightning[1] as CLightningNode;
  const litdNode = network.nodes.lightning[3] as LitdNode;
  const tapNode = network.nodes.tap[0] as TapdNode;

  beforeEach(() => {
    composeFile = new ComposeFile(1);
    mockOS.platform.mockReturnValue('darwin');
  });

  it('should have no services initially', () => {
    expect(composeFile.content.services).toEqual({});
  });

  it('should have a name', () => {
    expect(composeFile.content.name).toEqual('polar-paykit-network-1');
  });

  it('should add multiple services', () => {
    composeFile.addBitcoind(btcNode);
    composeFile.addLnd(lndNode, btcNode);
    composeFile.addSimln(1);
    expect(Object.keys(composeFile.content.services).length).toEqual(3);
  });

  it('should add a bitcoind config', () => {
    composeFile.addBitcoind(btcNode);
    expect(composeFile.content.services['backend1']).not.toBeUndefined();
  });

  it('should create the correct bitcoind docker compose values', () => {
    composeFile.addBitcoind(btcNode);
    const service = composeFile.content.services['backend1'];
    expect(service.image).toContain('bitcoind');
    expect(service.container_name).toEqual('polar-paykit-n1-backend1');
    expect(service.command).toContain(bitcoinCredentials.user);
    expect(service.volumes[0]).toContain('/backend1:');
  });

  it('should use the bitcoind nodes docker data', () => {
    btcNode.docker = { image: 'my-image', command: 'my-command' };
    composeFile.addBitcoind(btcNode);
    const service = composeFile.content.services['backend1'];
    expect(service.image).toBe('my-image');
    expect(service.command).toBe('my-command');
  });

  it('should add an lnd config', () => {
    composeFile.addLnd(lndNode, btcNode);
    expect(composeFile.content.services['alice']).not.toBeUndefined();
  });

  it('should create the correct lnd docker compose values', () => {
    composeFile.addLnd(lndNode, btcNode);
    const service = composeFile.content.services['alice'];
    expect(service.image).toContain('lnd');
    expect(service.container_name).toEqual('polar-paykit-n1-alice');
    expect(service.command).toContain('backend');
    expect(service.volumes[0]).toContain('/alice:');
  });

  it('should use the lnd nodes docker data', () => {
    lndNode.docker = { image: 'my-image', command: 'my-command' };
    composeFile.addLnd(lndNode, btcNode);
    const service = composeFile.content.services['alice'];
    expect(service.image).toBe('my-image');
    expect(service.command).toBe('my-command');
  });

  it('should add an c-lightning config', () => {
    composeFile.addClightning(clnNode, btcNode);
    expect(composeFile.content.services['bob']).not.toBeUndefined();
  });

  it('should create the correct c-lightning docker compose values on non-Windows', () => {
    mockOS.platform.mockReturnValue('darwin');
    composeFile.addClightning(clnNode, btcNode);
    const service = composeFile.content.services['bob'];
    expect(service.image).toContain('clightning');
    expect(service.container_name).toEqual('polar-paykit-n1-bob');
    expect(service.command).toContain('backend');
    expect(service.volumes[0]).toContain('/bob/lightningd:');
  });

  it('should create the correct c-lightning docker compose values on Windows', () => {
    mockOS.platform.mockReturnValue('win32');
    composeFile.addClightning(clnNode, btcNode);
    const service = composeFile.content.services['bob'];
    expect(service.image).toContain('clightning');
    expect(service.container_name).toEqual('polar-paykit-n1-bob');
    expect(service.command).toContain('backend');
    expect(service.volumes[0]).toContain('polar-paykit-n1-bob:');
    expect(composeFile.content.volumes).toHaveProperty('polar-paykit-n1-bob');
  });

  it('should have the grpc port for c-lightning', () => {
    composeFile.addClightning(clnNode, btcNode);
    const service = composeFile.content.services['bob'];
    expect(service.command).toContain('--grpc-port');
  });

  it('should not have the grpc port for c-lightning', () => {
    clnNode.version = '0.10.1';
    clnNode.ports.grpc = 0;
    composeFile.addClightning(clnNode, btcNode);
    const service = composeFile.content.services['bob'];
    expect(service.command).not.toContain('--grpc-port');
  });

  it('should use the c-lightning nodes docker data', () => {
    clnNode.docker = { image: 'my-image', command: 'my-command' };
    composeFile.addClightning(clnNode, btcNode);
    const service = composeFile.content.services['bob'];
    expect(service.image).toBe('my-image');
    expect(service.command).toBe('my-command');
  });

  it('should add an tap config', () => {
    composeFile.addTapd(tapNode, lndNode);
    expect(composeFile.content.services['alice-tap']).not.toBeUndefined();
  });

  it('should create the correct tapd docker compose values', () => {
    composeFile.addTapd(tapNode, lndNode);
    const service = composeFile.content.services['alice-tap'];
    expect(service.image).toContain('tapd');
    expect(service.container_name).toEqual('polar-paykit-n1-alice-tap');
    expect(service.command).toContain('lnd.host=polar-paykit-n1-alice');
    expect(service.volumes[0]).toContain('/alice:');
    expect(service.volumes[1]).toContain('/alice-tap:');
  });

  it('should use the tapd nodes custom docker data', () => {
    const tap = {
      ...tapNode,
      docker: { image: 'my-image', command: 'my-command' },
    };
    composeFile.addTapd(tap, lndNode);
    const service = composeFile.content.services['alice-tap'];
    expect(service.image).toBe('my-image');
    expect(service.command).toBe('my-command');
  });

  it('should use the correct command for tapd v3', () => {
    const tap = { ...tapNode, version: '0.3.3' };
    composeFile.addTapd(tap, lndNode);
    const service = composeFile.content.services['alice-tap'];
    expect(service.command).toContain('--universe.public-access');
    expect(service.command).not.toContain('--universe.public-access=rw');
    expect(service.command).not.toContain('--universe.sync-all-assets');
  });

  it('should use the correct command for tapd v4+', () => {
    const tap = { ...tapNode, version: '0.4.0' };
    composeFile.addTapd(tap, lndNode);
    const service = composeFile.content.services['alice-tap'];
    expect(service.command).toContain('--universe.public-access=rw');
    expect(service.command).toContain('--universe.sync-all-assets');
  });

  it('should add an litd config', () => {
    composeFile.addLitd(litdNode, btcNode, litdNode);
    expect(composeFile.content.services['dave']).not.toBeUndefined();
  });

  it('should create the correct litd docker compose values', () => {
    composeFile.addLitd(litdNode, btcNode, litdNode);
    const service = composeFile.content.services['dave'];
    expect(service.image).toContain('litd');
    expect(service.container_name).toEqual('polar-paykit-n1-dave');
    expect(service.command).toContain('lnd.bitcoind.rpchost=polar-paykit-n1-backend1');
    expect(service.volumes[0]).toContain('/dave/lit:');
    expect(service.volumes[1]).toContain('/dave/lnd:');
    expect(service.volumes[2]).toContain('/dave/tapd:');
  });

  it('should use the tapd nodes custom docker data', () => {
    litdNode.docker = { image: 'my-image', command: 'my-command' };
    composeFile.addLitd(litdNode, btcNode, litdNode);
    const service = composeFile.content.services['dave'];
    expect(service.image).toBe('my-image');
    expect(service.command).toBe('my-command');
  });

  it('should add a simln config', () => {
    composeFile.addSimln(1);
    expect(composeFile.content.services['simln']).not.toBeUndefined();
  });

  it('should create the correct simln docker compose values', () => {
    composeFile.addSimln(1);
    const service = composeFile.content.services['simln'];
    expect(service.image).toContain('simln');
    expect(service.container_name).toEqual('polar-paykit-n1-simln');
    expect(service.command).toBe('');
  });

  it('should not reinitialize volumes when adding multiple c-lightning nodes on Windows', () => {
    mockOS.platform.mockReturnValue('win32');
    composeFile.addClightning(clnNode, btcNode);
    const secondClnNode = { ...clnNode, name: 'carol' };
    composeFile.addClightning(secondClnNode as CLightningNode, btcNode);
    expect(composeFile.content.volumes).toHaveProperty('polar-paykit-n1-bob');
    expect(composeFile.content.volumes).toHaveProperty('polar-paykit-n1-carol');
  });
});

describe('Paykit compose isolation', () => {
  it('publishes only the authenticated loopback API and keeps credentials outside exports', () => {
    const file = new ComposeFile(9);
    file.addPaykit(9, {
      apiVersion: 1,
      environmentId: '9b03a782-e2f3-4b7a-8ef5-429628921ee2',
      servicePort: 30099,
    });
    const { paykit, 'paykit-postgres': database } = file.content.services;
    expect(paykit.container_name).toBe('polar-paykit-n9-paykit');
    expect(paykit.ports).toEqual(['127.0.0.1:30099:10090']);
    expect(database.ports).toEqual([]);
    expect(paykit.user).toBe('${PAYKIT_UID:-1000}:${PAYKIT_GID:-1000}');
    expect(database.user).toBe(paykit.user);
    expect(paykit.volumes).toContain('./volumes/paykit:/data');
    expect(database.volumes).toContain('./volumes/paykit-postgres:/var/lib/postgresql');
    expect(
      paykit.volumes.some(
        v => v.includes('paykit-credentials/') && v.endsWith(':/run/paykit:ro'),
      ),
    ).toBe(true);
    expect(database.environment?.POSTGRES_PASSWORD_FILE).toBe(
      '/run/paykit/postgres-password',
    );
    expect(database.environment?.POSTGRES_PASSWORD).toBeUndefined();
    expect(paykit.environment?.PAYKIT_WALLET_CONFIG_FILE).toBe(
      '/run/paykit/wallet-config.json',
    );
    expect(paykit.volumes).not.toEqual(
      expect.arrayContaining([expect.stringContaining('/volumes/lnd')]),
    );
    expect(paykit.depends_on).toEqual({
      'paykit-postgres': { condition: 'service_healthy' },
    });
    const other = new ComposeFile(10);
    other.addPaykit(10, {
      apiVersion: 1,
      environmentId: '95588681-99e2-46f2-8245-d042fa07a962',
      servicePort: 30100,
    });
    expect(other.content.name).not.toEqual(file.content.name);
    expect(other.content.services.paykit.container_name).not.toEqual(
      paykit.container_name,
    );
    expect(other.content.services.paykit.volumes[1]).not.toEqual(paykit.volumes[1]);
  });
  it('refuses to overwrite an existing node with a reserved service name', () => {
    const file = new ComposeFile(9);
    file.content.services.paykit = { image: 'existing' } as any;
    expect(() =>
      file.addPaykit(9, { apiVersion: 1, environmentId: 'id', servicePort: 30099 }),
    ).toThrow('reserved');
    expect(file.content.services.paykit.image).toBe('existing');
  });
});
