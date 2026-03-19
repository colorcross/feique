import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_CONFIG_RELATIVE_PATH = path.join('.feique', 'config.toml');

const CURRENT_DIR_NAME = '.feique';
const LEGACY_DIR_NAMES = ['.feishu-bridge', '.codex-feishu'];

/**
 * Resolve the effective home directory for the bridge.
 * If ~/.feique/ exists, use it.
 * If not but ~/.feishu-bridge/ or ~/.codex-feishu/ exists, use that (legacy migration path).
 * Otherwise default to ~/.feique/.
 */
function resolveHomeDir(): string {
  const home = os.homedir();
  const currentDir = path.join(home, CURRENT_DIR_NAME);
  if (fs.existsSync(currentDir)) {
    return currentDir;
  }
  for (const legacyName of LEGACY_DIR_NAMES) {
    const legacyDir = path.join(home, legacyName);
    if (fs.existsSync(legacyDir)) {
      return legacyDir;
    }
  }
  return currentDir;
}

export function getGlobalConfigPath(): string {
  return path.join(resolveHomeDir(), 'config.toml');
}

export function getDefaultStateDir(): string {
  return path.join(resolveHomeDir(), 'state');
}
