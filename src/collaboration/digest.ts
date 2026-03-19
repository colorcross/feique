/**
 * Team AI Collaboration Digest
 *
 * Generates periodic (daily/weekly) summaries of team AI activity,
 * knowledge accumulation, bottlenecks, and collaboration health.
 * Pushed to designated Feishu group chats.
 */

import type { RunState } from '../state/run-state-store.js';
import type { MemoryRecord } from '../state/memory-store.js';
import type { TeamInsight } from './insights.js';
import { analyzeTeamHealth, formatInsightsReport } from './insights.js';

export interface DigestPeriod {
  from: Date;
  to: Date;
  label: string;
}

export interface TeamDigest {
  period: DigestPeriod;
  summary: DigestSummary;
  topProjects: ProjectDigest[];
  topContributors: ContributorDigest[];
  insights: TeamInsight[];
  knowledgeAdded: number;
  handoffsCompleted: number;
}

interface DigestSummary {
  total_runs: number;
  successful_runs: number;
  failed_runs: number;
  cancelled_runs: number;
  unique_actors: number;
  unique_projects: number;
  avg_duration_ms: number;
}

interface ProjectDigest {
  alias: string;
  runs: number;
  success_rate: number;
  actors: string[];
}

interface ContributorDigest {
  actor_id: string;
  runs: number;
  success_rate: number;
  projects: string[];
}

/**
 * Build a team digest for a given time period.
 */
export function buildTeamDigest(
  runs: RunState[],
  memories: MemoryRecord[],
  auditEvents: Array<{ type: string; at: string; [key: string]: unknown }>,
  period: DigestPeriod,
): TeamDigest {
  const periodRuns = runs.filter((r) => {
    const t = new Date(r.started_at);
    return t >= period.from && t <= period.to;
  });

  const successful = periodRuns.filter((r) => r.status === 'success');
  const failed = periodRuns.filter((r) => r.status === 'failure');
  const cancelled = periodRuns.filter((r) => r.status === 'cancelled');

  const actors = new Set(periodRuns.map((r) => r.actor_id).filter(Boolean));
  const projects = new Set(periodRuns.map((r) => r.project_alias));

  const durations = periodRuns
    .filter((r) => r.finished_at && r.started_at)
    .map((r) => new Date(r.finished_at!).getTime() - new Date(r.started_at).getTime())
    .filter((d) => d > 0);

  const avgDuration = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : 0;

  // Per-project breakdown
  const projectMap = new Map<string, RunState[]>();
  for (const run of periodRuns) {
    const list = projectMap.get(run.project_alias) ?? [];
    list.push(run);
    projectMap.set(run.project_alias, list);
  }

  const topProjects: ProjectDigest[] = [...projectMap.entries()]
    .map(([alias, projectRuns]) => ({
      alias,
      runs: projectRuns.length,
      success_rate: projectRuns.length > 0
        ? projectRuns.filter((r) => r.status === 'success').length / projectRuns.length
        : 0,
      actors: [...new Set(projectRuns.map((r) => r.actor_id).filter(Boolean))] as string[],
    }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5);

  // Per-contributor breakdown
  const actorMap = new Map<string, RunState[]>();
  for (const run of periodRuns) {
    if (!run.actor_id) continue;
    const list = actorMap.get(run.actor_id) ?? [];
    list.push(run);
    actorMap.set(run.actor_id, list);
  }

  const topContributors: ContributorDigest[] = [...actorMap.entries()]
    .map(([actor_id, actorRuns]) => ({
      actor_id,
      runs: actorRuns.length,
      success_rate: actorRuns.length > 0
        ? actorRuns.filter((r) => r.status === 'success').length / actorRuns.length
        : 0,
      projects: [...new Set(actorRuns.map((r) => r.project_alias))],
    }))
    .sort((a, b) => b.runs - a.runs)
    .slice(0, 5);

  // Knowledge added in period
  const knowledgeAdded = memories.filter((m) => {
    const t = new Date(m.created_at);
    return t >= period.from && t <= period.to && !m.archived_at;
  }).length;

  // Handoffs completed in period
  const handoffsCompleted = auditEvents.filter((e) => {
    const t = new Date(e.at);
    return e.type === 'collaboration.handoff.accepted' && t >= period.from && t <= period.to;
  }).length;

  const insights = analyzeTeamHealth(periodRuns, auditEvents);

  return {
    period,
    summary: {
      total_runs: periodRuns.length,
      successful_runs: successful.length,
      failed_runs: failed.length,
      cancelled_runs: cancelled.length,
      unique_actors: actors.size,
      unique_projects: projects.size,
      avg_duration_ms: avgDuration,
    },
    topProjects,
    topContributors,
    insights,
    knowledgeAdded,
    handoffsCompleted,
  };
}

/**
 * Format digest as readable text for Feishu.
 */
export function formatTeamDigest(digest: TeamDigest): string {
  const { period, summary } = digest;
  const lines: string[] = [];

  lines.push(`📊 团队 AI 协作日报 (${period.label})`);
  lines.push('');

  // Overview
  const successRate = summary.total_runs > 0
    ? Math.round((summary.successful_runs / summary.total_runs) * 100)
    : 0;
  const avgMin = Math.round(summary.avg_duration_ms / 60_000);

  lines.push('📈 总览');
  lines.push(`  运行: ${summary.total_runs} 次 (成功 ${successRate}%)`);
  lines.push(`  成员: ${summary.unique_actors} 人 / 项目: ${summary.unique_projects} 个`);
  if (avgMin > 0) {
    lines.push(`  平均耗时: ${avgMin} 分钟`);
  }
  if (digest.knowledgeAdded > 0) {
    lines.push(`  知识沉淀: ${digest.knowledgeAdded} 条`);
  }
  if (digest.handoffsCompleted > 0) {
    lines.push(`  会话交接: ${digest.handoffsCompleted} 次`);
  }

  // Top projects
  if (digest.topProjects.length > 0) {
    lines.push('');
    lines.push('🏗️ 活跃项目');
    for (const p of digest.topProjects) {
      const rate = Math.round(p.success_rate * 100);
      lines.push(`  ${p.alias}: ${p.runs} 次运行, ${rate}% 成功, ${p.actors.length} 人参与`);
    }
  }

  // Top contributors
  if (digest.topContributors.length > 0) {
    lines.push('');
    lines.push('👥 活跃成员');
    for (const c of digest.topContributors) {
      const rate = Math.round(c.success_rate * 100);
      lines.push(`  ${c.actor_id}: ${c.runs} 次运行, ${rate}% 成功, ${c.projects.length} 个项目`);
    }
  }

  // Insights (only warnings and above)
  const actionable = digest.insights.filter((i) => i.severity !== 'info');
  if (actionable.length > 0) {
    lines.push('');
    lines.push('⚠️ 需要关注');
    for (const insight of actionable.slice(0, 3)) {
      const icon = insight.severity === 'critical' ? '🔴' : '🟡';
      lines.push(`  ${icon} ${insight.title}`);
      lines.push(`    💡 ${insight.suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Create a DigestPeriod for the last N hours (default: 24 = daily).
 */
export function createDigestPeriod(hours: number = 24): DigestPeriod {
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3600_000);
  const label = hours <= 24
    ? `${from.toLocaleDateString('zh-CN')} ${from.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} — ${to.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
    : `${from.toLocaleDateString('zh-CN')} — ${to.toLocaleDateString('zh-CN')}`;

  return { from, to, label };
}
