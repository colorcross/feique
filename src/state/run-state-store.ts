import path from 'node:path';
import { SerialExecutor } from '../utils/serial-executor.js';
import { ensureDir, fileExists, readUtf8, writeUtf8Atomic } from '../utils/fs.js';
import { isProcessAlive } from '../runtime/process.js';

export type RunStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'stale' | 'orphaned';

export interface RunState {
  run_id: string;
  queue_key: string;
  conversation_key: string;
  project_alias: string;
  chat_id: string;
  actor_id?: string;
  session_id?: string;
  project_root?: string;
  pid?: number;
  prompt_excerpt: string;
  status: RunStatus;
  status_detail?: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  error?: string;
}

interface RunStateFile {
  version: 1;
  runs: Record<string, RunState>;
}

const DEFAULT_STATE: RunStateFile = {
  version: 1,
  runs: {},
};

export class RunStateStore {
  private readonly filePath: string;
  private readonly serial = new SerialExecutor();

  public constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'runs.json');
  }

  public async upsertRun(
    runId: string,
    patch: Partial<RunState> & Pick<RunState, 'queue_key' | 'conversation_key' | 'project_alias' | 'chat_id' | 'prompt_excerpt' | 'status'>,
  ): Promise<RunState> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const existing = state.runs[runId];
      const now = nextMonotonicTimestamp(Object.values(state.runs).map((run) => run.updated_at));
      const next: RunState = {
        run_id: runId,
        queue_key: patch.queue_key,
        conversation_key: patch.conversation_key,
        project_alias: patch.project_alias,
        chat_id: patch.chat_id,
        prompt_excerpt: patch.prompt_excerpt,
        status: patch.status,
        started_at: existing?.started_at ?? now,
        updated_at: now,
        actor_id: pickPatchedValue(patch, 'actor_id', existing?.actor_id),
        session_id: pickPatchedValue(patch, 'session_id', existing?.session_id),
        project_root: pickPatchedValue(patch, 'project_root', existing?.project_root),
        pid: pickPatchedValue(patch, 'pid', existing?.pid),
        status_detail: pickPatchedValue(patch, 'status_detail', existing?.status_detail),
        finished_at: pickPatchedValue(patch, 'finished_at', existing?.finished_at),
        error: pickPatchedValue(patch, 'error', existing?.error),
      };
      if (isTerminalRunStatus(next.status)) {
        next.finished_at = patch.finished_at ?? now;
      } else {
        next.finished_at = undefined;
      }
      state.runs[runId] = next;
      await this.writeState(state);
      return next;
    });
  }

  public async getRun(runId: string): Promise<RunState | null> {
    await this.serial.wait();
    const state = await this.readState();
    return state.runs[runId] ?? null;
  }

  public async listRuns(): Promise<RunState[]> {
    await this.serial.wait();
    const state = await this.readState();
    return Object.values(state.runs).sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  public async getActiveRun(queueKey: string): Promise<RunState | null> {
    await this.serial.wait();
    const state = await this.readState();
    const active = Object.values(state.runs)
      .filter((run) => run.queue_key === queueKey && isExecutionRunStatus(run.status))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return active ?? null;
  }

  public async getLatestVisibleRun(queueKey: string): Promise<RunState | null> {
    await this.serial.wait();
    const state = await this.readState();
    const active = Object.values(state.runs)
      .filter((run) => run.queue_key === queueKey && isVisibleRunStatus(run.status))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return active ?? null;
  }

  public async listActiveRuns(): Promise<RunState[]> {
    await this.serial.wait();
    const state = await this.readState();
    return Object.values(state.runs)
      .filter((run) => isVisibleRunStatus(run.status))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  public async getExecutionRunByProjectRoot(projectRoot: string): Promise<RunState | null> {
    await this.serial.wait();
    const state = await this.readState();
    const active = Object.values(state.runs)
      .filter((run) => run.project_root === projectRoot && isExecutionRunStatus(run.status))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
    return active ?? null;
  }

  public async recoverOrphanedRuns(): Promise<RunState[]> {
    return this.serial.run(async () => {
      const state = await this.readState();
      const recovered: RunState[] = [];
      const now = new Date().toISOString();

      for (const run of Object.values(state.runs)) {
        if (run.status !== 'running') {
          continue;
        }
        if (run.pid && isProcessAlive(run.pid)) {
          run.status = 'orphaned';
          run.updated_at = now;
          recovered.push({ ...run });
          continue;
        }
        run.status = 'stale';
        run.finished_at = now;
        run.updated_at = now;
        recovered.push({ ...run });
      }

      if (recovered.length > 0) {
        await this.writeState(state);
      }
      return recovered;
    });
  }

  private async readState(): Promise<RunStateFile> {
    if (!(await fileExists(this.filePath))) {
      return structuredClone(DEFAULT_STATE);
    }

    const content = await readUtf8(this.filePath);
    const parsed = JSON.parse(content) as Partial<RunStateFile>;
    return {
      version: 1,
      runs: parsed.runs ?? {},
    };
  }

  private async writeState(state: RunStateFile): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await writeUtf8Atomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

function isExecutionRunStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'orphaned';
}

function isVisibleRunStatus(status: RunStatus): boolean {
  return status === 'queued' || isExecutionRunStatus(status);
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'success' || status === 'failure' || status === 'cancelled' || status === 'stale';
}

function pickPatchedValue<T extends keyof RunState>(patch: Partial<RunState>, key: T, fallback: RunState[T]): RunState[T] {
  return (Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : fallback) as RunState[T];
}

function nextMonotonicTimestamp(existingTimestamps: string[]): string {
  const now = Date.now();
  const latestExisting = existingTimestamps.reduce((max, value) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? max : Math.max(max, parsed);
  }, 0);
  return new Date(Math.max(now, latestExisting + 1)).toISOString();
}
