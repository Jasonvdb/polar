import { sync } from 'shell-env';

/** Recover command discovery for GUI launches while retaining explicit overrides. */
export const mergeLaunchEnvironment = (
  launch: NodeJS.ProcessEnv,
  shell: Record<string, string | undefined>,
): NodeJS.ProcessEnv => ({
  ...shell,
  ...launch,
  PATH: shell.PATH || launch.PATH,
});

// This module must be the entry point's first import: Paykit configuration is
// shared with the renderer and must see the recovered environment on first load.
process.env = mergeLaunchEnvironment(process.env, sync());
