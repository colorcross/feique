import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { Logger } from '../logging.js';
import type { AuditLog } from '../state/audit-log.js';
import { RunStateStore, type RunState } from '../state/run-state-store.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import type { TaskQueue } from './task-queue.js';
import { buildProjectRootQueueKey, createDeferred, truncateExcerpt } from './service-utils.js';

/**
 * Subset of FeiqueService needed by the run scheduler. The scheduler owns
 * nothing — it reaches back through the host to enqueue work on the
 * shared TaskQueues, update run state, write audit events, and emit
 * metrics.
 */
export interface RunSchedulerHost {
  readonly queue: TaskQueue;
  readonly projectRootQueue: TaskQueue;
  readonly auditLog: AuditLog;
  readonly runStateStore: RunStateStore;
  readonly logger: Logger;
  readonly metrics?: MetricsRegistry;
}

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export interface QueuedExecutionNotice {
  runId: string;
  detail: string;
  reason: 'project' | 'project-root';
}

export interface ScheduledProjectExecution {
  runId: string;
  queued: QueuedExecutionNotice | null;
  release: () => void;
  completion: Promise<void>;
}

export interface ScheduleProjectContext {
  projectAlias: string;
  project: ProjectConfig;
  sessionKey: string;
  queueKey: string;
}

export interface ScheduleMetadata {
  chatId: string;
  actorId?: string;
  actorName?: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Pure status-line builders (exported so service.ts reply paths can inline them)
// ---------------------------------------------------------------------------

export function buildAcknowledgedRunReply(
  projectAlias: string,
  phase: '已接收' | '排队中' | '处理中',
  detail: string,
  mode: BridgeConfig['service']['reply_mode'],
): string {
  if (mode === 'text') {
    return [`项目: ${projectAlias}`, `状态: ${phase}`, '', detail].join('\n');
  }
  return detail;
}

export function buildQueuedStatusDetail(
  projectAlias: string,
  reason: QueuedExecutionNotice['reason'],
  frontCount: number,
  blockingRun: RunState | null,
): string {
  const lines: Array<string | null> = [
    reason === 'project' ? `当前项目 ${projectAlias} 已有任务在处理，已进入排队。` : '当前仓库正在被其他会话操作，已进入排队。',
    frontCount > 0 ? `前方还有 ${frontCount} 个任务。` : null,
  ];
  if (blockingRun) {
    const actorName = blockingRun.actor_name ?? blockingRun.actor_id ?? '其他成员';
    lines.push(`当前执行: ${actorName}`);
    const elapsedMs = Date.now() - new Date(blockingRun.started_at).getTime();
    const elapsedMin = Math.round(elapsedMs / 60_000);
    if (elapsedMin > 0) {
      lines.push(`已运行: ${elapsedMin} 分钟`);
    }
    if (reason === 'project-root' && blockingRun.project_alias && blockingRun.project_alias !== projectAlias) {
      lines.push(`占用项目: ${blockingRun.project_alias}`);
    }
  }
  lines.push(`排队时间: ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
  return lines.filter((line): line is string => line !== null).join('\n');
}

export function buildRunStatusSummary(lastResponseExcerpt?: string, activeRun?: RunState | null): string {
  if (activeRun?.status === 'queued' && activeRun.status_detail) {
    return [activeRun.status_detail, lastResponseExcerpt ? `\n上一轮摘要:\n${lastResponseExcerpt}` : null].filter(Boolean).join('\n');
  }
  return lastResponseExcerpt ?? '暂无会话摘要。';
}

// ---------------------------------------------------------------------------
// Queue preparation (module-private)
// ---------------------------------------------------------------------------

async function prepareQueuedExecution(
  host: RunSchedulerHost,
  projectContext: ScheduleProjectContext,
  metadata: ScheduleMetadata,
  runId: string,
): Promise<QueuedExecutionNotice | null> {
  const queuePending = host.queue.getPendingCount(projectContext.queueKey);
  const rootKey = buildProjectRootQueueKey(projectContext.project.root);
  const rootPending = host.projectRootQueue.getPendingCount(rootKey);
  if (queuePending <= 0 && rootPending <= 0) {
    return null;
  }

  const projectRoot = path.resolve(projectContext.project.root);
  const reason = queuePending > 0 ? 'project' : 'project-root';
  const frontCount = reason === 'project' ? queuePending : rootPending;
  const blockingRun =
    reason === 'project'
      ? await host.runStateStore.getActiveRun(projectContext.queueKey)
      : await host.runStateStore.getExecutionRunByProjectRoot(projectRoot);
  const detail = buildQueuedStatusDetail(projectContext.projectAlias, reason, frontCount, blockingRun);
  await host.runStateStore.upsertRun(runId, {
    queue_key: projectContext.queueKey,
    conversation_key: projectContext.sessionKey,
    project_alias: projectContext.projectAlias,
    chat_id: metadata.chatId,
    actor_id: metadata.actorId,
    actor_name: metadata.actorName,
    project_root: projectRoot,
    prompt_excerpt: truncateExcerpt(metadata.prompt),
    status: 'queued',
    status_detail: detail,
  });
  await host.auditLog.append({
    type: 'codex.run.queued',
    run_id: runId,
    chat_id: metadata.chatId,
    actor_id: metadata.actorId,
    project_alias: projectContext.projectAlias,
    conversation_key: projectContext.sessionKey,
    project_root: projectRoot,
    queue_reason: reason,
    blocking_run_id: blockingRun?.run_id,
    front_count: frontCount,
  });
  host.logger.warn(
    {
      runId,
      queueKey: projectContext.queueKey,
      sessionKey: projectContext.sessionKey,
      projectAlias: projectContext.projectAlias,
      projectRoot,
      reason,
      frontCount,
      blockingStatus: blockingRun?.status,
      blockingProjectAlias: blockingRun?.project_alias,
    },
    'Codex run queued',
  );

  return {
    runId,
    detail,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Main entry: schedule a project execution on the dual-queue system
// ---------------------------------------------------------------------------

export async function scheduleProjectExecution(
  host: RunSchedulerHost,
  projectContext: ScheduleProjectContext,
  metadata: ScheduleMetadata,
  task: (runId?: string) => Promise<void>,
): Promise<ScheduledProjectExecution> {
  const runId = randomUUID();
  const queued = await prepareQueuedExecution(host, projectContext, metadata, runId);
  const rootKey = buildProjectRootQueueKey(projectContext.project.root);
  const startGate = createDeferred<void>();
  // Record queue depth when enqueuing
  host.metrics?.recordQueueDepth(
    projectContext.projectAlias,
    host.queue.getPendingCount(projectContext.queueKey) + 1,
  );
  return {
    runId,
    queued,
    release: () => startGate.resolve(),
    completion: host.queue.run(projectContext.queueKey, async () => {
      await host.projectRootQueue.run(rootKey, async () => {
        await startGate.promise;
        await task(runId);
      }, { priority: projectContext.project.run_priority });
      // Record queue depth after dequeue
      host.metrics?.recordQueueDepth(
        projectContext.projectAlias,
        host.queue.getPendingCount(projectContext.queueKey),
      );
    }),
  };
}
