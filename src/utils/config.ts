import { remote } from 'electron';
import { join } from 'path';
import { NodeImplementationWithSimln } from 'shared/types';
import { paykitConfig } from 'shared/paykitConfig';
import { Network } from 'types';
import { dockerConfigs } from './constants';

/**
 * XDG-compliant path where application data is stored
 */
export const xdgDataPath = paykitConfig.xdgDataPath;

/**
 * root path where application data is stored
 */
export const dataPath = paykitConfig.dataPath;

/**
 * legacy path where application data was stored in v0.1.0
 */
export const legacyDataPath = join(remote.app.getPath('userData'), 'data');

/**
 * path where networks data is stored
 */
export const networksPath = join(dataPath, 'networks');

/**
 * returns a path to store data for an individual node
 */
export const nodePath = (
  network: Network,
  implementation: NodeImplementationWithSimln,
  name: string,
): string =>
  join(network.path, 'volumes', dockerConfigs[implementation].volumeDirName, name);
