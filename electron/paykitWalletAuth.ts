import { request } from 'https';

// URI grants are deliberately separate from the receiving invoice credential.
export const paymentPermissions = [
  '/lnrpc.Lightning/GetInfo',
  '/lnrpc.Lightning/SendPaymentSync',
  '/lnrpc.Lightning/ListPayments',
];
export const setupPermissions = [
  '/lnrpc.Lightning/GetInfo',
  '/lnrpc.Lightning/NewAddress',
  '/lnrpc.Lightning/WalletBalance',
  '/lnrpc.Lightning/ConnectPeer',
  '/lnrpc.Lightning/ListPeers',
  '/lnrpc.Lightning/OpenChannelSync',
  '/lnrpc.Lightning/ListChannels',
  '/lnrpc.Lightning/PendingChannels',
];

/** Main-only, bounded bakery call. Neither response bodies nor auth errors are logged. */
export function bakePaykitMacaroon(
  port: number,
  cert: Buffer,
  admin: Buffer,
  permissions: string[],
): Promise<Buffer> {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    return Promise.reject(new Error('Invalid local LND REST port'));
  const payload = JSON.stringify({
    permissions: permissions.map(action => ({ entity: 'uri', action })),
  });
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('Local LND authorization is unavailable'));
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/v1/macaroon',
        method: 'POST',
        ca: cert,
        rejectUnauthorized: true,
        agent: false,
        headers: {
          'Grpc-Metadata-macaroon': admin.toString('hex'),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 131072) req.destroy(new Error('Authorization response limit'));
          else chunks.push(chunk);
        });
        response.once('error', failed);
        response.once('aborted', failed);
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error();
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
              typeof value.macaroon !== 'string' ||
              !/^(?:[a-fA-F0-9]{2}){1,65536}$/.test(value.macaroon)
            )
              throw new Error();
            resolve(Buffer.from(value.macaroon, 'hex'));
          } catch (_) {
            failed();
          }
        });
      },
    );
    const timeout = setTimeout(
      () => req.destroy(new Error('Authorization deadline')),
      5000,
    );
    req.once('close', () => clearTimeout(timeout));
    req.once('error', failed);
    req.end(payload);
  });
}
