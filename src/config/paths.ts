import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_RELATIVE_PATH = path.join('.feishu-bridge', 'config.toml');

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), '.feishu-bridge', 'config.toml');
}

export function getDefaultStateDir(): string {
  return path.join(os.homedir(), '.feishu-bridge', 'state');
}
