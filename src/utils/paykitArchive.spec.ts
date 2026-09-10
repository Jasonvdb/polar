import fsExtra from 'fs-extra';
import { join } from 'path';
import { createIpcSender } from 'lib/ipc/ipcService';
import { importNetworkFromZip, zipNetwork } from './network';
import { getNetwork } from './tests';

jest.mock('lib/ipc/ipcService');
const files = fsExtra as jest.Mocked<typeof fsExtra>;
const ipc = createIpcSender as jest.Mock;

describe('Paykit archive safety', () => {
  beforeEach(() => ipc.mockReturnValue(jest.fn().mockResolvedValue(undefined)));
  it('rejects a Paykit export through the shared utility used by MCP', async () => {
    const network = {
      ...getNetwork(),
      paykit: { apiVersion: 1 as const, environmentId: 'id', servicePort: 30091 },
    };
    await expect(zipNetwork(network, {} as any, '/export.zip')).rejects.toThrow(
      'Backup and Recovery',
    );
    expect(files.writeFile).not.toHaveBeenCalled();
  });
  it.each(['metadata', 'paykit', 'paykit-postgres'])(
    'rejects Paykit import identified by %s before copying into a network',
    async source => {
      files.readFile.mockResolvedValue(
        Buffer.from(
          JSON.stringify({ network: source === 'metadata' ? { paykit: {} } : {} }),
        ) as any,
      );
      files.pathExists.mockImplementation(async path =>
        `${path}`.endsWith(join('volumes', source)),
      );
      await expect(importNetworkFromZip('/archive.zip', 2)).rejects.toThrow(
        'Backup and Recovery',
      );
      expect(files.copy).not.toHaveBeenCalled();
      expect(files.remove).toHaveBeenCalled();
    },
  );
});
