import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { IncomingMessageContext } from './types.js';
import type { Logger } from '../logging.js';
import type { FeishuClient } from '../feishu/client.js';
import type { AuditLog } from '../state/audit-log.js';
import type { SessionStore } from '../state/session-store.js';
import type { MemoryStore } from '../state/memory-store.js';
import type { RunStateStore } from '../state/run-state-store.js';
import type { TrustStore } from '../state/trust-store.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import type { Backend, BackendEvent, BackendName, BackendRunResult } from '../backend/types.js';
import type { CodexSessionIndex } from '../codex/session-index.js';
import type { FailoverInfo } from '../backend/factory.js';
import { resolveProjectBackendWithFailover } from '../backend/factory.js';
import { retrieveMemoryContext } from '../memory/retrieve.js';
import { summarizeThreadTurn } from '../memory/summarize.js';
import { extractInsights } from '../collaboration/knowledge.js';
import { recordRunOutcome, DEFAULT_TRUST_POLICY } from '../collaboration/trust.js';
import { buildProjectTimeline, buildOnboardingContext, isNewActor } from '../collaboration/timeline.js';
import { truncateForFeishuCard } from '../feishu/text.js';
import { estimateCost } from '../observability/cost.js';
import type { RunState } from '../state/run-state-store.js';
import { extractFileMarkers, friendlyErrorMessage, truncateExcerpt } from './service-utils.js';
import type { ActiveRunHandle } from './service.js';

/**
 * Subset of FeiqueService that the executePrompt pipeline needs.
 *
 * This is the largest host interface in feique because executePrompt is
 * the central run-execution pipeline that touches almost everything in
 * the service: stores, reply rendering, run state, audit, metrics, and
 * collaboration features.
 *
 * Splitting it further into per-phase functions is a future refactor;
 * for now we move the whole 470-line pipeline into a single free
 * function so service.ts can shed the bulk.
 */
export interface PipelineHost {
  readonly config: BridgeConfig;
  readonly logger: Logger;
  readonly feishuClient: FeishuClient;
  readonly auditLog: AuditLog;
  readonly sessionStore: SessionStore;
  readonly memoryStore: MemoryStore;
  readonly runStateStore: RunStateStore;
  readonly trustStore: TrustStore;
  readonly metrics?: MetricsRegistry;
  readonly codexSessionIndex: CodexSessionIndex;
  readonly activeRuns: Map<string, ActiveRunHandle>;
  readonly runReplyTargets: Map<string, unknown>;

  // Methods that stay on FeiqueService and are reached back into via host
  resolveBackendByName(projectAlias: string, sessionOverride?: BackendName): Backend;
  buildBridgePrompt(
    projectAlias: string,
    project: ProjectConfig,
    incomingMessage: IncomingMessageContext,
    effectivePrompt: string,
    memoryContext: Awaited<ReturnType<typeof retrieveMemoryContext>>,
  ): Promise<string>;
  appendProjectAuditEvent(projectAlias: string, project: ProjectConfig, event: { type: string; [key: string]: unknown }): Promise<void>;
  resolveProjectTempDir(projectAlias: string, project: ProjectConfig): string;
  resolveProjectCacheDir(projectAlias: string, project: ProjectConfig): string;
  handleBackendFailover(chatId: string, projectAlias: string, runId: string, info: FailoverInfo): Promise<void>;
  updateRunStartedReply(chatId: string, projectAlias: string, runId: string, backendLabel?: string): Promise<void>;
  updateRunProgressReply(input: { chatId: string; projectAlias: string; prompt: string; sessionKey: string; replyToMessageId?: string }, runId: string, message: string, backendLabel?: string): Promise<void>;
  sendOrUpdateRunOutcome(input: { input: ExecutePromptInput; runId: string; title: string; body: string; runStatus: 'success' | 'failure' | 'cancelled'; runPhase: string; cardSummary: string; sessionId?: string }): Promise<void>;
  enforceSessionHistoryLimit(conversationKey: string, projectAlias: string): Promise<void>;
  notifyProjectChats(projectAlias: string, text: string): Promise<void>;
  checkAndSendAlerts(completedRun: RunState): Promise<void>;
}

