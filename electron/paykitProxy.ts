import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { request as httpRequest } from 'http';
import { createServer } from 'net';
import { join, resolve } from 'path';
import {
  isUuid,
  newPaykitId,
  PaykitEnvironment,
  PaykitRequest,
  validatePaykitCommand,
} from '../src/shared/paykitApi';
import { paykitConfig } from '../src/shared/paykitConfig';

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

async function writeCredential(path: string, value: string) {
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

/** Finite, authenticated requests. Only fixed loopback paths and public payloads are accepted. */
async function callService(
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
          if (size > 4 * 1024 * 1024)
            req.destroy(new Error('Paykit response exceeded size limit'));
          else chunks.push(chunk);
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
    const timeout = setTimeout(
      () => req.destroy(new Error('Paykit service request timed out')),
      5000,
    );
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

// Project known public fields, even if a future backend accidentally adds secrets.
const fields = (value: any, names: string[]) =>
  Object.fromEntries(
    names.filter(name => value[name] !== undefined).map(name => [name, value[name]]),
  );
export const publicOperation = (value: any) => ({
  ...fields(value, ['id', 'command', 'status']),
  ...(value.result
    ? {
        result: fields(value.result, ['participantId', 'receiverId', 'preset', 'funded']),
      }
    : {}),
  ...(value.error ? { error: fields(value.error, ['code', 'message']) } : {}),
});
export const publicState = (value: any, environmentId: string) => {
  if (value.apiVersion !== 1 || value.environmentId !== environmentId)
    throw new Error('Paykit service environment mismatch');
  return {
    ...fields(value, ['apiVersion', 'environmentId', 'ready', 'lastEventSequence']),
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
  };
};

export async function paykitProxy(args: PaykitRequest): Promise<any> {
  const network = await getNetwork(args.networkId);
  if (args.action === 'provision') return provision(args.networkId);
  const binding = await getBinding(args.networkId);
  if (
    !network.paykit ||
    network.paykit.environmentId !== binding.environmentId ||
    network.paykit.servicePort !== binding.servicePort ||
    network.paykit.apiVersion !== 1
  ) {
    throw new Error('Paykit environment binding does not match this network');
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
