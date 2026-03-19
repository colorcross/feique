import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/state/run-state-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('run state store', () => {
  it('tracks active runs and recovers stale ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-runs-'));
    tempDirs.push(dir);
    const store = new RunStateStore(dir);

    await store.upsertRun('run-1', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      prompt_excerpt: 'hello',
      status: 'running',
      pid: 999999,
    });

    expect((await store.listActiveRuns()).map((run) => run.run_id)).toEqual(['run-1']);

    const recovered = await store.recoverOrphanedRuns();
    expect(recovered[0]?.status).toBe('stale');
    expect((await store.getRun('run-1'))?.status).toBe('stale');
  });

  it('keeps queued runs visible without marking them finished', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-runs-'));
    tempDirs.push(dir);
    const store = new RunStateStore(dir);

    await store.upsertRun('run-running', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      project_root: '/tmp/repo-a',
      prompt_excerpt: 'running',
      status: 'running',
      pid: 999999,
    });
    await store.upsertRun('run-queued', {
      queue_key: 'queue-b',
      conversation_key: 'conv-b',
      project_alias: 'repo-a',
      chat_id: 'chat-b',
      project_root: '/tmp/repo-a',
      prompt_excerpt: 'queued',
      status: 'queued',
      status_detail: '当前仓库正在被其他会话操作，已进入排队。',
    });

    expect((await store.getRun('run-queued'))?.finished_at).toBeUndefined();
    expect((await store.listActiveRuns()).map((run) => run.run_id)).toEqual(['run-queued', 'run-running']);
    expect((await store.getLatestVisibleRun('queue-b'))?.run_id).toBe('run-queued');
    expect((await store.getExecutionRunByProjectRoot('/tmp/repo-a'))?.run_id).toBe('run-running');
  });

  it('marks queued runs stale during recovery because queue state cannot survive a restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feishu-bridge-runs-'));
    tempDirs.push(dir);
    const store = new RunStateStore(dir);

    await store.upsertRun('run-queued', {
      queue_key: 'queue-a',
      conversation_key: 'conv-a',
      project_alias: 'repo-a',
      chat_id: 'chat-a',
      prompt_excerpt: 'queued',
      status: 'queued',
      status_detail: '当前仓库正在被其他会话操作，已进入排队。',
    });

    const recovered = await store.recoverOrphanedRuns();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe('stale');
    expect((await store.getRun('run-queued'))?.status).toBe('stale');
    expect(await store.listActiveRuns()).toEqual([]);
  });
});
