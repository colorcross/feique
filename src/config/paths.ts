import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_RELATIVE_PATH = path.join('.feishu-bridge', 'config.toml');

const LEGACY_DIR_NAME = '.codex-feishu';
const CURRENT_DIR_NAME = '.feishu-bridge';

/**
 * Resolve the effective home directory for the bridge.
 * If ~/.feishu-bridge/ exists, use it.
 * If not but ~/.codex-feishu/ exists, use that (legacy migration path).
 * Otherwise default to ~/.feishu-bridge/.
 */
function resolveHomeDir(): string {
  const home = os.homedir();
  const currentDir = path.join(home, CURRENT_DIR_NAME);
  if (fs.existsSync(currentDir)) {
    return currentDir;
  }
  const legacyDir = path.join(home, LEGACY_DIR_NAME);
  if (fs.existsSync(legacyDir)) {
    return legacyDir;
  }
  return currentDir;
}

export function getGlobalConfigPath(): string {
  return path.join(resolveHomeDir(), 'config.toml');
}

export function getDefaultStateDir(): string {
  return path.join(resolveHomeDir(), 'state');
}
