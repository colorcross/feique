import fs from 'node:fs/promises';
import path from 'node:path';
import * as toml from '@iarna/toml';
import { ZodError } from 'zod';
import { z } from 'zod';
import { fileExists, readUtf8 } from '../utils/fs.js';
import { expandHomePath, resolveMaybeRelative } from '../utils/path.js';
import { PROJECT_CONFIG_RELATIVE_PATH, getGlobalConfigPath } from './paths.js';
import { bridgeConfigSchema, type BridgeConfig } from './schema.js';

export interface LoadedConfig {
  config: BridgeConfig;
  sources: string[];
}

export interface LoadedRuntimeConfig {
  config: {
    service: {
      name: string;
      log_tail_lines: number;
      log_rotate_max_bytes: number;
      log_rotate_keep_files: number;
    };
    storage: {
      dir: string;
    };
  };
  sources: string[];
}

interface ConfigLayer {
  path: string;
  value: Record<string, unknown>;
}

export async function loadBridgeConfig(options: { cwd?: string; configPath?: string } = {}): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const layers = await loadConfigLayers({ ...(options.configPath ? { configPath: options.configPath } : {}), cwd });
  if (layers.length === 0) {
    throw new Error(
      `No config found. Run \`feique init --mode global\` or create ${PROJECT_CONFIG_RELATIVE_PATH}.`,
    );
  }

  const merged = layers.reduce<Record<string, unknown>>((accumulator, layer) => deepMerge(accumulator, layer.value), {});

  try {
    const config = bridgeConfigSchema.parse(merged);
    return {
      config,
      sources: layers.map((layer) => layer.path),
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid config: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    throw error;
  }
}

