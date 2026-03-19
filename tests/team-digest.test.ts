import { describe, expect, it } from 'vitest';
import { buildTeamDigest, formatTeamDigest, createDigestPeriod } from '../src/collaboration/digest.js';
import type { RunState } from '../src/state/run-state-store.js';

function buildRun(overrides: Partial<RunState> = {}): RunState {
  const now = new Date();
  return {
    run_id: `run-${Math.random().toString(36).slice(2, 8)}`,
    queue_key: 'qk',
    conversation_key: 'ck',
    project_alias: 'proj-a',
    chat_id: 'chat-1',
    actor_id: 'user-1',
    prompt_excerpt: 'do something',
    status: 'success',
    started_at: new Date(now.getTime() - 300_000).toISOString(),
    updated_at: now.toISOString(),
    finished_at: now.toISOString(),
    ...overrides,
  };
}

describe('team digest', () => {
  const period = createDigestPeriod(24);

  it('summarizes runs by project and contributor', () => {
    const runs: RunState[] = [
      buildRun({ actor_id: 'alice', project_alias: 'frontend', status: 'success' }),
      buildRun({ actor_id: 'alice', project_alias: 'frontend', status: 'success' }),
      buildRun({ actor_id: 'bob', project_alias: 'backend', status: 'failure' }),
      buildRun({ actor_id: 'charlie', project_alias: 'frontend', status: 'success' }),
    ];

    const digest = buildTeamDigest(runs, [], [], period);

    expect(digest.summary.total_runs).toBe(4);
    expect(digest.summary.successful_runs).toBe(3);
    expect(digest.summary.failed_runs).toBe(1);
    expect(digest.summary.unique_actors).toBe(3);
    expect(digest.summary.unique_projects).toBe(2);
    expect(digest.topProjects).toHaveLength(2);
    expect(digest.topProjects[0]!.alias).toBe('frontend');
    expect(digest.topProjects[0]!.runs).toBe(3);
    expect(digest.topContributors).toHaveLength(3);
    expect(digest.topContributors[0]!.actor_id).toBe('alice');
  });

  it('filters runs outside the period', () => {
    const oldRun = buildRun({
      started_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    });
    const recentRun = buildRun();

    const digest = buildTeamDigest([oldRun, recentRun], [], [], period);
    expect(digest.summary.total_runs).toBe(1);
  });

  it('counts knowledge added in period', () => {
    const withinPeriod = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago
    const outsidePeriod = new Date(Date.now() - 48 * 3600_000).toISOString(); // 2 days ago
    const memories = [
      { id: '1', scope: 'project' as const, project_alias: 'a', title: 't', content: 'c', tags: [] as string[], source: 'manual', pinned: false, confidence: 1, created_at: withinPeriod, updated_at: withinPeriod },
      { id: '2', scope: 'project' as const, project_alias: 'a', title: 't', content: 'c', tags: [] as string[], source: 'auto', pinned: false, confidence: 1, created_at: outsidePeriod, updated_at: outsidePeriod },
    ];

    const digest = buildTeamDigest([], memories, [], period);
    expect(digest.knowledgeAdded).toBe(1);
  });

  it('counts completed handoffs in period', () => {
    const withinPeriod = new Date(Date.now() - 3600_000).toISOString();
    const outsidePeriod = new Date(Date.now() - 48 * 3600_000).toISOString();
    const events = [
      { type: 'collaboration.handoff.accepted', at: withinPeriod },
      { type: 'collaboration.handoff.accepted', at: outsidePeriod },
      { type: 'collaboration.handoff.created', at: withinPeriod },
    ];

    const digest = buildTeamDigest([], [], events, period);
    expect(digest.handoffsCompleted).toBe(1);
  });

  it('returns zero for empty period', () => {
    const digest = buildTeamDigest([], [], [], period);
    expect(digest.summary.total_runs).toBe(0);
    expect(digest.summary.unique_actors).toBe(0);
  });
});

describe('formatTeamDigest', () => {
  const period = createDigestPeriod(24);

  it('formats a digest with all sections', () => {
    const runs: RunState[] = [
      buildRun({ actor_id: 'alice', project_alias: 'frontend', status: 'success' }),
      buildRun({ actor_id: 'bob', project_alias: 'backend', status: 'failure' }),
    ];

    const digest = buildTeamDigest(runs, [], [], period);
    const text = formatTeamDigest(digest);

    expect(text).toContain('团队 AI 协作日报');
    expect(text).toContain('总览');
    expect(text).toContain('运行: 2 次');
    expect(text).toContain('成员: 2 人');
    expect(text).toContain('活跃项目');
    expect(text).toContain('活跃成员');
  });

  it('omits sections with no data', () => {
    const digest = buildTeamDigest([buildRun()], [], [], period);
    const text = formatTeamDigest(digest);

    expect(text).toContain('总览');
    expect(text).not.toContain('知识沉淀');
    expect(text).not.toContain('会话交接');
  });
});

describe('createDigestPeriod', () => {
  it('creates a 24-hour period', () => {
    const period = createDigestPeriod(24);
    const diff = period.to.getTime() - period.from.getTime();
    expect(diff).toBeCloseTo(24 * 3600_000, -3);
    expect(period.label).toBeTruthy();
  });

  it('creates a custom-hour period', () => {
    const period = createDigestPeriod(168);
    const diff = period.to.getTime() - period.from.getTime();
    expect(diff).toBeCloseTo(168 * 3600_000, -3);
  });
});
