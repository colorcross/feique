import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { Backend, BackendEvent, BackendRunOptions, BackendRunResult, IndexedSession, SessionMatchKind, SessionSource } from './types.js';
import type { Logger } from '../logging.js';

export type ClaudePermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan' | 'auto';

export interface ClaudeBackendConfig {
  bin: string;
  shell?: string;
  preExec?: string;
  defaultPermissionMode: ClaudePermissionMode;
  defaultModel?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  systemPromptAppend?: string;
  runTimeoutMs: number;
}

export interface ClaudeProjectConfig {
  permissionMode?: ClaudePermissionMode;
  model?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  systemPromptAppend?: string;
}

interface ClaudeStreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  message?: {
    id?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  [key: string]: unknown;
}

export class ClaudeBackend implements Backend {
  public readonly name = 'claude' as const;

  public constructor(
    private readonly config: ClaudeBackendConfig,
    private readonly claudeHomeDir: string = resolveClaudeHomeDir(),
  ) {}

  public async run(options: BackendRunOptions & { projectConfig?: ClaudeProjectConfig }): Promise<BackendRunResult> {
    const args = this.buildArgs(options);
    const spawnSpec = this.buildSpawnSpec(args);

    options.logger.info(
      { command: spawnSpec.command, args: spawnSpec.args, workdir: options.workdir },
      'Starting Claude turn',
    );

    return await new Promise<BackendRunResult>((resolve, reject) => {
      const processRef = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: options.workdir,
        env: {
          ...process.env,
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let stdoutBuffer = '';
      let sessionId = options.sessionId;
      let finalMessage = '';
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let abortCleanup: (() => void) | undefined;

      const finishReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const finishResolve = (result: BackendRunResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const cleanup = () => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        abortCleanup?.();
        abortCleanup = undefined;
      };

      const abortRun = (reason: unknown) => {
        if (processRef.killed) return;
        const message = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Claude run aborted';
        const error = new Error(message);
        error.name = 'AbortError';
        processRef.kill('SIGTERM');
        setTimeout(() => {
          if (!processRef.killed) processRef.kill('SIGKILL');
        }, 3000).unref();
        finishReject(error);
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          abortRun(`Claude timed out after ${options.timeoutMs}ms`);
        }, options.timeoutMs);
        timeoutHandle.unref();
      }

      if (options.signal) {
        const onAbort = () => abortRun(options.signal?.reason ?? 'Claude run aborted');
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
          if (!trimmed.startsWith('{')) continue;

          try {
            const event = JSON.parse(trimmed) as ClaudeStreamEvent;

            // Extract session_id from result event
            if (event.type === 'result' && event.session_id) {
              sessionId = event.session_id;
            }

            // Extract final text and token usage from result event
            if (event.type === 'result' && typeof event.result === 'string') {
              finalMessage = event.result;
            }
            if (event.type === 'result') {
              if (typeof event.total_input_tokens === 'number') inputTokens = event.total_input_tokens;
              if (typeof event.total_output_tokens === 'number') outputTokens = event.total_output_tokens;
            }

            // Extract assistant text from assistant messages
            if (event.type === 'assistant' && event.message?.content) {
              const texts = event.message.content
                .filter(c => c.type === 'text' && typeof c.text === 'string')
                .map(c => c.text!)
                .join('\n');
              if (texts) {
                finalMessage = texts;
              }
            }

            // Forward as unified BackendEvent
            const backendEvent: BackendEvent = {
              type: event.type,
              session_id: event.session_id ?? sessionId,
              message: typeof event.result === 'string' ? event.result : undefined,
            };
            await options.onEvent?.(backendEvent);
          } catch {
            options.logger.debug({ line }, 'Ignoring unparsable Claude line');
          }
        }
      });

      processRef.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      processRef.on('error', (error) => {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      });

