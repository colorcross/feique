import type { Backend, BackendRunOptions, BackendRunResult, BackendEvent, IndexedSession } from './types.js';
import { runCodexTurn, summarizeCodexEvent } from '../codex/runner.js';
import { CodexSessionIndex } from '../codex/session-index.js';
import type { SandboxMode } from '../config/schema.js';

export interface CodexBackendConfig {
  bin: string;
  shell?: string;
  preExec?: string;
  defaultProfile?: string;
  defaultSandbox: SandboxMode;
  skipGitRepoCheck: boolean;
  runTimeoutMs: number;
}

export interface CodexProjectConfig {
  profile?: string;
  sandbox?: SandboxMode;
  tempDir?: string;
  cacheDir?: string;
}

export class CodexBackend implements Backend {
  public readonly name = 'codex' as const;

  constructor(
    private readonly config: CodexBackendConfig,
    private readonly sessionIndex: CodexSessionIndex = new CodexSessionIndex(),
  ) {}

  async run(options: BackendRunOptions & { projectConfig?: CodexProjectConfig }): Promise<BackendRunResult> {
    const result = await runCodexTurn({
      bin: this.config.bin,
      shell: this.config.shell,
      preExec: this.config.preExec,
      workdir: options.workdir,
      prompt: options.prompt,
      sessionId: options.sessionId,
      profile: options.projectConfig?.profile ?? this.config.defaultProfile,
      sandbox: options.projectConfig?.sandbox ?? this.config.defaultSandbox,
      tempDir: options.projectConfig?.tempDir,
      cacheDir: options.projectConfig?.cacheDir,
      skipGitRepoCheck: this.config.skipGitRepoCheck,
      timeoutMs: options.timeoutMs ?? this.config.runTimeoutMs,
      signal: options.signal,
      logger: options.logger,
      onEvent: options.onEvent ? async (event) => {
        await options.onEvent?.({
          type: event.type,
          session_id: event.thread_id,
          item: event.item,
          message: event.message,
          ...event,
        });
      } : undefined,
      onSpawn: options.onSpawn,
    });

    // The thread_id from Codex JSON events is the OpenAI API thread ID,
    // which differs from the Codex session file ID (payload.id).
    // We need the session file ID for `codex exec resume` to work.
    // Scan the session index to find the real session ID.
    let sessionId = result.sessionId;
    if (sessionId && options.workdir) {
      try {
        const latest = await this.sessionIndex.findLatestProjectSession(options.workdir);
        if (latest) {
          sessionId = latest.threadId;
        }
      } catch { /* best-effort: fall back to JSON event thread_id */ }
    }

    return {
      sessionId,
      finalMessage: result.finalMessage,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  summarizeEvent(event: BackendEvent): string | null {
    return summarizeCodexEvent({
      type: event.type,
      thread_id: event.session_id,
      item: event.item,
      message: event.message,
    });
  }

  async listProjectSessions(projectRoot: string, limit?: number): Promise<IndexedSession[]> {
    const sessions = await this.sessionIndex.listProjectSessions(projectRoot, limit);
    return sessions.map(s => ({
      sessionId: s.threadId,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      filePath: s.filePath,
      source: s.source,
      backend: 'codex' as const,
      matchKind: s.matchKind,
      matchScore: s.matchScore,
    }));
  }

  async findLatestSession(projectRoot: string): Promise<IndexedSession | null> {
    const session = await this.sessionIndex.findLatestProjectSession(projectRoot);
    if (!session) return null;
    return {
      sessionId: session.threadId,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      filePath: session.filePath,
      source: session.source,
      backend: 'codex' as const,
      matchKind: session.matchKind,
      matchScore: session.matchScore,
    };
  }

  async findSessionById(projectRoot: string, sessionId: string): Promise<IndexedSession | null> {
    const session = await this.sessionIndex.findProjectSessionById(projectRoot, sessionId);
    if (!session) return null;
    return {
      sessionId: session.threadId,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      filePath: session.filePath,
      source: session.source,
      backend: 'codex' as const,
      matchKind: session.matchKind,
      matchScore: session.matchScore,
    };
  }
}
