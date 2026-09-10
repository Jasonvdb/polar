import { EventEmitter } from 'events';
import { request } from 'https';
import {
  bakePaykitMacaroon,
  paymentPermissions,
  setupPermissions,
} from '../../electron/paykitWalletAuth';

jest.mock('https', () => ({ request: jest.fn() }));
const mocked = request as jest.Mock;
const setup = (statusCode: number, body: string) => {
  const req = new EventEmitter() as any;
  req.end = jest.fn(() => {
    const response = new EventEmitter() as any;
    response.statusCode = statusCode;
    mocked.mock.calls[mocked.mock.calls.length - 1][1](response);
    response.emit('data', Buffer.from(body));
    response.emit('end');
    req.emit('close');
  });
  req.destroy = jest.fn((error: Error) => {
    req.emit('error', error);
    req.emit('close');
  });
  mocked.mockReturnValue(req);
  return req;
};
it('bakes only URI permissions against bounded verified local TLS without returning admin auth', async () => {
  const req = setup(200, '{"macaroon":"abcd"}');
  const cert = Buffer.from('certificate');
  const admin = Buffer.from('private admin');
  expect(await bakePaykitMacaroon(8080, cert, admin, paymentPermissions)).toEqual(
    Buffer.from('abcd', 'hex'),
  );
  expect(mocked).toHaveBeenLastCalledWith(
    expect.objectContaining({
      hostname: '127.0.0.1',
      path: '/v1/macaroon',
      ca: cert,
      rejectUnauthorized: true,
      agent: false,
    }),
    expect.any(Function),
  );
  expect(JSON.parse(req.end.mock.calls[0][0])).toEqual({
    permissions: paymentPermissions.map(action => ({ entity: 'uri', action })),
  });
  expect(paymentPermissions).not.toContain('/lnrpc.Lightning/BakeMacaroon');
  expect(setupPermissions).not.toContain('/lnrpc.Lightning/SendCoins');
});
it('sanitizes failed and malformed bakery responses and rejects arbitrary ports', async () => {
  for (const [status, body] of [
    [403, 'private auth diagnostics'],
    [200, '{"macaroon":"not hex"}'],
    [200, 'invalid response'],
  ] as const) {
    setup(status, body);
    await expect(
      bakePaykitMacaroon(
        8080,
        Buffer.from('cert'),
        Buffer.from('admin'),
        paymentPermissions,
      ),
    ).rejects.toThrow('Local LND authorization is unavailable');
  }
  await expect(
    bakePaykitMacaroon(80, Buffer.from('cert'), Buffer.from('admin'), []),
  ).rejects.toThrow('Invalid local LND REST port');
});
it('terminates a stalled bakery request at its deadline without leaking a transport error', async () => {
  jest.useFakeTimers();
  try {
    const req = setup(200, '{}');
    req.end.mockImplementation(() => undefined);
    const pending = bakePaykitMacaroon(
      8080,
      Buffer.from('cert'),
      Buffer.from('admin'),
      paymentPermissions,
    );
    const rejected = expect(pending).rejects.toThrow(
      'Local LND authorization is unavailable',
    );
    jest.advanceTimersByTime(5000);
    await rejected;
    expect(req.destroy).toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});
