import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/state/run-state-store.js';

const tempDirs: string[] = [];
const servers: http.Server[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(repoRoot, 'src', 'cli.ts');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe('cli flow', () => {
  it('initializes a project config and binds a project alias', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-cli-'));
    tempDirs.push(cwd);

    const init = runCli(['init', '--mode', 'project'], { cwd });
    expect(init.status).toBe(0);
    expect(await exists(path.join(cwd, '.codex-feishu', 'config.toml'))).toBe(true);

    const repoPath = path.join(cwd, 'repo-a');
    await fs.mkdir(repoPath, { recursive: true });
    const bind = runCli(['bind', 'repo-a', repoPath, '--config', path.join(cwd, '.codex-feishu', 'config.toml')], { cwd });
    expect(bind.status).toBe(0);

    const print = runCli(['print-config', '--config', path.join(cwd, '.codex-feishu', 'config.toml')], {
      cwd,
      env: {
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret_test',
      },
    });
    expect(print.status).toBe(0);
    expect(print.stdout).toContain('repo-a');
    expect(print.stdout).toContain('<redacted>');
  });

  it('prints service instructions without writing system state', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-service-'));
    tempDirs.push(cwd);

    const result = runCli(['service', 'print', '--platform', 'linux', '--working-dir', cwd], { cwd });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('systemctl --user enable --now');
    expect(result.stdout).toContain('ExecStart=');
  });

  it('bind uses the global config by default when no project config exists', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-bind-global-'));
    tempDirs.push(home, cwd);

    const env = {
      HOME: home,
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: 'secret_test',
    };

    const init = runCli(['init', '--mode', 'global'], { cwd, env });
    expect(init.status).toBe(0);

    const repoPath = path.join(cwd, 'repo-global');
    await fs.mkdir(repoPath, { recursive: true });

    const bind = runCli(['bind', 'repo-global', repoPath], { cwd, env });
    expect(bind.status).toBe(0);

    const print = runCli(['print-config'], { cwd, env });
    expect(print.status).toBe(0);
    expect(print.stdout).toContain('repo-global');
  });

  it('surfaces missing environment variables through doctor when config load fails', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-doctor-cli-'));
    tempDirs.push(home, cwd);

    await fs.mkdir(path.join(home, '.codex-feishu'), { recursive: true });
    await fs.writeFile(
      path.join(home, '.codex-feishu', 'config.toml'),
      [
        'version = 1',
        '',
        '[feishu]',
        'app_id = "env:CLI_DOCTOR_APP_ID"',
        'app_secret = "env:CLI_DOCTOR_APP_SECRET"',
        '',
        '[projects.default]',
        `root = "${cwd}"`,
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['doctor'], {
      cwd,
      env: {
        HOME: home,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Missing environment variable: CLI_DOCTOR_APP_ID');
    expect(result.stdout).toContain('Missing environment variable: CLI_DOCTOR_APP_SECRET');
  });

  it('fails fast on serve when startup doctor finds blocking errors', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-serve-'));
    tempDirs.push(home, cwd);

    const configPath = path.join(cwd, 'bridge.toml');
    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[codex]',
        `bin = "${process.execPath}"`,
        '',
        '[feishu]',
        'app_id = "app-id"',
        'app_secret = "app-secret"',
        'transport = "webhook"',
        'event_path = "/shared"',
        'card_path = "/shared"',
        '',
        '[service]',
        'default_project = "missing-project"',
        '',
        '[projects.repo-a]',
        `root = "${cwd}"`,
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['serve', '--config', configPath], {
      cwd,
      env: {
        HOME: home,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Doctor failed with blocking errors');
  });

  it('prints doctor findings as json', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-doctor-json-'));
    tempDirs.push(home, cwd);
    const fakeCodex = path.join(cwd, 'fake-codex');
    await fs.writeFile(
      fakeCodex,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        '  echo "codex-cli 0.98.0"',
        '  exit 0',
        'fi',
        'if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then',
        '  echo "Usage: codex exec"',
        '  echo "  -C, --cd <DIR>"',
        '  echo "  --json"',
        '  echo "  -o, --output-last-message <FILE>"',
        '  exit 0',
        'fi',
        'if [ "$1" = "exec" ] && [ "$2" = "resume" ] && [ "$3" = "--help" ]; then',
        '  echo "Usage: codex exec resume"',
        '  echo "  --json"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
      'utf8',
    );
    await fs.chmod(fakeCodex, 0o755);

    const configPath = path.join(cwd, 'bridge.toml');
    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[codex]',
        `bin = "${fakeCodex}"`,
        '',
        '[feishu]',
        'app_id = "app-id"',
        'app_secret = "app-secret"',
        'transport = "webhook"',
        '',
        '[projects.repo-a]',
        `root = "${cwd}"`,
      ].join('\n'),
      'utf8',
    );

    const result = runCli(['doctor', '--json', '--config', configPath], {
      cwd,
      env: {
        HOME: home,
      },
    });
    expect(result.status).toBe(0);
    const findings = JSON.parse(result.stdout) as Array<{ level: string; message: string }>;
    expect(findings.some((finding) => finding.level === 'info' && finding.message.includes('Codex detected'))).toBe(true);
    expect(findings.some((finding) => finding.level === 'warn' && finding.message.includes('verification_token'))).toBe(true);
  });

  it('runs webhook smoke against a local endpoint', async () => {
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        if (request.url === '/healthz') {
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ ok: true }));
          return;
        }

        if (request.url === '/webhook/event' || request.url === '/webhook/card') {
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(body || JSON.stringify({ ok: true }));
          return;
        }

        response.statusCode = 404;
        response.end('not found');
      });
    });
    servers.push(server);

    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address() as { port: number });
      });
    });

    const result = await runCliAsync(['webhook', 'smoke', '--base-url', `http://127.0.0.1:${address.port}`], {
      cwd: repoRoot,
    });

    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      ok: boolean;
      health: { statusCode: number };
      message: { statusCode: number };
      card: { statusCode: number };
    };
    expect(summary.ok).toBe(true);
    expect(summary.health.statusCode).toBe(200);
    expect(summary.message.statusCode).toBe(200);
    expect(summary.card.statusCode).toBe(200);
  });

  it('inspects and stops runtime state through runtime management commands without requiring Feishu secrets', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-runtime-home-'));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-runtime-cli-'));
    tempDirs.push(home, cwd);
    const stateDir = path.join(cwd, 'state');
    await fs.mkdir(stateDir, { recursive: true });

    const configPath = path.join(cwd, 'bridge.toml');
    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[service]',
        'name = "runtime-test"',
        'default_project = "repo-a"',
        'log_tail_lines = 100',
        '',
        '[storage]',
        `dir = "${stateDir}"`,
        '',
        '[feishu]',
        'app_id = "env:RUNTIME_TEST_APP_ID"',
        'app_secret = "env:RUNTIME_TEST_APP_SECRET"',
        '',
        '[projects.repo-a]',
        `root = "${cwd}"`,
      ].join('\n'),
      'utf8',
    );

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    await fs.writeFile(path.join(stateDir, 'runtime-test.pid'), `${child.pid}\n`, 'utf8');
    await fs.writeFile(path.join(stateDir, 'runtime-test.log'), ['line-1', 'line-2', 'line-3'].join('\n'), 'utf8');

    const runStateStore = new RunStateStore(stateDir);
    await runStateStore.upsertRun('run-1', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      prompt_excerpt: 'hello',
      status: 'orphaned',
      pid: child.pid,
    });

    const runtimeEnv = { HOME: home };

    const status = runCli(['status', '--config', configPath], { cwd, env: runtimeEnv });
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('running: true');
    expect(status.stdout).toContain('active_runs: 1');

    const serveStatus = runCli(['serve', 'status', '--config', configPath], { cwd, env: runtimeEnv });
    expect(serveStatus.status).toBe(0);
    expect(serveStatus.stdout).toContain('running: true');

    const logs = runCli(['logs', '--config', configPath, '--lines', '2'], { cwd, env: runtimeEnv });
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain('line-2');
    expect(logs.stdout).toContain('line-3');
    expect(logs.stdout).not.toContain('line-1');

    const followedLogs = await captureFollowLogs(['logs', '--config', configPath, '--lines', '2', '--follow'], {
      cwd,
      env: runtimeEnv,
      append: async () => {
        await fs.appendFile(path.join(stateDir, 'runtime-test.log'), '\nline-4\n', 'utf8');
      },
      until: 'line-4',
    });
    expect(followedLogs).toContain('line-2');
    expect(followedLogs).toContain('line-3');
    expect(followedLogs).toContain('line-4');

    const ps = runCli(['ps', '--config', configPath], { cwd, env: runtimeEnv });
    expect(ps.status).toBe(0);
    const runs = JSON.parse(ps.stdout) as Array<{ run_id: string; status: string }>;
    expect(runs).toEqual([
      expect.objectContaining({
        run_id: 'run-1',
        status: 'orphaned',
      }),
    ]);

    const stop = runCli(['stop', '--config', configPath, '--force', '--wait-ms', '1000'], { cwd, env: runtimeEnv });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toContain('Stopped bridge pid');
    await waitForProcessExit(child.pid ?? 0);
  });

  it('bootstraps a global config through the install script without requiring --config afterwards', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-install-home-'));
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-install-project-'));
    tempDirs.push(home, projectRoot);

    const result = spawnSync('bash', [path.join(repoRoot, 'scripts', 'install.sh'), '--skip-global-install', '--project-root', projectRoot, '--alias', 'repo-install'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        NODE_ENV: 'test',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(await exists(path.join(home, '.codex-feishu', 'config.toml'))).toBe(true);

    const print = runCli(['print-config'], {
      cwd: projectRoot,
      env: {
        HOME: home,
        FEISHU_APP_ID: 'cli_test',
        FEISHU_APP_SECRET: 'secret_test',
      },
    });
    expect(print.status).toBe(0);
    expect(print.stdout).toContain('repo-install');
    expect(print.stdout).toContain(projectRoot);
  });
});

function runCli(args: string[], options: { cwd: string; env?: Record<string, string> }) {
  return spawnSync(tsxBin, [cliEntry, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      NODE_ENV: 'test',
    },
    encoding: 'utf8',
  });
}

function runCliAsync(args: string[], options: { cwd: string; env?: Record<string, string> }) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function captureFollowLogs(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; append: () => Promise<void>; until: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let appendTriggered = false;
    let done = false;

    const finish = (error?: Error) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    };

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`Timed out waiting for ${options.until} in follow logs.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (!appendTriggered && stdout.includes('line-3')) {
        appendTriggered = true;
        void options.append().catch((error) => finish(error as Error));
      }
      if (stdout.includes(options.until)) {
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (status, signal) => {
      if (signal && signal !== 'SIGINT') {
        finish(new Error(`Follow logs exited with signal ${signal}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      if (status !== 0 && status !== null && !stdout.includes(options.until)) {
        finish(new Error(`Follow logs exited with status ${status}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      finish();
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(isPidAlive(pid)).toBe(false);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
