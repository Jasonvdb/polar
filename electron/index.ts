import './bootstrapEnvironment';
import { app } from 'electron';
import { mkdirSync } from 'fs';
import electronDebug from 'electron-debug';
import { debug, error } from 'electron-log';
import { APP_ID, APP_NAME, paykitConfig } from '../src/shared/paykitConfig';
import { initLogger } from '../src/shared/utils';
import { IS_DEV } from './constants';
import { initWindowsDarkHack } from './hacks/windows';
import WindowManager from './windowManager';

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
mkdirSync(paykitConfig.userDataPath, { recursive: true });
app.setPath('userData', paykitConfig.userDataPath);

// set global configuration for logging
initLogger();

// disable the Electron Security Warnings shown when access the dev url
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = `${IS_DEV}`;

debug(`Starting Electron main process`);

// add keyboard shortcuts and auto open dev tools for all windows
electronDebug({ isEnabled: IS_DEV });

// This is needed to run electron on windows with dark mode. There's currently a bug in
// electron v6 when used on Win10 with dark mode enabled and react/redux devtools installed.
// The electron window is never displayed.
// See https://github.com/electron/electron/issues/19468
// TODO: remove win10 hack when electron bug is fixed
if (IS_DEV && initWindowsDarkHack()) {
  debug('*** Applied Windows 10 Dark Mode Hack ***');
}

try {
  const windowManager = new WindowManager();
  windowManager.start();
} catch (e) {
  error('Unable to start WindowManager', e);
}
