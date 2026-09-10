import { app, remote } from 'electron';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';

export const APP_NAME = 'Polar Paykit';
export const APP_ID = 'com.jasonvdb.polar-paykit';

/** One namespace owns its application data and every Docker resource. */
export const readPaykitConfig = (
  env: Record<string, string | undefined>,
  home: string,
) => {
  const instance = env.POLAR_PAYKIT_INSTANCE || 'default';
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(instance)) {
    throw new Error(
      'POLAR_PAYKIT_INSTANCE must be 1-40 lowercase letters, digits or hyphens',
    );
  }
  const namespace = instance === 'default' ? 'polar-paykit' : `polar-paykit-${instance}`;
  const xdgDataPath = join(home, '.local', 'share', namespace);
  const dataPath =
    env.POLAR_PAYKIT_DATA_ROOT ||
    (existsSync(xdgDataPath) ? xdgDataPath : join(home, `.${namespace}`));
  if (env.POLAR_PAYKIT_DATA_ROOT && !isAbsolute(dataPath)) {
    throw new Error('POLAR_PAYKIT_DATA_ROOT must be an absolute path');
  }
  const readPort = (value: string, name: string, min: number, max: number) => {
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    }
    return Number(value);
  };
  return {
    namespace,
    dataPath,
    xdgDataPath,
    userDataPath: join(dataPath, 'electron'),
    mcpPort: readPort(
      env.POLAR_PAYKIT_MCP_PORT || '38383',
      'POLAR_PAYKIT_MCP_PORT',
      1024,
      65535,
    ),
    // Leave the upstream host-port range available. In-container ports stay unchanged.
    portOffset: readPort(
      env.POLAR_PAYKIT_PORT_OFFSET || '20000',
      'POLAR_PAYKIT_PORT_OFFSET',
      10000,
      30000,
    ),
  };
};

const electronApp = app || remote.app;
const environment = app ? process.env : remote.process.env;
export const paykitConfig = readPaykitConfig(environment, electronApp.getPath('home'));
export const getProjectName = (networkId: number) =>
  `${paykitConfig.namespace}-network-${networkId}`;
export const getNamespacedContainerName = (networkId: number, name: string) =>
  `${paykitConfig.namespace}-n${networkId}-${name}`;
