import { bitcoind, lnd } from './nodeTemplates';

describe('nodeTemplates', () => {
  it('should create a valid bitcoind config', () => {
    const node = bitcoind(
      'mynode',
      'polar-mynode',
      'bitcoind:v0.8.0',
      18443,
      19444,
      28334,
      29335,
      '',
    );
    expect(node.image).toContain('bitcoind');
    expect(node.container_name).toEqual('polar-mynode');
    expect(node.volumes[0]).toContain('mynode');
  });

  it('should create a valid lnd config', () => {
    const node = lnd('mynode', 'polar-mynode', 'lnd:v0.8.0', 8080, 10009, 9735, '');
    expect(node.image).toContain('lnd');
    expect(node.container_name).toEqual('polar-mynode');
    expect(node.volumes[0]).toContain('mynode');
  });
});
