import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Logger } from '../logging.js';
import type { SandboxMode } from '../config/schema.js';
import { detectCodexCliCapabilities, type CodexCliCapabilities } from './capabilities.js';

export interface CodexRunOptions {
  bin: string;
  shell?: string;
  preExec?: string;
  workdir: string;
  prompt: string;
  sessionId?: string;
  profile?: string;
  sandbox: SandboxMode;
  tempDir?: string;
  cacheDir?: string;
  skipGitRepoCheck: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  logger: Logger;
  onEvent?: (event: CodexJsonEvent) => Promise<void> | void;
  onSpawn?: (pid: number) => Promise<void> | void;
}

export interface CodexRunResult {
  sessionId?: string;
  finalMessage: string;
  stderr: string;
  exitCode: number;
  capabilities: CodexCliCapabilities;
}

export interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    content?: unknown;
  };
  message?: string;
  [key: string]: unknown;
}

export async function runCodexTurn(options: CodexRunOptions): Promise<CodexRunResult> {
  const runtimeTempDir = options.tempDir ? path.resolve(options.tempDir) : os.tmpdir();
  await fs.mkdir(runtimeTempDir, { recursive: true });
  if (options.cacheDir) {
    await fs.mkdir(path.resolve(options.cacheDir), { recursive: true });
  }
  const outputFile = path.join(runtimeTempDir, `feique-${randomUUID()}.txt`);
  const capabilities = detectCodexCliCapabilities(options.bin);
  const args = buildCodexArgs(options, outputFile, capabilities);
  const spawnSpec = buildSpawnSpec(options, args);
  options.logger.info(
    { command: spawnSpec.command, args: spawnSpec.args, workdir: options.workdir, preExec: options.preExec, capabilities },
    'Starting Codex turn',
  );

  return await new Promise<CodexRunResult>((resolve, reject) => {
    const processRef = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.workdir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        ...(options.tempDir
          ? {
              TMPDIR: path.resolve(options.tempDir),
              TMP: path.resolve(options.tempDir),
              TEMP: path.resolve(options.tempDir),
            }
          : {}),
        ...(options.cacheDir ? { XDG_CACHE_HOME: path.resolve(options.cacheDir) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdoutBuffer = '';
    let sessionId = options.sessionId;
    let finalMessageFromEvents = '';
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let abortCleanup: (() => void) | undefined;

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const finishResolve = (result: CodexRunResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      abortCleanup?.();
      abortCleanup = undefined;
      void fs.rm(outputFile, { force: true });
    };

    const abortRun = (reason: unknown) => {
      if (processRef.killed) {
        return;
      }
      const error = createAbortError(reason);
      processRef.kill('SIGTERM');
      setTimeout(() => {
        if (!processRef.killed) {
          processRef.kill('SIGKILL');
        }
      }, 3000).unref();
      finishReject(error);
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        abortRun(`Codex timed out after ${options.timeoutMs}ms`);
      }, options.timeoutMs);
      timeoutHandle.unref();
    }

    if (options.signal) {
      const onAbort = () => abortRun(options.signal?.reason ?? 'Codex run aborted');
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
    }

    if (typeof processRef.pid === 'number') {
      void options.onSpawn?.(processRef.pid);
    }

    processRef.stdout.on('data', async (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
          continue;
        }

        try {
          const event = JSON.parse(trimmed) as CodexJsonEvent;
          if (!sessionId && event.thread_id) {
            sessionId = event.thread_id;
          }
          if (!sessionId && event.type === 'thread.started' && typeof event.thread_id === 'string') {
            sessionId = event.thread_id;
          }
          const assistantText = extractAssistantText(event);
          if (assistantText) {
            finalMessageFromEvents = assistantText;
          }
          await options.onEvent?.(event);
        } catch (error) {
          options.logger.debug({ line, error }, 'Ignoring unparsable Codex line');
        }
      }
    });

    processRef.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    processRef.on('error', (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    });

    processRef.on('close', async (exitCode) => {
      if (settled) {
        return;
      }

      try {
        const finalMessage = (await readFinalMessage(outputFile)) || finalMessageFromEvents.trim();
        if ((exitCode ?? 1) !== 0 && !finalMessage) {
          finishReject(new Error(`Codex exited with code ${exitCode ?? 1}: ${stderr.trim() || 'no stderr output'}`));
          return;
        }

        finishResolve({
          sessionId,
          finalMessage,
          stderr: stderr.trim(),
          exitCode: exitCode ?? 0,
          capabilities,
        });
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function buildSpawnSpec(options: Pick<CodexRunOptions, 'bin' | 'shell' | 'preExec'>, codexArgs: string[]): {
  command: string;
  args: string[];
} {
  if (!options.preExec) {
    return {
      command: options.bin,
      args: codexArgs,
    };
  }

  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh';
  const chainedCommand = `${options.preExec} && ${quoteShellCommand([options.bin, ...codexArgs])}`;
  return {
    command: shell,
    args: ['-ic', chainedCommand],
  };
}

export function buildCodexArgs(options: CodexRunOptions, outputFile: string, capabilities: CodexCliCapabilities): string[] {
  const sharedArgs: string[] = [];
  if (capabilities.exec.supportsJson) {
    sharedArgs.push('--json');
  }
  if (capabilities.exec.supportsOutputLastMessage && capabilities.resume.supportsOutputLastMessage) {
    sharedArgs.push('--output-last-message', outputFile);
  }
  if (options.skipGitRepoCheck && capabilities.exec.supportsJson && capabilities.resume.supportsJson) {
    sharedArgs.push('--skip-git-repo-check');
  }

  if (options.sessionId) {
    const args = ['exec', 'resume'];
    if (capabilities.resume.supportsJson) {
      args.push('--json');
    }
    if (capabilities.resume.supportsOutputLastMessage) {
      args.push('--output-last-message', outputFile);
    }
    if (options.skipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    args.push(options.sessionId, options.prompt);
    return args;
  }

  const args = ['exec'];
  if (capabilities.exec.supportsJson) {
    args.push('--json');
  }
  if (capabilities.exec.supportsOutputLastMessage) {
    args.push('--output-last-message', outputFile);
  }
  if (options.skipGitRepoCheck) {
    args.push('--skip-git-repo-check');
  }
  if (capabilities.exec.supportsCd) {
    args.push('-C', options.workdir);
  }
  if (capabilities.exec.supportsSandbox) {
    args.push('--sandbox', options.sandbox);
  }
  if (options.profile && capabilities.exec.supportsProfile) {
    args.push('--profile', options.profile);
  }
  args.push(options.prompt);
  return args;
}

function quoteShellCommand(parts: string[]): string {
  return parts.map((part) => quoteShellArg(part)).join(' ');
}

export function extractAssistantText(event: CodexJsonEvent): string {
  const item = isRecord(event.item) ? event.item : undefined;
  if (!item) {
    return '';
  }
  const itemType = typeof item.type === 'string' ? item.type : '';
  if (!['agent_message', 'assistant_message', 'message'].includes(itemType)) {
    return '';
  }
  const directText = typeof item.text === 'string' ? item.text.trim() : '';
  if (directText) {
    return directText;
  }
  return extractTextContent(item.content);
}

function extractTextContent(input: unknown): string {
  if (typeof input === 'string') {
    return input.trim();
  }
  if (Array.isArray(input)) {
    const text = input
      .map((part) => extractTextContent(part))
      .filter(Boolean)
      .join('\n')
      .trim();
    return text;
  }
  if (!isRecord(input)) {
    return '';
  }

  const nestedText = [
    typeof input.text === 'string' ? input.text : '',
    typeof input.content === 'string' ? input.content : extractTextContent(input.content),
    typeof input.value === 'string' ? input.value : extractTextContent(input.value),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
  if (nestedText) {
    return nestedText;
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function quoteShellArg(value: string): string {
  if (value.length === 0) {
    return "''";
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readFinalMessage(filePath: string): Promise<string> {
  try {
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch {
    return '';
  }
}

export function summarizeCodexEvent(event: CodexJsonEvent): string | null {
  if (event.type === 'turn.failed') {
    return 'Codex 处理失败。';
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    return `Codex 错误：${event.message}`;
  }
  return null;
}

function createAbortError(reason: unknown): Error {
  const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Codex run aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
