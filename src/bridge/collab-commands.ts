import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { IncomingMessageContext } from './types.js';
import type { AuditLog } from '../state/audit-log.js';
import type { SessionStore } from '../state/session-store.js';
import type { MemoryStore } from '../state/memory-store.js';
import type { RunStateStore } from '../state/run-state-store.js';
import type { HandoffStore } from '../state/handoff-store.js';
import type { TrustStore } from '../state/trust-store.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { buildLearnInput, formatRecallResults } from '../collaboration/knowledge.js';
import { createHandoff, acceptHandoff, createReview, resolveReview, formatHandoff, formatReview, formatReviewResult } from '../collaboration/handoff.js';
import { analyzeTeamHealth, formatInsightsReport } from '../collaboration/insights.js';
import { formatTrustState, type TrustLevel } from '../collaboration/trust.js';
import { buildProjectTimeline, formatTimeline } from '../collaboration/timeline.js';
import { buildTeamDigest, formatTeamDigest, createDigestPeriod } from '../collaboration/digest.js';
import { detectKnowledgeGaps, formatKnowledgeGaps } from '../collaboration/knowledge-gaps.js';

/**
 * Subset of FeiqueService that the collaboration command handlers
 * (/learn, /recall, /handoff, /pickup, /review, /approve, /reject,
 * /insights, /trust, /digest, /gaps, /timeline) need access to.
 */
export interface CollabCommandHost {
  readonly config: BridgeConfig;
  readonly auditLog: AuditLog;
  readonly sessionStore: SessionStore;
  readonly memoryStore: MemoryStore;
  readonly runStateStore: RunStateStore;
  readonly handoffStore: HandoffStore;
  readonly trustStore: TrustStore;
  readonly metrics?: MetricsRegistry;
  sendTextReply(
    chatId: string,
    body: string,
    replyToMessageId?: string,
    originalText?: string,
  ): Promise<unknown>;
}

export interface CollabProjectContext {
  projectAlias: string;
  project: ProjectConfig;
  sessionKey: string;
}

// ---------------------------------------------------------------------------
// /learn /recall — knowledge capture and retrieval
// ---------------------------------------------------------------------------

export async function handleLearnCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
  value: string,
): Promise<void> {
  const input = buildLearnInput(value, projectContext.projectAlias, context.actor_id, context.chat_id);

  await host.memoryStore.saveProjectMemory({
    project_alias: input.project_alias,
    title: input.title,
    content: input.content,
    tags: input.tags,
    source: input.source,
    created_by: context.actor_id,
  });

  await host.auditLog.append({
    type: 'collaboration.knowledge.learned',
    project_alias: input.project_alias,
    actor_id: context.actor_id,
    title: input.title,
  });

  await host.sendTextReply(
    context.chat_id,
    `💡 团队知识已记录: "${input.title}"\n项目: ${input.project_alias}`,
    context.message_id,
    context.text,
  );
}

export async function handleRecallCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
  query: string,
): Promise<void> {
  const memories = await host.memoryStore.searchMemories(
    { scope: 'project', project_alias: projectContext.projectAlias },
    query,
    10,
  );
  const text = formatRecallResults(memories, query);
  await host.sendTextReply(context.chat_id, text, context.message_id, context.text);
}

// ---------------------------------------------------------------------------
// /handoff /pickup — session handoff
// ---------------------------------------------------------------------------

export async function handleHandoffCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
  summary?: string,
): Promise<void> {
  const conversation = await host.sessionStore.getConversation(projectContext.sessionKey);
  const projectState = conversation?.projects[projectContext.projectAlias];

  const record = createHandoff({
    from_actor_id: context.actor_id ?? 'unknown',
    from_actor_name: context.actor_name,
    project_alias: projectContext.projectAlias,
    conversation_key: projectContext.sessionKey,
    thread_id: projectState?.active_thread_id ?? projectState?.thread_id,
    summary: summary ?? '会话交接',
    last_prompt: projectState?.last_prompt,
    last_response_excerpt: projectState?.last_response_excerpt,
  });

  await host.handoffStore.addHandoff(record);

  await host.auditLog.append({
    type: 'collaboration.handoff.created',
    handoff_id: record.id,
    from_actor_id: record.from_actor_id,
    project_alias: record.project_alias,
  });

  await host.sendTextReply(context.chat_id, formatHandoff(record), context.message_id, context.text);
}

