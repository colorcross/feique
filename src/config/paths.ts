import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_RELATIVE_PATH = path.join('.feique', 'config.toml');

const CURRENT_DIR_NAME = '.feique';

function resolveHomeDir(): string {
  return path.join(os.homedir(), CURRENT_DIR_NAME);
}

export function getGlobalConfigPath(): string {
  return path.join(resolveHomeDir(), 'config.toml');
}

export function getDefaultStateDir(): string {
  return path.join(resolveHomeDir(), 'state');
}