export async function loadBridgeConfigFile(configPath: string, behavior: { resolveEnv?: boolean } = {}): Promise<LoadedConfig> {
  const explicitPath = path.resolve(expandHomePath(configPath));
  const layer = await readLayerIfExists(explicitPath, { resolveEnv: behavior.resolveEnv ?? true });
  if (!layer) {
    throw new Error(`Config file not found: ${explicitPath}`);
  }

  try {
    const config = bridgeConfigSchema.parse(layer.value);
    return {
      config,
      sources: [layer.path],
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid config: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    throw error;
  }
}

const runtimeConfigSchema = z.object({
  service: z
    .object({
      name: z.string().default('feique'),
      log_tail_lines: z.number().int().positive().default(100),
      log_rotate_max_bytes: z.number().int().positive().default(10 * 1024 * 1024),
      log_rotate_keep_files: z.number().int().positive().default(5),
    })
    .default({
      name: 'feique',
      log_tail_lines: 100,
      log_rotate_max_bytes: 10 * 1024 * 1024,
      log_rotate_keep_files: 5,
    }),
  storage: z
    .object({
      dir: z.string().default('~/.feique/state'),
    })
    .default({
      dir: '~/.feique/state',
    }),
});

export async function loadRuntimeConfig(options: { cwd?: string; configPath?: string } = {}): Promise<LoadedRuntimeConfig> {
  const cwd = options.cwd ?? process.cwd();
  const layers = await loadConfigLayers({ ...(options.configPath ? { configPath: options.configPath } : {}), cwd }, { resolveEnv: false });
  if (layers.length === 0) {
    throw new Error(
      `No config found. Run \`feique init --mode global\` or create ${PROJECT_CONFIG_RELATIVE_PATH}.`,
    );
  }

  const merged = layers.reduce<Record<string, unknown>>((accumulator, layer) => deepMerge(accumulator, layer.value), {});

  try {
    const config = runtimeConfigSchema.parse(merged);
    return {
      config,
      sources: layers.map((layer) => layer.path),
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Invalid runtime config: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    throw error;
  }
}

export async function findNearestProjectConfig(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);

  while (true) {
    const candidate = path.join(current, PROJECT_CONFIG_RELATIVE_PATH);
    if (await fileExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function loadConfigLayers(
  options: { cwd: string; configPath?: string },
  behavior: { resolveEnv?: boolean } = {},
): Promise<ConfigLayer[]> {
  const layers: ConfigLayer[] = [];
  const globalPath = getGlobalConfigPath();
  const resolveEnv = behavior.resolveEnv ?? true;

  if (!options.configPath) {
    const globalLayer = await readLayerIfExists(globalPath, { resolveEnv });
    if (globalLayer) {
      layers.push(globalLayer);
    }

    const projectConfigPath = await findNearestProjectConfig(options.cwd);
    if (projectConfigPath && path.resolve(projectConfigPath) !== path.resolve(globalPath)) {
      const projectLayer = await readLayerIfExists(projectConfigPath, { resolveEnv });
      if (projectLayer) {
        layers.push(projectLayer);
      }
    }

    return layers;
  }

  const explicitPath = path.resolve(expandHomePath(options.configPath));
  if (path.resolve(globalPath) !== explicitPath) {
    const globalLayer = await readLayerIfExists(globalPath, { resolveEnv });
    if (globalLayer) {
      layers.push(globalLayer);
    }
  }

  const explicitLayer = await readLayerIfExists(explicitPath, { resolveEnv });
  if (!explicitLayer) {
    throw new Error(`Config file not found: ${explicitPath}`);
  }
  layers.push(explicitLayer);
  return layers;
}

async function readLayerIfExists(filePath: string, behavior: { resolveEnv?: boolean } = {}): Promise<ConfigLayer | null> {
  const resolvedPath = path.resolve(expandHomePath(filePath));
  if (!(await fileExists(resolvedPath))) {
    return null;
  }
  const content = await readUtf8(resolvedPath);
  const parsed = toml.parse(content) as Record<string, unknown>;
  const maybeResolved = behavior.resolveEnv === false ? parsed : resolveEnvRefs(parsed);
  if (!isPlainObject(maybeResolved)) {
    throw new Error(`Invalid TOML structure in ${resolvedPath}`);
  }
  const resolved = resolveLayerPaths(maybeResolved, resolveLayerBaseDir(resolvedPath));
  return { path: resolvedPath, value: resolved };
}


function resolveLayerBaseDir(configPath: string): string {
  const configDir = path.dirname(configPath);
  if (path.basename(configDir) === '.feique') {
    return path.dirname(configDir);
  }
  return configDir;
}

function resolveEnvRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvRefs(item));
  }

  if (isPlainObject(value)) {
    const resolvedEntries = Object.entries(value).map(([key, innerValue]) => [key, resolveEnvRefs(innerValue)]);
    return Object.fromEntries(resolvedEntries);
  }

  if (typeof value === 'string' && value.startsWith('env:')) {
    const envKey = value.slice(4).trim();
    const envValue = process.env[envKey];
    if (!envValue) {
      throw new Error(`Missing environment variable: ${envKey}`);
    }
    return envValue;
  }

  return value;
}

function resolveLayerPaths(raw: Record<string, unknown>, baseDir: string): Record<string, unknown> {
  const cloned = structuredClone(raw);
  const storage = asObject(cloned.storage);
  if (storage?.dir && typeof storage.dir === 'string') {
    storage.dir = resolveMaybeRelative(storage.dir, baseDir);
  }

  const service = asObject(cloned.service);
  if (service?.transcribe_cli_path && typeof service.transcribe_cli_path === 'string') {
    service.transcribe_cli_path = resolveMaybeRelative(service.transcribe_cli_path, baseDir);
  }

  const projects = asObject(cloned.projects);
  if (projects) {
    for (const projectValue of Object.values(projects)) {
      const projectConfig = asObject(projectValue);
      if (!projectConfig) {
        continue;
      }
      if (typeof projectConfig.root === 'string') {
        projectConfig.root = resolveMaybeRelative(projectConfig.root, baseDir);
      }
      if (typeof projectConfig.instructions_prefix === 'string') {
        projectConfig.instructions_prefix = resolveMaybeRelative(projectConfig.instructions_prefix, baseDir);
      }
      if (typeof projectConfig.download_dir === 'string') {
        projectConfig.download_dir = resolveMaybeRelative(projectConfig.download_dir, baseDir);
      }
      if (typeof projectConfig.temp_dir === 'string') {
        projectConfig.temp_dir = resolveMaybeRelative(projectConfig.temp_dir, baseDir);
      }
      if (typeof projectConfig.cache_dir === 'string') {
        projectConfig.cache_dir = resolveMaybeRelative(projectConfig.cache_dir, baseDir);
      }
      if (typeof projectConfig.log_dir === 'string') {
        projectConfig.log_dir = resolveMaybeRelative(projectConfig.log_dir, baseDir);
      }
      if (Array.isArray(projectConfig.knowledge_paths)) {
        projectConfig.knowledge_paths = projectConfig.knowledge_paths.map((entry) =>
          typeof entry === 'string' ? resolveMaybeRelative(entry, baseDir) : entry,
        );
      }
    }
  }

  const codex = asObject(cloned.codex);
  if (codex?.bin && typeof codex.bin === 'string' && codex.bin.includes(path.sep)) {
    codex.bin = resolveMaybeRelative(codex.bin, baseDir);
  }

  return cloned;
}

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const currentValue = result[key];
    if (isPlainObject(currentValue) && isPlainObject(value)) {
      result[key] = deepMerge(currentValue, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export async function readRawToml(filePath: string): Promise<Record<string, unknown>> {
  const content = await fs.readFile(filePath, 'utf8');
  return toml.parse(content) as Record<string, unknown>;
}

export async function writeToml(filePath: string, data: Record<string, unknown>): Promise<void> {
  const content = toml.stringify(data as unknown as toml.JsonMap);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}
