import { join } from 'path';

jest.mock('fs', () => ({ existsSync: jest.fn(() => false) }));
jest.mock('shell-env', () => ({ sync: jest.fn() }));

// Import the actual bootstrap before config, as the Electron entry point does.
describe('Electron environment bootstrap', () => {
  const originalEnvironment = process.env;
  const home = '/home/alice';

  afterEach(() => {
    process.env = originalEnvironment;
    jest.resetModules();
    jest.dontMock('electron');
  });

  const loadMain = async (
    launch: Record<string, string>,
    shell: Record<string, string>,
  ) => {
    jest.resetModules();
    process.env = { ...originalEnvironment, ...launch };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('POLAR_PAYKIT_') && !(key in launch)) delete process.env[key];
    }
    jest.doMock('shell-env', () => ({ sync: jest.fn(() => shell) }));
    jest.doMock('electron', () => ({ app: { getPath: () => home } }));
    await import('../../electron/bootstrapEnvironment');
    return (await import('./paykitConfig')).paykitConfig;
  };

  it('restores login-shell command paths for a minimal macOS GUI environment', async () => {
    await loadMain(
      { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' },
    );
    expect(process.env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });

  it('retains the launch PATH when shell recovery returns no usable PATH', async () => {
    await loadMain({ PATH: '/usr/bin:/bin' }, { PATH: '' });
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('loads shell-only Paykit settings before main configuration and shares them with the renderer', async () => {
    const mainConfig = await loadMain(
      {},
      {
        POLAR_PAYKIT_INSTANCE: 'shell-run',
        POLAR_PAYKIT_DATA_ROOT: '/tmp/shell-run',
        POLAR_PAYKIT_MCP_PORT: '39383',
        POLAR_PAYKIT_PORT_OFFSET: '21000',
      },
    );
    expect(mainConfig.namespace).toBe('polar-paykit-shell-run');
    expect(mainConfig.userDataPath).toBe(join('/tmp/shell-run', 'electron'));
    expect(mainConfig.mcpPort).toBe(39383);
    expect(mainConfig.portOffset).toBe(21000);

    const recoveredEnvironment = { ...process.env };
    jest.resetModules();
    jest.doMock('electron', () => ({
      remote: { app: { getPath: () => home }, process: { env: recoveredEnvironment } },
    }));
    const rendererConfig = (await import('./paykitConfig')).paykitConfig;
    expect(rendererConfig).toEqual(mainConfig);
  });

  it('keeps explicit launch settings when the login shell supplies different defaults', async () => {
    const config = await loadMain(
      {
        POLAR_PAYKIT_INSTANCE: 'launch-run',
        POLAR_PAYKIT_DATA_ROOT: '/tmp/launch-run',
        POLAR_PAYKIT_MCP_PORT: '40383',
        POLAR_PAYKIT_PORT_OFFSET: '22000',
      },
      {
        POLAR_PAYKIT_INSTANCE: 'shell-run',
        POLAR_PAYKIT_DATA_ROOT: '/tmp/shell-run',
        POLAR_PAYKIT_MCP_PORT: '39383',
        POLAR_PAYKIT_PORT_OFFSET: '21000',
      },
    );
    expect(config.namespace).toBe('polar-paykit-launch-run');
    expect(config.dataPath).toBe('/tmp/launch-run');
    expect(config.mcpPort).toBe(40383);
    expect(config.portOffset).toBe(22000);
  });
});
