import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { ClaudeBackend } from '../src/backend/claude.js';
import type { ClaudeBackendConfig, ClaudeProjectConfig } from '../src/backend/claude.js';
import type { Logger } from '../src/logging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
  fatal: () => {},
  trace: () => {},
  silent: () => {},
  level: 'silent',
  isLevelEnabled: () => false,
} as unknown as Logger;

function baseConfig(overrides?: Partial<ClaudeBackendConfig>): ClaudeBackendConfig {
  return {
    bin: 'claude',
    defaultPermissionMode: 'auto',
    runTimeoutMs: 60_000,
    ...overrides,
  };
}

/**
 * Mock child_process.spawn at module level so ClaudeBackend picks it up.
 * Each test can inspect `spawnCalls` to see what command + args were used.
 */
const spawnCalls: Array<{ command: string; args: string[] }> = [];

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], _opts?: unknown) => {
    spawnCalls.push({ command, args: [...args] });

    // Return a minimal ChildProcess-like emitter that immediately closes with code 0
    const proc = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      pid: number;
      killed: boolean;
      kill: () => void;
    };
    proc.stdout = new Readable({ read() {} });
    proc.stderr = new Readable({ read() {} });
    proc.pid = 12345;
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
    };

    // Emit a result event on stdout, then close
    process.nextTick(() => {
      const resultEvent = JSON.stringify({ type: 'result', session_id: 'sess-1', result: 'done' });
      proc.stdout.push(`${resultEvent}\n`);
      proc.stdout.push(null);
      proc.stderr.push(null);
      proc.emit('close', 0);
    });

    return proc;
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeBackend args building', () => {
  it('builds basic args: -p --verbose --output-format stream-json --permission-mode auto <prompt>', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig());

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'hello world',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toEqual([
      '-p', '--verbose',
      '--output-format', 'stream-json',
      '--permission-mode', 'auto',
      'hello world',
    ]);
  });

  it('adds --resume <session_id> when sessionId is provided', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig());

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'follow up',
      sessionId: 'sess-42',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toContain('--resume');
    expect(args).toContain('sess-42');
    // --resume should come before the prompt
    const resumeIndex = args.indexOf('--resume');
    const promptIndex = args.indexOf('follow up');
    expect(resumeIndex).toBeLessThan(promptIndex);
  });

  it('adds --model when model is configured', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig({ defaultModel: 'sonnet' }));

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'test',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
  });

  it('adds --max-budget-usd when maxBudgetUsd is configured', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig({ maxBudgetUsd: 5 }));

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'test',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('5');
  });

  it('adds --allowedTools when allowedTools is configured', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig({ allowedTools: ['Bash', 'Edit'] }));

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'test',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Bash');
    expect(args).toContain('Edit');
  });

  it('uses project-level config overrides over defaults', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig({ defaultModel: 'sonnet', maxBudgetUsd: 5 }));

    const projectConfig: ClaudeProjectConfig = {
      model: 'opus',
      maxBudgetUsd: 10,
      permissionMode: 'plan',
      allowedTools: ['Read'],
    };

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'test',
      logger: noopLogger,
      projectConfig: projectConfig as Record<string, unknown>,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toContain('--model');
    expect(args).toContain('opus');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('10');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read');
    // Should NOT contain the default values
    expect(args).not.toContain('sonnet');
    expect(args).not.toContain('5');
    expect(args).not.toContain('auto');
  });

  it('wraps with shell when preExec is configured', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig({ preExec: 'proxy_on', shell: '/bin/zsh' }));

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'test',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { command, args } = spawnCalls[0]!;
    expect(command).toBe('/bin/zsh');
    expect(args[0]).toBe('-ic');
    expect(args[1]).toContain('proxy_on &&');
    expect(args[1]).toContain("'claude'");
  });

  it('adds --append-system-prompt when systemPromptAppend is configured', async () => {
    spawnCalls.length = 0;
    const backend = new ClaudeBackend(baseConfig({ systemPromptAppend: 'Always respond in English' }));

    await backend.run({
      workdir: '/tmp/repo',
      prompt: 'test',
      logger: noopLogger,
    });

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0]!;
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('Always respond in English');
  });
});
