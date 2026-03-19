import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as toml from '@iarna/toml';
import { ensureDir, fileExists } from '../utils/fs.js';

export async function installBundledCodexSkill(options: { skillSourceDir: string; skillName?: string }): Promise<{ skillPath: string; configPath: string }> {
  const skillName = options.skillName ?? 'feique-session';
  const skillTargetDir = path.join(os.homedir(), '.codex', 'skills', skillName);
  const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');

  await fs.rm(skillTargetDir, { recursive: true, force: true });
  await ensureDir(path.dirname(skillTargetDir));
  await fs.cp(options.skillSourceDir, skillTargetDir, { recursive: true });

  const config = (await loadCodexConfig(codexConfigPath)) ?? {};
  const existingSkills = Array.isArray(config.skills?.config) ? (config.skills.config as unknown[]) : [];
  const normalizedSkillPath = path.resolve(skillTargetDir);
  const hasEntry = existingSkills.some((entry: unknown) => isSkillEntry(entry, normalizedSkillPath));
  if (!hasEntry) {
    existingSkills.push({ path: normalizedSkillPath, enabled: true });
  }
  config.skills = {
    ...(isObject(config.skills) ? config.skills : {}),
    config: existingSkills,
  };

  await ensureDir(path.dirname(codexConfigPath));
  await fs.writeFile(codexConfigPath, toml.stringify(config as unknown as toml.JsonMap), 'utf8');

  return { skillPath: skillTargetDir, configPath: codexConfigPath };
}

async function loadCodexConfig(configPath: string): Promise<Record<string, any> | null> {
  if (!(await fileExists(configPath))) {
    return {};
  }
  const content = await fs.readFile(configPath, 'utf8');
  return toml.parse(content) as Record<string, any>;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSkillEntry(value: unknown, expectedPath: string): boolean {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.path === 'string' && path.resolve(value.path) === expectedPath;
}