      processRef.on('close', (exitCode) => {
        if (settled) return;

        if ((exitCode ?? 1) !== 0 && !finalMessage) {
          finishReject(new Error(`Claude exited with code ${exitCode ?? 1}: ${stderr.trim() || 'no stderr output'}`));
          return;
        }

        finishResolve({
          sessionId,
          finalMessage: finalMessage.trim(),
          stderr: stderr.trim(),
          exitCode: exitCode ?? 0,
          inputTokens,
          outputTokens,
        });
      });
    });
  }

  public summarizeEvent(event: BackendEvent): string | null {
    if (event.type === 'error' && typeof event.message === 'string') {
      return `Claude 错误：${event.message}`;
    }
    return null;
  }

  public async listProjectSessions(projectRoot: string, limit: number = 10): Promise<IndexedSession[]> {
    const sessions = await this.scanSessions();
    const matches: IndexedSession[] = [];
    for (const session of sessions) {
      const match = scoreSessionMatch(projectRoot, session.cwd);
      if (!match) continue;
      matches.push({
        ...session,
        matchKind: match.kind,
        matchScore: match.score,
      });
    }
    return matches
      .sort((a, b) => {
        const scoreDelta = (b.matchScore ?? 0) - (a.matchScore ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit);
  }

  public async findLatestSession(projectRoot: string): Promise<IndexedSession | null> {
    const [session] = await this.listProjectSessions(projectRoot, 1);
    return session ?? null;
  }

  public async findSessionById(projectRoot: string, sessionId: string): Promise<IndexedSession | null> {
    const sessions = await this.scanSessions();
    const candidate = sessions.find(s => s.sessionId === sessionId);
    if (!candidate) return null;
    const match = scoreSessionMatch(projectRoot, candidate.cwd);
    if (!match) return null;
    return { ...candidate, matchKind: match.kind, matchScore: match.score };
  }

  private buildArgs(options: BackendRunOptions & { projectConfig?: ClaudeProjectConfig }): string[] {
    const args: string[] = ['-p', '--verbose'];
    args.push('--output-format', 'stream-json');

    const permissionMode = options.projectConfig?.permissionMode ?? this.config.defaultPermissionMode;
    args.push('--permission-mode', permissionMode);

    const model = options.projectConfig?.model ?? this.config.defaultModel;
    if (model) {
      args.push('--model', model);
    }

    const maxBudget = options.projectConfig?.maxBudgetUsd ?? this.config.maxBudgetUsd;
    if (maxBudget !== undefined && maxBudget > 0) {
      args.push('--max-budget-usd', String(maxBudget));
    }

    const allowedTools = options.projectConfig?.allowedTools ?? this.config.allowedTools;
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowedTools', ...allowedTools);
    }

    const systemPromptAppend = options.projectConfig?.systemPromptAppend ?? this.config.systemPromptAppend;
    if (systemPromptAppend) {
      args.push('--append-system-prompt', systemPromptAppend);
    }

    if (options.sessionId) {
      args.push('--resume', options.sessionId);
    }

    args.push(options.prompt);
    return args;
  }

  private buildSpawnSpec(claudeArgs: string[]): { command: string; args: string[] } {
    if (!this.config.preExec) {
      return { command: this.config.bin, args: claudeArgs };
    }
    const shell = this.config.shell ?? process.env.SHELL ?? '/bin/zsh';
    const chainedCommand = `${this.config.preExec} && ${quoteShellCommand([this.config.bin, ...claudeArgs])}`;
    return { command: shell, args: ['-ic', chainedCommand] };
  }

  private async scanSessions(): Promise<IndexedSession[]> {
    const sessionsDir = path.join(this.claudeHomeDir, 'sessions');
    const sessions = new Map<string, IndexedSession>();

    let entries: string[];
    try {
      entries = await fs.readdir(sessionsDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      const sessionDir = path.join(sessionsDir, entry);
      const stat = await fs.stat(sessionDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      // Claude sessions are stored as directories with session files inside
      // The directory name is the session ID
      const sessionId = entry;
      const sessionFiles = await fs.readdir(sessionDir).catch(() => [] as string[]);

      // Look for session metadata - Claude stores conversation.jsonl or similar
      let cwd = '';
      let updatedAt = new Date(stat.mtimeMs).toISOString();
      let createdAt: string | undefined;

      // Try to read session metadata from the first jsonl file
      for (const file of sessionFiles) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(sessionDir, file);
        try {
          const content = await fs.readFile(filePath, 'utf8');
          const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
          if (!firstLine) continue;
          const parsed = JSON.parse(firstLine);
          if (parsed.cwd || parsed.working_directory) {
            cwd = parsed.cwd ?? parsed.working_directory ?? '';
          }
          if (parsed.timestamp) {
            createdAt = parsed.timestamp;
          }
          break;
        } catch {
          continue;
        }
      }

      // If no cwd found from jsonl, try reading from session config
      if (!cwd) {
        try {
          const configPath = path.join(sessionDir, 'config.json');
          const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
          cwd = config.cwd ?? config.working_directory ?? '';
        } catch {
          // ignore
        }
      }

      if (!cwd) continue;

      const existing = sessions.get(sessionId);
      if (!existing || existing.updatedAt < updatedAt) {
        sessions.set(sessionId, {
          sessionId,
          cwd,
          updatedAt,
          createdAt,
          filePath: sessionDir,
          source: 'sessions',
          backend: 'claude',
        });
      }
    }

    return [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function resolveClaudeHomeDir(): string {
  const configured = process.env.CLAUDE_HOME?.trim();
  if (!configured) return path.join(os.homedir(), '.claude');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/')) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

function quoteShellArg(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteShellCommand(parts: string[]): string {
  return parts.map(quoteShellArg).join(' ');
}

const FUZZY_SUFFIX_TOKENS = new Set(['bridge', 'repo', 'project', 'workspace']);

function scoreSessionMatch(projectRoot: string, sessionCwd: string): { kind: SessionMatchKind; score: number } | null {
  const normalizedProjectRoot = path.resolve(projectRoot).replace(/\/+$/, '').toLowerCase();
  const normalizedSessionRoot = path.resolve(sessionCwd).replace(/\/+$/, '').toLowerCase();

  if (normalizedProjectRoot === normalizedSessionRoot) {
    return { kind: 'exact-root', score: 100 };
  }

  const projectBase = path.basename(normalizedProjectRoot);
  const sessionBase = path.basename(normalizedSessionRoot);
  if (projectBase === sessionBase) {
    return { kind: 'basename', score: 80 };
  }

  const normalizedProjectName = normalizeProjectName(projectBase);
  const normalizedSessionName = normalizeProjectName(sessionBase);
  if (normalizedProjectName && normalizedProjectName === normalizedSessionName) {
    return { kind: 'normalized-name', score: 60 };
  }

  if (normalizedProjectName.length >= 5 && normalizedSessionName.includes(normalizedProjectName)) {
    return { kind: 'basename-contains', score: 40 };
  }

  return null;
}

function normalizeProjectName(input: string): string {
  const tokens = input
    .toLowerCase()
    .replace(/\.git$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const filtered = tokens.filter(token => !FUZZY_SUFFIX_TOKENS.has(token));
  return (filtered.length > 0 ? filtered : tokens).join('-');
}
