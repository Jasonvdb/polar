import { createHash, randomBytes } from 'crypto';
import { constants as fsConstants } from 'fs';
import { promises as fs } from 'fs';
import { request as httpRequest } from 'http';
import { createServer } from 'net';
import { join, resolve, relative, isAbsolute } from 'path';
import { dialog } from 'electron';
import {
  isUuid,
  isPaykitUtcInstant,
  isPaykitEndpointCommitment,
  isPaykitRequestEndpointBinding,
  safePaykitAvatar,
  newPaykitId,
  PaykitEnvironment,
  PaykitRequest,
  PaykitTransfer,
  PaykitTransferRequest,
  validatePaykitCommand,
  validatePaykitProof,
} from '../src/shared/paykitApi';
import { bitcoinCredentials } from '../src/shared/bitcoinConfig';
import { getNamespacedContainerName, paykitConfig } from '../src/shared/paykitConfig';

import {
  bakePaykitMacaroon,
  paymentPermissions,
  setupPermissions,
} from './paykitWalletAuth';

const credentialsRoot = () => join(paykitConfig.dataPath, 'paykit-credentials');
const referencePath = (networkId: number) =>
  join(credentialsRoot(), `network-${networkId}.json`);

const checkPort = (port: number): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () =>
      reject(
        new Error(
          `Paykit port ${port} is unavailable. Stop the conflicting service before starting this network.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

async function getNetwork(networkId: number) {
  if (!Number.isSafeInteger(networkId) || networkId < 1)
    throw new Error('Invalid network ID');
  const file = JSON.parse(
    await fs.readFile(join(paykitConfig.dataPath, 'networks', 'networks.json'), 'utf8'),
  );
  const network = file.networks.find((n: { id: number }) => n.id === networkId);
  if (
    !network ||
    resolve(network.path) !== resolve(paykitConfig.dataPath, 'networks', `${networkId}`)
  ) {
    throw new Error('Unknown or invalid Paykit network');
  }
  return network;
}

async function getBinding(networkId: number): Promise<PaykitEnvironment> {
  const binding = JSON.parse(await fs.readFile(referencePath(networkId), 'utf8'));
  if (
    binding.apiVersion !== 1 ||
    !isUuid(binding.environmentId) ||
    !Number.isSafeInteger(binding.servicePort) ||
    binding.servicePort < 1024 ||
    binding.servicePort > 65535
  ) {
    throw new Error('Invalid Paykit environment binding');
  }
  return {
    apiVersion: 1,
    environmentId: binding.environmentId,
    servicePort: binding.servicePort,
  };
}

async function writeCredential(path: string, value: string | Buffer) {
  const file = await fs.open(path, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  // Windows does not support opening directory handles through Node's fs API.
  if (process.platform === 'win32') return;
  const directory = await fs.open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// Serialize provisioning so double clicks cannot create different identities for one network.
let provisioning = Promise.resolve();
async function provision(networkId: number): Promise<PaykitEnvironment> {
  let result: PaykitEnvironment | undefined;
  const pending = provisioning.then(async () => {
    try {
      result = await getBinding(networkId);
      return;
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
    const network = await getNetwork(networkId);
    if (network.paykit)
      throw new Error(
        'Paykit credentials are missing. Recovery is required; a new identity will not be created.',
      );
    const file = JSON.parse(
      await fs.readFile(join(paykitConfig.dataPath, 'networks', 'networks.json'), 'utf8'),
    );
    const assigned = new Set<number>(
      file.networks.flatMap((n: any) => [
        ...(n.paykit ? [n.paykit.servicePort] : []),
        ...Object.values(n.nodes).flatMap((nodes: any) =>
          nodes.flatMap((node: any) => Object.values(node.ports)),
        ),
      ]),
    );
    await fs.mkdir(credentialsRoot(), { recursive: true, mode: 0o700 });
    for (const filename of await fs.readdir(credentialsRoot())) {
      const match = /^network-([0-9]+)\.json$/.exec(filename);
      if (match) assigned.add((await getBinding(Number(match[1]))).servicePort);
    }
    let servicePort = 10090 + paykitConfig.portOffset + networkId;
    while (servicePort <= 65535) {
      if (!assigned.has(servicePort)) {
        try {
          await checkPort(servicePort);
          break;
        } catch {
          /* try the next free port */
        }
      }
      servicePort++;
    }
    if (servicePort > 65535) throw new Error('No available Paykit service port');
    result = { apiVersion: 1, environmentId: newPaykitId(), servicePort };
    const dir = join(credentialsRoot(), result.environmentId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of ['master-key', 'api-token', 'postgres-password']) {
      await writeCredential(join(dir, name), randomBytes(32).toString('hex'));
    }
    await syncDirectory(dir);
    await writeCredential(referencePath(networkId), JSON.stringify(result));
    await syncDirectory(credentialsRoot());
  });
  provisioning = pending.catch(() => undefined);
  await pending;
  return result!;
}

interface WalletBinding {
  id: string;
  bitcoinBackendId: string;
  label: string;
  bitcoin: { url: string; username: string; password: string };
  lightning?: {
    url: string;
    tlsCertPath: string;
    macaroonPath: string;
    paymentMacaroonPath: string;
    setupMacaroonPath: string;
    peerAddress: string;
  };
}
/** Derive trusted endpoints from persisted local nodes, never from command input. */
export function walletBindings(network: any): WalletBinding[] {
  const bitcoin = network.nodes?.bitcoin;
  const lightning = network.nodes?.lightning;
  if (!Array.isArray(bitcoin) || !Array.isArray(lightning))
    throw new Error('Invalid Paykit wallet nodes');
  const names = new Set<string>();
  for (const nodes of [bitcoin, lightning]) {
    const ids = new Set<number>();
    for (const node of nodes) {
      if (
        !Number.isSafeInteger(node.id) ||
        node.id < 0 ||
        ids.has(node.id) ||
        node.networkId !== network.id ||
        typeof node.name !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(node.name) ||
        names.has(node.name)
      )
        throw new Error('Invalid Paykit wallet node identity');
      names.add(node.name);
      ids.add(node.id);
    }
  }
  const core = bitcoin.filter(node => node.implementation === 'bitcoind');
  const coreConfig = (node: any) => ({
    url: `http://${getNamespacedContainerName(network.id, node.name)}:18443`,
    username: bitcoinCredentials.user,
    password: bitcoinCredentials.pass,
  });
  const wallets: WalletBinding[] = core.map(node => ({
    id: `core-${node.id}`,
    bitcoinBackendId: `core-${node.id}`,
    label: `Bitcoin / ${node.name}`,
    bitcoin: coreConfig(node),
  }));
  for (const node of lightning.filter(node => node.implementation === 'LND')) {
    const backend = core.find(item => item.name === node.backendName);
    if (!backend) continue;
    const id = `lnd-${node.id}-core-${backend.id}`;
    wallets.push({
      id,
      bitcoinBackendId: `core-${backend.id}`,
      label: `Lightning / ${node.name} + Bitcoin / ${backend.name}`,
      bitcoin: coreConfig(backend),
      lightning: {
        url: `https://${getNamespacedContainerName(network.id, node.name)}:8080`,
        tlsCertPath: `/run/paykit/wallets/${id}/tls.cert`,
        macaroonPath: `/run/paykit/wallets/${id}/invoices.macaroon`,
        paymentMacaroonPath: `/run/paykit/wallets/${id}/payment.macaroon`,
        setupMacaroonPath: `/run/paykit/wallets/${id}/setup.macaroon`,
        peerAddress: `${getNamespacedContainerName(network.id, node.name)}:9735`,
      },
    });
  }
  return wallets;
}
async function replaceCredential(path: string, value: Buffer | string) {
  try {
    if ((await fs.readFile(path)).equals(Buffer.from(value))) return;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${newPaykitId()}.tmp`;
  try {
    await writeCredential(temporary, value);
    await fs.rename(temporary, path);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
const authorizedWallets = new Map<string, string>();

async function readWalletCredential(network: any, source: string) {
  const real = await fs.realpath(source);
  const networkRoot = await fs.realpath(network.path);
  const within = relative(networkRoot, real);
  if (
    within.startsWith('..') ||
    isAbsolute(within) ||
    real !== resolve(networkRoot, relative(network.path, source))
  )
    throw new Error('Paykit wallet credential escaped its network');
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > 65536)
    throw new Error('Invalid Paykit wallet credential file');
  return fs.readFile(real);
}

// Routine polls refresh receiving credentials. Spending/setup authorizations are baked
// only for an explicit payment or funded-preset command, never during state polling.
export function fundingWalletIds(wallets: WalletBinding[]): string[] {
  const backends = [
    ...new Set(
      wallets.filter(wallet => wallet.lightning).map(wallet => wallet.bitcoinBackendId),
    ),
  ].sort();
  for (const backend of backends) {
    const ids = wallets
      .filter(wallet => wallet.lightning && wallet.bitcoinBackendId === backend)
      .map(wallet => wallet.id)
      .sort();
    if (ids.length >= 3) return ids.slice(0, 3);
  }
  throw new Error(
    'The funded preset requires three LND nodes sharing a Bitcoin Core backend',
  );
}

export async function refreshWalletConfig(
  network: any,
  binding: PaykitEnvironment,
  authorizeWalletId?: string,
) {
  const wallets = walletBindings(network);
  const root = join(credentialsRoot(), binding.environmentId);
  const authorize = new Set(
    authorizeWalletId === '*'
      ? fundingWalletIds(wallets)
      : authorizeWalletId
      ? [authorizeWalletId]
      : [],
  );
  const authorizationJobs: (() => Promise<void>)[] = [];
  for (const wallet of wallets) {
    if (!wallet.lightning) continue;
    const node = network.nodes.lightning.find((item: any) =>
      wallet.id.startsWith(`lnd-${item.id}-core-`),
    );
    const sourceRoot = join(network.path, 'volumes', 'lnd', node.name);
    const targetRoot = join(root, 'wallets', wallet.id);
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    for (const [name, source] of [
      ['tls.cert', join(sourceRoot, 'tls.cert')],
      [
        'invoices.macaroon',
        join(sourceRoot, 'data', 'chain', 'bitcoin', 'regtest', 'invoices.macaroon'),
      ],
    ]) {
      try {
        await replaceCredential(
          join(targetRoot, name),
          await readWalletCredential(network, source),
        );
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        // A removed credential must not leave an old authorization copy in use.
        await fs.rm(join(targetRoot, name), { force: true });
      }
    }
    if (authorize.has(wallet.id))
      authorizationJobs.push(async () => {
        const admin = await readWalletCredential(
          network,
          join(sourceRoot, 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon'),
        );
        const cert = await readWalletCredential(network, join(sourceRoot, 'tls.cert'));
        const fingerprint = createHash('sha256')
          .update(admin)
          .update(cert)
          .update(JSON.stringify([paymentPermissions, setupPermissions]))
          .digest('hex');
        let credentialsExist = false;
        try {
          credentialsExist =
            (await fs.readFile(join(targetRoot, 'payment.macaroon'))).length > 0 &&
            (await fs.readFile(join(targetRoot, 'setup.macaroon'))).length > 0;
        } catch (_) {
          /* Bake missing restricted grants. */
        }
        if (authorizedWallets.get(targetRoot) !== fingerprint || !credentialsExist) {
          const grants = await Promise.allSettled([
            bakePaykitMacaroon(node.ports?.rest, cert, admin, paymentPermissions),
            bakePaykitMacaroon(node.ports?.rest, cert, admin, setupPermissions),
          ]);
          const payment = grants[0];
          const setup = grants[1];
          if (payment.status === 'rejected' || setup.status === 'rejected')
            throw new Error('Local LND authorization is unavailable');
          await replaceCredential(join(targetRoot, 'payment.macaroon'), payment.value);
          await replaceCredential(join(targetRoot, 'setup.macaroon'), setup.value);
          await syncDirectory(targetRoot);
          authorizedWallets.set(targetRoot, fingerprint);
        }
      });
    await syncDirectory(targetRoot);
  }
  const authorizations = await Promise.allSettled(authorizationJobs.map(run => run()));
  const failed = authorizations.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  await replaceCredential(
    join(root, 'wallet-config.json'),
    JSON.stringify({
      apiVersion: 1,
      environmentId: binding.environmentId,
      wallets,
    }),
  );
  await syncDirectory(root);
}
let walletRefresh = Promise.resolve();
const refreshWallets = (
  network: any,
  binding: PaykitEnvironment,
  authorizeWalletId?: string,
) => {
  const pending = walletRefresh.then(() =>
    refreshWalletConfig(network, binding, authorizeWalletId),
  );
  walletRefresh = pending.catch(() => undefined);
  return pending;
};

/** Finite, authenticated requests. Only fixed loopback paths and public payloads are accepted. */
export async function callService(
  binding: PaykitEnvironment,
  path: string,
  body?: unknown,
): Promise<any> {
  const token = await fs.readFile(
    join(credentialsRoot(), binding.environmentId, 'api-token'),
    'utf8',
  );
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid Paykit API credential');
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: binding.servicePort,
        path,
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      },
      res => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            reject(new Error('Paykit response exceeded size limit'));
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('Paykit service response interrupted')));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `Paykit service rejected the request (HTTP ${res.statusCode || 0})`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Invalid Paykit service response'));
          }
        });
      },
    );
    const timeout = setTimeout(() => {
      reject(new Error('Paykit service request timed out'));
      req.destroy();
    }, 5000);
    req.once('close', () => clearTimeout(timeout));
    req.on('error', () =>
      reject(
        new Error(
          'Paykit service is unavailable. Start the network or check its service logs.',
        ),
      ),
    );
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const MAX_BACKUP_BYTES = 24 * 1024 * 1024;
const exportDestinations = new Map<string, { path: string; expiresAt: number }>();
const uuidBytes = (value: string) => {
  if (!isUuid(value) || value !== value.toLowerCase())
    throw new Error('Invalid Paykit receiver ID');
  return Buffer.from(value.replace(/-/g, ''), 'hex');
};
const transferPath = (transferId: string, suffix = '') => {
  if (
    !isUuid(transferId) ||
    transferId !== transferId.toLowerCase() ||
    transferId[14] !== '4'
  )
    throw new Error('Invalid Paykit transfer ID');
  return `/v1/transfers/${transferId}${suffix}`;
};
async function callTransfer(
  binding: PaykitEnvironment,
  method: 'POST' | 'GET' | 'DELETE',
  path: string,
  body?: Buffer,
): Promise<{ body: Buffer; contentType?: string }> {
  const token = await fs.readFile(
    join(credentialsRoot(), binding.environmentId, 'api-token'),
    'utf8',
  );
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid Paykit API credential');
  return new Promise((resolveRequest, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: binding.servicePort,
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body
            ? {
                'Content-Type': 'application/octet-stream',
                'Content-Length': body.length,
              }
            : {}),
        },
      },
      res => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BACKUP_BYTES) {
            reject(new Error('Paykit transfer response exceeded size limit'));
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('Paykit transfer response interrupted')));
        res.on('end', () => {
          const response = Buffer.concat(chunks);
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            let code = 'transfer_invalid';
            try {
              const parsed = JSON.parse(response.toString('utf8'));
              if (typeof parsed?.error?.code === 'string')
                code = parsed.error.code.slice(0, 64);
            } catch (_) {}
            reject(new Error(`Paykit transfer failed: ${code}`));
            return;
          }
          resolveRequest({
            body: response,
            contentType: `${res.headers['content-type'] || ''}`,
          });
        });
      },
    );
    const timeout = setTimeout(() => {
      reject(new Error('Paykit transfer timed out'));
      req.destroy();
    }, 30000);
    req.once('close', () => clearTimeout(timeout));
    req.on('error', () =>
      reject(
        new Error(
          'Paykit service is unavailable. Start the network or check its service logs.',
        ),
      ),
    );
    req.end(body);
  });
}
export async function regularArchive(path: string): Promise<Buffer> {
  let handle;
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BACKUP_BYTES)
      throw new Error('Backup must be a regular file no larger than 24 MiB');
    handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size !== stat.size ||
      current.mtimeMs !== stat.mtimeMs
    )
      throw new Error('Backup file changed while opening');
    if (current.size > MAX_BACKUP_BYTES)
      throw new Error('Backup must be a regular file no larger than 24 MiB');

    const chunks: Buffer[] = [];
    const readLimit = Math.min(MAX_BACKUP_BYTES + 1, current.size + 1);
    let size = 0;
    while (size < readLimit) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }
    if (size > current.size) throw new Error('Backup file changed while reading');

    const final = await handle.stat();
    if (
      !final.isFile() ||
      final.dev !== current.dev ||
      final.ino !== current.ino ||
      final.size !== current.size ||
      final.mtimeMs !== current.mtimeMs ||
      size !== current.size
    )
      throw new Error('Backup file changed while reading');
    return Buffer.concat(chunks, size);
  } catch (error: any) {
    if (
      error?.message === 'Backup must be a regular file no larger than 24 MiB' ||
      error?.message === 'Backup file changed while opening' ||
      error?.message === 'Backup file changed while reading'
    )
      throw error;
    throw new Error('Unable to read the selected backup file');
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_) {}
    }
  }
}
export function frameTransfer(
  purpose: 1 | 2,
  receiverId: string,
  passphrase: string,
  archive: Buffer,
) {
  const password = Buffer.from(passphrase, 'utf8');
  if (password.length < 12 || password.length > 1024) {
    password.fill(0);
    throw new Error('Passphrase must be 12 to 1024 UTF-8 bytes');
  }
  const header = Buffer.alloc(28);
  header.write('PKTR');
  header[4] = 1;
  header[5] = purpose;
  uuidBytes(receiverId).copy(header, 6);
  header.writeUInt16BE(password.length, 22);
  header.writeUInt32BE(archive.length, 24);
  const framed = Buffer.concat([header, password, archive]);
  password.fill(0);
  return framed;
}
export async function paykitTransferProxy(
  args: PaykitTransferRequest,
): Promise<PaykitTransfer | boolean> {
  if (
    !args ||
    !Number.isSafeInteger(args.networkId) ||
    args.networkId < 1 ||
    !['prepareExport', 'prepareRestore', 'downloadExport', 'cancel'].includes(
      args.action,
    ) ||
    Object.keys(args).some(
      key =>
        ![
          'networkId',
          'action',
          'receiverId',
          'passphrase',
          'transferId',
          'replyTo',
        ].includes(key),
    )
  )
    throw new Error('Invalid Paykit transfer request');
  if (
    (args.action === 'prepareExport' || args.action === 'prepareRestore') &&
    (typeof args.receiverId !== 'string' || typeof args.passphrase !== 'string')
  )
    throw new Error('Invalid Paykit transfer request');
  const network = await getNetwork(args.networkId);
  const binding = await getBinding(args.networkId);
  if (
    !network.paykit ||
    network.paykit.apiVersion !== 1 ||
    network.paykit.environmentId !== binding.environmentId ||
    network.paykit.servicePort !== binding.servicePort
  )
    throw new Error('Paykit environment binding does not match this network');
  if (args.action === 'cancel') {
    exportDestinations.delete(args.transferId);
    await callTransfer(binding, 'DELETE', transferPath(args.transferId));
    return true;
  }
  if (args.action === 'downloadExport') {
    const destination = exportDestinations.get(args.transferId);
    exportDestinations.delete(args.transferId);
    if (!destination || destination.expiresAt < Date.now())
      throw new Error('Paykit transfer failed: transfer_expired');
    const response = await callTransfer(
      binding,
      'GET',
      transferPath(args.transferId, '/archive'),
    );
    if (!response.contentType?.startsWith('application/octet-stream'))
      throw new Error('Invalid Paykit archive response');
    const temporary = `${destination.path}.${newPaykitId()}.tmp`;
    try {
      const target = await fs
        .lstat(destination.path)
        .catch((error: any) =>
          error.code === 'ENOENT' ? undefined : Promise.reject(error),
        );
      if (target?.isSymbolicLink() || (target && !target.isFile()))
        throw new Error('Backup destination must be a regular file');
      await fs.writeFile(temporary, response.body, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, destination.path);
    } finally {
      response.body.fill(0);
      await fs.rm(temporary, { force: true });
    }
    return true;
  }
  const password = args.passphrase;
  let archive = Buffer.alloc(0);
  let destination: string | undefined;
  try {
    if (args.action === 'prepareRestore') {
      const selected = await dialog.showOpenDialog({
        title: 'Open encrypted Paykit backup',
        properties: ['openFile'],
        filters: [{ name: 'Paykit backup', extensions: ['paykit-backup'] }],
      });
      if (selected.canceled || selected.filePaths.length !== 1)
        throw new Error('Backup selection cancelled');
      archive = await regularArchive(selected.filePaths[0]);
    } else {
      const selected = await dialog.showSaveDialog({
        title: 'Save encrypted Paykit backup',
        defaultPath: 'receiver.paykit-backup',
        filters: [{ name: 'Paykit backup', extensions: ['paykit-backup'] }],
      });
      if (selected.canceled || !selected.filePath)
        throw new Error('Backup selection cancelled');
      destination = selected.filePath;
    }
    const framed = frameTransfer(
      args.action === 'prepareExport' ? 1 : 2,
      args.receiverId,
      password,
      archive,
    );
    try {
      const response = await callTransfer(binding, 'POST', '/v1/transfers', framed);
      const transfer = JSON.parse(response.body.toString('utf8')) as PaykitTransfer;
      if (
        !isUuid(transfer.transferId) ||
        transfer.transferId !== transfer.transferId.toLowerCase() ||
        transfer.transferId[14] !== '4' ||
        !['export', 'restore'].includes(transfer.purpose) ||
        transfer.purpose !== (args.action === 'prepareExport' ? 'export' : 'restore') ||
        !Number.isFinite(Date.parse(transfer.expiresAt))
      )
        throw new Error('Invalid Paykit transfer response');
      if (destination)
        exportDestinations.set(transfer.transferId, {
          path: destination,
          expiresAt: Date.parse(transfer.expiresAt),
        });
      return transfer;
    } finally {
      framed.fill(0);
    }
  } finally {
    archive.fill(0);
  }
}

// Project known public fields, even if a future backend accidentally adds secrets.
const fields = (value: any, names: string[]) =>
  Object.fromEntries(
    names
      .filter(
        name => value && ['string', 'number', 'boolean'].includes(typeof value[name]),
      )
      .map(name => [name, value[name]]),
  );
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const list = (value: unknown, project: (item: any) => any) =>
  Array.isArray(value)
    ? value.filter(item => item && typeof item === 'object').map(project)
    : [];
const recoveryReasons = (value: unknown) =>
  strings(value).filter(item =>
    [
      'sdk_validation',
      'grant_invalid',
      'marker_invalid',
      'wallet_uncertain',
      'wallet_history_unknown',
      'peer_relink_required',
      'activation_incomplete',
    ].includes(item),
  );
const publicRecoveryPeers = (value: unknown) =>
  list(value, item => fields(item, ['peerPublicKey', 'peerReceiverPath']));
const publicRecoveryWallet = (value: any) =>
  fields(value, [
    'imported',
    'retainedLive',
    'terminal',
    'uncertain',
    'unknownAfterExport',
  ]);
const publicRecovery = (value: any) => ({
  ...fields(value, [
    'phase',
    'automationPaused',
    'sdkValidated',
    'walletReconciled',
    'identityFingerprint',
    'receiverFingerprint',
    'grantValid',
    'markerValid',
    'terminalExecutionCount',
    'uncertainExecutionCount',
    'unknownAfterExportCount',
    'restoredAt',
    'lastError',
  ]),
  peersRequiringRelink: publicRecoveryPeers(value?.peersRequiringRelink),
  unresolvedExecutionIds: strings(value?.unresolvedExecutionIds),
  blockedReasons: recoveryReasons(value?.blockedReasons),
});
const publicProfile = (value: any) => ({
  ...fields(value, [
    'peerPublicKey',
    'peerReceiverPath',
    'displayName',
    'about',
    'imageUri',
    'path',
    'updatedAt',
  ]),
  ...(safePaykitAvatar(value.avatarDataUrl)
    ? { avatarDataUrl: safePaykitAvatar(value.avatarDataUrl) }
    : {}),
});
const publicResolution = (value: any) =>
  fields(value, [
    'id',
    'peerPublicKey',
    'peerReceiverPath',
    'source',
    'amountSats',
    'createdAt',
    'method',
    'endpoint',
    'version',
    'expiresAt',
    'status',
    'lastError',
  ]);
const publicReservation = (value: any) =>
  fields(value, [
    'id',
    'listId',
    'walletId',
    'source',
    'peerPublicKey',
    'peerReceiverPath',
    'method',
    'endpoint',
    'amountSats',
    'createdAt',
    'expiresAt',
    'status',
    'deliveryStatus',
    'cleanupStatus',
    'outboundMessageId',
    'lastError',
  ]);
const nullableFields = (value: any, names: string[]) => ({
  ...fields(value, names),
  ...Object.fromEntries(
    names.filter(name => value?.[name] === null).map(name => [name, null]),
  ),
});
const billingPeriodFields = (value: any) =>
  value.billingPeriod === undefined
    ? {}
    : {
        billingPeriod:
          value.billingPeriod &&
          isPaykitUtcInstant(value.billingPeriod.startsAt) &&
          isPaykitUtcInstant(value.billingPeriod.endsAt)
            ? {
                startsAt: value.billingPeriod.startsAt,
                endsAt: value.billingPeriod.endsAt,
              }
            : null,
      };
const endpointBindings = (value: any) =>
  Array.isArray(value)
    ? value
        .filter(isPaykitRequestEndpointBinding)
        .map((entry: any) =>
          fields(entry, ['source', 'method', 'endpoint', 'reservationId']),
        )
    : [];
const recurringFields = (value: any) => ({
  ...billingPeriodFields(value),
  ...(value.periodIndex === null ||
  (Number.isInteger(value.periodIndex) &&
    value.periodIndex >= 0 &&
    value.periodIndex <= 10000)
    ? { periodIndex: value.periodIndex }
    : {}),
});
const publicProof = (value: any) => {
  try {
    validatePaykitProof(value.proof);
    return {
      ...fields(value, ['id', 'requestId', 'method', 'deliveryStatus', 'recordedAt']),
      ...recurringFields(value),
      proof: { ...value.proof },
    };
  } catch (_) {
    return {
      ...fields(value, ['id', 'requestId', 'method', 'deliveryStatus', 'recordedAt']),
      ...recurringFields(value),
    };
  }
};
const publicFunding = (value: any) => ({
  ...nullableFields(value, ['status', 'funded', 'step', 'lastError']),
  wallets: list(value.wallets, item =>
    fields(item, [
      'participant',
      'walletId',
      'onchainBalanceSats',
      'lightningBalanceSats',
    ]),
  ),
  channelPoints: strings(value.channelPoints),
});
// Receipt DTOs contain strings and explicit nulls only. Never forward SDK records,
// arbitrary metadata, encryption material, or objects injected into scalar fields.
const receiptFields = (value: any, names: string[], nullable: string[] = []) =>
  Object.fromEntries(
    [...names, ...nullable]
      .filter(
        name =>
          typeof value?.[name] === 'string' ||
          (nullable.includes(name) && value?.[name] === null),
      )
      .map(name => [name, value[name]]),
  );
export const publicWorkspace = (value: any) => ({
  ...fields(value, ['receiverId', 'deliveryPaused', 'lastError', 'updatedAt']),
  ...(value.recovery === null
    ? { recovery: null }
    : value.recovery && typeof value.recovery === 'object'
    ? { recovery: publicRecovery(value.recovery) }
    : {}),
  ...(value.paymentMethods && typeof value.paymentMethods === 'object'
    ? {
        paymentMethods: {
          ...fields(value.paymentMethods, ['walletId']),
          enabledMethods: strings(value.paymentMethods.enabledMethods),
          preference: strings(value.paymentMethods.preference),
          wallets: list(value.paymentMethods.wallets, item => ({
            ...fields(item, ['id', 'label', 'status']),
            supportedMethods: strings(item.supportedMethods),
          })),
        },
      }
    : {}),
  ...(value.publicPaymentList && typeof value.publicPaymentList === 'object'
    ? {
        publicPaymentList: {
          ...fields(value.publicPaymentList, [
            'id',
            'amountSats',
            'createdAt',
            'expiresAt',
            'status',
            'deliveryStatus',
            'cleanupStatus',
            'lastError',
          ]),
          reservationIds: strings(value.publicPaymentList.reservationIds),
        },
      }
    : {}),
  ...(value.applicationClock &&
  ['system', 'controlled'].includes(value.applicationClock.mode) &&
  isPaykitUtcInstant(value.applicationClock.now)
    ? { applicationClock: fields(value.applicationClock, ['mode', 'now']) }
    : {}),
  subscriptions: list(value.subscriptions, item => ({
    ...nullableFields(item, ['requestId', 'currentPeriodIndex']),
    autopay: nullableFields(item.autopay, [
      'enabled',
      'walletId',
      'source',
      'method',
      'status',
      'lastError',
    ]),
    periods: list(item.periods, period => ({
      ...nullableFields(period, [
        'index',
        'startsAt',
        'endsAt',
        'status',
        'offerId',
        'executionId',
        'proofId',
        'lastError',
      ]),
      endpointBindings: endpointBindings(period.endpointBindings),
      ...(period.endpointCommitments === undefined
        ? {}
        : {
            endpointCommitments: Array.isArray(period.endpointCommitments)
              ? period.endpointCommitments
                  .filter(isPaykitEndpointCommitment)
                  .map((commitment: any) =>
                    fields(commitment, [
                      'source',
                      'method',
                      'reservationId',
                      'endpointHash',
                    ]),
                  )
              : [],
          }),
    })),
  })),
  requests: list(value.requests, item => ({
    ...nullableFields(item, [
      'id',
      'peerPublicKey',
      'peerReceiverPath',
      'role',
      'lifecycle',
      'amountSats',
      'description',
      'paymentReference',
      'proposalExpiresAt',
      'deliveryStatus',
      'createdAt',
    ]),
    acceptedMethods: strings(item.acceptedMethods),
    ...(item.recurrence === undefined
      ? {}
      : {
          recurrence:
            item.recurrence && typeof item.recurrence === 'object'
              ? nullableFields(item.recurrence, [
                  'every',
                  'unit',
                  'startsAt',
                  'anchor',
                  'endsAt',
                ])
              : null,
        }),
    endpointBindings: endpointBindings(item.endpointBindings),
  })),
  executions: list(value.executions, item => ({
    ...recurringFields(item),
    ...nullableFields(item, [
      'id',
      'requestId',
      'walletId',
      'source',
      'method',
      'endpoint',
      'amountSats',
      'status',
      'createdAt',
      'updatedAt',
      'txid',
      'outputIndex',
      'paymentHash',
      'lastError',
    ]),
  })),
  proofs: list(value.proofs, publicProof),
  settlements: list(value.settlements, item => ({
    ...recurringFields(item),
    ...nullableFields(item, [
      'proofId',
      'requestId',
      'status',
      'requiredConfirmations',
      'confirmations',
      'verifiedAt',
      'lastError',
    ]),
  })),
  receiptIssuances: list(value.receiptIssuances, item => ({
    ...billingPeriodFields(item),
    ...receiptFields(
      item,
      [
        'id',
        'requestId',
        'proofId',
        'peerPublicKey',
        'peerReceiverPath',
        'paymentReference',
        'method',
        'amountSats',
        'description',
        'note',
        'status',
        'deliveryStatus',
        'accessEventId',
        'createdAt',
        'updatedAt',
      ],
      ['outboundMessageId', 'storedAt', 'accessQueuedAt', 'lastError'],
    ),
  })),
  receiptAccess: list(value.receiptAccess, item => ({
    ...billingPeriodFields(item),
    ...receiptFields(
      item,
      [
        'receiptId',
        'peerPublicKey',
        'peerReceiverPath',
        'accessEventId',
        'paymentReference',
        'retrievalStatus',
        'receivedAt',
      ],
      ['requestId', 'attemptedAt', 'retrievedAt', 'lastError'],
    ),
  })),
  receipts: list(value.receipts, item => ({
    ...billingPeriodFields(item),
    ...receiptFields(
      item,
      [
        'id',
        'issuerPublicKey',
        'issuerReceiverPath',
        'recipientPublicKey',
        'paymentReference',
        'accessEventId',
        'retrievedAt',
      ],
      ['requestId', 'proofId', 'method', 'amountSats', 'description', 'note'],
    ),
  })),
  reservations: list(value.reservations, publicReservation),
  resolutions: list(value.resolutions, publicResolution),
  links: list(value.links, item =>
    fields(item, [
      'peerPublicKey',
      'peerReceiverPath',
      'state',
      'generation',
      'handshakeRole',
      'lastSyncAt',
      'lastReceiveAt',
      'failureCount',
      'pendingMessages',
      'latestReceivedListId',
      'lastSentMessageId',
      'lastError',
    ]),
  ),
  ...(value.profile && typeof value.profile === 'object'
    ? { profile: publicProfile(value.profile) }
    : {}),
  profiles: list(value.profiles, publicProfile),
  contacts: list(value.contacts, item => ({
    ...fields(item, [
      'peerPublicKey',
      'label',
      'publicSharing',
      'publicReceiverPath',
      'lastError',
    ]),
    receiverPaths: strings(item.receiverPaths),
  })),
  discoveries: list(value.discoveries, item => ({
    ...fields(item, ['peerPublicKey', 'updatedAt']),
    receiverPaths: strings(item.receiverPaths),
  })),
});
export const publicOperation = (value: any) => ({
  ...fields(value, ['id', 'command', 'status']),
  ...(value.result
    ? {
        result: {
          ...fields(value.result, [
            'participantId',
            'receiverId',
            'preset',
            'funded',
            'peerPublicKey',
            'peerReceiverPath',
            'outboundMessageId',
            'deliveryPaused',
            'status',
            'path',
            'imageUri',
            'transferId',
            'archiveVersion',
            'createdAt',
            'byteLength',
            'sha256',
            'identityFingerprint',
            'receiverFingerprint',
            'identityMatches',
            'receiverMatches',
            'grantValid',
            'markerValid',
            'sdkValidationPending',
            'safeCheckpointCount',
            'unsafeCheckpointCount',
            'restorable',
          ]),
          ...(value.result.sdkCounts && typeof value.result.sdkCounts === 'object'
            ? {
                sdkCounts: Object.fromEntries(
                  Object.entries(value.result.sdkCounts).filter(
                    ([, count]) => Number.isSafeInteger(count) && (count as number) >= 0,
                  ),
                ),
              }
            : {}),
          ...(value.result.wallet && typeof value.result.wallet === 'object'
            ? { wallet: publicRecoveryWallet(value.result.wallet) }
            : {}),
          peersRequiringRelink: publicRecoveryPeers(value.result.peersRequiringRelink),
          blockedReasons: recoveryReasons(value.result.blockedReasons),
          ...receiptFields(value.result, ['receiptId']),
          ...(value.result.funding && typeof value.result.funding === 'object'
            ? { funding: publicFunding(value.result.funding) }
            : {}),
          ...(value.result.resolution && typeof value.result.resolution === 'object'
            ? { resolution: publicResolution(value.result.resolution) }
            : {}),
          ...(value.result.workspace && typeof value.result.workspace === 'object'
            ? { workspace: publicWorkspace(value.result.workspace) }
            : {}),
        },
      }
    : {}),
  ...(value.error ? { error: fields(value.error, ['code', 'message']) } : {}),
});
export const publicState = (value: any, environmentId: string) => {
  if (value.apiVersion !== 1 || value.environmentId !== environmentId)
    throw new Error('Paykit service environment mismatch');
  return {
    ...fields(value, ['apiVersion', 'environmentId', 'ready', 'lastEventSequence']),
    ...(value.funding && typeof value.funding === 'object'
      ? { funding: publicFunding(value.funding) }
      : {}),
    participants: value.participants.map((p: any) =>
      fields(p, ['id', 'name', 'publicKey']),
    ),
    receivers: value.receivers.map((r: any) =>
      fields(r, [
        'id',
        'participantId',
        'name',
        'path',
        'status',
        'generation',
        'noisePublicKey',
        'lastError',
      ]),
    ),
    operations: value.operations.map(publicOperation),
    receiverWorkspaces: list(value.receiverWorkspaces, publicWorkspace),
  };
};

export async function paykitProxy(args: PaykitRequest): Promise<any> {
  const network = await getNetwork(args.networkId);
  if (args.action === 'provision') {
    const binding = await provision(args.networkId);
    await refreshWallets(network, binding);
    return binding;
  }
  const binding = await getBinding(args.networkId);
  if (
    !network.paykit ||
    network.paykit.environmentId !== binding.environmentId ||
    network.paykit.servicePort !== binding.servicePort ||
    network.paykit.apiVersion !== 1
  ) {
    throw new Error('Paykit environment binding does not match this network');
  }
  if (args.action === 'command') validatePaykitCommand(args.request);
  const authorizeWalletId =
    args.action === 'command'
      ? args.request.command === 'preset.fund'
        ? '*'
        : args.request.command === 'payment.execute'
        ? (args.request.input.walletId as string)
        : undefined
      : undefined;
  if (['checkPort', 'state', 'command'].includes(args.action)) {
    try {
      await refreshWallets(network, binding, authorizeWalletId);
    } catch (error: any) {
      if (!authorizeWalletId) throw error;
      const reason = error.message?.startsWith('The funded preset requires')
        ? error.message
        : 'Local wallet authorization is unavailable. Check that the selected LND nodes are running.';
      throw new Error(`Paykit command not submitted: ${reason}`);
    }
  }
  if (args.action === 'checkPort') return checkPort(binding.servicePort);
  if (args.action === 'remove') {
    await fs.rm(join(credentialsRoot(), binding.environmentId), {
      recursive: true,
      force: true,
    });
    await fs.unlink(referencePath(args.networkId));
    return true;
  }
  if (args.action === 'state')
    return publicState(await callService(binding, '/v1/state'), binding.environmentId);
  if (args.action === 'operation') {
    if (!isUuid(args.operationId)) throw new Error('Invalid Paykit operation ID');
    return publicOperation(
      await callService(binding, `/v1/operations/${args.operationId}`),
    );
  }
  if (args.action === 'command') {
    validatePaykitCommand(args.request);
    const result = await callService(binding, '/v1/commands', args.request);
    if (!isUuid(result.operationId)) throw new Error('Invalid Paykit operation response');
    return { operationId: result.operationId };
  }
  throw new Error('Unsupported Paykit action');
}