export async function handlePickupCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
  id?: string,
): Promise<void> {
  let handoff = id
    ? await host.handoffStore.updateHandoff(id, {})
    : await host.handoffStore.getPendingHandoffForActor(context.actor_id ?? '', undefined);

  if (id) {
    handoff = await host.handoffStore.getPendingHandoff();
    if (handoff && !handoff.id.startsWith(id)) {
      handoff = null;
    }
  }

  if (!handoff || handoff.status !== 'pending') {
    await host.sendTextReply(context.chat_id, '没有找到待接手的交接任务。', context.message_id, context.text);
    return;
  }

  const accepted = acceptHandoff(handoff, context.actor_id ?? 'unknown');
  await host.handoffStore.updateHandoff(handoff.id, {
    status: 'accepted',
    accepted_at: accepted.accepted_at,
    accepted_by: accepted.accepted_by,
  });

  // Adopt the session if there's a thread_id
  if (handoff.thread_id) {
    await host.sessionStore.setActiveProjectSession(
      projectContext.sessionKey,
      handoff.project_alias,
      handoff.thread_id,
    );
  }

  await host.auditLog.append({
    type: 'collaboration.handoff.accepted',
    handoff_id: handoff.id,
    accepted_by: context.actor_id,
    project_alias: handoff.project_alias,
  });

  await host.sendTextReply(
    context.chat_id,
    `✅ 已接手 ${handoff.from_actor_name ?? handoff.from_actor_id} 的交接任务 [${handoff.project_alias}]\n摘要: ${handoff.summary}`,
    context.message_id,
    context.text,
  );
}

// ---------------------------------------------------------------------------
// /review /approve /reject — review workflow
// ---------------------------------------------------------------------------

export async function handleReviewCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
): Promise<void> {
  const runs = await host.runStateStore.listRuns();
  const latestRun = runs.find(
    (r) => r.project_alias === projectContext.projectAlias && (r.status === 'success' || r.status === 'failure'),
  );

  if (!latestRun) {
    await host.sendTextReply(context.chat_id, '没有找到最近的运行结果可供评审。', context.message_id, context.text);
    return;
  }

  const review = createReview({
    run_id: latestRun.run_id,
    project_alias: projectContext.projectAlias,
    chat_id: context.chat_id,
    actor_id: context.actor_id ?? 'unknown',
    content_excerpt: latestRun.prompt_excerpt,
  });

  await host.handoffStore.addReview(review);

  await host.auditLog.append({
    type: 'collaboration.review.created',
    review_id: review.id,
    run_id: review.run_id,
    project_alias: review.project_alias,
  });

  await host.sendTextReply(context.chat_id, formatReview(review), context.message_id, context.text);
}

export async function handleApproveCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  comment?: string,
): Promise<void> {
  const pending = await host.handoffStore.getPendingReview(context.chat_id);
  if (!pending) {
    await host.sendTextReply(context.chat_id, '当前没有待评审的内容。', context.message_id, context.text);
    return;
  }

  const resolved = resolveReview(pending, 'approved', context.actor_id ?? 'unknown', comment);
  await host.handoffStore.updateReview(pending.id, {
    status: 'approved',
    reviewer_id: resolved.reviewer_id,
    review_comment: resolved.review_comment,
    resolved_at: resolved.resolved_at,
  });

  await host.auditLog.append({
    type: 'collaboration.review.approved',
    review_id: pending.id,
    reviewer_id: context.actor_id,
  });

  await host.sendTextReply(context.chat_id, formatReviewResult(resolved), context.message_id, context.text);
}

export async function handleRejectCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  reason?: string,
): Promise<void> {
  const pending = await host.handoffStore.getPendingReview(context.chat_id);
  if (!pending) {
    await host.sendTextReply(context.chat_id, '当前没有待评审的内容。', context.message_id, context.text);
    return;
  }

  const resolved = resolveReview(pending, 'rejected', context.actor_id ?? 'unknown', reason);
  await host.handoffStore.updateReview(pending.id, {
    status: 'rejected',
    reviewer_id: resolved.reviewer_id,
    review_comment: resolved.review_comment,
    resolved_at: resolved.resolved_at,
  });

  await host.auditLog.append({
    type: 'collaboration.review.rejected',
    review_id: pending.id,
    reviewer_id: context.actor_id,
    reason,
  });

  await host.sendTextReply(context.chat_id, formatReviewResult(resolved), context.message_id, context.text);
}

// ---------------------------------------------------------------------------
// /insights — team health
// ---------------------------------------------------------------------------

export async function handleInsightsCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
): Promise<void> {
  const runs = await host.runStateStore.listRuns();
  const auditEvents = await host.auditLog.tail(500);
  const insights = analyzeTeamHealth(runs, auditEvents);
  const text = formatInsightsReport(insights);
  await host.sendTextReply(context.chat_id, text, context.message_id, context.text);
}

