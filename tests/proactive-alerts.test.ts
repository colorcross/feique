import { describe, expect, it } from 'vitest';
import { checkRunAlerts, checkLongRunningAlerts, formatAlert, DEFAULT_ALERT_RULES } from '../src/collaboration/proactive-alerts.js';
import type { RunState } from '../src/state/run-state-store.js';

function buildRun(overrides: Partial<RunState> = {}): RunState {
  return {
    run_id: `run-${Math.random().toString(36).slice(2, 8)}`,
    queue_key: 'qk', conversation_key: 'ck', project_alias: 'proj-a',
    chat_id: 'chat-1', actor_id: 'user-1', prompt_excerpt: 'do something',
    status: 'success', started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('proactive alerts', () => {
  describe('consecutive failures', () => {
    it('alerts after 3 consecutive failures', () => {
      const runs = [
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 1000).toISOString() }),
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 2000).toISOString() }),
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 3000).toISOString() }),
      ];
      const completed = runs[0]!;
      const alerts = checkRunAlerts(completed, runs);
      expect(alerts.some((a) => a.kind === 'consecutive_failures')).toBe(true);
    });

    it('does not alert after 2 failures', () => {
      const runs = [
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 1000).toISOString() }),
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 2000).toISOString() }),
        buildRun({ status: 'success', updated_at: new Date(Date.now() - 3000).toISOString() }),
      ];
      const alerts = checkRunAlerts(runs[0]!, runs);
      expect(alerts.some((a) => a.kind === 'consecutive_failures')).toBe(false);
    });

    it('resets count after a success', () => {
      const runs = [
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 1000).toISOString() }),
        buildRun({ status: 'success', updated_at: new Date(Date.now() - 2000).toISOString() }),
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 3000).toISOString() }),
        buildRun({ status: 'failure', updated_at: new Date(Date.now() - 4000).toISOString() }),
      ];
      const alerts = checkRunAlerts(runs[0]!, runs);
      expect(alerts.some((a) => a.kind === 'consecutive_failures')).toBe(false);
    });
  });

  describe('retry loop', () => {
    it('alerts when same actor has too many runs and failures in window', () => {
      const runs = Array.from({ length: 5 }, (_, i) =>
        buildRun({
          actor_id: 'alice',
          status: i < 2 ? 'failure' : 'success',
          started_at: new Date(Date.now() - i * 60_000).toISOString(),
        }),
      );
      const alerts = checkRunAlerts(runs[0]!, runs);
      expect(alerts.some((a) => a.kind === 'retry_loop')).toBe(true);
    });

    it('does not alert for frequent successful runs', () => {
      const runs = Array.from({ length: 5 }, (_, i) =>
        buildRun({
          actor_id: 'alice',
          status: 'success',
          started_at: new Date(Date.now() - i * 60_000).toISOString(),
        }),
      );
      const alerts = checkRunAlerts(runs[0]!, runs);
      expect(alerts.some((a) => a.kind === 'retry_loop')).toBe(false);
    });

    it('does not alert for different actors', () => {
      const runs = Array.from({ length: 5 }, (_, i) =>
        buildRun({ actor_id: `user-${i}`, status: 'failure', started_at: new Date(Date.now() - i * 60_000).toISOString() }),
      );
      const alerts = checkRunAlerts(runs[0]!, runs);
      expect(alerts.some((a) => a.kind === 'retry_loop')).toBe(false);
    });
  });

  describe('cost threshold', () => {
    it('alerts when daily tokens exceed 80% of quota', () => {
      const runs = [
        buildRun({ input_tokens: 40000, output_tokens: 10000, started_at: new Date().toISOString() }),
      ];
      const alerts = checkRunAlerts(runs[0]!, runs, DEFAULT_ALERT_RULES, 50000);
      expect(alerts.some((a) => a.kind === 'cost_threshold')).toBe(true);
    });

    it('does not alert when under threshold', () => {
      const runs = [
        buildRun({ input_tokens: 1000, output_tokens: 500, started_at: new Date().toISOString() }),
      ];
      const alerts = checkRunAlerts(runs[0]!, runs, DEFAULT_ALERT_RULES, 50000);
      expect(alerts.some((a) => a.kind === 'cost_threshold')).toBe(false);
    });
  });

  describe('long running', () => {
    it('alerts for runs exceeding threshold', () => {
      const longRun = buildRun({
        status: 'running',
        started_at: new Date(Date.now() - 35 * 60_000).toISOString(),
      });
      const alerts = checkLongRunningAlerts([longRun]);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.kind).toBe('long_running');
    });

    it('ignores short runs', () => {
      const shortRun = buildRun({
        status: 'running',
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      });
      expect(checkLongRunningAlerts([shortRun])).toHaveLength(0);
    });
  });

  it('ignores non-terminal statuses', () => {
    const run = buildRun({ status: 'queued' });
    expect(checkRunAlerts(run, [run])).toHaveLength(0);
  });

  it('formats alerts with severity icon', () => {
    const text = formatAlert({
      kind: 'consecutive_failures', severity: 'critical',
      title: '连续失败', detail: '详情', project_alias: 'p',
      suggestion: '建议',
    });
    expect(text).toContain('🔴');
    expect(text).toContain('连续失败');
    expect(text).toContain('💡');
  });
});
