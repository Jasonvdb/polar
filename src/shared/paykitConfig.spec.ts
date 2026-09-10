import { join } from 'path';
import { readPaykitConfig } from './paykitConfig';

jest.mock('fs', () => ({ existsSync: jest.fn(() => false) }));

describe('Paykit resource isolation', () => {
  it('separates the installed application from upstream Polar', () => {
    const config = readPaykitConfig({}, '/home/alice');
    expect(config.dataPath).toBe(join('/home/alice', '.polar-paykit'));
    expect(config.userDataPath).toBe(join('/home/alice', '.polar-paykit', 'electron'));
    expect(config.namespace).toBe('polar-paykit');
    expect(config.mcpPort).toBe(38383);
    expect(config.portOffset).toBe(20000);
  });

  it('keeps concurrent instance resources separate and supports allocated ports', () => {
    const first = readPaykitConfig({ POLAR_PAYKIT_INSTANCE: 'test-a' }, '/home/alice');
    const second = readPaykitConfig(
      {
        POLAR_PAYKIT_INSTANCE: 'test-b',
        POLAR_PAYKIT_DATA_ROOT: '/tmp/test-b/data',
        POLAR_PAYKIT_MCP_PORT: '39393',
        POLAR_PAYKIT_PORT_OFFSET: '25000',
      },
      '/home/alice',
    );
    expect(first.namespace).not.toBe(second.namespace);
    expect(first.dataPath).not.toBe(second.dataPath);
    expect(second.userDataPath).toBe(join('/tmp/test-b/data', 'electron'));
    expect(second.mcpPort).toBe(39393);
    expect(second.portOffset).toBe(25000);
  });

  it.each([
    { POLAR_PAYKIT_INSTANCE: '../polar' },
    { POLAR_PAYKIT_INSTANCE: 'UPPER' },
    { POLAR_PAYKIT_DATA_ROOT: 'relative/path' },
    { POLAR_PAYKIT_MCP_PORT: '123oops' },
    { POLAR_PAYKIT_MCP_PORT: '65536' },
    { POLAR_PAYKIT_PORT_OFFSET: '0' },
  ])('rejects unsafe configuration %o', env => {
    expect(() => readPaykitConfig(env, '/home/alice')).toThrow();
  });
});
