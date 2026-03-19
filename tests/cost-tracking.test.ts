import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStateStore } from '../src/state/run-state-store.js';
import { estimateCost } from '../src/observability/cost.js';

const stores: RunStateStore[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ store: RunStateStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-cost-'));
  tempDirs.push(dir);
  const store = new RunStateStore(dir);
  stores.push(store);
  return { store, dir };
}

describe('estimateCost', () => {
  it('returns undefined when no tokens are provided', () => {
    expect(estimateCost(undefined, undefined)).toBeUndefined();
    expect(estimateCost(0, 0)).toBeUndefined();
  });

  it('computes cost with default codex rates', () => {
    // 1000 input tokens at $2/M = 0.002, 500 output tokens at $8/M = 0.004
    const cost = estimateCost(1000, 500);
    expect(cost).toBeCloseTo(0.006, 6);
  });

  it('computes cost with claude rates', () => {
    // 1_000_000 input at $3/M = 3.0, 1_000_000 output at $15/M = 15.0
    const cost = estimateCost(1_000_000, 1_000_000, 'claude');
    expect(cost).toBeCloseTo(18.0, 4);
  });

  it('falls back to codex rates for unknown backend', () => {
    const cost = estimateCost(1_000_000, 0, 'unknown-backend');
    expect(cost).toBeCloseTo(2.0, 4);
  });

  it('handles only input tokens', () => {
    const cost = estimateCost(1_000_000, undefined, 'codex');
    expect(cost).toBeCloseTo(2.0, 4);
  });

  it('handles only output tokens', () => {
    const cost = estimateCost(undefined, 1_000_000, 'codex');
    expect(cost).toBeCloseTo(8.0, 4);
  });
});

describe('RunStateStore token fields', () => {
  it('persists and retrieves token fields via upsertRun', async () => {
    const { store } = await makeStore();

    await store.upsertRun('run-tok-1', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'success',
      input_tokens: 5000,
      output_tokens: 2000,
      estimated_cost_usd: 0.026,
    });

    const run = await store.getRun('run-tok-1');
    expect(run).not.toBeNull();
    expect(run!.input_tokens).toBe(5000);
    expect(run!.output_tokens).toBe(2000);
    expect(run!.estimated_cost_usd).toBeCloseTo(0.026, 6);
  });

  it('returns undefined tokens when not set', async () => {
    const { store } = await makeStore();

    await store.upsertRun('run-no-tok', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'success',
    });

    const run = await store.getRun('run-no-tok');
    expect(run!.input_tokens).toBeUndefined();
    expect(run!.output_tokens).toBeUndefined();
    expect(run!.estimated_cost_usd).toBeUndefined();
  });

  it('preserves token fields across upsert updates', async () => {
    const { store } = await makeStore();

    await store.upsertRun('run-update', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'running',
    });
    await store.upsertRun('run-update', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'success',
      input_tokens: 10000,
      output_tokens: 3000,
      estimated_cost_usd: 0.044,
    });

    const run = await store.getRun('run-update');
    expect(run!.status).toBe('success');
    expect(run!.input_tokens).toBe(10000);
    expect(run!.output_tokens).toBe(3000);
    expect(run!.estimated_cost_usd).toBeCloseTo(0.044, 6);
  });

  it('lists runs with token data', async () => {
    const { store } = await makeStore();

    await store.upsertRun('run-list-a', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'a', status: 'success',
      input_tokens: 1000,
      output_tokens: 500,
      estimated_cost_usd: 0.006,
    });
    await store.upsertRun('run-list-b', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'b', status: 'success',
    });

    const runs = await store.listRuns();
    const a = runs.find((r) => r.run_id === 'run-list-a');
    const b = runs.find((r) => r.run_id === 'run-list-b');
    expect(a!.input_tokens).toBe(1000);
    expect(b!.input_tokens).toBeUndefined();
  });
});

describe('getCostSummary', () => {
  it('aggregates token cost by project and actor', async () => {
    const { store } = await makeStore();

    await store.upsertRun('run-cs-1', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'frontend',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'success',
      actor_id: 'alice',
      input_tokens: 10000,
      output_tokens: 5000,
      estimated_cost_usd: 0.06,
    });
    await store.upsertRun('run-cs-2', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'backend',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'success',
      actor_id: 'bob',
      input_tokens: 20000,
      output_tokens: 8000,
      estimated_cost_usd: 0.104,
    });
    await store.upsertRun('run-cs-3', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'frontend',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'failure',
      actor_id: 'alice',
      input_tokens: 3000,
      output_tokens: 1000,
      estimated_cost_usd: 0.014,
    });

    const summary = await store.getCostSummary(24);

    expect(summary.total_runs).toBe(3);
    expect(summary.total_input_tokens).toBe(33000);
    expect(summary.total_output_tokens).toBe(14000);
    expect(summary.total_cost_usd).toBeCloseTo(0.178, 4);

    // By project
    expect(summary.by_project['frontend']!.runs).toBe(2);
    expect(summary.by_project['frontend']!.input_tokens).toBe(13000);
    expect(summary.by_project['backend']!.runs).toBe(1);
    expect(summary.by_project['backend']!.input_tokens).toBe(20000);

    // By actor
    expect(summary.by_actor['alice']!.runs).toBe(2);
    expect(summary.by_actor['alice']!.cost_usd).toBeCloseTo(0.074, 4);
    expect(summary.by_actor['bob']!.runs).toBe(1);
  });

  it('returns zeros when no runs in the time window', async () => {
    const { store } = await makeStore();

    const summary = await store.getCostSummary(24);

    expect(summary.total_runs).toBe(0);
    expect(summary.total_input_tokens).toBe(0);
    expect(summary.total_output_tokens).toBe(0);
    expect(summary.total_cost_usd).toBe(0);
    expect(Object.keys(summary.by_project)).toHaveLength(0);
    expect(Object.keys(summary.by_actor)).toHaveLength(0);
  });

  it('handles runs without token data gracefully', async () => {
    const { store } = await makeStore();

    await store.upsertRun('run-no-tokens', {
      queue_key: 'q', conversation_key: 'c', project_alias: 'proj',
      chat_id: 'ch', prompt_excerpt: 'test', status: 'success',
      actor_id: 'user1',
    });

    const summary = await store.getCostSummary(24);

    expect(summary.total_runs).toBe(1);
    expect(summary.total_input_tokens).toBe(0);
    expect(summary.total_output_tokens).toBe(0);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.by_project['proj']!.runs).toBe(1);
    expect(summary.by_project['proj']!.input_tokens).toBe(0);
  });
});