export interface ExecutePromptInput {
  runId?: string;
  chatId: string;
  actorId?: string;
  tenantKey?: string;
  projectAlias: string;
  project: ProjectConfig;
  incomingMessage: IncomingMessageContext;
  prompt: string;
  sessionKey: string;
  queueKey: string;
  replyToMessageId?: string;
}

export async function executePrompt(host: PipelineHost, input: ExecutePromptInput): Promise<void> {
  const conversation =
    (await host.sessionStore.getConversation(input.sessionKey)) ??
    (await host.sessionStore.ensureConversation(input.sessionKey, {
      chat_id: input.chatId,
      actor_id: input.actorId,
      tenant_key: input.tenantKey,
      scope: input.project.session_scope,
    }));
  let currentSession = conversation.projects[input.projectAlias];

  // Auto-adopt latest local session when no active session exists
  if (!currentSession?.thread_id && host.config.service.project_switch_auto_adopt_latest) {
    try {
      const sessionBackendOverrideForAdopt = await host.sessionStore.getProjectBackend(input.sessionKey, input.projectAlias);
      const backendForAdopt = host.resolveBackendByName(input.projectAlias, sessionBackendOverrideForAdopt);
      const latestLocal = await backendForAdopt.findLatestSession(input.project.root);
      if (latestLocal) {
        await host.sessionStore.upsertProjectSession(input.sessionKey, input.projectAlias, {
          thread_id: latestLocal.sessionId,
        });
        const refreshed = await host.sessionStore.getConversation(input.sessionKey);
        currentSession = refreshed?.projects[input.projectAlias];
        host.logger.info(
          { projectAlias: input.projectAlias, sessionId: latestLocal.sessionId, backend: latestLocal.backend },
          'Auto-adopted latest local session for prompt execution',
        );
      }
    } catch { /* auto-adopt is best-effort */ }
  }

  if (host.config.service.memory_enabled) {
    await host.memoryStore.cleanupExpiredMemories();
  }
  const memoryContext = host.config.service.memory_enabled
    ? await retrieveMemoryContext(host.memoryStore, {
        conversationKey: input.sessionKey,
        projectAlias: input.projectAlias,
        threadId: currentSession?.thread_id,
        query: input.prompt,
        searchLimit: host.config.service.memory_search_limit,
        groupChatId: input.incomingMessage.chat_type === 'group' ? input.incomingMessage.chat_id : undefined,
        includeGroupMemories: host.config.service.memory_group_enabled && input.incomingMessage.chat_type === 'group',
      })
    : { pinnedMemories: [], relevantMemories: [], pinnedGroupMemories: [], relevantGroupMemories: [] };

  // Direction 6: Inject onboarding context for new actors
  let onboardingPrefix = '';
  if (input.actorId && host.config.service.memory_enabled) {
    try {
      const allRuns = await host.runStateStore.listRuns();
      if (isNewActor(input.actorId, allRuns, input.projectAlias)) {
        const memories = await host.memoryStore.listRecentMemories(
          { scope: 'project', project_alias: input.projectAlias },
          10,
        );
        const timeline = buildProjectTimeline(allRuns, memories, [], input.projectAlias, 10);
        onboardingPrefix = buildOnboardingContext(timeline, memories, input.projectAlias);
      }
    } catch { /* onboarding injection is best-effort */ }
  }
  const effectivePrompt = onboardingPrefix
    ? `${onboardingPrefix}\n\n${input.prompt}`
    : input.prompt;

  const bridgePrompt = await host.buildBridgePrompt(input.projectAlias, input.project, input.incomingMessage, effectivePrompt, memoryContext);
  const startedAt = Date.now();
  const projectRoot = path.resolve(input.project.root);
  const runId = input.runId ?? randomUUID();
  let lastProgressUpdate = 0;
  const activeRun: ActiveRunHandle = {
    runId,
    controller: new AbortController(),
  };
  host.activeRuns.set(input.queueKey, activeRun);
  const sessionBackendOverride = await host.sessionStore.getProjectBackend(input.sessionKey, input.projectAlias);
  const failoverResolution = await resolveProjectBackendWithFailover(
    host.config,
    input.projectAlias,
    sessionBackendOverride,
    host.codexSessionIndex,
  );
  const backend = failoverResolution.backend;
  if (failoverResolution.failover) {
    await host.handleBackendFailover(input.chatId, input.projectAlias, runId, failoverResolution.failover);
  }
  const backendLabel = backend.name === 'claude' ? 'Claude' : backend.name === 'qwen' ? 'Qwen' : 'Codex';
  await host.updateRunStartedReply(input.chatId, input.projectAlias, runId, backendLabel);

  await host.runStateStore.upsertRun(runId, {
    queue_key: input.queueKey,
    conversation_key: input.sessionKey,
    project_alias: input.projectAlias,
    chat_id: input.chatId,
    actor_id: input.actorId,
    actor_name: input.incomingMessage.actor_name,
    session_id: currentSession?.thread_id,
    project_root: projectRoot,
    prompt_excerpt: truncateExcerpt(input.prompt),
    status: 'running',
    status_detail: undefined,
  });
  await host.auditLog.append({
    type: 'codex.run.started',
    run_id: runId,
    chat_id: input.chatId,
    actor_id: input.actorId,
    project_alias: input.projectAlias,
    conversation_key: input.sessionKey,
    session_id: currentSession?.thread_id,
    prompt: input.prompt,
  });
  await host.appendProjectAuditEvent(input.projectAlias, input.project, {
    type: 'codex.run.started',
    run_id: runId,
    chat_id: input.chatId,
    actor_id: input.actorId,
    session_id: currentSession?.thread_id,
    project_root: projectRoot,
  });
  host.logger.info(
    {
      runId,
      queueKey: input.queueKey,
      sessionKey: input.sessionKey,
      projectAlias: input.projectAlias,
      projectRoot,
      sessionId: currentSession?.thread_id,
    },
    'Codex run started',
  );

  host.metrics?.recordCodexTurnStarted(input.projectAlias, runId);

  const runBackendTurn = async (sessionId?: string): Promise<BackendRunResult> => backend.run({
    workdir: input.project.root,
    prompt: bridgePrompt,
    sessionId,
    timeoutMs: backend.name === 'claude'
      ? (host.config.claude?.run_timeout_ms ?? host.config.codex.run_timeout_ms)
      : backend.name === 'qwen'
        ? (host.config.qwen?.run_timeout_ms ?? host.config.codex.run_timeout_ms)
        : host.config.codex.run_timeout_ms,
    signal: activeRun.controller.signal,
    logger: host.logger,
    projectConfig: backend.name === 'codex'
      ? {
          profile: input.project.profile ?? host.config.codex.default_profile,
          model: input.project.codex_model ?? host.config.codex.default_model,
          sandbox: input.project.codex_sandbox ?? input.project.sandbox ?? host.config.codex.default_sandbox,
          tempDir: host.resolveProjectTempDir(input.projectAlias, input.project),
          cacheDir: host.resolveProjectCacheDir(input.projectAlias, input.project),
        }
      : backend.name === 'qwen'
        ? {
            approvalMode: input.project.qwen_approval_mode ?? host.config.qwen?.default_approval_mode,
            model: input.project.qwen_model ?? host.config.qwen?.default_model,
            allowedTools: input.project.qwen_allowed_tools ?? host.config.qwen?.allowed_tools,
            systemPromptAppend: input.project.qwen_system_prompt_append ?? host.config.qwen?.system_prompt_append,
          }
        : {
            permissionMode: input.project.claude_permission_mode ?? host.config.claude?.default_permission_mode,
            model: input.project.claude_model ?? host.config.claude?.default_model,
            maxBudgetUsd: input.project.claude_max_budget_usd ?? host.config.claude?.max_budget_usd,
            allowedTools: input.project.claude_allowed_tools ?? host.config.claude?.allowed_tools,
            systemPromptAppend: input.project.claude_system_prompt_append ?? host.config.claude?.system_prompt_append,
          },
    onSpawn: async (pid) => {
      activeRun.pid = pid;
      await host.runStateStore.upsertRun(runId, {
        queue_key: input.queueKey,
        conversation_key: input.sessionKey,
        project_alias: input.projectAlias,
        chat_id: input.chatId,
        actor_id: input.actorId,
        session_id: sessionId,
        project_root: projectRoot,
        prompt_excerpt: truncateExcerpt(input.prompt),
        status: 'running',
        status_detail: undefined,
        pid,
      });
    },
    onEvent: async (event: BackendEvent) => {
      if (!host.config.service.emit_progress_updates) {
        return;
      }
      const message = backend.summarizeEvent(event);
      if (!message) {
        return;
      }
      const now = Date.now();
      if (now - lastProgressUpdate < host.config.service.progress_update_interval_ms) {
        return;
      }
      lastProgressUpdate = now;
      await host.updateRunProgressReply(input, runId, message, backendLabel);
    },
  });

  try {
    const outputTokenLimit = backend.name === 'claude'
      ? (host.config.claude?.output_token_limit ?? host.config.codex.output_token_limit)
      : backend.name === 'qwen'
        ? (host.config.qwen?.output_token_limit ?? host.config.codex.output_token_limit)
        : host.config.codex.output_token_limit;
    let result: BackendRunResult;
    try {
      result = await runBackendTurn(currentSession?.thread_id);
    } catch (error) {
      const staleSessionId = currentSession?.thread_id;
      if (!staleSessionId || !isMissingBackendSessionError(error)) {
        throw error;
      }

      await host.sessionStore.dropProjectSession(input.sessionKey, input.projectAlias, staleSessionId);
      currentSession = currentSession
        ? {
            ...currentSession,
            thread_id: undefined,
            active_thread_id: undefined,
          }
        : undefined;
      await host.auditLog.append({
        type: 'codex.run.session_stale',
        run_id: runId,
        chat_id: input.chatId,
        actor_id: input.actorId,
        project_alias: input.projectAlias,
        conversation_key: input.sessionKey,
        session_id: staleSessionId,
        backend: backend.name,
      });
      host.logger.warn(
        {
          runId,
          queueKey: input.queueKey,
          sessionKey: input.sessionKey,
          projectAlias: input.projectAlias,
          sessionId: staleSessionId,
          backend: backend.name,
        },
        'Dropped stale backend session and retrying without resume',
      );
      await host.runStateStore.upsertRun(runId, {
        queue_key: input.queueKey,
        conversation_key: input.sessionKey,
        project_alias: input.projectAlias,
        chat_id: input.chatId,
        actor_id: input.actorId,
        session_id: undefined,
        project_root: projectRoot,
        pid: activeRun.pid,
        prompt_excerpt: truncateExcerpt(input.prompt),
        status: 'running',
        status_detail: 'stale session dropped; retrying without resume',
      });
      result = await runBackendTurn(undefined);
    }

    const excerpt = result.finalMessage.slice(0, outputTokenLimit);
    if (!excerpt.trim()) {
      host.logger.warn(
        {
          runId,
          queueKey: input.queueKey,
          sessionKey: input.sessionKey,
          projectAlias: input.projectAlias,
          sessionId: result.sessionId,
          durationMs: Date.now() - startedAt,
        },
        'Codex run completed without a displayable final message',
      );
    }
    // Extract and send any [SEND_FILE:path] markers before text reply
    const { cleanText: excerptWithoutFiles, filePaths } = extractFileMarkers(excerpt);
    if (filePaths.length > 0) {
      for (const filePath of filePaths) {
        try {
          await host.feishuClient.sendFile(input.chatId, filePath);
          host.logger.info({ chatId: input.chatId, filePath }, 'Sent file to Feishu');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          host.logger.warn({ chatId: input.chatId, filePath, error: msg }, 'Failed to send file to Feishu');
          // Notify user about the failure inline
          excerptWithoutFiles === excerpt || await host.feishuClient.sendText(input.chatId, `⚠️ 文件发送失败: ${filePath}\n${msg}`);
        }
      }
    }
    const finalExcerpt = excerptWithoutFiles.trim() || excerpt;
    const cardSummary = truncateForFeishuCard(finalExcerpt || `${backendLabel} 已完成，但没有返回可显示文本。`);
    await host.auditLog.append({
      type: 'codex.run.completed',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      project_alias: input.projectAlias,
      conversation_key: input.sessionKey,
      session_id: result.sessionId,
      exit_code: result.exitCode,
      duration_ms: Date.now() - startedAt,
      backend: backend.name,
    });
    await host.appendProjectAuditEvent(input.projectAlias, input.project, {
      type: 'codex.run.completed',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      session_id: result.sessionId,
      duration_ms: Date.now() - startedAt,
      backend: backend.name,
    });
    host.logger.info(
      {
        runId,
        queueKey: input.queueKey,
        sessionKey: input.sessionKey,
        projectAlias: input.projectAlias,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        finalMessageChars: excerpt.length,
        durationMs: Date.now() - startedAt,
      },
      'Codex run completed',
    );
    await host.sessionStore.upsertProjectSession(input.sessionKey, input.projectAlias, {
      thread_id: result.sessionId,
      last_prompt: input.prompt,
      last_response_excerpt: excerpt,
    });
    if (host.config.service.memory_enabled && result.sessionId) {
      const summaryDraft = summarizeThreadTurn({
        previousSummary: memoryContext.threadSummary?.summary,
        prompt: input.prompt,
        responseExcerpt: excerpt,
        maxChars: host.config.service.thread_summary_max_chars,
      });
      const threadSummary = await host.memoryStore.upsertThreadSummary({
        conversation_key: input.sessionKey,
        project_alias: input.projectAlias,
        thread_id: result.sessionId,
        summary: summaryDraft.summary,
        recent_prompt: input.prompt,
        recent_response_excerpt: excerpt,
        files_touched: summaryDraft.filesTouched,
        open_tasks: summaryDraft.openTasks,
        decisions: summaryDraft.decisions,
      });
      await host.auditLog.append({
        type: 'memory.thread_summary.updated',
        run_id: runId,
        project_alias: input.projectAlias,
        conversation_key: input.sessionKey,
        thread_id: result.sessionId,
        files_touched: threadSummary.files_touched,
      });
    }
    await host.enforceSessionHistoryLimit(input.sessionKey, input.projectAlias);
    await host.runStateStore.upsertRun(runId, {
      queue_key: input.queueKey,
      conversation_key: input.sessionKey,
      project_alias: input.projectAlias,
      chat_id: input.chatId,
      actor_id: input.actorId,
      session_id: result.sessionId,
      project_root: projectRoot,
      pid: activeRun.pid,
      prompt_excerpt: truncateExcerpt(input.prompt),
      status: 'success',
      status_detail: undefined,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      estimated_cost_usd: estimateCost(result.inputTokens, result.outputTokens, backend.name),
    });
    host.metrics?.recordCodexTurn('success', input.projectAlias, (Date.now() - startedAt) / 1000, runId);

    // Record cost and token metrics
    if (result.inputTokens || result.outputTokens) {
      const costUsd = estimateCost(result.inputTokens, result.outputTokens, backend.name) ?? 0;
      host.metrics?.recordCost(input.projectAlias, backend.name, costUsd);
      host.metrics?.recordTokens(input.projectAlias, backend.name, result.inputTokens ?? 0, result.outputTokens ?? 0);
    }

    // Direction 5: Record trust outcome
    try {
      const trustState = await host.trustStore.getOrCreate(input.projectAlias);
      const updated = recordRunOutcome(trustState, true, DEFAULT_TRUST_POLICY);
      await host.trustStore.update(input.projectAlias, updated);
      host.metrics?.recordTrustLevel(input.projectAlias, updated.current_level);
    } catch { /* trust tracking is best-effort */ }

    // Proactive alerts: check if this run triggers any team alerts
    try {
      const completedRunState = await host.runStateStore.getRun(runId);
      if (completedRunState) {
        await host.checkAndSendAlerts(completedRunState);
      }
    } catch { /* alerts are best-effort */ }

    // Direction 2: Auto-extract knowledge
    if (host.config.service.memory_enabled && excerpt.length >= 100) {
      try {
        const insight = extractInsights(input.prompt, excerpt, input.projectAlias);
        if (insight) {
          await host.memoryStore.saveProjectMemory({
            project_alias: insight.project_alias,
            title: insight.title,
            content: insight.content,
            tags: insight.tags,
            source: 'auto',
            created_by: input.actorId,
          });
        }
      } catch { /* auto-extraction is best-effort */ }
    }

    await host.sendOrUpdateRunOutcome({
      input,
      runId,
      title: `${backendLabel} 已完成`,
      body: finalExcerpt || `${backendLabel} 已完成，但没有返回可显示文本。`,
      runStatus: 'success',
      runPhase: '已完成',
      cardSummary,
      sessionId: result.sessionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = error instanceof Error && error.name === 'AbortError' && activeRun.cancelReason === 'user';
    const status = cancelled ? 'cancelled' : 'failure';
    if (!cancelled && error instanceof Error && error.name === 'AbortError') {
      activeRun.cancelReason = 'timeout';
    }
    if (!cancelled && activeRun.cancelReason === 'timeout') {
      host.metrics?.recordCodexTurn('failure', input.projectAlias, (Date.now() - startedAt) / 1000, runId);
    } else {
      host.metrics?.recordCodexTurn(cancelled ? 'cancelled' : 'failure', input.projectAlias, (Date.now() - startedAt) / 1000, runId);
    }
    await host.runStateStore.upsertRun(runId, {
      queue_key: input.queueKey,
      conversation_key: input.sessionKey,
      project_alias: input.projectAlias,
      chat_id: input.chatId,
      actor_id: input.actorId,
      session_id: currentSession?.thread_id,
      project_root: projectRoot,
      pid: activeRun.pid,
      prompt_excerpt: truncateExcerpt(input.prompt),
      status,
      status_detail: undefined,
      error: message,
    });
    await host.auditLog.append({
      type: cancelled ? 'codex.run.cancelled' : 'codex.run.failed',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      project_alias: input.projectAlias,
      conversation_key: input.sessionKey,
      error: message,
    });
    await host.appendProjectAuditEvent(input.projectAlias, input.project, {
      type: cancelled ? 'codex.run.cancelled' : 'codex.run.failed',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      error: message,
    });
    // Direction 5: Record trust failure (only for actual failures, not cancellations)
    if (!cancelled) {
      try {
        const trustState = await host.trustStore.getOrCreate(input.projectAlias);
        const updated = recordRunOutcome(trustState, false, DEFAULT_TRUST_POLICY);
        await host.trustStore.update(input.projectAlias, updated);
      } catch { /* trust tracking is best-effort */ }
      // Notify project chats about the failure
      await host.notifyProjectChats(input.projectAlias,
        `❌ 运行失败 [${input.projectAlias}]\n${message.slice(0, 200)}`);
      // Proactive alerts on failure
      try {
        const failedRunState = await host.runStateStore.getRun(runId);
        if (failedRunState) {
          await host.checkAndSendAlerts(failedRunState);
        }
      } catch { /* alerts are best-effort */ }
    }
    if (cancelled) {
      host.logger.warn(
        {
          runId,
          queueKey: input.queueKey,
          sessionKey: input.sessionKey,
          projectAlias: input.projectAlias,
          durationMs: Date.now() - startedAt,
        },
        'Codex run cancelled',
      );
    } else {
      host.logger.error(
        {
          error,
          runId,
          queueKey: input.queueKey,
          sessionKey: input.sessionKey,
          projectAlias: input.projectAlias,
          durationMs: Date.now() - startedAt,
        },
        'Codex run failed',
      );
    }
    await host.sendOrUpdateRunOutcome({
      input,
      runId,
      title: cancelled ? '运行已取消' : '执行失败',
      body: cancelled ? '当前运行已取消。' : ['执行失败。', '', friendlyErrorMessage(message)].join('\n'),
      runStatus: cancelled ? 'cancelled' : 'failure',
      runPhase: cancelled ? '已取消' : '失败',
      cardSummary: truncateForFeishuCard(cancelled ? '当前运行已取消。' : friendlyErrorMessage(message)),
    });
  } finally {
    host.activeRuns.delete(input.queueKey);
    host.runReplyTargets.delete(runId);
  }
}

function isMissingBackendSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'No conversation found with session ID',
    'No conversation found',
    'Session not found',
    'conversation not found',
  ].some((needle) => message.includes(needle));
}
