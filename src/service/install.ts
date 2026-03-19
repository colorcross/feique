import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureDir, fileExists, writeUtf8Atomic } from '../utils/fs.js';
import { buildServiceDescriptor, type ServiceDescriptor } from './templates.js';

export interface InstallServiceOptions {
  serviceName: string;
  cliScriptPath: string;
  nodeBinaryPath: string;
  workingDirectory: string;
  configPath?: string;
  logDirectory?: string;
  platform?: NodeJS.Platform;
}

export function resolveDefaultLogDirectory(): string {
  return path.join(os.homedir(), '.feique', 'logs');
}

export async function installServiceFile(options: InstallServiceOptions): Promise<ServiceDescriptor> {
  const logDirectory = options.logDirectory ?? resolveDefaultLogDirectory();
  const descriptor = buildServiceDescriptor({
    ...options,
    logDirectory,
  });

  await ensureDir(path.dirname(descriptor.targetPath));
  await ensureDir(logDirectory);
  await writeUtf8Atomic(descriptor.targetPath, descriptor.content);
  return descriptor;
}

export async function uninstallServiceFile(options: { serviceName: string; platform?: NodeJS.Platform }): Promise<{ removed: boolean; targetPath: string }> {
  const descriptor = buildServiceDescriptor({
    serviceName: options.serviceName,
    cliScriptPath: process.argv[1] ?? 'dist/cli.js',
    nodeBinaryPath: process.execPath,
    workingDirectory: process.cwd(),
    logDirectory: resolveDefaultLogDirectory(),
    platform: options.platform,
  });
  const exists = await fileExists(descriptor.targetPath);
  if (exists) {
    await fs.rm(descriptor.targetPath, { force: true });
  }
  return { removed: exists, targetPath: descriptor.targetPath };
}
