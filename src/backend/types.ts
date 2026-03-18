import type { Logger } from '../logging.js';

// ---------------------------------------------------------------------------
// Backend name
// ---------------------------------------------------------------------------

export type BackendName = 'codex' | 'claude';

// ---------------------------------------------------------------------------
// Unified event emitted by both Codex and Claude CLIs
// ---------------------------------------------------------------------------

export interface BackendEvent {
  type?: string;
  session_id?: string;
  item?: {
    type?: string;
    text?: string;
    content?: unknown;
  };
  message?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Options passed to Backend.run()
// ---------------------------------------------------------------------------

export interface BackendRunOptions {
  workdir: string;
  prompt: string;
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  logger: Logger;
  onEvent?: (event: BackendEvent) => Promise<void> | void;
  onSpawn?: (pid: number) => Promise<void> | void;
  /** Backend-specific project config (CodexProjectConfig or ClaudeProjectConfig). */
  projectConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Result returned from Backend.run()
// ---------------------------------------------------------------------------

export interface BackendRunResult {
  sessionId?: string;
  finalMessage: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Indexed session — unified representation of Codex / Claude sessions
// ---------------------------------------------------------------------------

export type SessionSource = 'sessions' | 'archived';
export type SessionMatchKind =
  | 'exact-root'
  | 'basename'
  | 'normalized-name'
  | 'basename-contains';

export interface IndexedSession {
  sessionId: string;
  cwd: string;
  updatedAt: string;
  createdAt?: string;
  filePath: string;
  source: SessionSource;
  backend: BackendName;
  matchKind?: SessionMatchKind;
  matchScore?: number;
}

// ---------------------------------------------------------------------------
// Backend interface — implemented by each backend adapter
// ---------------------------------------------------------------------------

export interface Backend {
  readonly name: BackendName;
  run(options: BackendRunOptions): Promise<BackendRunResult>;
  listProjectSessions(
    projectRoot: string,
    limit?: number,
  ): Promise<IndexedSession[]>;
  findLatestSession(projectRoot: string): Promise<IndexedSession | null>;
  findSessionById(
    projectRoot: string,
    sessionId: string,
  ): Promise<IndexedSession | null>;
  summarizeEvent(event: BackendEvent): string | null;
}
