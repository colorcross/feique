import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInitialConfig } from '../src/config/init.js';
import { loadBridgeConfig, loadBridgeConfigFile } from '../src/config/load.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
});

describe('config load', () => {
  it('merges global and project config layers', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-repo-'));
    tempDirs.push(home, repo);

    process.env.HOME = home;
    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    await fs.mkdir(path.join(home, '.feishu-bridge'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.feishu-bridge', 'config.toml'),
      [
        'version = 1',
        '',
        '[feishu]',
        'app_id = "env:FEISHU_APP_ID"',
        'app_secret = "env:FEISHU_APP_SECRET"',
        'transport = "long-connection"',
        '',
        '[projects.repo-a]',
        `root = "${repo}"`,
      ].join('\n'),
      'utf8',
    );

    await fs.mkdir(path.join(repo, '.feishu-bridge'), { recursive: true });
    await fs.writeFile(
      path.join(repo, '.feishu-bridge', 'config.toml'),
      [
        '[service]',
        'default_project = "repo-b"',
        '',
        '[projects.repo-b]',
        'root = "."',
        'session_scope = "chat-user"',
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadBridgeConfig({ cwd: repo });
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.config.service.default_project).toBe('repo-b');
    expect(loaded.config.projects['repo-a']?.root).toBe(repo);
    expect(loaded.config.projects['repo-b']?.root).toBe(repo);
    expect(loaded.config.feishu.app_id).toBe('cli_test');
  });

  it('defaults run_timeout_ms to 30 minutes and seeds init templates with the same value', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-home-'));
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-repo-'));
    tempDirs.push(home, repo);

    process.env.FEISHU_APP_ID = 'cli_test';
    process.env.FEISHU_APP_SECRET = 'secret_test';

    const configPath = path.join(home, '.feishu-bridge', 'config.toml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[feishu]',
        'app_id = "env:FEISHU_APP_ID"',
        'app_secret = "env:FEISHU_APP_SECRET"',
        '',
        '[projects.repo-a]',
        `root = "${repo}"`,
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadBridgeConfigFile(configPath);
    expect(loaded.config.codex.run_timeout_ms).toBe(1_800_000);
    expect(buildInitialConfig('global', repo)).toContain('run_timeout_ms = 1800000');
    expect(buildInitialConfig('project', repo)).toContain('run_timeout_ms = 1800000');
  });
});
