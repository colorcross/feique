/**
 * Proactive Alerts — real-time event-driven team notifications.
 *
 * Instead of waiting for /insights, checks alert conditions after
 * every run completion and pushes to Feishu immediately.
 */

import type { RunState } from '../state/run-state-store.js';

export type AlertKind =
  | 'consecutive_failures'
  | 'retry_loop'
  | 'cost_threshold'
  | 'long_running'
  | 'queue_stuck';

export interface ProactiveAlert {
  kind: AlertKind;
  severity: 'warning' | 'critical';
  title: string;
  detail: string;
  project_alias: string;
  actor_id?: string;
  suggestion: string;
}

export interface AlertRules {
  /** Alert after N consecutive failures on same project. Default: 3 */
  consecutive_failure_threshold: number;
  /** Alert when same actor retries N times in window_hours. Default: 5 */
  retry_loop_threshold: number;
  retry_loop_window_hours: number;
  /** Require at least N failures before classifying frequent runs as a retry loop. Default: 2 */
  retry_loop_min_failures: number;
  /** Alert when daily cost exceeds this % of quota. Default: 80 */
  cost_alert_pct: number;
  /** Alert when a run exceeds N minutes. Default: 30 */
  long_running_minutes: number;
}

export const DEFAULT_ALERT_RULES: AlertRules = {
  consecutive_failure_threshold: 3,
  retry_loop_threshold: 5,
  retry_loop_window_hours: 4,
  retry_loop_min_failures: 2,
  cost_alert_pct: 80,
  long_running_minutes: 30,
};

/**
 * Check if a just-completed run triggers any alerts.
 * Called after every run state update (success, failure, etc).
 */
export function checkRunAlerts(
  completedRun: RunState,
  recentRuns: RunState[],
  rules: AlertRules = DEFAULT_ALERT_RULES,
  dailyTokenQuota?: number,
): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];

  // Only check when a run finishes (success or failure)
  if (completedRun.status !== 'success' && completedRun.status !== 'failure') {
    return alerts;
  }

  const projectRuns = recentRuns.filter(
    (r) => r.project_alias === completedRun.project_alias,
  );

  // 1. Consecutive failures on same project
  if (completedRun.status === 'failure') {
    const recentProjectRuns = projectRuns
      .filter((r) => r.status === 'success' || r.status === 'failure')
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    let consecutiveFailures = 0;
    for (const run of recentProjectRuns) {
      if (run.status === 'failure') consecutiveFailures++;
      else break;
    }

    if (consecutiveFailures >= rules.consecutive_failure_threshold) {
      alerts.push({
        kind: 'consecutive_failures',
        severity: consecutiveFailures >= 5 ? 'critical' : 'warning',
        title: `项目 ${completedRun.project_alias} 连续失败 ${consecutiveFailures} 次`,
        detail: `最近错误: ${completedRun.error?.slice(0, 100) ?? '未知'}`,
        project_alias: completedRun.project_alias,
        suggestion: '建议检查项目配置或底层依赖',
      });
    }
  }

  // 2. Retry loop: same actor, same project, too many runs in time window
  if (completedRun.actor_id) {
    const windowMs = rules.retry_loop_window_hours * 3600_000;
    const cutoff = Date.now() - windowMs;
    const actorProjectRuns = projectRuns.filter(
      (r) =>
        r.actor_id === completedRun.actor_id &&
        new Date(r.started_at).getTime() > cutoff,
    );

    const failures = actorProjectRuns.filter((r) => r.status === 'failure').length;
    if (actorProjectRuns.length >= rules.retry_loop_threshold && failures >= rules.retry_loop_min_failures) {
      alerts.push({
        kind: 'retry_loop',
        severity: 'warning',
        title: `${completedRun.actor_id} 在 ${completedRun.project_alias} 上 ${rules.retry_loop_window_hours}h 内已运行 ${actorProjectRuns.length} 次`,
        detail: `其中 ${failures} 次失败`,
        project_alias: completedRun.project_alias,
        actor_id: completedRun.actor_id,
        suggestion: '可能需要换个思路，或寻求团队协助',
      });
    }
  }

  // 3. Cost threshold: daily token usage approaching quota
  if (dailyTokenQuota && dailyTokenQuota > 0) {
    const oneDayAgo = Date.now() - 86400_000;
    const dailyRuns = recentRuns.filter(
      (r) => new Date(r.started_at).getTime() > oneDayAgo,
    );
    const totalTokens = dailyRuns.reduce(
      (sum, r) => sum + (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
      0,
    );
    const pct = (totalTokens / dailyTokenQuota) * 100;

    if (pct >= rules.cost_alert_pct) {
      alerts.push({
        kind: 'cost_threshold',
        severity: pct >= 100 ? 'critical' : 'warning',
        title: `每日 token 用量已达 ${Math.round(pct)}%`,
        detail: `已用 ${formatTokens(totalTokens)} / 额度 ${formatTokens(dailyTokenQuota)}`,
        project_alias: completedRun.project_alias,
        suggestion: pct >= 100 ? '已超额，后续请求将被拒绝' : '建议控制使用频率',
      });
    }
  }

  return alerts;
}

/**
 * Check for long-running tasks (called periodically, not per-run).
 */
export function checkLongRunningAlerts(
  activeRuns: RunState[],
  rules: AlertRules = DEFAULT_ALERT_RULES,
): ProactiveAlert[] {
  const alerts: ProactiveAlert[] = [];
  const thresholdMs = rules.long_running_minutes * 60_000;

  for (const run of activeRuns) {
    if (run.status !== 'running') continue;
    const elapsed = Date.now() - new Date(run.started_at).getTime();

    if (elapsed >= thresholdMs) {
      const minutes = Math.round(elapsed / 60_000);
      alerts.push({
        kind: 'long_running',
        severity: minutes >= 60 ? 'critical' : 'warning',
        title: `任务已运行 ${minutes} 分钟`,
        detail: `项目: ${run.project_alias}, 操作: "${run.prompt_excerpt?.slice(0, 60) ?? '...'}"`,
        project_alias: run.project_alias,
        actor_id: run.actor_id,
        suggestion: '考虑检查是否卡住，或取消后重新拆解',
      });
    }
  }

  return alerts;
}

export function formatAlert(alert: ProactiveAlert): string {
  const icon = alert.severity === 'critical' ? '🔴' : '🟡';
  const lines = [
    `${icon} ${alert.title}`,
    `  ${alert.detail}`,
    `  💡 ${alert.suggestion}`,
  ];
  return lines.join('\n');
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