// ---------------------------------------------------------------------------
// /trust — trust level
// ---------------------------------------------------------------------------

export async function handleTrustCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
  action?: 'set',
  level?: string,
): Promise<void> {
  if (action === 'set' && level) {
    const TRUST_ORDER: TrustLevel[] = ['observe', 'suggest', 'execute', 'autonomous'];
    const validLevels = [...TRUST_ORDER];
    const state = await host.trustStore.getOrCreate(projectContext.projectAlias);

    // Handle relative promote/demote from natural language
    let resolvedLevel = level;
    if (level === '_promote') {
      const idx = TRUST_ORDER.indexOf(state.current_level);
      if (idx >= TRUST_ORDER.length - 1) {
        await host.sendTextReply(context.chat_id, `已经是最高信任等级 (${state.current_level})，无法继续提升。`, context.message_id, context.text);
        return;
      }
      resolvedLevel = TRUST_ORDER[idx + 1]!;
    } else if (level === '_demote') {
      const idx = TRUST_ORDER.indexOf(state.current_level);
      if (idx <= 0) {
        await host.sendTextReply(context.chat_id, `已经是最低信任等级 (${state.current_level})，无法继续降低。`, context.message_id, context.text);
        return;
      }
      resolvedLevel = TRUST_ORDER[idx - 1]!;
    }

    if (!validLevels.includes(resolvedLevel as TrustLevel)) {
      await host.sendTextReply(
        context.chat_id,
        `无效的信任等级。有效值: ${validLevels.join(', ')}`,
        context.message_id,
        context.text,
      );
      return;
    }

    state.current_level = resolvedLevel as TrustLevel;
    state.last_evaluated_at = new Date().toISOString();
    await host.trustStore.update(projectContext.projectAlias, state);
    host.metrics?.recordTrustLevel(projectContext.projectAlias, resolvedLevel);

    await host.auditLog.append({
      type: 'collaboration.trust.set',
      project_alias: projectContext.projectAlias,
      actor_id: context.actor_id,
      level,
    });

    await host.sendTextReply(
      context.chat_id,
      `🛡️ 项目 ${projectContext.projectAlias} 的信任等级已设置为: ${level}`,
      context.message_id,
      context.text,
    );
    return;
  }

  const state = await host.trustStore.getOrCreate(projectContext.projectAlias);
  await host.sendTextReply(context.chat_id, formatTrustState(state), context.message_id, context.text);
}

// ---------------------------------------------------------------------------
// /digest — periodic team digest (manual trigger)
// ---------------------------------------------------------------------------

export async function handleDigestCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
): Promise<void> {
  const period = createDigestPeriod(host.config.service.team_digest_interval_hours);
  const runs = await host.runStateStore.listRuns();
  const memories = host.config.service.memory_enabled
    ? await host.memoryStore.listRecentMemories({ scope: 'project', project_alias: '' }, 100)
    : [];
  const auditEvents = await host.auditLog.tail(500);
  const digest = buildTeamDigest(runs, memories, auditEvents, period);
  const text = formatTeamDigest(digest);
  await host.sendTextReply(context.chat_id, text, context.message_id, context.text);
}

// ---------------------------------------------------------------------------
// /gaps — knowledge gaps
// ---------------------------------------------------------------------------

export async function handleGapsCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
): Promise<void> {
  const runs = await host.runStateStore.listRuns();
  const memories = host.config.service.memory_enabled
    ? await host.memoryStore.listRecentMemories({ scope: 'project', project_alias: '' }, 200)
    : [];
  const gaps = detectKnowledgeGaps(runs, memories);
  const text = formatKnowledgeGaps(gaps);
  await host.sendTextReply(context.chat_id, text, context.message_id, context.text);
}

// ---------------------------------------------------------------------------
// /timeline — project activity timeline
// ---------------------------------------------------------------------------

export async function handleTimelineCommand(
  host: CollabCommandHost,
  context: IncomingMessageContext,
  projectContext: CollabProjectContext,
  projectArg?: string,
): Promise<void> {
  const projectAlias = projectArg ?? projectContext.projectAlias;

  const runs = await host.runStateStore.listRuns();
  const auditEvents = await host.auditLog.tail(200);

  const memories = host.config.service.memory_enabled
    ? await host.memoryStore.listRecentMemories(
        { scope: 'project', project_alias: projectAlias },
        20,
      )
    : [];

  const timeline = buildProjectTimeline(runs, memories, auditEvents, projectAlias, 20);
  const text = formatTimeline(timeline);
  await host.sendTextReply(context.chat_id, text, context.message_id, context.text);
}
