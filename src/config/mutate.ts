import path from 'node:path';
import type { ProjectConfig, SandboxMode } from './schema.js';
import { readRawToml, writeToml } from './load.js';

export async function bindProjectAlias(input: {
  configPath: string;
  alias: string;
  root: string;
  profile?: string;
  sandbox?: SandboxMode;
}): Promise<void> {
  await updateBridgeConfigFile(input.configPath, (raw) => {
    const projects = ensureObject(raw.projects);
    projects[input.alias] = {
      ...(ensureObject(projects[input.alias]) ?? {}),
      root: path.resolve(input.root),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    };
    raw.projects = projects;
  });
}

export async function updateBridgeConfigFile(
  configPath: string,
  updater: (raw: Record<string, unknown>) => void | Promise<void>,
): Promise<void> {
  const raw = await readRawToml(configPath);
  await updater(raw);
  await writeToml(configPath, raw);
}

export async function updateStringList(
  configPath: string,
  sectionKey: 'security' | 'feishu',
  listKey: string,
  value: string,
  mode: 'add' | 'remove',
): Promise<string[]> {
  let nextValues: string[] = [];
  await updateBridgeConfigFile(configPath, (raw) => {
    const section = ensureObject(raw[sectionKey]);
    const existing = Array.isArray(section[listKey]) ? section[listKey].filter((entry): entry is string => typeof entry === 'string') : [];
    const normalized = value.trim();
    nextValues =
      mode === 'add'
        ? Array.from(new Set([...existing, normalized]))
        : existing.filter((entry) => entry !== normalized);
    section[listKey] = nextValues;
    raw[sectionKey] = section;
  });
  return nextValues;
}

export async function removeProjectAlias(configPath: string, alias: string): Promise<void> {
  await updateBridgeConfigFile(configPath, (raw) => {
    const projects = ensureObject(raw.projects);
    delete projects[alias];
    raw.projects = projects;
  });
}

export async function updateProjectConfig(
  configPath: string,
  alias: string,
  patch: Partial<ProjectConfig>,
): Promise<ProjectConfig> {
  let nextProject: ProjectConfig | undefined;
  await updateBridgeConfigFile(configPath, (raw) => {
    const projects = ensureObject(raw.projects);
    const current = ensureObject(projects[alias]);
    const merged: Record<string, unknown> = {
      ...current,
      ...patch,
      ...(patch.root ? { root: path.resolve(patch.root) } : {}),
    };
    projects[alias] = merged;
    raw.projects = projects;
    nextProject = merged as unknown as ProjectConfig;
  });
  if (!nextProject) {
    throw new Error(`Failed to update project config: ${alias}`);
  }
  return nextProject;
}

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
