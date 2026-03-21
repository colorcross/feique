import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig, ProjectConfig, SessionScope } from '../config/schema.js';
import {
  buildHelpText,
  buildFullHelpText,
  describeBridgeCommand,
  isReadOnlyCommand,
  normalizeIncomingText,
  parseBridgeCommand,
  type MemoryCommandFilters,
  type MemoryScopeTarget,
} from './commands.js';
import type { IncomingCardActionContext, IncomingMessageContext } from './types.js';
import { SessionStore, buildConversationKey, type ConversationState } from '../state/session-store.js';
import type { Logger } from '../logging.js';
import { FeishuClient, type FeishuMessageResponse } from '../feishu/client.js';
import { buildMessageCard, buildStatusCard } from '../feishu/cards.js';
import { TaskQueue } from './task-queue.js';
import { AuditLog } from '../state/audit-log.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { IdempotencyStore } from '../state/idempotency-store.js';
import { RunStateStore, type RunState } from '../state/run-state-store.js';
import { isProcessAlive, terminateProcess } from '../runtime/process.js';
import { resolveKnowledgeRoots, searchKnowledgeBase } from '../knowledge/search.js';
import { FeishuWikiClient } from '../feishu/wiki.js';
import { FeishuDocClient } from '../feishu/doc.js';
import { FeishuBaseClient } from '../feishu/base.js';
import { FeishuTaskClient } from '../feishu/task.js';
import { resolveMessageResources } from '../feishu/message-resource.js';
import { MemoryStore } from '../state/memory-store.js';
import { retrieveMemoryContext, type MemoryContext } from '../memory/retrieve.js';
import { summarizeThreadTurn } from '../memory/summarize.js';
import { CodexSessionIndex } from '../codex/session-index.js';
import type { Backend, BackendEvent, BackendName } from '../backend/types.js';
import { resolveProjectBackendWithOverride, resolveProjectBackendName } from '../backend/factory.js';
import { bindProjectAlias, createProjectAlias, removeProjectAlias, updateProjectConfig, updateStringList } from '../config/mutate.js';
import { buildFeishuPost, truncateForFeishuCard } from '../feishu/text.js';
import { ConfigHistoryStore, type ConfigSnapshot } from '../state/config-history-store.js';
import { loadBridgeConfigFile } from '../config/load.js';
import { ensureDir, writeUtf8Atomic } from '../utils/fs.js';
import { expandHomePath } from '../utils/path.js';
import { canAccessGlobalCapability, canAccessProject, canAccessProjectCapability, describeMinimumRole, filterAccessibleProjects, resolveProjectAccessRole, type AccessRole } from '../security/access.js';
import { adoptProjectSession as adoptSharedProjectSession, listBridgeSessions as listSharedBridgeSessions, switchProjectBinding as switchSharedProjectBinding } from '../control-plane/project-session.js';
import { getProjectArchiveDir, getProjectAuditDir, getProjectAuditFile, getProjectCacheDir, getProjectDownloadsDir, getProjectTempDir } from '../projects/paths.js';
import { buildTeamActivityView, detectOverlaps, formatTeamView, formatOverlapAlerts } from '../collaboration/awareness.js';
import { extractInsights, buildLearnInput, formatRecallResults } from '../collaboration/knowledge.js';
import { createHandoff, acceptHandoff, createReview, resolveReview, formatHandoff, formatReview, formatReviewResult } from '../collaboration/handoff.js';
import { analyzeTeamHealth, formatInsightsReport } from '../collaboration/insights.js';
import { classifyOperation, enforceTrustBoundary, recordRunOutcome, formatTrustState, DEFAULT_TRUST_POLICY, type TrustLevel } from '../collaboration/trust.js';
import { buildProjectTimeline, buildOnboardingContext, formatTimeline, isNewActor } from '../collaboration/timeline.js';
import { HandoffStore } from '../state/handoff-store.js';
import { TrustStore } from '../state/trust-store.js';
import { IntentClassifier } from './intent-classifier.js';
import { buildTeamDigest, formatTeamDigest, createDigestPeriod } from '../collaboration/digest.js';
import { checkRunAlerts, checkLongRunningAlerts, formatAlert, type AlertRules, DEFAULT_ALERT_RULES } from '../collaboration/proactive-alerts.js';
import { detectKnowledgeGaps, formatKnowledgeGaps } from '../collaboration/knowledge-gaps.js';
import { estimateCost } from '../observability/cost.js';

interface ActiveRunHandle {
  runId: string;
  controller: AbortController;
  pid?: number;
  cancelReason?: 'user' | 'timeout' | 'recovery';
}

interface QueuedExecutionNotice {
  runId: string;
  detail: string;
  reason: 'project' | 'project-root';
}

interface ScheduledProjectExecution {
  runId: string;
  queued: QueuedExecutionNotice | null;
  release: () => void;
  completion: Promise<void>;
}

interface RuntimeControl {
  configPath?: string;
  restart?: () => Promise<void>;
}

interface RunReplyTarget {
  messageId?: string;
  mode: BridgeConfig['service']['reply_mode'];
}

interface RunLifecycleReplyDraft {
  title: string;
  body: string;
  runStatus: 'queued' | 'running';
  runPhase: string;
}

export class FeiqueService {
  private readonly queue = new TaskQueue();
  private readonly projectRootQueue = new TaskQueue();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private readonly runReplyTargets = new Map<string, RunReplyTarget>();
  private readonly chatRateWindows = new Map<string, number[]>();
  private maintenanceTimer?: NodeJS.Timeout;
  private digestTimer?: NodeJS.Timeout;
  private readonly intentClassifier?: IntentClassifier;
  /** Tracks the current incoming message for @mention in replies. */
  private currentMessageContext?: IncomingMessageContext;

  public constructor(
    private readonly config: BridgeConfig,
    private readonly feishuClient: FeishuClient,
    private readonly sessionStore: SessionStore,
    private readonly auditLog: AuditLog,
    private readonly logger: Logger,
    private readonly metrics?: MetricsRegistry,
    private readonly idempotencyStore: IdempotencyStore = new IdempotencyStore(config.storage.dir),
    private readonly runStateStore: RunStateStore = new RunStateStore(config.storage.dir),
    private readonly memoryStore: MemoryStore = new MemoryStore(config.storage.dir),
    private readonly codexSessionIndex: CodexSessionIndex = new CodexSessionIndex(),
    private readonly runtimeControl?: RuntimeControl,
    private readonly adminAuditLog: AuditLog = new AuditLog(config.storage.dir, 'admin-audit.jsonl'),
    private readonly configHistoryStore: ConfigHistoryStore = new ConfigHistoryStore(config.storage.dir),
    private readonly handoffStore: HandoffStore = new HandoffStore(config.storage.dir),
    private readonly trustStore: TrustStore = new TrustStore(config.storage.dir),
  ) {
    if (config.service.intent_classifier_enabled) {
      const defaultBackend = config.backend?.default ?? 'codex';
      const isClaude = defaultBackend === 'claude';
      this.intentClassifier = new IntentClassifier({
        enabled: true,
        backend: defaultBackend,
        backend_bin: isClaude ? (config.claude?.bin ?? 'claude') : config.codex.bin,
        shell: isClaude ? config.claude?.shell : config.codex.shell,
        pre_exec: isClaude ? config.claude?.pre_exec : config.codex.pre_exec,
        ollama_base_url: config.embedding.provider === 'ollama' ? config.embedding.ollama_base_url : undefined,
        timeout_ms: config.service.intent_classifier_timeout_ms,
        min_confidence: config.service.intent_classifier_min_confidence,
      });
    }
  }

  public async recoverRuntimeState(): Promise<RunState[]> {
    const recovered = await this.runStateStore.recoverOrphanedRuns();
    for (const run of recovered) {
      await this.auditLog.append({
        type: 'codex.run.recovered',
        run_id: run.run_id,
        project_alias: run.project_alias,
        conversation_key: run.conversation_key,
        status: run.status,
        pid: run.pid,
      });
    }
    return recovered;
  }

  public startMaintenanceLoop(): void {
    if (this.maintenanceTimer) {
      return;
    }
    const intervals: number[] = [];
    if (this.config.service.memory_enabled) {
      intervals.push(this.config.service.memory_cleanup_interval_seconds * 1000);
    }
    intervals.push(this.config.service.audit_cleanup_interval_seconds * 1000);
    const intervalMs = Math.min(...intervals.filter((value) => Number.isFinite(value) && value > 0));
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenanceCycle();
    }, intervalMs);
    this.maintenanceTimer.unref?.();
    this.startDigestLoop();
  }

  public stopMaintenanceLoop(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = undefined;
    }
  }

  public startDigestLoop(): void {
    if (this.digestTimer || !this.config.service.team_digest_enabled) {
      return;
    }
    if (this.config.service.team_digest_chat_ids.length === 0) {
      return;
    }
    const intervalMs = this.config.service.team_digest_interval_hours * 3600_000;
    this.digestTimer = setInterval(() => {
      void this.runDigestCycle();
    }, intervalMs);
    this.digestTimer.unref?.();
  }

  public async runDigestCycle(): Promise<void> {
    const chatIds = this.config.service.team_digest_chat_ids;
    if (chatIds.length === 0) return;

    try {
      const period = createDigestPeriod(this.config.service.team_digest_interval_hours);
      const runs = await this.runStateStore.listRuns();
      const memories = this.config.service.memory_enabled
        ? await this.memoryStore.listRecentMemories({ scope: 'project', project_alias: '' }, 100)
        : [];
      const auditEvents = await this.auditLog.tail(500);

      const digest = buildTeamDigest(runs, memories, auditEvents, period);

      if (digest.summary.total_runs === 0) {
        return; // Nothing to report
      }

      const text = formatTeamDigest(digest);
      for (const chatId of chatIds) {
        try {
          await this.feishuClient.sendText(chatId, text);
        } catch (error) {
          this.logger.warn({ chatId, error }, 'Failed to send team digest');
        }
      }

      await this.auditLog.append({
        type: 'collaboration.digest.sent',
        period_label: period.label,
        total_runs: digest.summary.total_runs,
        chat_ids: chatIds,
      });

      // Send per-project mini-digests to project notification chats
      for (const projectDigest of digest.topProjects) {
        const projectChatIds = this.config.projects[projectDigest.alias]?.notification_chat_ids ?? [];
        if (projectChatIds.length === 0) continue;
        const successPct = Math.round(projectDigest.success_rate * 100);
        const miniDigestText = [
          `📊 项目摘要 [${projectDigest.alias}] — ${period.label}`,
          `运行: ${projectDigest.runs} | 成功率: ${successPct}%`,
          `参与者: ${projectDigest.actors.join(', ') || '无'}`,
        ].join('\n');
        for (const chatId of projectChatIds) {
          try {
            await this.feishuClient.sendText(chatId, miniDigestText);
          } catch { /* best-effort */ }
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Failed to generate team digest');
    }
  }

  public async runMemoryMaintenance(): Promise<number> {
    if (!this.config.service.memory_enabled) {
      return 0;
    }
    const cleaned = await this.memoryStore.cleanupExpiredMemories();
    if (cleaned > 0) {
      await this.auditLog.append({
        type: 'memory.archive.expired.maintenance',
        count: cleaned,
      });
      this.logger.info({ cleaned }, 'Expired memories cleaned by background maintenance');
    }
    return cleaned;
  }

  public async runAuditMaintenance(): Promise<{ scanned: number; archived: number; removed: number }> {
    const auditTargets = this.listManagedAuditTargets();
    let scanned = 0;
    let archived = 0;
    let removed = 0;

    for (const target of auditTargets) {
      const auditLog = new AuditLog(target.stateDir, target.fileName);
      const result = await auditLog.cleanup({
        retentionDays: this.config.service.audit_retention_days,
        archiveAfterDays: this.config.service.audit_archive_after_days,
        archiveDir: target.archiveDir,
      });
      scanned += 1;
      archived += result.archived;
      removed += result.removed;
    }

    if (archived > 0 || removed > 0) {
      await this.auditLog.append({
        type: 'audit.cleanup.completed',
        scanned,
        archived,
        removed,
      });
      this.logger.info({ scanned, archived, removed }, 'Audit retention cleanup completed');
    }

    return { scanned, archived, removed };
  }

  public async runMaintenanceCycle(): Promise<void> {
    if (this.config.service.memory_enabled) {
      await this.runMemoryMaintenance();
    }
    await this.runAuditMaintenance();

    // Proactive: check for long-running tasks
    try {
      const activeRuns = await this.runStateStore.listRuns();
      const longAlerts = checkLongRunningAlerts(activeRuns);
      for (const alert of longAlerts) {
        const text = formatAlert(alert);
        for (const chatId of this.config.security.admin_chat_ids) {
          try { await this.feishuClient.sendText(chatId, text); } catch { /* best-effort */ }
        }
        await this.notifyProjectChats(alert.project_alias, text);
      }
    } catch { /* best-effort */ }
  }

  public async handleIncomingMessage(context: IncomingMessageContext): Promise<void> {
    this.currentMessageContext = context;
    if (!context.text.trim() && context.attachments.length === 0) {
      return;
    }

    if (context.sender_type && context.sender_type !== 'user') {
      this.logger.info({ chatId: context.chat_id, senderType: context.sender_type, messageId: context.message_id }, 'Ignoring non-user message');
      return;
    }

    if (context.message_id) {
      const key = buildMessageDedupeKey(context);
      const dedupe = await this.idempotencyStore.register(key, 'message', this.config.service.idempotency_ttl_seconds);
      if (dedupe.duplicate) {
        this.metrics?.recordDuplicateEvent('message');
        await this.auditLog.append({
          type: 'message.duplicate_ignored',
          message_id: context.message_id,
          chat_id: context.chat_id,
          actor_id: context.actor_id,
        });
        return;
      }
    }

    if (!Object.keys(this.config.projects).length) {
      await this.sendTextReply(context.chat_id, '未配置任何项目。请先执行 `feique bind <alias> <path>`。', context.message_id, context.text);
      return;
    }

    const normalizedText = normalizeIncomingText(context.text);
    const selectionKey = await this.getSelectionConversationKey(context);
    let command = parseBridgeCommand(context.text);

    // AI intent fallback: when regex doesn't match, try AI classification
    if (command.kind === 'prompt' && this.intentClassifier) {
      try {
        const aiCommand = await this.intentClassifier.classify(normalizedText);
        if (aiCommand) {
          command = aiCommand;
          this.logger.info({ originalText: normalizedText, aiCommand: command.kind }, 'AI intent classifier matched');
        }
      } catch { /* AI classification is best-effort */ }
    }

    this.metrics?.recordIncomingMessage(context.chat_type, command.kind);
    await this.auditLog.append({
      type: 'message.received',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      command: command.kind,
      message_id: context.message_id,
      text: context.text,
      message_type: context.message_type,
      attachment_count: context.attachments.length,
    });

    try {
      switch (command.kind) {
        case 'help':
          await this.sendTextReply(context.chat_id, command.detail ? buildFullHelpText() : buildHelpText(), context.message_id, context.text);
          return;
        case 'projects':
          await this.sendTextReply(context.chat_id, await this.buildProjectsText(selectionKey, context.chat_id), context.message_id, context.text);
          return;
        case 'project':
          await this.handleProjectCommand(context, selectionKey, command.alias, command.followupPrompt);
          return;
        case 'status':
          await this.handleStatusCommand(context, selectionKey, command.detail === true);
          return;
        case 'new':
          await this.handleNewCommand(context, selectionKey);
          return;
        case 'cancel':
          await this.handleCancelCommand(context, selectionKey);
          return;
        case 'kb':
          await this.handleKnowledgeCommand(context, selectionKey, command.action, command.query);
          return;
        case 'doc':
          await this.handleDocCommand(context, selectionKey, command.action, command.value, command.extra);
          return;
        case 'task':
          await this.handleTaskCommand(context, selectionKey, command.action, command.value);
          return;
        case 'base':
          await this.handleBaseCommand(context, selectionKey, command.action, command.appToken, command.tableId, command.recordId, command.value);
          return;
        case 'memory':
          await this.handleMemoryCommand(context, selectionKey, command.action, command.scope, command.value, command.filters);
          return;
        case 'wiki':
          await this.handleWikiCommand(context, selectionKey, command.action, command.value, command.extra, command.target, command.role);
          return;
        case 'backend':
          await this.handleBackendCommand(context, selectionKey, command.name);
          return;
        case 'session':
          const sessionArgument = command.action === 'adopt' ? command.target : command.threadId;
          await this.handleSessionCommand(
            context,
            selectionKey,
            command.action,
            sessionArgument,
          );
          return;
        case 'admin':
          await this.handleAdminCommand(context, selectionKey, command);
          return;
        case 'team':
          await this.handleTeamCommand(context);
          return;
        case 'learn':
          this.metrics?.recordCollaborationEvent('learn');
          await this.handleLearnCommand(context, selectionKey, command.value);
          return;
        case 'recall':
          this.metrics?.recordCollaborationEvent('recall');
          await this.handleRecallCommand(context, selectionKey, command.query);
          return;
        case 'handoff':
          this.metrics?.recordCollaborationEvent('handoff');
          await this.handleHandoffCommand(context, selectionKey, command.summary);
          return;
        case 'pickup':
          this.metrics?.recordCollaborationEvent('pickup');
          await this.handlePickupCommand(context, selectionKey, command.id);
          return;
        case 'review':
          this.metrics?.recordCollaborationEvent('review');
          await this.handleReviewCommand(context, selectionKey);
          return;
        case 'approve':
          this.metrics?.recordCollaborationEvent('approve');
          await this.handleApproveCommand(context, command.comment);
          return;
        case 'reject':
          this.metrics?.recordCollaborationEvent('reject');
          await this.handleRejectCommand(context, command.reason);
          return;
        case 'insights':
          await this.handleInsightsCommand(context);
          return;
        case 'trust':
          await this.handleTrustCommand(context, selectionKey, command.action, command.level);
          return;
        case 'timeline':
          await this.handleTimelineCommand(context, selectionKey, command.project);
          return;
        case 'digest':
          this.metrics?.recordCollaborationEvent('digest');
          await this.handleDigestCommand(context);
          return;
        case 'gaps':
          await this.handleGapsCommand(context);
          return;
        case 'prompt':
          await this.handlePromptMessage(context, selectionKey, command.prompt, context.text);
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ error, chatId: context.chat_id, actorId: context.actor_id, command: command.kind }, 'Failed to handle incoming message');
      await this.auditLog.append({
        type: 'message.failed',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        command: command.kind,
        error: message,
        message_id: context.message_id,
      });
      await this.sendTextReply(context.chat_id, `处理失败:\n${friendlyErrorMessage(message)}`, context.message_id, context.text);
    }
  }

  public async handleCardAction(context: IncomingCardActionContext): Promise<Record<string, unknown>> {
    const action = typeof context.action_value.action === 'string' ? context.action_value.action : 'status';
    const dedupeKey = buildCardDedupeKey(context, action);
    if (dedupeKey) {
      const dedupe = await this.idempotencyStore.register(dedupeKey, 'card', this.config.service.idempotency_ttl_seconds);
      if (dedupe.duplicate) {
        this.metrics?.recordDuplicateEvent('card');
        return buildStatusCard({
          title: '重复操作已忽略',
          summary: '这次卡片动作已经处理过，不会再次提交。',
          projectAlias: typeof context.action_value.project_alias === 'string' ? context.action_value.project_alias : 'unknown',
          includeActions: false,
        });
      }
    }

    this.metrics?.recordCardAction(action);
    await this.auditLog.append({
      type: 'card.action',
      action,
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      open_message_id: context.open_message_id,
    });
    const projectAlias = typeof context.action_value.project_alias === 'string' ? context.action_value.project_alias : undefined;
    const sessionKey = typeof context.action_value.conversation_key === 'string' ? context.action_value.conversation_key : undefined;
    const chatId = typeof context.action_value.chat_id === 'string' ? context.action_value.chat_id : context.chat_id;

    if (!projectAlias || !sessionKey || !chatId) {
      return buildStatusCard({
        title: '无法处理卡片操作',
        summary: '卡片中缺少会话元数据。请直接在飞书里发送文本继续。',
        projectAlias: projectAlias ?? 'unknown',
        includeActions: false,
      });
    }

    const project = this.requireProject(projectAlias);
    const queueKey = buildQueueKey(sessionKey, projectAlias);
    const conversation = await this.sessionStore.getConversation(sessionKey);
    if (!conversation) {
      return buildStatusCard({
        title: '会话不存在',
        summary: '对应的会话状态已经丢失。请发送 `/new` 后重新开始。',
        projectAlias,
        includeActions: false,
      });
    }

    if (action === 'new') {
      await this.sessionStore.clearActiveProjectSession(sessionKey, projectAlias);
      return buildStatusCard({
        title: '会话已重置',
        summary: '下一条文本消息会启动一个新的 Codex 会话。',
        projectAlias,
        includeActions: false,
      });
    }

    if (action === 'cancel') {
      const cancelled = await this.cancelActiveRun(queueKey, 'user');
      return buildStatusCard({
        title: cancelled ? '已提交取消' : '没有可取消的运行',
        summary: cancelled ? '当前项目的运行正在停止。' : '当前项目没有活动中的运行。',
        projectAlias,
        includeActions: false,
      });
    }

    if (action === 'rerun') {
      const previousPrompt = conversation.projects[projectAlias]?.last_prompt;
      if (!previousPrompt) {
        return buildStatusCard({
          title: '无法重试',
          summary: '没有找到上一轮提示词，请直接发新消息。',
          projectAlias,
          includeActions: false,
        });
      }
      const scheduled = await this.scheduleProjectExecution(
        {
          projectAlias,
          project,
          sessionKey,
          queueKey,
        },
        {
          chatId,
          actorId: context.actor_id,
          prompt: previousPrompt,
        },
        async (runId) => {
          await this.executePrompt({
            runId,
            chatId,
            actorId: context.actor_id,
            tenantKey: context.tenant_key,
            projectAlias,
            project,
            incomingMessage: {
              tenant_key: context.tenant_key,
              chat_id: chatId,
              chat_type: 'unknown',
              actor_id: context.actor_id,
              message_id: context.open_message_id ?? `card-rerun-${Date.now()}`,
              message_type: 'card-action',
              text: previousPrompt,
              attachments: [],
              mentions: [],
              raw: context.raw,
            },
            prompt: previousPrompt,
            sessionKey,
            queueKey,
          });
        },
      );
      scheduled.release();
      void scheduled.completion.catch((error) => {
        this.logger.error({ error, projectAlias }, 'Queued rerun execution failed unexpectedly');
      });
      return buildStatusCard({
        title: scheduled.queued ? '已加入排队' : '已提交重试',
        summary: scheduled.queued?.detail ?? '桥接器正在重新执行上一轮，结果会通过消息回传。',
        projectAlias,
        sessionId: conversation.projects[projectAlias]?.thread_id,
        runStatus: scheduled.queued ? 'queued' : undefined,
        runPhase: scheduled.queued ? '排队中' : undefined,
        includeActions: false,
      });
    }

    return this.buildStatusCardFromConversation(projectAlias, sessionKey, conversation, await this.runStateStore.getLatestVisibleRun(queueKey));
  }

  public async listRuns(): Promise<RunState[]> {
    return this.runStateStore.listRuns();
  }

  private async executePrompt(input: {
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
  }): Promise<void> {
    const conversation =
      (await this.sessionStore.getConversation(input.sessionKey)) ??
      (await this.sessionStore.ensureConversation(input.sessionKey, {
        chat_id: input.chatId,
        actor_id: input.actorId,
        tenant_key: input.tenantKey,
        scope: input.project.session_scope,
      }));
    let currentSession = conversation.projects[input.projectAlias];

    // Auto-adopt latest local session when no active session exists
    if (!currentSession?.thread_id && this.config.service.project_switch_auto_adopt_latest) {
      try {
        const sessionBackendOverrideForAdopt = await this.sessionStore.getProjectBackend(input.sessionKey, input.projectAlias);
        const backendForAdopt = this.resolveBackendByName(input.projectAlias, sessionBackendOverrideForAdopt);
        const latestLocal = await backendForAdopt.findLatestSession(input.project.root);
        if (latestLocal) {
          await this.sessionStore.upsertProjectSession(input.sessionKey, input.projectAlias, {
            thread_id: latestLocal.sessionId,
          });
          const refreshed = await this.sessionStore.getConversation(input.sessionKey);
          currentSession = refreshed?.projects[input.projectAlias];
          this.logger.info(
            { projectAlias: input.projectAlias, sessionId: latestLocal.sessionId, backend: latestLocal.backend },
            'Auto-adopted latest local session for prompt execution',
          );
        }
      } catch { /* auto-adopt is best-effort */ }
    }

    if (this.config.service.memory_enabled) {
      await this.memoryStore.cleanupExpiredMemories();
    }
    const memoryContext = this.config.service.memory_enabled
      ? await retrieveMemoryContext(this.memoryStore, {
          conversationKey: input.sessionKey,
          projectAlias: input.projectAlias,
          threadId: currentSession?.thread_id,
          query: input.prompt,
          searchLimit: this.config.service.memory_search_limit,
          groupChatId: input.incomingMessage.chat_type === 'group' ? input.incomingMessage.chat_id : undefined,
          includeGroupMemories: this.config.service.memory_group_enabled && input.incomingMessage.chat_type === 'group',
        })
      : { pinnedMemories: [], relevantMemories: [], pinnedGroupMemories: [], relevantGroupMemories: [] };
    // Direction 6: Inject onboarding context for new actors
    let onboardingPrefix = '';
    if (input.actorId && this.config.service.memory_enabled) {
      try {
        const allRuns = await this.runStateStore.listRuns();
        if (isNewActor(input.actorId, allRuns, input.projectAlias)) {
          const memories = await this.memoryStore.listRecentMemories(
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

    const bridgePrompt = await this.buildBridgePrompt(input.projectAlias, input.project, input.incomingMessage, effectivePrompt, memoryContext);
    const startedAt = Date.now();
    const projectRoot = this.resolveProjectRoot(input.project);
    const runId = input.runId ?? randomUUID();
    let lastProgressUpdate = 0;
    const activeRun: ActiveRunHandle = {
      runId,
      controller: new AbortController(),
    };
    this.activeRuns.set(input.queueKey, activeRun);
    const sessionBackendOverride = await this.sessionStore.getProjectBackend(input.sessionKey, input.projectAlias);
    const backend = this.resolveBackendByName(input.projectAlias, sessionBackendOverride);
    const backendLabel = backend.name === 'claude' ? 'Claude' : 'Codex';
    await this.updateRunStartedReply(input.chatId, input.projectAlias, runId, backendLabel);

    await this.runStateStore.upsertRun(runId, {
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
    await this.auditLog.append({
      type: 'codex.run.started',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      project_alias: input.projectAlias,
      conversation_key: input.sessionKey,
      session_id: currentSession?.thread_id,
      prompt: input.prompt,
    });
    await this.appendProjectAuditEvent(input.projectAlias, input.project, {
      type: 'codex.run.started',
      run_id: runId,
      chat_id: input.chatId,
      actor_id: input.actorId,
      session_id: currentSession?.thread_id,
      project_root: projectRoot,
    });
    this.logger.info(
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

    this.metrics?.recordCodexTurnStarted(input.projectAlias, runId);

    try {
      const outputTokenLimit = backend.name === 'claude'
        ? (this.config.claude?.output_token_limit ?? this.config.codex.output_token_limit)
        : this.config.codex.output_token_limit;
      const result = await backend.run({
        workdir: input.project.root,
        prompt: bridgePrompt,
        sessionId: currentSession?.thread_id,
        timeoutMs: backend.name === 'claude'
          ? (this.config.claude?.run_timeout_ms ?? this.config.codex.run_timeout_ms)
          : this.config.codex.run_timeout_ms,
        signal: activeRun.controller.signal,
        logger: this.logger,
        projectConfig: backend.name === 'codex'
          ? {
              profile: input.project.profile ?? this.config.codex.default_profile,
              sandbox: input.project.sandbox ?? this.config.codex.default_sandbox,
              tempDir: this.resolveProjectTempDir(input.projectAlias, input.project),
              cacheDir: this.resolveProjectCacheDir(input.projectAlias, input.project),
            }
          : {
              permissionMode: input.project.claude_permission_mode ?? this.config.claude?.default_permission_mode,
              model: input.project.claude_model ?? this.config.claude?.default_model,
              maxBudgetUsd: input.project.claude_max_budget_usd ?? this.config.claude?.max_budget_usd,
              allowedTools: input.project.claude_allowed_tools ?? this.config.claude?.allowed_tools,
              systemPromptAppend: input.project.claude_system_prompt_append ?? this.config.claude?.system_prompt_append,
            },
        onSpawn: async (pid) => {
          activeRun.pid = pid;
          await this.runStateStore.upsertRun(runId, {
            queue_key: input.queueKey,
            conversation_key: input.sessionKey,
            project_alias: input.projectAlias,
            chat_id: input.chatId,
            actor_id: input.actorId,
            session_id: currentSession?.thread_id,
            project_root: projectRoot,
            prompt_excerpt: truncateExcerpt(input.prompt),
            status: 'running',
            status_detail: undefined,
            pid,
          });
        },
        onEvent: async (event: BackendEvent) => {
          if (!this.config.service.emit_progress_updates) {
            return;
          }
          const message = backend.summarizeEvent(event);
          if (!message) {
            return;
          }
          const now = Date.now();
          if (now - lastProgressUpdate < this.config.service.progress_update_interval_ms) {
            return;
          }
          lastProgressUpdate = now;
          await this.updateRunProgressReply(input, runId, message, backendLabel);
        },
      });

      const excerpt = result.finalMessage.slice(0, outputTokenLimit);
      if (!excerpt.trim()) {
        this.logger.warn(
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
            await this.feishuClient.sendFile(input.chatId, filePath);
            this.logger.info({ chatId: input.chatId, filePath }, 'Sent file to Feishu');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn({ chatId: input.chatId, filePath, error: msg }, 'Failed to send file to Feishu');
            // Notify user about the failure inline
            excerptWithoutFiles === excerpt || await this.feishuClient.sendText(input.chatId, `⚠️ 文件发送失败: ${filePath}\n${msg}`);
          }
        }
      }
      const finalExcerpt = excerptWithoutFiles.trim() || excerpt;
      const cardSummary = truncateForFeishuCard(finalExcerpt || `${backendLabel} 已完成，但没有返回可显示文本。`);
      await this.auditLog.append({
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
      await this.appendProjectAuditEvent(input.projectAlias, input.project, {
        type: 'codex.run.completed',
        run_id: runId,
        chat_id: input.chatId,
        actor_id: input.actorId,
        session_id: result.sessionId,
        duration_ms: Date.now() - startedAt,
        backend: backend.name,
      });
      this.logger.info(
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
      await this.sessionStore.upsertProjectSession(input.sessionKey, input.projectAlias, {
        thread_id: result.sessionId,
        last_prompt: input.prompt,
        last_response_excerpt: excerpt,
      });
      if (this.config.service.memory_enabled && result.sessionId) {
        const summaryDraft = summarizeThreadTurn({
          previousSummary: memoryContext.threadSummary?.summary,
          prompt: input.prompt,
          responseExcerpt: excerpt,
          maxChars: this.config.service.thread_summary_max_chars,
        });
        const threadSummary = await this.memoryStore.upsertThreadSummary({
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
        await this.auditLog.append({
          type: 'memory.thread_summary.updated',
          run_id: runId,
          project_alias: input.projectAlias,
          conversation_key: input.sessionKey,
          thread_id: result.sessionId,
          files_touched: threadSummary.files_touched,
        });
      }
      await this.enforceSessionHistoryLimit(input.sessionKey, input.projectAlias);
      await this.runStateStore.upsertRun(runId, {
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
      this.metrics?.recordCodexTurn('success', input.projectAlias, (Date.now() - startedAt) / 1000, runId);

      // Record cost and token metrics
      if (result.inputTokens || result.outputTokens) {
        const costUsd = estimateCost(result.inputTokens, result.outputTokens, backend.name) ?? 0;
        this.metrics?.recordCost(input.projectAlias, backend.name, costUsd);
        this.metrics?.recordTokens(input.projectAlias, backend.name, result.inputTokens ?? 0, result.outputTokens ?? 0);
      }

      // Direction 5: Record trust outcome
      try {
        const trustState = await this.trustStore.getOrCreate(input.projectAlias);
        const updated = recordRunOutcome(trustState, true, DEFAULT_TRUST_POLICY);
        await this.trustStore.update(input.projectAlias, updated);
        this.metrics?.recordTrustLevel(input.projectAlias, updated.current_level);
      } catch { /* trust tracking is best-effort */ }

      // Proactive alerts: check if this run triggers any team alerts
      try {
        const completedRunState = await this.runStateStore.getRun(runId);
        if (completedRunState) {
          await this.checkAndSendAlerts(completedRunState);
        }
      } catch { /* alerts are best-effort */ }

      // Direction 2: Auto-extract knowledge
      if (this.config.service.memory_enabled && excerpt.length >= 100) {
        try {
          const insight = extractInsights(input.prompt, excerpt, input.projectAlias);
          if (insight) {
            await this.memoryStore.saveProjectMemory({
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

      await this.sendOrUpdateRunOutcome({
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
        this.metrics?.recordCodexTurn('failure', input.projectAlias, (Date.now() - startedAt) / 1000, runId);
      } else {
        this.metrics?.recordCodexTurn(cancelled ? 'cancelled' : 'failure', input.projectAlias, (Date.now() - startedAt) / 1000, runId);
      }
      await this.runStateStore.upsertRun(runId, {
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
      await this.auditLog.append({
        type: cancelled ? 'codex.run.cancelled' : 'codex.run.failed',
        run_id: runId,
        chat_id: input.chatId,
        actor_id: input.actorId,
        project_alias: input.projectAlias,
        conversation_key: input.sessionKey,
        error: message,
      });
      await this.appendProjectAuditEvent(input.projectAlias, input.project, {
        type: cancelled ? 'codex.run.cancelled' : 'codex.run.failed',
        run_id: runId,
        chat_id: input.chatId,
        actor_id: input.actorId,
        error: message,
      });
      // Direction 5: Record trust failure (only for actual failures, not cancellations)
      if (!cancelled) {
        try {
          const trustState = await this.trustStore.getOrCreate(input.projectAlias);
          const updated = recordRunOutcome(trustState, false, DEFAULT_TRUST_POLICY);
          await this.trustStore.update(input.projectAlias, updated);
        } catch { /* trust tracking is best-effort */ }
        // Notify project chats about the failure
        await this.notifyProjectChats(input.projectAlias,
          `❌ 运行失败 [${input.projectAlias}]\n${message.slice(0, 200)}`);
        // Proactive alerts on failure
        try {
          const failedRunState = await this.runStateStore.getRun(runId);
          if (failedRunState) {
            await this.checkAndSendAlerts(failedRunState);
          }
        } catch { /* alerts are best-effort */ }
      }
      if (cancelled) {
        this.logger.warn(
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
        this.logger.error(
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
      await this.sendOrUpdateRunOutcome({
        input,
        runId,
        title: cancelled ? '运行已取消' : '执行失败',
        body: cancelled ? '当前运行已取消。' : ['执行失败。', '', friendlyErrorMessage(message)].join('\n'),
        runStatus: cancelled ? 'cancelled' : 'failure',
        runPhase: cancelled ? '已取消' : '失败',
        cardSummary: truncateForFeishuCard(cancelled ? '当前运行已取消。' : friendlyErrorMessage(message)),
      });
    } finally {
      this.activeRuns.delete(input.queueKey);
      this.runReplyTargets.delete(runId);
    }
  }

  private async handleProjectCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    alias?: string,
    followupPrompt?: string,
  ): Promise<void> {
    if (!alias) {
      const currentAlias = await this.resolveProjectAlias(selectionKey);
      if (!canAccessProject(this.config, currentAlias, context.chat_id, 'viewer')) {
        await this.sendTextReply(
          context.chat_id,
          `当前 chat_id 无权查看项目 ${currentAlias}。至少需要 ${describeMinimumRole('viewer')} 权限。`,
          context.message_id,
          context.text,
        );
        return;
      }
      const project = this.requireProject(currentAlias);
      await this.sendTextReply(context.chat_id, `当前项目: ${currentAlias}${project.description ? `\n说明: ${project.description}` : ''}`, context.message_id, context.text);
      return;
    }

    if (!canAccessProject(this.config, alias, context.chat_id, 'viewer')) {
      await this.sendTextReply(
        context.chat_id,
        `当前 chat_id 无权切换到项目 ${alias}。至少需要 ${describeMinimumRole('viewer')} 权限。`,
        context.message_id,
        context.text,
      );
      return;
    }
    const project = this.requireProject(alias);
    const switched = await switchSharedProjectBinding(
      this.config,
      this.sessionStore,
      this.codexSessionIndex,
      {
        chatId: context.chat_id,
        actorId: context.actor_id,
        tenantKey: context.tenant_key,
      },
      alias,
    );
    await this.auditLog.append({
      type: 'project.selected',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: alias,
    });
    if (switched.structured.autoAdoption.kind === 'adopted') {
      await this.auditLog.append({
        type: 'session.adopted',
        project_alias: alias,
        conversation_key: switched.structured.sessionKey,
        thread_id: switched.structured.autoAdoption.session.sessionId,
        source_cwd: switched.structured.autoAdoption.session.cwd,
        source: switched.structured.autoAdoption.session.source,
        match_kind: switched.structured.autoAdoption.session.matchKind,
        backend: switched.structured.autoAdoption.session.backend,
        trigger: 'project-switch',
      });
    }
    if (followupPrompt) {
      const followupCommand = parseBridgeCommand(followupPrompt);
      if (isReadOnlyCommand(followupCommand)) {
        await this.handleReadOnlyFollowupCommand(context, selectionKey, followupCommand, followupPrompt);
        return;
      }
      await this.handlePromptMessage(context, selectionKey, followupPrompt, context.text);
      return;
    }
    await this.sendTextReply(context.chat_id, switched.text, context.message_id, context.text);
  }

  private async handleReadOnlyFollowupCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    command: ReturnType<typeof parseBridgeCommand>,
    followupPrompt: string,
  ): Promise<void> {
    switch (command.kind) {
      case 'help':
        await this.sendTextReply(context.chat_id, command.detail ? buildFullHelpText() : buildHelpText(), context.message_id, context.text);
        return;
      case 'projects':
        await this.sendTextReply(context.chat_id, await this.buildProjectsText(selectionKey, context.chat_id), context.message_id, context.text);
        return;
      case 'project':
        await this.handleProjectCommand(context, selectionKey, command.alias);
        return;
      case 'status':
        await this.handleStatusCommand(context, selectionKey, command.detail === true);
        return;
      case 'kb':
        await this.handleKnowledgeCommand(context, selectionKey, command.action, command.query);
        return;
      case 'doc':
        await this.handleDocCommand(context, selectionKey, command.action, command.value, command.extra);
        return;
      case 'task':
        await this.handleTaskCommand(context, selectionKey, command.action, command.value);
        return;
      case 'base':
        await this.handleBaseCommand(context, selectionKey, command.action, command.appToken, command.tableId, command.recordId, command.value);
        return;
      case 'memory':
        await this.handleMemoryCommand(context, selectionKey, command.action, command.scope, command.value, command.filters);
        return;
      case 'wiki':
        await this.handleWikiCommand(context, selectionKey, command.action, command.value, command.extra, command.target, command.role);
        return;
      case 'backend':
        await this.handleBackendCommand(context, selectionKey, command.name);
        return;
      case 'session': {
        const sessionArgument = command.action === 'adopt' ? command.target : command.threadId;
        await this.handleSessionCommand(context, selectionKey, command.action, sessionArgument);
        return;
      }
      case 'admin':
        await this.handleAdminCommand(context, selectionKey, command);
        return;
      case 'prompt':
        await this.handlePromptMessage(context, selectionKey, followupPrompt, context.text);
        return;
      default:
        await this.handlePromptMessage(context, selectionKey, followupPrompt, context.text);
    }
  }

  private async handlePromptMessage(
    context: IncomingMessageContext,
    selectionKey: string,
    rawPrompt: string,
    originalText?: string,
  ): Promise<void> {
    const prompt = normalizeIncomingText(rawPrompt) || (context.attachments.length > 0 ? '请结合这条飞书消息附带的多媒体信息继续处理。' : '');
    if (!prompt) {
      return;
    }
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    if (!this.canExecuteProjectRuns(context.chat_id, projectContext.projectAlias)) {
      await this.sendTextReply(
        context.chat_id,
        `当前 chat_id 只有 ${resolveProjectAccessRole(this.config, projectContext.projectAlias, context.chat_id) ?? '未授权'} 权限，执行运行至少需要 ${describeMinimumRole('operator')} 权限。`,
        context.message_id,
        context.text,
      );
      return;
    }
    const resolvedContext = await resolveMessageResources(
      this.feishuClient.createSdkClient?.(),
      this.resolveProjectDownloadDir(projectContext.projectAlias, projectContext.project),
      context,
      {
        downloadEnabled: this.config.service.download_message_resources,
        transcribeAudio: this.config.service.transcribe_audio_messages,
        transcribeCliPath: this.config.service.transcribe_cli_path,
        describeImages: this.config.service.describe_image_messages,
        openaiImageModel: this.config.service.openai_image_model,
        logger: this.logger,
      },
    );
    if (context.chat_type === 'group' && this.shouldRequireMention(projectContext.project) && context.mentions.length === 0) {
      return;
    }
    const rateLimitMessage = this.checkAndConsumeChatRateLimit(projectContext.projectAlias, projectContext.project, context.chat_id);
    if (rateLimitMessage) {
      await this.sendTextReply(context.chat_id, rateLimitMessage, context.message_id, context.text);
      return;
    }
    await this.sessionStore.selectProject(selectionKey, projectContext.projectAlias);

    // Direction 1: Overlap detection — notify when another team member is on the same project
    try {
      const activeRuns = await this.runStateStore.listRuns();
      const overlaps = detectOverlaps(
        { actor_id: context.actor_id, project_alias: projectContext.projectAlias, project_root: projectContext.project.root },
        activeRuns,
      );
      if (overlaps.length > 0) {
        const alertText = formatOverlapAlerts(overlaps);
        await this.sendTextReply(context.chat_id, alertText, context.message_id, context.text);
      }
    } catch { /* overlap detection is best-effort */ }

    // Direction 5: Trust boundary check
    try {
      const trustState = await this.trustStore.getOrCreate(projectContext.projectAlias);
      const operationClass = classifyOperation(prompt);
      const decision = enforceTrustBoundary(trustState.current_level, operationClass);
      if (!decision.allowed) {
        await this.sendTextReply(
          context.chat_id,
          `🛡️ 信任边界拦截: ${decision.reason ?? '操作不被允许'}`,
          context.message_id,
          context.text,
        );
        return;
      }
      if (decision.requires_approval) {
        // Create an approval request
        const review = createReview({
          run_id: `approval-${Date.now()}`,
          project_alias: projectContext.projectAlias,
          chat_id: context.chat_id,
          actor_id: context.actor_id ?? 'unknown',
          content_excerpt: `[${operationClass}] ${prompt.slice(0, 100)}`,
        });
        await this.handoffStore.addReview(review);

        // Notify admin chats
        const adminChatIds = projectContext.project.admin_chat_ids ?? [];
        const approvalText = `🛡️ 审批请求 [${projectContext.projectAlias}]\n发起人: ${context.actor_id}\n操作类型: ${operationClass}\n内容: "${prompt.slice(0, 80)}"\n\n使用 /approve 批准此操作`;
        for (const adminChat of adminChatIds) {
          try {
            await this.feishuClient.sendText(adminChat, approvalText);
          } catch { /* best-effort */ }
        }

        // Notify project notification chats
        await this.notifyProjectChats(projectContext.projectAlias, approvalText);

        // Tell the user their request is pending
        await this.sendTextReply(
          context.chat_id,
          `⏳ ${decision.reason ?? '此操作需要审批'}\n已通知管理员，等待审批中...`,
          context.message_id,
          context.text,
        );

        await this.auditLog.append({
          type: 'collaboration.approval.requested',
          project_alias: projectContext.projectAlias,
          actor_id: context.actor_id,
          operation_class: operationClass,
        });
        return;
      }
    } catch { /* trust enforcement is best-effort */ }

    // Token quota enforcement
    if (projectContext.project.daily_token_quota) {
      try {
        const costSummary = await this.runStateStore.getCostSummary(24);
        const projectUsage = costSummary.by_project[projectContext.projectAlias];
        if (projectUsage) {
          const usedTokens = projectUsage.input_tokens + projectUsage.output_tokens;
          if (usedTokens > projectContext.project.daily_token_quota) {
            await this.sendTextReply(
              context.chat_id,
              `\u26a0\ufe0f 项目 ${projectContext.projectAlias} 已达到每日 token 额度 (${usedTokens}/${projectContext.project.daily_token_quota})，请联系管理员调整。`,
              context.message_id,
              context.text,
            );
            return;
          }
        }
      } catch { /* quota check is best-effort */ }
    }

    const scheduled = await this.scheduleProjectExecution(
      projectContext,
      {
        chatId: context.chat_id,
        actorId: context.actor_id,
        actorName: context.actor_name,
        prompt,
      },
      async (runId) => {
        await this.executePrompt({
          runId,
          chatId: context.chat_id,
          actorId: context.actor_id,
          tenantKey: context.tenant_key,
          projectAlias: projectContext.projectAlias,
          project: projectContext.project,
          prompt,
          incomingMessage: resolvedContext,
          sessionKey: projectContext.sessionKey,
          queueKey: projectContext.queueKey,
          replyToMessageId: context.message_id,
        });
      },
    );
    try {
      await this.sendInitialRunLifecycleReply({
        chatId: context.chat_id,
        projectAlias: projectContext.projectAlias,
        runId: scheduled.runId,
        queued: scheduled.queued,
        replyToMessageId: context.message_id,
        originalText: context.text,
      });
    } finally {
      scheduled.release();
    }
    await scheduled.completion;
  }

  private async handleStatusCommand(context: IncomingMessageContext, selectionKey: string, detail: boolean = false): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const activeRun = await this.runStateStore.getLatestVisibleRun(projectContext.queueKey);
    const conversation = await this.sessionStore.getConversation(projectContext.sessionKey);
    if (!conversation && !activeRun) {
      await this.sendTextReply(context.chat_id, `项目 ${projectContext.projectAlias} 还没有会话。发送任意文本即可开始。`, context.message_id, context.text);
      return;
    }
    if (this.config.service.reply_mode === 'card') {
      await this.sendCardReply(
        context.chat_id,
        this.buildStatusCardFromConversation(projectContext.projectAlias, projectContext.sessionKey, conversation, activeRun, context.chat_id),
        context.message_id,
      );
      return;
    }

    const body = detail
      ? await this.buildDetailedStatusText(projectContext.projectAlias, projectContext.sessionKey, conversation, activeRun)
      : await this.buildStatusText(projectContext.projectAlias, conversation, activeRun);

    // Append collaboration status section
    const trustLevelLabels: Record<string, string> = {
      observe: '🔍 观察', suggest: '💡 建议', execute: '⚡ 执行', autonomous: '🚀 自主',
    };
    const trustState = await this.trustStore.getOrCreate(projectContext.projectAlias);
    const allRuns = await this.runStateStore.listRuns();
    const activeActorIds = new Set(
      allRuns
        .filter((r) => (r.status === 'running' || r.status === 'queued') && r.actor_id)
        .map((r) => r.actor_id!),
    );
    const pendingHandoffs = (await this.handoffStore.listHandoffs()).filter((h) => h.status === 'pending');
    const pendingReviews = (await this.handoffStore.listReviews()).filter((r) => r.status === 'pending');
    const collabSection = [
      '',
      '协作状态:',
      `  信任等级: ${trustLevelLabels[trustState.current_level] ?? trustState.current_level}`,
      `  团队活跃: ${activeActorIds.size} 人在线`,
      `  待交接: ${pendingHandoffs.length} / 待评审: ${pendingReviews.length}`,
    ].join('\n');

    await this.sendTextReply(context.chat_id, body + collabSection, context.message_id, context.text);
  }

  private async handleNewCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    if (!this.canControlProjectSessions(context.chat_id, projectContext.projectAlias)) {
      await this.sendTextReply(
        context.chat_id,
        `当前 chat_id 无权为项目 ${projectContext.projectAlias} 新开会话。至少需要 ${describeMinimumRole('operator')} 权限。`,
        context.message_id,
        context.text,
      );
      return;
    }
    await this.sessionStore.clearActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias);
    await this.auditLog.append({
      type: 'session.reset',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      conversation_key: projectContext.sessionKey,
    });
    await this.sendTextReply(context.chat_id, `已为项目 ${projectContext.projectAlias} 切换到新会话模式。下一条消息会新开一轮。`, context.message_id, context.text);
  }

  private async handleCancelCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    if (!this.canCancelProjectRuns(context.chat_id, projectContext.projectAlias)) {
      await this.sendTextReply(
        context.chat_id,
        `当前 chat_id 无权取消项目 ${projectContext.projectAlias} 的运行。至少需要 ${describeMinimumRole('operator')} 权限。`,
        context.message_id,
        context.text,
      );
      return;
    }
    const cancelled = await this.cancelActiveRun(projectContext.queueKey, 'user');
    await this.sendTextReply(
      context.chat_id,
      cancelled ? `已提交取消请求: ${projectContext.projectAlias}` : `当前项目 ${projectContext.projectAlias} 没有活动中的运行。`,
      context.message_id,
      context.text,
    );
  }

  private async handleSessionCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'list' | 'use' | 'new' | 'drop' | 'adopt',
    threadId?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const sessions = await this.sessionStore.listProjectSessions(projectContext.sessionKey, projectContext.projectAlias);
    const activeSessionId = (await this.sessionStore.getConversation(projectContext.sessionKey))?.projects[projectContext.projectAlias]?.thread_id;

    switch (action) {
      case 'list': {
        const listing = await listSharedBridgeSessions(this.config, this.sessionStore, {
          chatId: context.chat_id,
          actorId: context.actor_id,
          tenantKey: context.tenant_key,
          projectAlias: projectContext.projectAlias,
        });
        await this.sendTextReply(context.chat_id, listing.text, context.message_id, context.text);
        return;
      }
      case 'use': {
        if (!this.canControlProjectSessions(context.chat_id, projectContext.projectAlias)) {
          await this.sendTextReply(
            context.chat_id,
            `当前 chat_id 无权切换项目 ${projectContext.projectAlias} 的会话。至少需要 ${describeMinimumRole('operator')} 权限。`,
            context.message_id,
            context.text,
          );
          return;
        }
        if (!threadId) {
          await this.sendTextReply(context.chat_id, '用法: /session use <thread_id>', context.message_id, context.text);
          return;
        }
        await this.sessionStore.setActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias, threadId);
        await this.sendTextReply(context.chat_id, `已切换到会话: ${threadId}`, context.message_id, context.text);
        return;
      }
      case 'new': {
        if (!this.canControlProjectSessions(context.chat_id, projectContext.projectAlias)) {
          await this.sendTextReply(
            context.chat_id,
            `当前 chat_id 无权为项目 ${projectContext.projectAlias} 新开会话。至少需要 ${describeMinimumRole('operator')} 权限。`,
            context.message_id,
            context.text,
          );
          return;
        }
        await this.sessionStore.clearActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias);
        await this.sendTextReply(context.chat_id, '已切换为新会话模式。下一条消息会新开会话。', context.message_id, context.text);
        return;
      }
      case 'drop': {
        if (!this.canControlProjectSessions(context.chat_id, projectContext.projectAlias)) {
          await this.sendTextReply(
            context.chat_id,
            `当前 chat_id 无权删除项目 ${projectContext.projectAlias} 的会话。至少需要 ${describeMinimumRole('operator')} 权限。`,
            context.message_id,
            context.text,
          );
          return;
        }
        const targetThreadId = threadId ?? activeSessionId;
        if (!targetThreadId) {
          await this.sendTextReply(context.chat_id, '没有可删除的会话。', context.message_id, context.text);
          return;
        }
        await this.sessionStore.dropProjectSession(projectContext.sessionKey, projectContext.projectAlias, targetThreadId);
        await this.sendTextReply(context.chat_id, `已删除会话: ${targetThreadId}`, context.message_id, context.text);
        return;
      }
      case 'adopt': {
        if (!this.canControlProjectSessions(context.chat_id, projectContext.projectAlias)) {
          await this.sendTextReply(
            context.chat_id,
            `当前 chat_id 无权接管项目 ${projectContext.projectAlias} 的会话。至少需要 ${describeMinimumRole('operator')} 权限。`,
            context.message_id,
            context.text,
          );
          return;
        }
        await this.handleSessionAdoptCommand(context, projectContext, threadId);
        return;
      }
    }
  }

  // ── Direction 1: Team Awareness ──

  private async handleTeamCommand(context: IncomingMessageContext): Promise<void> {
    const runs = await this.runStateStore.listRuns();
    const activities = buildTeamActivityView(runs);
    const text = formatTeamView(activities);
    await this.sendTextReply(context.chat_id, text, context.message_id, context.text);
  }

  // ── Direction 2: Knowledge Loop ──

  private async handleLearnCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    value: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const input = buildLearnInput(value, projectContext.projectAlias, context.actor_id, context.chat_id);

    await this.memoryStore.saveProjectMemory({
      project_alias: input.project_alias,
      title: input.title,
      content: input.content,
      tags: input.tags,
      source: input.source,
      created_by: context.actor_id,
    });

    await this.auditLog.append({
      type: 'collaboration.knowledge.learned',
      project_alias: input.project_alias,
      actor_id: context.actor_id,
      title: input.title,
    });

    await this.sendTextReply(
      context.chat_id,
      `💡 团队知识已记录: "${input.title}"\n项目: ${input.project_alias}`,
      context.message_id,
      context.text,
    );
  }

  private async handleRecallCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    query: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const memories = await this.memoryStore.searchMemories(
      { scope: 'project', project_alias: projectContext.projectAlias },
      query,
      10,
    );
    const text = formatRecallResults(memories, query);
    await this.sendTextReply(context.chat_id, text, context.message_id, context.text);
  }

  // ── Direction 3: Handoff & Review ──

  private async handleHandoffCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    summary?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const conversation = await this.sessionStore.getConversation(projectContext.sessionKey);
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

    await this.handoffStore.addHandoff(record);

    await this.auditLog.append({
      type: 'collaboration.handoff.created',
      handoff_id: record.id,
      from_actor_id: record.from_actor_id,
      project_alias: record.project_alias,
    });

    await this.sendTextReply(context.chat_id, formatHandoff(record), context.message_id, context.text);
  }

  private async handlePickupCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    id?: string,
  ): Promise<void> {
    let handoff = id
      ? await this.handoffStore.updateHandoff(id, {})  // just to find it
      : await this.handoffStore.getPendingHandoffForActor(context.actor_id ?? '', undefined);

    if (id) {
      handoff = await this.handoffStore.getPendingHandoff();
      if (handoff && !handoff.id.startsWith(id)) {
        handoff = null;
      }
    }

    if (!handoff || handoff.status !== 'pending') {
      await this.sendTextReply(context.chat_id, '没有找到待接手的交接任务。', context.message_id, context.text);
      return;
    }

    const accepted = acceptHandoff(handoff, context.actor_id ?? 'unknown');
    await this.handoffStore.updateHandoff(handoff.id, {
      status: 'accepted',
      accepted_at: accepted.accepted_at,
      accepted_by: accepted.accepted_by,
    });

    // Adopt the session if there's a thread_id
    if (handoff.thread_id) {
      const projectContext = await this.resolveProjectContext(context, selectionKey);
      await this.sessionStore.setActiveProjectSession(
        projectContext.sessionKey,
        handoff.project_alias,
        handoff.thread_id,
      );
    }

    await this.auditLog.append({
      type: 'collaboration.handoff.accepted',
      handoff_id: handoff.id,
      accepted_by: context.actor_id,
      project_alias: handoff.project_alias,
    });

    await this.sendTextReply(
      context.chat_id,
      `✅ 已接手 ${handoff.from_actor_name ?? handoff.from_actor_id} 的交接任务 [${handoff.project_alias}]\n摘要: ${handoff.summary}`,
      context.message_id,
      context.text,
    );
  }

  private async handleReviewCommand(
    context: IncomingMessageContext,
    selectionKey: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const runs = await this.runStateStore.listRuns();
    const latestRun = runs.find(
      (r) => r.project_alias === projectContext.projectAlias && (r.status === 'success' || r.status === 'failure'),
    );

    if (!latestRun) {
      await this.sendTextReply(context.chat_id, '没有找到最近的运行结果可供评审。', context.message_id, context.text);
      return;
    }

    const review = createReview({
      run_id: latestRun.run_id,
      project_alias: projectContext.projectAlias,
      chat_id: context.chat_id,
      actor_id: context.actor_id ?? 'unknown',
      content_excerpt: latestRun.prompt_excerpt,
    });

    await this.handoffStore.addReview(review);

    await this.auditLog.append({
      type: 'collaboration.review.created',
      review_id: review.id,
      run_id: review.run_id,
      project_alias: review.project_alias,
    });

    await this.sendTextReply(context.chat_id, formatReview(review), context.message_id, context.text);
  }

  private async handleApproveCommand(
    context: IncomingMessageContext,
    comment?: string,
  ): Promise<void> {
    const pending = await this.handoffStore.getPendingReview(context.chat_id);
    if (!pending) {
      await this.sendTextReply(context.chat_id, '当前没有待评审的内容。', context.message_id, context.text);
      return;
    }

    const resolved = resolveReview(pending, 'approved', context.actor_id ?? 'unknown', comment);
    await this.handoffStore.updateReview(pending.id, {
      status: 'approved',
      reviewer_id: resolved.reviewer_id,
      review_comment: resolved.review_comment,
      resolved_at: resolved.resolved_at,
    });

    await this.auditLog.append({
      type: 'collaboration.review.approved',
      review_id: pending.id,
      reviewer_id: context.actor_id,
    });

    await this.sendTextReply(context.chat_id, formatReviewResult(resolved), context.message_id, context.text);
  }

  private async handleRejectCommand(
    context: IncomingMessageContext,
    reason?: string,
  ): Promise<void> {
    const pending = await this.handoffStore.getPendingReview(context.chat_id);
    if (!pending) {
      await this.sendTextReply(context.chat_id, '当前没有待评审的内容。', context.message_id, context.text);
      return;
    }

    const resolved = resolveReview(pending, 'rejected', context.actor_id ?? 'unknown', reason);
    await this.handoffStore.updateReview(pending.id, {
      status: 'rejected',
      reviewer_id: resolved.reviewer_id,
      review_comment: resolved.review_comment,
      resolved_at: resolved.resolved_at,
    });

    await this.auditLog.append({
      type: 'collaboration.review.rejected',
      review_id: pending.id,
      reviewer_id: context.actor_id,
      reason,
    });

    await this.sendTextReply(context.chat_id, formatReviewResult(resolved), context.message_id, context.text);
  }

  // ── Direction 4: Insights ──

  private async handleInsightsCommand(context: IncomingMessageContext): Promise<void> {
    const runs = await this.runStateStore.listRuns();
    const auditEvents = await this.auditLog.tail(500);
    const insights = analyzeTeamHealth(runs, auditEvents);
    const text = formatInsightsReport(insights);
    await this.sendTextReply(context.chat_id, text, context.message_id, context.text);
  }

  // ── Direction 5: Trust ──

  private async handleTrustCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action?: 'set',
    level?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);

    if (action === 'set' && level) {
      const TRUST_ORDER: TrustLevel[] = ['observe', 'suggest', 'execute', 'autonomous'];
      const validLevels = [...TRUST_ORDER];
      const state = await this.trustStore.getOrCreate(projectContext.projectAlias);

      // Handle relative promote/demote from natural language
      let resolvedLevel = level;
      if (level === '_promote') {
        const idx = TRUST_ORDER.indexOf(state.current_level);
        if (idx >= TRUST_ORDER.length - 1) {
          await this.sendTextReply(context.chat_id, `已经是最高信任等级 (${state.current_level})，无法继续提升。`, context.message_id, context.text);
          return;
        }
        resolvedLevel = TRUST_ORDER[idx + 1]!;
      } else if (level === '_demote') {
        const idx = TRUST_ORDER.indexOf(state.current_level);
        if (idx <= 0) {
          await this.sendTextReply(context.chat_id, `已经是最低信任等级 (${state.current_level})，无法继续降低。`, context.message_id, context.text);
          return;
        }
        resolvedLevel = TRUST_ORDER[idx - 1]!;
      }

      if (!validLevels.includes(resolvedLevel as TrustLevel)) {
        await this.sendTextReply(
          context.chat_id,
          `无效的信任等级。有效值: ${validLevels.join(', ')}`,
          context.message_id,
          context.text,
        );
        return;
      }

      state.current_level = resolvedLevel as TrustLevel;
      state.last_evaluated_at = new Date().toISOString();
      await this.trustStore.update(projectContext.projectAlias, state);
      this.metrics?.recordTrustLevel(projectContext.projectAlias, resolvedLevel);

      await this.auditLog.append({
        type: 'collaboration.trust.set',
        project_alias: projectContext.projectAlias,
        actor_id: context.actor_id,
        level,
      });

      await this.sendTextReply(
        context.chat_id,
        `🛡️ 项目 ${projectContext.projectAlias} 的信任等级已设置为: ${level}`,
        context.message_id,
        context.text,
      );
      return;
    }

    const state = await this.trustStore.getOrCreate(projectContext.projectAlias);
    await this.sendTextReply(context.chat_id, formatTrustState(state), context.message_id, context.text);
  }

  // ── Team Digest ──

  private async handleDigestCommand(context: IncomingMessageContext): Promise<void> {
    const period = createDigestPeriod(this.config.service.team_digest_interval_hours);
    const runs = await this.runStateStore.listRuns();
    const memories = this.config.service.memory_enabled
      ? await this.memoryStore.listRecentMemories({ scope: 'project', project_alias: '' }, 100)
      : [];
    const auditEvents = await this.auditLog.tail(500);
    const digest = buildTeamDigest(runs, memories, auditEvents, period);
    const text = formatTeamDigest(digest);
    await this.sendTextReply(context.chat_id, text, context.message_id, context.text);
  }

  // ── Proactive Alerts ──

  private async checkAndSendAlerts(completedRun: RunState): Promise<void> {
    const recentRuns = await this.runStateStore.listRuns();
    const projectConfig = this.config.projects[completedRun.project_alias];
    const dailyQuota = projectConfig?.daily_token_quota;

    const alerts = checkRunAlerts(completedRun, recentRuns, DEFAULT_ALERT_RULES, dailyQuota);
    if (alerts.length === 0) return;

    for (const alert of alerts) {
      const text = formatAlert(alert);

      // Send to admin chat IDs
      for (const chatId of this.config.security.admin_chat_ids) {
        try { await this.feishuClient.sendText(chatId, text); } catch { /* best-effort */ }
      }

      // Send to project notification channels
      await this.notifyProjectChats(alert.project_alias, text);

      await this.auditLog.append({
        type: 'collaboration.alert.sent',
        alert_kind: alert.kind,
        severity: alert.severity,
        project_alias: alert.project_alias,
        actor_id: alert.actor_id,
      });
    }
  }

  // ── Knowledge Gap Detection ──

  private async handleGapsCommand(context: IncomingMessageContext): Promise<void> {
    const runs = await this.runStateStore.listRuns();
    const memories = this.config.service.memory_enabled
      ? await this.memoryStore.listRecentMemories({ scope: 'project', project_alias: '' }, 200)
      : [];
    const gaps = detectKnowledgeGaps(runs, memories);
    const text = formatKnowledgeGaps(gaps);
    await this.sendTextReply(context.chat_id, text, context.message_id, context.text);
  }

  // ── Direction 6: Timeline ──

  private async handleTimelineCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    projectArg?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const projectAlias = projectArg ?? projectContext.projectAlias;

    const runs = await this.runStateStore.listRuns();
    const auditEvents = await this.auditLog.tail(200);

    const memories = this.config.service.memory_enabled
      ? await this.memoryStore.listRecentMemories(
          { scope: 'project', project_alias: projectAlias },
          20,
        )
      : [];

    const timeline = buildProjectTimeline(runs, memories, auditEvents, projectAlias, 20);
    const text = formatTimeline(timeline);
    await this.sendTextReply(context.chat_id, text, context.message_id, context.text);
  }

  private async handleAdminCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    command: Extract<ReturnType<typeof parseBridgeCommand>, { kind: 'admin' }>,
  ): Promise<void> {
    const runtimeConfigPath = this.runtimeControl?.configPath;
    const currentProjectAlias = await this.resolveProjectAlias(selectionKey);
    const globalAdmin = this.isAdminChat(context.chat_id);
    const globalConfigAdmin = this.canMutateRuntimeConfig(context.chat_id);
    const serviceObserver = this.canObserveService(context.chat_id) || this.canObserveRuns(context.chat_id);
    const serviceRestarter = this.canRestartService(context.chat_id);
    const projectAdminAliases = this.getAuthorizedProjectAliases(context.chat_id, 'admin');
    const projectOperatorAliases = this.getAuthorizedProjectAliases(context.chat_id, 'operator');
    const canAccess =
      globalAdmin ||
      this.canAccessAdminCommand(command, currentProjectAlias, projectAdminAliases, projectOperatorAliases, {
        globalConfigAdmin,
        serviceObserver,
        serviceRestarter,
      });

    if (!canAccess) {
      await this.sendTextReply(
        context.chat_id,
        '当前 chat_id 没有足够权限。请先在全局或项目级角色列表中授予 operator/admin 权限。',
        context.message_id,
        context.text,
      );
      return;
    }

    if (!runtimeConfigPath && this.commandRequiresWritableConfig(command)) {
      await this.sendTextReply(context.chat_id, '当前运行实例没有可写配置路径，无法执行管理员动态操作。', context.message_id, context.text);
      return;
    }

    if (command.resource === 'service') {
      if (command.action === 'runs') {
        await this.sendTextReply(
          context.chat_id,
          await this.buildAdminRunsText(globalAdmin || serviceObserver ? undefined : new Set(projectOperatorAliases)),
          context.message_id,
          context.text,
        );
        return;
      }
      if (command.action === 'restart') {
        if (!(globalAdmin || serviceRestarter)) {
          await this.sendTextReply(context.chat_id, '当前 chat_id 无权重启服务。', context.message_id, context.text);
          return;
        }
        await this.sendTextReply(context.chat_id, '配置已保存，正在重启服务。预计数秒内恢复。', context.message_id, context.text);
        this.logger.warn({ chatId: context.chat_id, actorId: context.actor_id }, 'Restart requested by Feishu admin');
        await this.appendAdminAudit({
          type: 'admin.service.restart',
          chat_id: context.chat_id,
          actor_id: context.actor_id,
          config_path: runtimeConfigPath,
        });
        await this.runtimeControl?.restart?.();
        return;
      }
      await this.sendTextReply(context.chat_id, await this.buildAdminStatusText(), context.message_id, context.text);
      return;
    }

    if (command.resource === 'config') {
      await this.handleAdminConfigCommand(context, command);
      return;
    }

    if (command.resource === 'project') {
      if (command.action === 'list') {
        await this.sendTextReply(
          context.chat_id,
          this.buildProjectsAdminText(globalAdmin || serviceObserver ? undefined : new Set(projectOperatorAliases)),
          context.message_id,
          context.text,
        );
        return;
      }
      if (command.action === 'add' || command.action === 'create') {
        if (!(globalAdmin || globalConfigAdmin)) {
          await this.sendTextReply(context.chat_id, '当前 chat_id 无权动态接入项目。', context.message_id, context.text);
          return;
        }
        if (!command.alias || !command.value) {
          await this.sendTextReply(
            context.chat_id,
            command.action === 'create' ? '用法: /admin project create <alias> <root>' : '用法: /admin project add <alias> <root>',
            context.message_id,
            context.text,
          );
          return;
        }
        if (command.action === 'create' && this.config.projects[command.alias]) {
          await this.sendTextReply(context.chat_id, `项目已存在: ${command.alias}`, context.message_id, context.text);
          return;
        }
        const resolvedRoot = path.resolve(expandHomePath(command.value));
        const snapshot = await this.snapshotConfigForAdminMutation(context, `project.${command.action}`, `${command.alias} -> ${resolvedRoot}`);
        if (command.action === 'create') {
          await createProjectAlias({ configPath: runtimeConfigPath!, alias: command.alias, root: command.value });
        } else {
          await bindProjectAlias({ configPath: runtimeConfigPath!, alias: command.alias, root: command.value });
        }
        this.config.projects[command.alias] = {
          root: resolvedRoot,
          session_scope: 'chat',
          mention_required: true,
          knowledge_paths: [],
          wiki_space_ids: [],
          viewer_chat_ids: [],
          operator_chat_ids: [],
          admin_chat_ids: [],
          notification_chat_ids: [],
          session_operator_chat_ids: [],
          run_operator_chat_ids: [],
          config_admin_chat_ids: [],
          run_priority: 100,
          chat_rate_limit_window_seconds: 60,
          chat_rate_limit_max_runs: 20,
        };
        await this.sendTextReply(
          context.chat_id,
          `${command.action === 'create' ? '已创建并接入项目' : '已接入项目'}: ${command.alias}\n根目录: ${resolvedRoot}`,
          context.message_id,
          context.text,
        );
        await this.appendAdminAudit({
          type: `admin.project.${command.action}`,
          chat_id: context.chat_id,
          actor_id: context.actor_id,
          project_alias: command.alias,
          root: resolvedRoot,
          snapshot_id: snapshot.id,
        });
        this.logger.info(
          { alias: command.alias, root: resolvedRoot, actorId: context.actor_id, created: command.action === 'create' },
          command.action === 'create' ? 'Project created by Feishu admin' : 'Project added by Feishu admin',
        );
        return;
      }
      if (command.action === 'remove') {
        if (!(globalAdmin || globalConfigAdmin)) {
          await this.sendTextReply(context.chat_id, '当前 chat_id 无权移除项目。', context.message_id, context.text);
          return;
        }
        if (!command.alias) {
          await this.sendTextReply(context.chat_id, '用法: /admin project remove <alias>', context.message_id, context.text);
          return;
        }
        if (this.config.service.default_project === command.alias) {
          await this.sendTextReply(context.chat_id, `不能移除默认项目: ${command.alias}。请先切换 service.default_project。`, context.message_id, context.text);
          return;
        }
        const snapshot = await this.snapshotConfigForAdminMutation(context, 'project.remove', command.alias);
        await removeProjectAlias(runtimeConfigPath!, command.alias);
        delete this.config.projects[command.alias];
        await this.sendTextReply(context.chat_id, `已移除项目: ${command.alias}`, context.message_id, context.text);
        await this.appendAdminAudit({
          type: 'admin.project.remove',
          chat_id: context.chat_id,
          actor_id: context.actor_id,
          project_alias: command.alias,
          snapshot_id: snapshot.id,
        });
        this.logger.info({ alias: command.alias, actorId: context.actor_id }, 'Project removed by Feishu admin');
        return;
      }
      if (!command.alias || !command.field || !command.value) {
        await this.sendTextReply(context.chat_id, '用法: /admin project set <alias> <field> <value>', context.message_id, context.text);
        return;
      }
      if (!(globalAdmin || globalConfigAdmin) && !this.isProjectAdminChat(context.chat_id, command.alias)) {
        await this.sendTextReply(context.chat_id, `当前 chat_id 无权修改项目 ${command.alias}。`, context.message_id, context.text);
        return;
      }
      const patch = this.parseProjectPatch(command.field, command.value);
      if (!patch) {
        await this.sendTextReply(
          context.chat_id,
          '支持字段: root, profile, sandbox, session_scope, mention_required, description, viewer_chat_ids, operator_chat_ids, admin_chat_ids, session_operator_chat_ids, run_operator_chat_ids, config_admin_chat_ids, download_dir, temp_dir, cache_dir, log_dir, run_priority, chat_rate_limit_window_seconds, chat_rate_limit_max_runs',
          context.message_id,
          context.text,
        );
        return;
      }
      const snapshot = await this.snapshotConfigForAdminMutation(context, 'project.set', `${command.alias}.${command.field}=${command.value}`);
      const nextProject = await updateProjectConfig(runtimeConfigPath!, command.alias, patch);
      this.config.projects[command.alias] = {
        ...this.requireProject(command.alias),
        ...nextProject,
      };
      await this.sendTextReply(context.chat_id, `已更新项目 ${command.alias}\n字段: ${command.field}\n值: ${command.value}`, context.message_id, context.text);
      await this.appendAdminAudit({
        type: 'admin.project.set',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: command.alias,
        field: command.field,
        value: command.value,
        snapshot_id: snapshot.id,
      });
      this.logger.info({ alias: command.alias, field: command.field, actorId: context.actor_id }, 'Project config updated by Feishu admin');
      return;
    }

    if (command.action === 'list' || command.action === 'status') {
      await this.sendTextReply(context.chat_id, this.buildAdminListText(command.resource), context.message_id, context.text);
      return;
    }
    if (!command.value) {
      await this.sendTextReply(context.chat_id, `用法: /admin ${command.resource} ${command.action} <chat_id>`, context.message_id, context.text);
      return;
    }
    const snapshot = await this.snapshotConfigForAdminMutation(context, `${command.resource}.${command.action}`, command.value);
    const { section, key } = resolveAdminListTarget(command.resource);
    const nextValues = await updateStringList(runtimeConfigPath!, section, key, command.value, command.action);
    this.applyAdminListValues(command.resource, nextValues);
    await this.sendTextReply(context.chat_id, `已${command.action === 'add' ? '添加' : '移除'} ${command.resource}:\n${command.value}`, context.message_id, context.text);
    await this.appendAdminAudit({
      type: `admin.${command.resource}.${command.action}`,
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      value: command.value,
      snapshot_id: snapshot.id,
    });
    this.logger.info({ resource: command.resource, action: command.action, value: command.value, actorId: context.actor_id }, 'Feishu access list updated by admin');
  }

  private async handleSessionAdoptCommand(
    context: IncomingMessageContext,
    projectContext: {
      projectAlias: string;
      project: ProjectConfig;
      sessionKey: string;
      queueKey: string;
    },
    target?: string,
  ): Promise<void> {
    const adoption = await adoptSharedProjectSession(this.config, this.sessionStore, this.codexSessionIndex, {
      chatId: context.chat_id,
      actorId: context.actor_id,
      tenantKey: context.tenant_key,
      projectAlias: projectContext.projectAlias,
    }, target);
    if (adoption.structured.adopted) {
      await this.auditLog.append({
        type: 'session.adopted',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        conversation_key: projectContext.sessionKey,
        thread_id: adoption.structured.adopted.sessionId,
        source_cwd: adoption.structured.adopted.cwd,
        source: adoption.structured.adopted.source,
        match_kind: adoption.structured.adopted.matchKind,
        backend: adoption.structured.adopted.backend,
      });
    }
    await this.sendTextReply(context.chat_id, adoption.text, context.message_id, context.text);
  }

  private async handleBackendCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    name?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);

    if (!name) {
      const sessionOverride = await this.sessionStore.getProjectBackend(projectContext.sessionKey, projectContext.projectAlias);
      const effectiveName = resolveProjectBackendName(this.config, projectContext.projectAlias, sessionOverride);
      const source = sessionOverride
        ? '会话级覆盖'
        : this.config.projects[projectContext.projectAlias]?.backend
          ? '项目配置'
          : '全局默认';
      await this.sendTextReply(
        context.chat_id,
        `项目: ${projectContext.projectAlias}\n当前后端: ${effectiveName} (${source})`,
        context.message_id,
        context.text,
      );
      return;
    }

    const normalized = name.toLowerCase();
    if (normalized !== 'codex' && normalized !== 'claude') {
      await this.sendTextReply(
        context.chat_id,
        `未知后端: ${name}\n可选值: codex | claude`,
        context.message_id,
        context.text,
      );
      return;
    }

    const backendName = normalized as BackendName;
    await this.sessionStore.setProjectBackend(projectContext.sessionKey, projectContext.projectAlias, backendName);
    await this.auditLog.append({
      type: 'backend.switched',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      conversation_key: projectContext.sessionKey,
      backend: backendName,
    });
    const label = backendName === 'claude' ? 'Claude Code' : 'Codex';
    await this.sendTextReply(
      context.chat_id,
      `项目 ${projectContext.projectAlias} 已切换到 ${label} 后端。\n下一条消息将使用 ${label} 执行。`,
      context.message_id,
      context.text,
    );
  }

  private async handleMemoryCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'status' | 'stats' | 'search' | 'recent' | 'save' | 'pin' | 'unpin' | 'forget' | 'restore',
    scope: MemoryScopeTarget | undefined,
    value?: string,
    filters?: MemoryCommandFilters,
  ): Promise<void> {
    if (!this.config.service.memory_enabled) {
      await this.sendTextReply(context.chat_id, '当前未启用记忆功能。请在配置里设置 `service.memory_enabled = true`。', context.message_id, context.text);
      return;
    }

    try {
      const explicitExpiredCleanup = action === 'forget' && value?.trim() === 'all-expired';
      if (!explicitExpiredCleanup) {
        await this.memoryStore.cleanupExpiredMemories();
      }
      const projectContext = await this.resolveProjectContext(context, selectionKey);
      const conversation = await this.sessionStore.getConversation(projectContext.sessionKey);
      const activeThreadId = conversation?.projects[projectContext.projectAlias]?.thread_id;
      const groupMemoryAvailable = this.config.service.memory_group_enabled && context.chat_type === 'group';

      if (action === 'status') {
        if (scope === 'group') {
          const target = this.resolveMemoryTarget(context, 'group');
          const [count, pinnedCount] = await Promise.all([
            this.memoryStore.countGroupMemories(projectContext.projectAlias, target.chatId!),
            this.memoryStore.countPinnedGroupMemories(projectContext.projectAlias, target.chatId!),
          ]);
          await this.sendTextReply(
            context.chat_id,
            [
              `项目: ${projectContext.projectAlias}`,
              `群共享记忆数: ${count}`,
              `Pinned 群共享记忆数: ${pinnedCount}`,
              `群 chat_id: ${target.chatId}`,
            ].join('\n'),
            context.message_id,
            context.text,
          );
          return;
        }

        const [count, pinnedCount, threadSummary, groupCount, groupPinnedCount] = await Promise.all([
          this.memoryStore.countProjectMemories(projectContext.projectAlias),
          this.memoryStore.countPinnedProjectMemories(projectContext.projectAlias),
          activeThreadId ? this.memoryStore.getThreadSummary(projectContext.sessionKey, projectContext.projectAlias, activeThreadId) : Promise.resolve(null),
          groupMemoryAvailable ? this.memoryStore.countGroupMemories(projectContext.projectAlias, context.chat_id) : Promise.resolve(0),
          groupMemoryAvailable ? this.memoryStore.countPinnedGroupMemories(projectContext.projectAlias, context.chat_id) : Promise.resolve(0),
        ]);
        await this.sendTextReply(
          context.chat_id,
          [
            `项目: ${projectContext.projectAlias}`,
            `项目记忆数: ${count}`,
            `Pinned 项目记忆数: ${pinnedCount}`,
            ...(groupMemoryAvailable ? [`群共享记忆数: ${groupCount}`, `Pinned 群共享记忆数: ${groupPinnedCount}`] : []),
            `当前会话: ${activeThreadId ?? '未开始'}`,
            '',
            threadSummary?.summary ?? '当前没有 thread summary。',
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }

      if (action === 'stats') {
        const target = this.resolveMemoryTarget(context, scope);
        const stats = await this.memoryStore.getMemoryStats({
          scope: target.scope,
          project_alias: projectContext.projectAlias,
          chat_id: target.chatId,
        });
        await this.sendTextReply(
          context.chat_id,
          [
            `项目: ${projectContext.projectAlias}`,
            `${target.label}统计:`,
            `active_count: ${stats.active_count}`,
            `expired_count: ${stats.expired_count}`,
            `pinned_count: ${stats.pinned_count}`,
            `archived_count: ${stats.archived_count}`,
            `latest_accessed_at: ${stats.latest_accessed_at ?? '-'}`,
            `latest_updated_at: ${stats.latest_updated_at ?? '-'}`,
            `latest_archived_at: ${stats.latest_archived_at ?? '-'}`,
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }

      if (action === 'recent') {
        const target = this.resolveMemoryTarget(context, scope);
        const recent = await this.memoryStore.listRecentMemories(
          { scope: target.scope, project_alias: projectContext.projectAlias, chat_id: target.chatId },
          this.config.service.memory_recent_limit,
          filters,
        );
        if (recent.length === 0) {
          await this.sendTextReply(
            context.chat_id,
            [
              `项目: ${projectContext.projectAlias}`,
              `当前没有可展示的${target.label}。`,
              ...this.renderMemoryFilterLines(filters),
            ].join('\n'),
            context.message_id,
            context.text,
          );
          return;
        }
        await this.sendTextReply(
          context.chat_id,
          [
            `项目: ${projectContext.projectAlias}`,
            `最近${target.label}:`,
            ...this.renderMemoryFilterLines(filters),
            '',
            ...recent.map((item, index) =>
              [
                `${index + 1}. ${item.title}${item.pinned ? ' [pinned]' : ''}`,
                `   id: ${item.id}`,
                `   source: ${item.source}`,
                ...(item.created_by ? [`   created_by: ${item.created_by}`] : []),
                ...(item.tags.length > 0 ? [`   tags: ${item.tags.join(', ')}`] : []),
                `   updated_at: ${item.updated_at}`,
                ...(item.last_accessed_at ? [`   last_accessed_at: ${item.last_accessed_at}`] : []),
                ...(item.expires_at ? [`   expires_at: ${item.expires_at}`] : []),
                `   ${truncateExcerpt(item.content, 180)}`,
              ].join('\n'),
            ),
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }

      if (action === 'search') {
        if (!value?.trim()) {
          await this.sendTextReply(context.chat_id, '用法: /memory search [--tag <tag>] [--source <source>] [--created-by <actor_id>] <query>', context.message_id, context.text);
          return;
        }
        const target = this.resolveMemoryTarget(context, scope);
        const hits = await this.memoryStore.searchMemories(
          { scope: target.scope, project_alias: projectContext.projectAlias, chat_id: target.chatId },
          value,
          this.config.service.memory_search_limit,
          filters,
        );
        await this.auditLog.append({
          type: 'memory.search',
          chat_id: context.chat_id,
          actor_id: context.actor_id,
          project_alias: projectContext.projectAlias,
          scope: target.scope,
          query: value,
          result_count: hits.length,
        });
        if (hits.length === 0) {
          await this.sendTextReply(
            context.chat_id,
            [`项目: ${projectContext.projectAlias}`, `${target.label}搜索: ${value}`, ...this.renderMemoryFilterLines(filters), '未找到匹配记忆。'].join('\n'),
            context.message_id,
            context.text,
          );
          return;
        }
        await this.sendTextReply(
          context.chat_id,
          [
            `项目: ${projectContext.projectAlias}`,
            `${target.label}搜索: ${value}`,
            ...this.renderMemoryFilterLines(filters),
            '',
            ...hits.map((hit, index) =>
              [
                `${index + 1}. ${hit.title}${hit.pinned ? ' [pinned]' : ''}`,
                `   id: ${hit.id}`,
                `   source: ${hit.source}`,
                ...(hit.created_by ? [`   created_by: ${hit.created_by}`] : []),
                ...(hit.tags.length > 0 ? [`   tags: ${hit.tags.join(', ')}`] : []),
                ...(hit.last_accessed_at ? [`   last_accessed_at: ${hit.last_accessed_at}`] : []),
                `   ${truncateExcerpt(hit.content, 180)}`,
              ].join('\n'),
            ),
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }

      if (action === 'pin' || action === 'unpin' || action === 'forget' || action === 'restore') {
        if (!value?.trim()) {
          const usage = action === 'forget'
            ? '用法: /memory forget <id> 或 /memory forget group <id>'
            : action === 'restore'
              ? '用法: /memory restore <id> 或 /memory restore group <id>'
              : `用法: /memory ${action} <id> 或 /memory ${action} group <id>`;
          await this.sendTextReply(context.chat_id, usage, context.message_id, context.text);
          return;
        }

        const target = this.resolveMemoryTarget(context, scope);
        const selector = { scope: target.scope, project_alias: projectContext.projectAlias, chat_id: target.chatId };
        if (action === 'forget' && value === 'all-expired') {
          const cleaned = await this.memoryStore.cleanupExpiredMemories(selector);
          await this.auditLog.append({
            type: 'memory.archive.expired',
            chat_id: context.chat_id,
            actor_id: context.actor_id,
            project_alias: projectContext.projectAlias,
            scope: target.scope,
            count: cleaned,
          });
          await this.sendTextReply(
            context.chat_id,
            `${target.label}已归档过期项: ${cleaned}`,
            context.message_id,
            context.text,
          );
          return;
        }
        const existing = await this.memoryStore.getMemoryById(selector, value, { includeArchived: action === 'restore', includeExpired: action === 'restore' });
        if (!existing) {
          await this.sendTextReply(context.chat_id, `未找到可更新的${target.label} ID: ${value}`, context.message_id, context.text);
          return;
        }
        if (action === 'forget') {
          const archived = await this.memoryStore.archiveMemory(selector, value, { archived_by: context.actor_id, reason: 'manual' });
          if (archived) {
            await this.auditLog.append({
              type: 'memory.archive',
              chat_id: context.chat_id,
              actor_id: context.actor_id,
              project_alias: projectContext.projectAlias,
              scope: target.scope,
              memory_id: value,
            });
          }
          await this.sendTextReply(
            context.chat_id,
            archived
              ? [`${target.label}已归档: ${archived.title}`, `memory_id: ${archived.id}`, `可用 /memory restore${target.scope === 'group' ? ' group' : ''} ${archived.id} 恢复`].join('\n')
              : `未找到可归档的${target.label} ID: ${value}`,
            context.message_id,
            context.text,
          );
          return;
        }

        if (action === 'restore') {
          const restored = await this.memoryStore.restoreMemory(selector, value, context.actor_id);
          if (restored) {
            await this.auditLog.append({
              type: 'memory.restore',
              chat_id: context.chat_id,
              actor_id: context.actor_id,
              project_alias: projectContext.projectAlias,
              scope: target.scope,
              memory_id: value,
            });
          }
          await this.sendTextReply(
            context.chat_id,
            restored ? `${target.label}已恢复: ${restored.title}\nmemory_id: ${restored.id}` : `未找到可恢复的${target.label} ID: ${value}`,
            context.message_id,
            context.text,
          );
          return;
        }

        const pinned = action === 'pin';
        let agedOutMemoryTitle: string | undefined;
        let agedOutMemoryId: string | undefined;
        if (pinned && !existing.pinned) {
          const pinnedCount = await this.memoryStore.countPinnedMemories(selector);
          if (pinnedCount >= this.config.service.memory_max_pinned_per_scope) {
            if (this.config.service.memory_pin_overflow_strategy === 'age-out') {
              const oldest = await this.memoryStore.getOldestPinnedMemory(selector, this.config.service.memory_pin_age_basis);
              if (oldest && oldest.id !== existing.id) {
                await this.memoryStore.setMemoryPinned(selector, oldest.id, false);
                agedOutMemoryTitle = oldest.title;
                agedOutMemoryId = oldest.id;
                await this.auditLog.append({
                  type: 'memory.pin.aged_out',
                  chat_id: context.chat_id,
                  actor_id: context.actor_id,
                  project_alias: projectContext.projectAlias,
                  scope: target.scope,
                  memory_id: oldest.id,
                  replaced_by: existing.id,
                });
              } else {
                await this.sendTextReply(
                  context.chat_id,
                  `${target.label}置顶数量已达上限 (${this.config.service.memory_max_pinned_per_scope})。请先取消置顶旧记录。`,
                  context.message_id,
                  context.text,
                );
                return;
              }
            } else {
              await this.sendTextReply(
                context.chat_id,
                `${target.label}置顶数量已达上限 (${this.config.service.memory_max_pinned_per_scope})。请先取消置顶旧记录。`,
                context.message_id,
                context.text,
              );
              return;
            }
          }
        }
        const updated = await this.memoryStore.setMemoryPinned(selector, value, pinned);
        if (!updated) {
          await this.sendTextReply(context.chat_id, `未找到可更新的${target.label} ID: ${value}`, context.message_id, context.text);
          return;
        }
        await this.auditLog.append({
          type: pinned ? 'memory.pin' : 'memory.unpin',
          chat_id: context.chat_id,
          actor_id: context.actor_id,
          project_alias: projectContext.projectAlias,
          scope: target.scope,
          memory_id: value,
        });
        await this.sendTextReply(
          context.chat_id,
          [
            `${target.label}${pinned ? '已置顶' : '已取消置顶'}: ${updated.title}`,
            `memory_id: ${updated.id}`,
            ...(agedOutMemoryId ? [`已自动老化旧置顶: ${agedOutMemoryTitle} (${agedOutMemoryId})`] : []),
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }

      const content = value?.trim();
      if (!content) {
        await this.sendTextReply(context.chat_id, '用法: /memory save <text> 或 /memory save group <text>', context.message_id, context.text);
        return;
      }
      const target = this.resolveMemoryTarget(context, scope);
      const title = truncateExcerpt(content.replace(/\s+/g, ' ').trim(), 60);
      const expiresAt = this.buildMemoryExpiresAt();
      const saved = await this.memoryStore.saveMemory({
        scope: target.scope,
        project_alias: projectContext.projectAlias,
        chat_id: target.chatId,
        title,
        content,
        tags: filters?.tag ? [filters.tag] : undefined,
        source: filters?.source ?? 'manual',
        created_by: context.actor_id,
        expires_at: expiresAt,
      });
      await this.auditLog.append({
        type: 'memory.save',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        scope: target.scope,
        memory_id: saved.id,
        title: saved.title,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `已保存${target.label}: ${saved.title}`,
          `memory_id: ${saved.id}`,
          ...(saved.expires_at ? [`expires_at: ${saved.expires_at}`] : []),
        ].join('\n'),
        context.message_id,
        context.text,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendTextReply(context.chat_id, message, context.message_id, context.text);
    }
  }

  private renderMemoryFilterLines(filters?: MemoryCommandFilters): string[] {
    return [
      ...(filters?.tag ? [`tag: ${filters.tag}`] : []),
      ...(filters?.source ? [`source: ${filters.source}`] : []),
      ...(filters?.created_by ? [`created_by: ${filters.created_by}`] : []),
    ];
  }

  private async handleKnowledgeCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'search' | 'status',
    query?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const roots = await resolveKnowledgeRoots(projectContext.project);

    if (action === 'status') {
      const message = roots.length
        ? [`项目: ${projectContext.projectAlias}`, '知识库目录:', ...roots.map((root) => `- ${root}`)].join('\n')
        : [`项目: ${projectContext.projectAlias}`, '当前没有可用知识库目录。', '可在项目配置中设置 knowledge_paths，或在项目根下提供 docs/README。'].join('\n');
      await this.sendTextReply(context.chat_id, message, context.message_id, context.text);
      return;
    }

    if (!query) {
      await this.sendTextReply(context.chat_id, '用法: /kb search <query>', context.message_id, context.text);
      return;
    }

    const result = await searchKnowledgeBase(projectContext.project, query, 5);
    await this.auditLog.append({
      type: 'knowledge.search',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      query,
      result_count: result.matches.length,
    });

    if (result.roots.length === 0) {
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, '当前没有可搜索的知识库目录。', '可在项目配置中设置 knowledge_paths，或在项目根下提供 docs/README。'].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (result.matches.length === 0) {
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `知识库搜索: ${query}`, '未找到匹配项。', '', '搜索目录:', ...result.roots.map((root) => `- ${root}`)].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    const lines = result.matches.map((match, index) => {
      const relativePath = match.file.startsWith(projectContext.project.root)
        ? match.file.slice(projectContext.project.root.length + 1)
        : match.file;
      return `${index + 1}. ${relativePath}:${match.line}\n   ${truncateExcerpt(match.text, 140)}`;
    });
    await this.sendTextReply(
      context.chat_id,
      [`项目: ${projectContext.projectAlias}`, `知识库搜索: ${query}`, '', ...lines].join('\n'),
      context.message_id,
      context.text,
    );
  }

  private async handleDocCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'read' | 'create',
    value?: string,
    extra?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    if (!canAccessProject(this.config, projectContext.projectAlias, context.chat_id, action === 'create' ? 'operator' : 'viewer')) {
      await this.sendTextReply(context.chat_id, `当前 chat_id 无权${action === 'create' ? '写入' : '读取'}项目 ${projectContext.projectAlias} 关联的飞书文档。`, context.message_id, context.text);
      return;
    }
    const docClient = new FeishuDocClient(this.feishuClient.createSdkClient());

    if (action === 'create') {
      const title = value?.trim();
      if (!title) {
        await this.sendTextReply(context.chat_id, '用法: /doc create <title>', context.message_id, context.text);
        return;
      }
      const created = await docClient.create(title, extra?.trim());
      await this.auditLog.append({
        type: 'doc.create',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        document_id: created.documentId,
        title: created.title,
      });
      await this.sendTextReply(
        context.chat_id,
        ['已创建飞书文档', `标题: ${created.title ?? title}`, `文档: ${created.documentId}`, ...(created.url ? [`链接: ${created.url}`] : [])].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (!value) {
      await this.sendTextReply(context.chat_id, '用法: /doc read <url|token>', context.message_id, context.text);
      return;
    }

    const document = await docClient.read(value);
    await this.auditLog.append({
      type: 'doc.read',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      document_id: document.documentId,
      title: document.title,
    });
    await this.sendTextReply(
      context.chat_id,
      [
        `标题: ${document.title ?? '未知'}`,
        `文档: ${document.documentId}`,
        ...(document.url ? [`链接: ${document.url}`] : []),
        '',
        truncateExcerpt(document.content?.replace(/\s+/g, ' ').trim() ?? '文档暂无可读取的纯文本内容。', 1200),
      ].join('\n'),
      context.message_id,
      context.text,
    );
  }

  private async handleTaskCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'list' | 'get' | 'create' | 'complete',
    value?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    if (!canAccessProject(this.config, projectContext.projectAlias, context.chat_id, action === 'create' || action === 'complete' ? 'operator' : 'viewer')) {
      await this.sendTextReply(context.chat_id, `当前 chat_id 无权${action === 'create' || action === 'complete' ? '写入' : '查看'}项目 ${projectContext.projectAlias} 关联的飞书任务。`, context.message_id, context.text);
      return;
    }
    const taskClient = new FeishuTaskClient(this.feishuClient.createSdkClient());

    if (action === 'list') {
      const limit = clampListLimit(value, 10, 20);
      const tasks = await taskClient.list(limit);
      const lines = tasks.length > 0
        ? tasks.map((task, index) => `${index + 1}. ${task.summary ?? '(无标题)'}\n   guid: ${task.guid}\n   status: ${task.status ?? 'unknown'}${task.url ? `\n   url: ${task.url}` : ''}`)
        : ['当前没有可见任务。'];
      await this.sendTextReply(context.chat_id, ['最近任务', '', ...lines].join('\n'), context.message_id, context.text);
      return;
    }

    if (action === 'get') {
      if (!value) {
        await this.sendTextReply(context.chat_id, '用法: /task get <task_guid>', context.message_id, context.text);
        return;
      }
      const task = await taskClient.get(value);
      await this.auditLog.append({
        type: 'task.read',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        task_guid: task.guid,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `任务: ${task.summary ?? '(无标题)'}`,
          `guid: ${task.guid}`,
          `status: ${task.status ?? 'unknown'}`,
          ...(task.url ? [`链接: ${task.url}`] : []),
          '',
          task.description ?? '无描述',
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'create') {
      const summary = value?.trim();
      if (!summary) {
        await this.sendTextReply(context.chat_id, '用法: /task create <summary>', context.message_id, context.text);
        return;
      }
      const task = await taskClient.create(summary);
      await this.auditLog.append({
        type: 'task.create',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        task_guid: task.guid,
        summary: task.summary,
      });
      await this.sendTextReply(
        context.chat_id,
        [`已创建任务`, `标题: ${task.summary ?? summary}`, `guid: ${task.guid}`, ...(task.url ? [`链接: ${task.url}`] : [])].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (!value) {
      await this.sendTextReply(context.chat_id, '用法: /task complete <task_guid>', context.message_id, context.text);
      return;
    }
    const task = await taskClient.complete(value);
    await this.auditLog.append({
      type: 'task.complete',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      task_guid: task.guid,
      summary: task.summary,
    });
    await this.sendTextReply(
      context.chat_id,
      [`已完成任务`, `标题: ${task.summary ?? '(无标题)'}`, `guid: ${task.guid}`, `status: ${task.status ?? 'unknown'}`].join('\n'),
      context.message_id,
      context.text,
    );
  }

  private async handleBaseCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'tables' | 'records' | 'create' | 'update',
    appToken?: string,
    tableId?: string,
    recordId?: string,
    value?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    if (!canAccessProject(this.config, projectContext.projectAlias, context.chat_id, action === 'create' || action === 'update' ? 'operator' : 'viewer')) {
      await this.sendTextReply(context.chat_id, `当前 chat_id 无权${action === 'create' || action === 'update' ? '写入' : '查看'}项目 ${projectContext.projectAlias} 关联的多维表格。`, context.message_id, context.text);
      return;
    }
    const baseClient = new FeishuBaseClient(this.feishuClient.createSdkClient());

    if (action === 'tables') {
      if (!appToken) {
        await this.sendTextReply(context.chat_id, '用法: /base tables <app_token>', context.message_id, context.text);
        return;
      }
      const tables = await baseClient.listTables(appToken, 20);
      const lines = tables.length > 0
        ? tables.map((table, index) => `${index + 1}. ${table.name ?? '(未命名表)'}\n   table_id: ${table.tableId}${table.revision !== undefined ? `\n   revision: ${table.revision}` : ''}`)
        : ['当前 Base 中没有可见数据表。'];
      await this.sendTextReply(context.chat_id, [`Base: ${appToken}`, '', ...lines].join('\n'), context.message_id, context.text);
      return;
    }

    if (action === 'records') {
      if (!appToken || !tableId) {
        await this.sendTextReply(context.chat_id, '用法: /base records <app_token> <table_id> [limit]', context.message_id, context.text);
        return;
      }
      const limit = clampListLimit(value, 10, 20);
      const records = await baseClient.listRecords(appToken, tableId, limit);
      const lines = records.length > 0
        ? records.map((record, index) => `${index + 1}. ${record.recordId}\n   fields: ${truncateExcerpt(JSON.stringify(record.fields), 240)}${record.recordUrl ? `\n   url: ${record.recordUrl}` : ''}`)
        : ['当前数据表没有可见记录。'];
      await this.sendTextReply(context.chat_id, [`Base: ${appToken}`, `Table: ${tableId}`, '', ...lines].join('\n'), context.message_id, context.text);
      return;
    }

    if (action === 'create') {
      if (!appToken || !tableId || !value) {
        await this.sendTextReply(context.chat_id, '用法: /base create <app_token> <table_id> <json>', context.message_id, context.text);
        return;
      }
      const fields = parseJsonObject(value);
      const record = await baseClient.createRecord(appToken, tableId, fields);
      await this.auditLog.append({
        type: 'base.record.create',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        app_token: appToken,
        table_id: tableId,
        record_id: record.recordId,
      });
      await this.sendTextReply(
        context.chat_id,
        [`已创建 Base 记录`, `app: ${appToken}`, `table: ${tableId}`, `record: ${record.recordId}`, `fields: ${truncateExcerpt(JSON.stringify(record.fields), 240)}`].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (!appToken || !tableId || !recordId || !value) {
      await this.sendTextReply(context.chat_id, '用法: /base update <app_token> <table_id> <record_id> <json>', context.message_id, context.text);
      return;
    }
    const fields = parseJsonObject(value);
    const record = await baseClient.updateRecord(appToken, tableId, recordId, fields);
    await this.auditLog.append({
      type: 'base.record.update',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      app_token: appToken,
      table_id: tableId,
      record_id: record.recordId,
    });
    await this.sendTextReply(
      context.chat_id,
      [`已更新 Base 记录`, `app: ${appToken}`, `table: ${tableId}`, `record: ${record.recordId}`, `fields: ${truncateExcerpt(JSON.stringify(record.fields), 240)}`].join('\n'),
      context.message_id,
      context.text,
    );
  }

  private async handleWikiCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'spaces' | 'search' | 'read' | 'create' | 'rename' | 'copy' | 'move' | 'members' | 'grant' | 'revoke',
    value?: string,
    extra?: string,
    target?: string,
    role?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const wikiClient = new FeishuWikiClient(this.feishuClient.createSdkClient());

    if (action === 'spaces') {
      const spaces = await wikiClient.listSpaces(10);
      const lines = spaces.length > 0
        ? spaces.map((space) => `- ${space.name} (${space.id})${space.description ? ` | ${space.description}` : ''}`)
        : ['当前应用可访问的知识空间为空。请确认机器人已被加入目标空间。'];
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `配置过滤空间数: ${projectContext.project.wiki_space_ids.length}`, '', ...lines].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'search') {
      if (!value) {
        await this.sendTextReply(context.chat_id, '用法: /wiki search <query>', context.message_id, context.text);
        return;
      }
      const hits = await wikiClient.search(value, projectContext.project.wiki_space_ids, 5);
      await this.auditLog.append({
        type: 'wiki.search',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        query: value,
        result_count: hits.length,
      });
      if (hits.length === 0) {
        await this.sendTextReply(
          context.chat_id,
          [`项目: ${projectContext.projectAlias}`, `飞书知识库搜索: ${value}`, '未找到匹配结果。', '', '提示: 确认机器人有目标空间访问权限，或在项目配置里设置 wiki_space_ids。'].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }
      const lines = hits.map((hit, index) =>
        [
          `${index + 1}. ${hit.title}`,
          `   space: ${hit.spaceId}`,
          `   token: ${hit.objToken}`,
          ...(hit.url ? [`   url: ${hit.url}`] : []),
        ].join('\n'),
      );
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `飞书知识库搜索: ${value}`, '', ...lines].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'members') {
      const spaceId = value?.trim() || projectContext.project.wiki_space_ids[0];
      if (!spaceId) {
        await this.sendTextReply(context.chat_id, '用法: /wiki members [space_id]，或先在项目配置里设置默认 wiki_space_ids。', context.message_id, context.text);
        return;
      }
      const members = await wikiClient.listMembers(spaceId, 20);
      await this.auditLog.append({
        type: 'wiki.members',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        space_id: spaceId,
        result_count: members.length,
      });
      const lines = members.length > 0
        ? members.map((member, index) => `${index + 1}. ${member.memberId}\n   member_type: ${member.memberType}\n   role: ${member.memberRole}${member.type ? `\n   type: ${member.type}` : ''}`)
        : ['当前知识空间没有可见成员，或机器人没有成员读取权限。'];
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `知识空间成员: ${spaceId}`, '', ...lines].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'create') {
      const defaultSpaceId = projectContext.project.wiki_space_ids[0];
      const spaceId = extra ?? defaultSpaceId;
      const title = value?.trim();
      if (!title) {
        await this.sendTextReply(context.chat_id, '用法: /wiki create <title> 或 /wiki create <space_id> <title>', context.message_id, context.text);
        return;
      }
      if (!spaceId) {
        await this.sendTextReply(
          context.chat_id,
          '当前项目未配置默认 wiki_space_ids，请使用 `/wiki create <space_id> <title>`。',
          context.message_id,
          context.text,
        );
        return;
      }

      const created = await wikiClient.createDoc(spaceId, title);
      await this.auditLog.append({
        type: 'wiki.create',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        title,
        space_id: created.spaceId,
        obj_token: created.objToken,
        node_token: created.nodeToken,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `已创建飞书文档: ${created.title ?? title}`,
          `空间: ${created.spaceId ?? spaceId}`,
          ...(created.nodeToken ? [`节点: ${created.nodeToken}`] : []),
          ...(created.objToken ? [`文档: ${created.objToken}`] : []),
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'grant') {
      const spaceId = extra?.trim();
      const memberType = target?.trim();
      const memberId = value?.trim();
      const memberRole = role?.trim() || 'member';
      if (!spaceId || !memberType || !memberId) {
        await this.sendTextReply(context.chat_id, '用法: /wiki grant <space_id> <member_type> <member_id> [member|admin]', context.message_id, context.text);
        return;
      }

      const granted = await wikiClient.addMember(spaceId, memberType, memberId, memberRole);
      await this.auditLog.append({
        type: 'wiki.member.grant',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        space_id: spaceId,
        member_id: granted.memberId,
        member_type: granted.memberType,
        member_role: granted.memberRole,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          '已添加知识空间成员',
          `空间: ${spaceId}`,
          `member_type: ${granted.memberType}`,
          `member_id: ${granted.memberId}`,
          `role: ${granted.memberRole}`,
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'rename') {
      const nodeToken = extra?.trim();
      const title = value?.trim();
      if (!nodeToken || !title) {
        await this.sendTextReply(context.chat_id, '用法: /wiki rename <node_token> <title>', context.message_id, context.text);
        return;
      }

      await wikiClient.renameNode(nodeToken, title, projectContext.project.wiki_space_ids[0]);
      await this.auditLog.append({
        type: 'wiki.rename',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        node_token: nodeToken,
        title,
      });
      await this.sendTextReply(
        context.chat_id,
        [`项目: ${projectContext.projectAlias}`, `已更新知识库节点标题`, `节点: ${nodeToken}`, `标题: ${title}`].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'copy') {
      const nodeToken = value?.trim();
      const targetSpaceId = extra?.trim() || projectContext.project.wiki_space_ids[0];
      if (!nodeToken) {
        await this.sendTextReply(context.chat_id, '用法: /wiki copy <node_token> [target_space_id]', context.message_id, context.text);
        return;
      }
      if (!targetSpaceId) {
        await this.sendTextReply(context.chat_id, '当前项目未配置默认 wiki_space_ids，请显式传入 target_space_id。', context.message_id, context.text);
        return;
      }

      const copied = await wikiClient.copyNode(nodeToken, targetSpaceId);
      await this.auditLog.append({
        type: 'wiki.copy',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        node_token: nodeToken,
        target_space_id: copied.spaceId,
        obj_token: copied.objToken,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `已复制知识库节点`,
          `源节点: ${nodeToken}`,
          `目标空间: ${copied.spaceId ?? targetSpaceId}`,
          ...(copied.nodeToken ? [`新节点: ${copied.nodeToken}`] : []),
          ...(copied.objToken ? [`对象: ${copied.objToken}`] : []),
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'move') {
      const sourceSpaceId = extra?.trim();
      const nodeToken = value?.trim();
      const targetSpaceId = target?.trim() || projectContext.project.wiki_space_ids[0];
      if (!sourceSpaceId || !nodeToken) {
        await this.sendTextReply(context.chat_id, '用法: /wiki move <source_space_id> <node_token> [target_space_id]', context.message_id, context.text);
        return;
      }
      if (!targetSpaceId) {
        await this.sendTextReply(context.chat_id, '当前项目未配置默认 wiki_space_ids，请显式传入 target_space_id。', context.message_id, context.text);
        return;
      }

      const moved = await wikiClient.moveNode(sourceSpaceId, nodeToken, targetSpaceId);
      await this.auditLog.append({
        type: 'wiki.move',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        node_token: nodeToken,
        source_space_id: sourceSpaceId,
        target_space_id: moved.spaceId,
        obj_token: moved.objToken,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `已移动知识库节点`,
          `源空间: ${sourceSpaceId}`,
          `源节点: ${nodeToken}`,
          `目标空间: ${moved.spaceId ?? targetSpaceId}`,
          ...(moved.nodeToken ? [`当前节点: ${moved.nodeToken}`] : []),
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (action === 'revoke') {
      const spaceId = extra?.trim();
      const memberType = target?.trim();
      const memberId = value?.trim();
      const memberRole = role?.trim() || 'member';
      if (!spaceId || !memberType || !memberId) {
        await this.sendTextReply(context.chat_id, '用法: /wiki revoke <space_id> <member_type> <member_id> [member|admin]', context.message_id, context.text);
        return;
      }

      const revoked = await wikiClient.removeMember(spaceId, memberType, memberId, memberRole);
      await this.auditLog.append({
        type: 'wiki.member.revoke',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        space_id: spaceId,
        member_id: revoked.memberId,
        member_type: revoked.memberType,
        member_role: revoked.memberRole,
      });
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          '已移除知识空间成员',
          `空间: ${spaceId}`,
          `member_type: ${revoked.memberType}`,
          `member_id: ${revoked.memberId}`,
          `role: ${revoked.memberRole}`,
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    if (!value) {
      await this.sendTextReply(context.chat_id, '用法: /wiki read <url|token>', context.message_id, context.text);
      return;
    }

    const result = await wikiClient.read(value);
    await this.auditLog.append({
      type: 'wiki.read',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      target: value,
      obj_type: result.objType,
      obj_token: result.objToken,
    });

    const summary = result.content ? truncateExcerpt(result.content.replace(/\s+/g, ' ').trim(), 1200) : '当前对象不是 docx 文档，暂不支持直接拉取纯文本内容。';
    await this.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        `标题: ${result.title ?? '未知'}`,
        `类型: ${result.objType ?? '未知'}`,
        ...(result.spaceId ? [`空间: ${result.spaceId}`] : []),
        ...(result.objToken ? [`对象: ${result.objToken}`] : []),
        ...(result.url ? [`链接: ${result.url}`] : []),
        '',
        summary,
      ].join('\n'),
      context.message_id,
      context.text,
    );
  }

  private async buildProjectsText(selectionKey: string, chatId?: string): Promise<string> {
    const selected = await this.resolveProjectAlias(selectionKey);
    const visibleAliases = chatId ? filterAccessibleProjects(this.config, chatId) : Object.keys(this.config.projects);
    const lines = Object.entries(this.config.projects)
      .filter(([alias]) => visibleAliases.includes(alias))
      .map(([alias, project]) => {
        const marker = alias === selected ? '*' : '-';
        const description = project.description ? ` | ${project.description}` : '';
        return `${marker} ${alias}: ${project.root}${description}`;
      });
    if (chatId && lines.length === 0) {
      return '当前 chat_id 没有任何可访问项目。请联系管理员分配 viewer/operator/admin 权限。';
    }
    return ['可用项目:', ...(lines.length > 0 ? lines : ['(empty)'])].join('\n');
  }

  private async buildStatusText(projectAlias: string, conversation: ConversationState | null, activeRun?: RunState | null): Promise<string> {
    const session = conversation?.projects[projectAlias];
    const sessions = conversation ? await this.sessionStore.listProjectSessions(buildConversationKeyForConversation(conversation), projectAlias) : [];
    const memoryCount = this.config.service.memory_enabled ? await this.memoryStore.countProjectMemories(projectAlias) : 0;
    const threadSummary =
      this.config.service.memory_enabled && conversation && session?.thread_id
        ? await this.memoryStore.getThreadSummary(buildConversationKeyForConversation(conversation), projectAlias, session.thread_id)
        : null;
    return [
      `项目: ${projectAlias}`,
      `当前会话: ${session?.thread_id ?? activeRun?.session_id ?? '未开始'}`,
      `已保存会话数: ${sessions.length}`,
      `项目记忆数: ${memoryCount}`,
      `最近更新时间: ${session?.updated_at ?? conversation?.updated_at ?? activeRun?.updated_at ?? '无'}`,
      `当前运行状态: ${activeRun?.status ?? '无'}`,
      ...(activeRun?.status === 'queued' && activeRun.status_detail ? ['', activeRun.status_detail] : []),
      '',
      threadSummary?.summary ?? session?.last_response_excerpt ?? '暂无回复摘要。',
    ].join('\n');
  }

  private async buildDetailedStatusText(
    projectAlias: string,
    sessionKey: string,
    conversation: ConversationState | null,
    activeRun?: RunState | null,
  ): Promise<string> {
    const session = conversation?.projects[projectAlias];
    const runs = await this.runStateStore.listRuns();
    const currentProjectRuns = runs.filter((run) => run.queue_key === buildQueueKey(sessionKey, projectAlias));
    const recentFailure = currentProjectRuns.find((run) => run.status === 'failure' || run.status === 'cancelled' || run.status === 'stale');
    const lines = [
      await this.buildStatusText(projectAlias, conversation, activeRun),
      '',
      '详细状态',
      `当前队列耗时: ${activeRun ? formatAgeFromNow(activeRun.started_at) : '无'}`,
      `当前运行更新时间: ${activeRun ? formatAgeFromNow(activeRun.updated_at) : '无'}`,
      activeRun?.project_root ? `项目根: ${activeRun.project_root}` : null,
      activeRun?.prompt_excerpt ? `当前提示摘要: ${activeRun.prompt_excerpt}` : null,
      recentFailure ? '' : null,
      recentFailure ? '最近失败' : null,
      recentFailure ? `状态: ${recentFailure.status}` : null,
      recentFailure?.error ? `原因: ${recentFailure.error}` : null,
      recentFailure ? `发生时间: ${recentFailure.updated_at}` : null,
      session?.last_prompt ? '' : null,
      session?.last_prompt ? `最近提示词: ${truncateExcerpt(session.last_prompt, 120)}` : null,
    ];
    return lines.filter(Boolean).join('\n');
  }

  private buildStatusCardFromConversation(
    projectAlias: string,
    sessionKey: string,
    conversation: ConversationState | null,
    activeRun?: RunState | null,
    fallbackChatId?: string,
  ): Record<string, unknown> {
    const session = conversation?.projects[projectAlias];
    const sessionCount = Object.keys(session?.sessions ?? {}).length;
    const isExecutableRun = activeRun ? isExecutionRunStatus(activeRun.status) : false;
    const includeActions = this.supportsInteractiveCardActions();
    const actionChatId = conversation?.chat_id ?? activeRun?.chat_id ?? fallbackChatId;
    return buildStatusCard({
      title: '当前会话状态',
      summary: this.buildRunStatusSummary(session?.last_response_excerpt, activeRun),
      projectAlias,
      sessionId: session?.thread_id,
      runStatus: activeRun?.status,
      runPhase: activeRun ? mapRunStatusToPhase(activeRun.status) : undefined,
      sessionCount,
      includeActions,
      rerunPayload: includeActions && session?.last_prompt && !activeRun
        ? {
            action: 'rerun',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: actionChatId ?? '',
          }
        : undefined,
      newSessionPayload: includeActions
        ? {
            action: 'new',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: actionChatId ?? '',
          }
        : undefined,
      cancelPayload: includeActions && isExecutableRun
        ? {
            action: 'cancel',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: actionChatId ?? '',
          }
        : undefined,
      statusPayload: includeActions
        ? {
            action: 'status',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: actionChatId ?? '',
          }
        : undefined,
    });
  }

  private async buildBridgePrompt(
    projectAlias: string,
    project: ProjectConfig,
    incomingMessage: IncomingMessageContext,
    userPrompt: string,
    memoryContext: MemoryContext,
  ): Promise<string> {
    const prefixParts = [
      'You are replying through Feique, a team AI collaboration hub connected via Feishu.',
      'Your response text will be forwarded to the user via Feishu. Do NOT directly call Feishu APIs, send Feishu messages, or use any Feishu MCP tools — the bridge handles all Feishu communication. Sending messages directly would cause duplicates.',
      'To send a file to the user via Feishu, include [SEND_FILE:/absolute/path/to/file] in your response. The bridge will upload and deliver it. You can include multiple [SEND_FILE:...] markers. The markers will be stripped from the text shown to the user. Example: "Here is the build log:\n[SEND_FILE:/project/build.log]"',
      'Keep the final response concise and action-oriented.',
      'When files change, summarize key paths and verification.',
      'Do not expose session IDs, run IDs, chat IDs, conversation keys, secrets, raw logs, or absolute local filesystem paths to Feishu users unless they explicitly ask for them.',
      'Prefer project-relative paths over absolute paths when referencing files.',
      this.config.codex.bridge_instructions,
    ].filter(Boolean);

    if (project.instructions_prefix) {
      try {
        const projectInstructions = (await fs.readFile(project.instructions_prefix, 'utf8')).trim();
        if (projectInstructions) {
          prefixParts.push(projectInstructions);
        }
      } catch (error) {
        this.logger.warn({ error, projectAlias }, 'Failed to read project instructions prefix');
      }
    }

    return [
      ...prefixParts,
      '',
      `Current project alias: ${projectAlias}`,
      `Current project root: ${project.root}`,
      `Feishu message type: ${incomingMessage.message_type}`,
      ...(memoryContext.threadSummary?.summary
        ? [
            '',
            'Thread summary:',
            truncateExcerpt(memoryContext.threadSummary.summary, this.config.service.memory_prompt_max_chars),
          ]
        : []),
      ...renderMemorySection('Project memory', [...memoryContext.pinnedMemories, ...memoryContext.relevantMemories], this.config.service.memory_prompt_max_chars),
      ...renderMemorySection('Group shared memory', [...memoryContext.pinnedGroupMemories, ...memoryContext.relevantGroupMemories], this.config.service.memory_prompt_max_chars),
      '',
      'User message from Feishu:',
      userPrompt || '[no text body]',
      ...(incomingMessage.attachments.length > 0
        ? [
            '',
            'Message attachments:',
            ...incomingMessage.attachments.map((attachment, index) =>
              [
                `${index + 1}. ${attachment.summary}`,
                ...(attachment.downloaded_path ? [`   downloaded_path: ${attachment.downloaded_path}`] : []),
                ...(attachment.content_excerpt ? [`   content_excerpt: ${truncateExcerpt(attachment.content_excerpt, 320)}`] : []),
                ...(attachment.image_description ? [`   image_description: ${truncateExcerpt(attachment.image_description, 320)}`] : []),
                ...(attachment.transcript_text ? [`   transcript: ${truncateExcerpt(attachment.transcript_text, 320)}`] : []),
              ].join('\n'),
            ),
          ]
        : []),
    ].join('\n');
  }

  private requireProject(alias: string): ProjectConfig {
    const project = this.config.projects[alias];
    if (!project) {
      throw new Error(`Unknown project alias: ${alias}`);
    }
    return project;
  }

  private async resolveProjectAlias(selectionKey: string): Promise<string> {
    const selection = await this.sessionStore.getConversation(selectionKey);
    if (selection?.selected_project_alias) {
      return selection.selected_project_alias;
    }
    const firstAlias = Object.keys(this.config.projects)[0];
    const selected = this.config.service.default_project ?? firstAlias;
    if (!selected) {
      throw new Error('No project configured.');
    }
    return selected;
  }

  private async resolveProjectContext(context: IncomingMessageContext, selectionKey: string): Promise<{
    projectAlias: string;
    project: ProjectConfig;
    sessionKey: string;
    queueKey: string;
  }> {
    const projectAlias = await this.resolveProjectAlias(selectionKey);
    if (!canAccessProject(this.config, projectAlias, context.chat_id, 'viewer')) {
      throw new Error(`当前 chat_id 无权访问项目 ${projectAlias}。至少需要 ${describeMinimumRole('viewer')} 权限。`);
    }
    const project = this.requireProject(projectAlias);
    const sessionKey = buildConversationKey({
      tenantKey: context.tenant_key,
      chatId: context.chat_id,
      actorId: context.actor_id,
      scope: project.session_scope,
    });
    await this.sessionStore.ensureConversation(sessionKey, {
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      tenant_key: context.tenant_key,
      scope: project.session_scope,
    });

    return {
      projectAlias,
      project,
      sessionKey,
      queueKey: buildQueueKey(sessionKey, projectAlias),
    };
  }

  private async getSelectionConversationKey(context: IncomingMessageContext): Promise<string> {
    const scope = this.getSelectionScope(context);
    const key = buildConversationKey({
      tenantKey: context.tenant_key,
      chatId: context.chat_id,
      actorId: context.actor_id,
      scope,
    });

    await this.sessionStore.ensureConversation(key, {
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      tenant_key: context.tenant_key,
      scope,
    });
    return key;
  }

  private getSelectionScope(_context: Pick<IncomingMessageContext, 'actor_id'>): SessionScope {
    // Project routing is shared by chat_id so a group can keep one project binding
    // and `/project <alias>` updates the binding for the whole chat.
    return 'chat';
  }

  private shouldRequireMention(project: ProjectConfig): boolean {
    return project.mention_required || this.config.security.require_group_mentions;
  }

  private resolveMemoryTarget(
    context: Pick<IncomingMessageContext, 'chat_id' | 'chat_type'>,
    requestedScope?: MemoryScopeTarget,
  ): { scope: 'project' | 'group'; chatId?: string; label: string } {
    if (requestedScope === 'group') {
      if (!this.config.service.memory_group_enabled) {
        throw new Error('群共享记忆未启用。请在配置中设置 `service.memory_group_enabled = true`。');
      }
      if (context.chat_type !== 'group') {
        throw new Error('群共享记忆只能在群聊中使用。');
      }
      return {
        scope: 'group',
        chatId: context.chat_id,
        label: '群共享记忆',
      };
    }

    return {
      scope: 'project',
      label: '项目记忆',
    };
  }

  private buildMemoryExpiresAt(): string | undefined {
    const ttlDays = this.config.service.memory_default_ttl_days;
    if (!ttlDays) {
      return undefined;
    }
    return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  }

  private async cancelActiveRun(queueKey: string, reason: 'user' | 'recovery'): Promise<boolean> {
    const live = this.activeRuns.get(queueKey);
    if (live) {
      live.cancelReason = reason;
      live.controller.abort(reason === 'user' ? 'Cancelled by user' : 'Recovered stale run');
      if (live.pid) {
        terminateProcess(live.pid, 'SIGTERM');
      }
      return true;
    }

    const persisted = await this.runStateStore.getActiveRun(queueKey);
    if (!persisted?.pid || !isProcessAlive(persisted.pid)) {
      return false;
    }
    await this.runStateStore.upsertRun(persisted.run_id, {
      queue_key: persisted.queue_key,
      conversation_key: persisted.conversation_key,
      project_alias: persisted.project_alias,
      chat_id: persisted.chat_id,
      actor_id: persisted.actor_id,
      session_id: persisted.session_id,
      pid: persisted.pid,
      prompt_excerpt: persisted.prompt_excerpt,
      status: 'cancelled',
      error: 'Cancelled from runtime management command',
    });
    return terminateProcess(persisted.pid, 'SIGTERM');
  }

  private async scheduleProjectExecution(
    projectContext: {
      projectAlias: string;
      project: ProjectConfig;
      sessionKey: string;
      queueKey: string;
    },
    metadata: {
      chatId: string;
      actorId?: string;
      actorName?: string;
      prompt: string;
    },
    task: (runId?: string) => Promise<void>,
  ): Promise<ScheduledProjectExecution> {
    const runId = randomUUID();
    const queued = await this.prepareQueuedExecution(projectContext, metadata, runId);
    const rootKey = buildProjectRootQueueKey(projectContext.project.root);
    const startGate = createDeferred<void>();
    // Record queue depth when enqueuing
    this.metrics?.recordQueueDepth(
      projectContext.projectAlias,
      this.queue.getPendingCount(projectContext.queueKey) + 1,
    );
    return {
      runId,
      queued,
      release: () => startGate.resolve(),
      completion: this.queue.run(projectContext.queueKey, async () => {
        await this.projectRootQueue.run(rootKey, async () => {
          await startGate.promise;
          await task(runId);
        }, { priority: projectContext.project.run_priority });
        // Record queue depth after dequeue
        this.metrics?.recordQueueDepth(
          projectContext.projectAlias,
          this.queue.getPendingCount(projectContext.queueKey),
        );
      }),
    };
  }

  private async prepareQueuedExecution(
    projectContext: {
      projectAlias: string;
      project: ProjectConfig;
      sessionKey: string;
      queueKey: string;
    },
    metadata: {
      chatId: string;
      actorId?: string;
      actorName?: string;
      prompt: string;
    },
    runId: string,
  ): Promise<QueuedExecutionNotice | null> {
    const queuePending = this.queue.getPendingCount(projectContext.queueKey);
    const rootKey = buildProjectRootQueueKey(projectContext.project.root);
    const rootPending = this.projectRootQueue.getPendingCount(rootKey);
    if (queuePending <= 0 && rootPending <= 0) {
      return null;
    }

    const projectRoot = this.resolveProjectRoot(projectContext.project);
    const reason = queuePending > 0 ? 'project' : 'project-root';
    const frontCount = reason === 'project' ? queuePending : rootPending;
    const blockingRun =
      reason === 'project'
        ? await this.runStateStore.getActiveRun(projectContext.queueKey)
        : await this.runStateStore.getExecutionRunByProjectRoot(projectRoot);
    const detail = this.buildQueuedStatusDetail(projectContext.projectAlias, reason, frontCount, blockingRun);
    await this.runStateStore.upsertRun(runId, {
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
    await this.auditLog.append({
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
    this.logger.warn(
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

  private buildAcknowledgedRunReply(
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

  private buildQueuedStatusDetail(
    projectAlias: string,
    reason: QueuedExecutionNotice['reason'],
    frontCount: number,
    blockingRun: RunState | null,
  ): string {
    const lines = [
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
    return lines.filter(Boolean).join('\n');
  }

  private buildRunStatusSummary(lastResponseExcerpt?: string, activeRun?: RunState | null): string {
    if (activeRun?.status === 'queued' && activeRun.status_detail) {
      return [activeRun.status_detail, lastResponseExcerpt ? `\n上一轮摘要:\n${lastResponseExcerpt}` : null].filter(Boolean).join('\n');
    }
    return lastResponseExcerpt ?? '暂无会话摘要。';
  }

  private isAdminChat(chatId: string): boolean {
    return this.config.security.admin_chat_ids.includes(chatId);
  }

  private async buildAdminStatusText(): Promise<string> {
    const snapshots = await this.configHistoryStore.listSnapshots();
    return [
      '管理员配置',
      '',
      `viewer chat_id 数: ${this.config.security.viewer_chat_ids?.length ?? 0}`,
      `operator chat_id 数: ${this.config.security.operator_chat_ids?.length ?? 0}`,
      `管理员 chat_id 数: ${this.config.security.admin_chat_ids.length}`,
      `service observer chat_id 数: ${this.config.security.service_observer_chat_ids?.length ?? 0}`,
      `service restart chat_id 数: ${this.config.security.service_restart_chat_ids?.length ?? 0}`,
      `config admin chat_id 数: ${this.config.security.config_admin_chat_ids?.length ?? 0}`,
      `允许私聊数: ${this.config.feishu.allowed_chat_ids.length}`,
      `允许群聊数: ${this.config.feishu.allowed_group_ids.length}`,
      `项目数: ${Object.keys(this.config.projects).length}`,
      `默认项目: ${this.config.service.default_project ?? '未设置'}`,
      `回复模式: ${this.config.service.reply_mode}`,
      `配置快照数: ${snapshots.length}`,
      `可写配置: ${this.runtimeControl?.configPath ?? '无'}`,
    ].join('\n');
  }

  private buildAdminListText(resource: 'viewer' | 'operator' | 'admin' | 'service-observer' | 'service-restart' | 'config-admin' | 'group' | 'chat'): string {
    const items =
      resource === 'viewer'
        ? (this.config.security.viewer_chat_ids ?? [])
        : resource === 'operator'
          ? (this.config.security.operator_chat_ids ?? [])
          : resource === 'service-observer'
            ? (this.config.security.service_observer_chat_ids ?? [])
            : resource === 'service-restart'
              ? (this.config.security.service_restart_chat_ids ?? [])
              : resource === 'config-admin'
                ? (this.config.security.config_admin_chat_ids ?? [])
          : resource === 'admin'
        ? this.config.security.admin_chat_ids
        : resource === 'group'
          ? this.config.feishu.allowed_group_ids
          : this.config.feishu.allowed_chat_ids;
    return [`当前${resource}列表:`, ...(items.length > 0 ? items : ['(empty)'])].join('\n');
  }

  private buildProjectsAdminText(allowedAliases?: Set<string>): string {
    const entries = Object.entries(this.config.projects).filter(([alias]) => !allowedAliases || allowedAliases.has(alias));
    const lines = entries.map(([alias, project]) => {
      const flags = [`scope=${project.session_scope}`, `mention=${project.mention_required ? 'on' : 'off'}`].join(' ');
      const roles = [
        `viewer=${project.viewer_chat_ids?.length ?? 0}`,
        `operator=${project.operator_chat_ids?.length ?? 0}`,
        `admin=${project.admin_chat_ids.length}`,
        `session_operator=${project.session_operator_chat_ids?.length ?? 0}`,
        `run_operator=${project.run_operator_chat_ids?.length ?? 0}`,
        `config_admin=${project.config_admin_chat_ids?.length ?? 0}`,
      ].join(' ');
      return `- ${alias}: ${project.root} | ${flags} | ${roles}`;
    });
    return ['当前项目列表:', ...(lines.length > 0 ? lines : ['(empty)'])].join('\n');
  }

  private async buildAdminRunsText(allowedAliases?: Set<string>): Promise<string> {
    const runs = await this.runStateStore.listRuns();
    const visibleRuns = allowedAliases ? runs.filter((run) => allowedAliases.has(run.project_alias)) : runs;
    const active = visibleRuns.filter((run) => isVisibleRunStatus(run.status)).slice(0, 10);
    const recentFailures = visibleRuns.filter((run) => run.status === 'failure' || run.status === 'cancelled' || run.status === 'stale').slice(0, 5);

    const lines = ['当前运行列表'];
    if (active.length === 0) {
      lines.push('', 'active/queued: (empty)');
    } else {
      lines.push('', 'active/queued:');
      for (const run of active) {
        lines.push(
          `- ${run.project_alias} | ${run.status} | chat=${run.chat_id} | 已持续 ${formatAgeFromNow(run.started_at)}${run.project_root ? ` | root=${run.project_root}` : ''}`,
        );
        lines.push(`  prompt=${truncateExcerpt(run.prompt_excerpt, 80)}`);
        if (run.status_detail) {
          lines.push(`  detail=${truncateExcerpt(run.status_detail, 120)}`);
        }
      }
    }

    if (recentFailures.length > 0) {
      lines.push('', '最近失败:');
      for (const run of recentFailures) {
        lines.push(`- ${run.project_alias} | ${run.status} | ${run.updated_at}`);
        lines.push(`  error=${truncateExcerpt(run.error ?? 'unknown', 120)}`);
      }
    }

    return lines.join('\n');
  }

  private getAuthorizedProjectAliases(chatId: string, minimumRole: AccessRole = 'admin'): string[] {
    return Object.keys(this.config.projects).filter((alias) => canAccessProject(this.config, alias, chatId, minimumRole));
  }

  private isProjectAdminChat(chatId: string, projectAlias: string): boolean {
    return canAccessProjectCapability(this.config, projectAlias, chatId, 'project:mutate');
  }

  private canControlProjectSessions(chatId: string, projectAlias: string): boolean {
    return canAccessProjectCapability(this.config, projectAlias, chatId, 'session:control');
  }

  private canExecuteProjectRuns(chatId: string, projectAlias: string): boolean {
    return canAccessProjectCapability(this.config, projectAlias, chatId, 'run:execute');
  }

  private canCancelProjectRuns(chatId: string, projectAlias: string): boolean {
    return canAccessProjectCapability(this.config, projectAlias, chatId, 'run:cancel');
  }

  private canObserveService(chatId: string): boolean {
    return canAccessGlobalCapability(this.config, chatId, 'service:status');
  }

  private canObserveRuns(chatId: string): boolean {
    return canAccessGlobalCapability(this.config, chatId, 'service:runs');
  }

  private canRestartService(chatId: string): boolean {
    return canAccessGlobalCapability(this.config, chatId, 'service:restart');
  }

  private canMutateRuntimeConfig(chatId: string): boolean {
    return canAccessGlobalCapability(this.config, chatId, 'config:mutate');
  }

  private canReadConfigHistory(chatId: string): boolean {
    return canAccessGlobalCapability(this.config, chatId, 'config:history') || this.canMutateRuntimeConfig(chatId);
  }

  private canAccessAdminCommand(
    command: Extract<ReturnType<typeof parseBridgeCommand>, { kind: 'admin' }>,
    currentProjectAlias: string,
    authorizedProjectAliases: string[],
    operatorProjectAliases: string[],
    globalCapabilities: {
      globalConfigAdmin: boolean;
      serviceObserver: boolean;
      serviceRestarter: boolean;
    },
  ): boolean {
    if (command.resource === 'project') {
      if (command.action === 'list') {
        return globalCapabilities.serviceObserver || operatorProjectAliases.length > 0;
      }
      if (command.action === 'set' && command.alias) {
        return globalCapabilities.globalConfigAdmin || authorizedProjectAliases.includes(command.alias);
      }
      return globalCapabilities.globalConfigAdmin;
    }

    if (command.resource === 'service') {
      if (command.action === 'restart') {
        return globalCapabilities.serviceRestarter;
      }
      return globalCapabilities.serviceObserver || operatorProjectAliases.length > 0;
    }

    if (command.resource === 'config') {
      return globalCapabilities.globalConfigAdmin;
    }

    return authorizedProjectAliases.includes(currentProjectAlias);
  }

  private commandRequiresWritableConfig(command: Extract<ReturnType<typeof parseBridgeCommand>, { kind: 'admin' }>): boolean {
    if (command.resource === 'service') {
      return command.action === 'restart';
    }
    return true;
  }

  private async handleAdminConfigCommand(
    context: IncomingMessageContext,
    command: { kind: 'admin'; resource: 'config'; action: 'history' | 'rollback'; value?: string },
  ): Promise<void> {
    if (command.action === 'history' && !this.canReadConfigHistory(context.chat_id)) {
      await this.sendTextReply(context.chat_id, '当前 chat_id 无权查看配置历史。', context.message_id, context.text);
      return;
    }
    if (command.action === 'rollback' && !this.canMutateRuntimeConfig(context.chat_id)) {
      await this.sendTextReply(context.chat_id, '当前 chat_id 无权回滚配置。', context.message_id, context.text);
      return;
    }
    if (!this.runtimeControl?.configPath) {
      await this.sendTextReply(context.chat_id, '当前运行实例没有可写配置路径，无法执行配置历史操作。', context.message_id, context.text);
      return;
    }

    if (command.action === 'history') {
      const snapshots = await this.configHistoryStore.listSnapshots();
      if (snapshots.length === 0) {
        await this.sendTextReply(context.chat_id, '当前没有可回滚的配置快照。', context.message_id, context.text);
        return;
      }
      const lines = ['最近配置快照:'];
      for (const snapshot of snapshots) {
        lines.push(`- ${snapshot.id} | ${snapshot.at} | ${snapshot.action}${snapshot.summary ? ` | ${snapshot.summary}` : ''}`);
      }
      await this.sendTextReply(context.chat_id, lines.join('\n'), context.message_id, context.text);
      return;
    }

    const target = await this.configHistoryStore.getSnapshot(command.value);
    if (!target) {
      await this.sendTextReply(context.chat_id, '未找到指定配置快照。可先执行 `/admin config history`。', context.message_id, context.text);
      return;
    }

    const rollbackSnapshot = await this.snapshotConfigForAdminMutation(context, 'config.rollback', `rollback -> ${target.id}`);
    const previousContent = rollbackSnapshot.content;
    try {
      await writeUtf8Atomic(this.runtimeControl.configPath, target.content);
      await this.reloadRuntimeConfigFromDisk(this.runtimeControl.configPath);
    } catch (error) {
      await writeUtf8Atomic(this.runtimeControl.configPath, previousContent);
      await this.reloadRuntimeConfigFromDisk(this.runtimeControl.configPath);
      throw error;
    }
    await this.appendAdminAudit({
      type: 'admin.config.rollback',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      target_snapshot_id: target.id,
      snapshot_id: rollbackSnapshot.id,
      config_path: this.runtimeControl.configPath,
    });
    await this.sendTextReply(
      context.chat_id,
      `已回滚配置。\n目标快照: ${target.id}\n回滚前快照: ${rollbackSnapshot.id}\n如需生效到某些运行时状态，请再执行 /admin service restart。`,
      context.message_id,
      context.text,
    );
  }

  private async snapshotConfigForAdminMutation(
    context: IncomingMessageContext,
    action: string,
    summary?: string,
  ): Promise<ConfigSnapshot> {
    if (!this.runtimeControl?.configPath) {
      throw new Error('Runtime config path is unavailable');
    }
    return this.configHistoryStore.recordSnapshot({
      configPath: this.runtimeControl.configPath,
      action,
      summary,
      chatId: context.chat_id,
      actorId: context.actor_id,
      limit: 5,
    });
  }

  private async appendAdminAudit(event: { type: string; [key: string]: unknown }): Promise<void> {
    await this.adminAuditLog.append(event);
  }

  private async reloadRuntimeConfigFromDisk(configPath: string): Promise<void> {
    const { config: nextConfig } = await loadBridgeConfigFile(configPath);
    replaceObject(this.config.service, nextConfig.service);
    replaceObject(this.config.codex, nextConfig.codex);
    replaceObject(this.config.storage, nextConfig.storage);
    replaceObject(this.config.security, nextConfig.security);
    replaceObject(this.config.feishu, nextConfig.feishu);
    replaceProjects(this.config.projects, nextConfig.projects);
  }

  private parseProjectPatch(field: string, value: string): Partial<ProjectConfig> | null {
    switch (field) {
      case 'root':
        return { root: value };
      case 'profile':
        return { profile: value };
      case 'sandbox':
        if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
          return { sandbox: value };
        }
        return null;
      case 'session_scope':
        if (value === 'chat' || value === 'chat-user') {
          return { session_scope: value };
        }
        return null;
      case 'mention_required':
        if (value === 'true' || value === 'false') {
          return { mention_required: value === 'true' };
        }
        return null;
      case 'description':
        return { description: value };
      case 'viewer_chat_ids':
        return { viewer_chat_ids: splitCommaSeparatedValues(value) };
      case 'operator_chat_ids':
        return { operator_chat_ids: splitCommaSeparatedValues(value) };
      case 'admin_chat_ids':
        return { admin_chat_ids: splitCommaSeparatedValues(value) };
      case 'session_operator_chat_ids':
        return { session_operator_chat_ids: splitCommaSeparatedValues(value) };
      case 'run_operator_chat_ids':
        return { run_operator_chat_ids: splitCommaSeparatedValues(value) };
      case 'config_admin_chat_ids':
        return { config_admin_chat_ids: splitCommaSeparatedValues(value) };
      case 'download_dir':
        return { download_dir: value };
      case 'temp_dir':
        return { temp_dir: value };
      case 'cache_dir':
        return { cache_dir: value };
      case 'log_dir':
        return { log_dir: value };
      case 'run_priority': {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 1 && parsed <= 1000 ? { run_priority: parsed } : null;
      }
      case 'chat_rate_limit_window_seconds': {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? { chat_rate_limit_window_seconds: parsed } : null;
      }
      case 'chat_rate_limit_max_runs': {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed > 0 ? { chat_rate_limit_max_runs: parsed } : null;
      }
      default:
        return null;
    }
  }

  private resolveProjectDownloadDir(projectAlias: string, project: ProjectConfig): string {
    return getProjectDownloadsDir(this.config.storage.dir, projectAlias, project);
  }

  private resolveProjectTempDir(projectAlias: string, project: ProjectConfig): string {
    return getProjectTempDir(this.config.storage.dir, projectAlias, project);
  }

  private resolveProjectCacheDir(projectAlias: string, project: ProjectConfig): string {
    return getProjectCacheDir(this.config.storage.dir, projectAlias, project);
  }

  private async appendProjectAuditEvent(projectAlias: string, project: ProjectConfig, event: { type: string; [key: string]: unknown }): Promise<void> {
    const auditLog = new AuditLog(getProjectAuditDir(this.config.storage.dir, projectAlias, project), 'project-audit.jsonl');
    await auditLog.append(event);
  }

  private async notifyProjectChats(projectAlias: string, text: string): Promise<void> {
    const project = this.config.projects[projectAlias];
    const chatIds = project?.notification_chat_ids ?? [];
    for (const chatId of chatIds) {
      try {
        await this.feishuClient.sendText(chatId, text);
      } catch { /* best-effort */ }
    }
  }

  private listManagedAuditTargets(): Array<{ stateDir: string; fileName: string; archiveDir?: string }> {
    const targets: Array<{ stateDir: string; fileName: string; archiveDir?: string }> = [
      {
        stateDir: this.config.storage.dir,
        fileName: 'audit.jsonl',
        archiveDir: path.join(this.config.storage.dir, 'archive'),
      },
      {
        stateDir: this.config.storage.dir,
        fileName: 'admin-audit.jsonl',
        archiveDir: path.join(this.config.storage.dir, 'archive'),
      },
    ];

    for (const [alias, project] of Object.entries(this.config.projects)) {
      targets.push({
        stateDir: getProjectAuditDir(this.config.storage.dir, alias, project),
        fileName: path.basename(getProjectAuditFile(this.config.storage.dir, alias, project)),
        archiveDir: getProjectArchiveDir(this.config.storage.dir, alias),
      });
    }

    return targets;
  }

  private checkAndConsumeChatRateLimit(projectAlias: string, project: ProjectConfig, chatId: string): string | null {
    const windowMs = project.chat_rate_limit_window_seconds * 1000;
    const maxRuns = project.chat_rate_limit_max_runs;
    const key = `${projectAlias}::${chatId}`;
    const now = Date.now();
    const recent = (this.chatRateWindows.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= maxRuns) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - recent[0]!)) / 1000));
      this.chatRateWindows.set(key, recent);
      return [
        '消息接收: rejected',
        '处理状态: rate_limited',
        `项目: ${projectAlias}`,
        '',
        `当前 chat 在 ${project.chat_rate_limit_window_seconds} 秒内最多提交 ${project.chat_rate_limit_max_runs} 次运行。`,
        `请约 ${retryAfterSeconds} 秒后再试。`,
      ].join('\n');
    }
    recent.push(now);
    this.chatRateWindows.set(key, recent);
    return null;
  }

  private applyAdminListValues(resource: 'viewer' | 'operator' | 'admin' | 'service-observer' | 'service-restart' | 'config-admin' | 'group' | 'chat', values: string[]): void {
    if (resource === 'viewer') {
      this.config.security.viewer_chat_ids = values;
      return;
    }
    if (resource === 'operator') {
      this.config.security.operator_chat_ids = values;
      return;
    }
    if (resource === 'service-observer') {
      this.config.security.service_observer_chat_ids = values;
      return;
    }
    if (resource === 'service-restart') {
      this.config.security.service_restart_chat_ids = values;
      return;
    }
    if (resource === 'config-admin') {
      this.config.security.config_admin_chat_ids = values;
      return;
    }
    if (resource === 'admin') {
      this.config.security.admin_chat_ids = values;
      return;
    }
    if (resource === 'group') {
      this.config.feishu.allowed_group_ids = values;
      return;
    }
    this.config.feishu.allowed_chat_ids = values;
  }

  private resolveProjectRoot(project: ProjectConfig): string {
    return path.resolve(project.root);
  }

  private resolveBackendByName(projectAlias: string, sessionOverride?: BackendName): Backend {
    return resolveProjectBackendWithOverride(this.config, projectAlias, sessionOverride, this.codexSessionIndex);
  }

  private async enforceSessionHistoryLimit(conversationKey: string, projectAlias: string): Promise<void> {
    const sessions = await this.sessionStore.listProjectSessions(conversationKey, projectAlias);
    const overflow = sessions.slice(this.config.service.session_history_limit);
    for (const session of overflow) {
      await this.sessionStore.dropProjectSession(conversationKey, projectAlias, session.thread_id);
    }
  }

  private async sendTextReply(
    chatId: string,
    body: string,
    replyToMessageId?: string,
    originalText?: string,
    presentation?: { status?: string; phase?: string; projectAlias?: string },
    mentionActor?: { chat_type?: string; actor_id?: string; actor_name?: string },
  ): Promise<FeishuMessageResponse> {
    // In group chats, prepend @mention to the reply so the requester gets notified
    const actor = mentionActor ?? this.currentMessageContext;
    let mentionPrefix = '';
    if (actor?.chat_type === 'group' && actor.actor_id) {
      const displayName = actor.actor_name || actor.actor_id;
      mentionPrefix = `<at user_id="${actor.actor_id}">${displayName}</at>\n`;
    }
    const bodyWithMention = mentionPrefix ? mentionPrefix + body : body;

    const title = this.buildReplyTitle(this.sanitizeUserVisibleReply(body));
    // Card mode uses replyToMessageId for threading — @mention tags render as
    // literal text inside card JSON, so use the clean body for cards.
    const formattedBodyClean = this.sanitizeUserVisibleReply(this.formatQuotedReply(body, originalText));
    const formattedBodyWithMention = this.sanitizeUserVisibleReply(this.formatQuotedReply(bodyWithMention, originalText));
    if (this.config.service.reply_mode === 'card') {
      const card = buildMessageCard({
        title,
        body: formattedBodyClean,
        status: presentation?.status,
        phase: presentation?.phase,
        projectAlias: presentation?.projectAlias,
      });
      const response = await this.sendCardReply(chatId, card, replyToMessageId);
      await this.auditLog.append({
        type: 'message.replied',
        chat_id: chatId,
        reply_mode: 'card',
        reply_to_message_id: replyToMessageId,
        title,
      });
      return response;
    }
    if (this.config.service.reply_mode === 'post') {
      const post = buildFeishuPost(title, formattedBodyWithMention);
      if (this.config.service.reply_quote_user_message && replyToMessageId) {
        const response = await this.feishuClient.sendPost(chatId, post, { replyToMessageId });
        await this.auditLog.append({
          type: 'message.replied',
          chat_id: chatId,
          reply_mode: 'post',
          reply_to_message_id: replyToMessageId,
          title,
        });
        return response;
      }
      const response = await this.feishuClient.sendPost(chatId, post);
      await this.auditLog.append({
        type: 'message.replied',
        chat_id: chatId,
        reply_mode: 'post',
        title,
      });
      return response;
    }
    if (this.config.service.reply_quote_user_message && replyToMessageId) {
      const response = await this.feishuClient.sendText(chatId, this.sanitizeUserVisibleReply(bodyWithMention), { replyToMessageId });
      await this.auditLog.append({
        type: 'message.replied',
        chat_id: chatId,
        reply_mode: 'text',
        reply_to_message_id: replyToMessageId,
        title,
      });
      return response;
    }
    const response = await this.feishuClient.sendText(chatId, formattedBodyWithMention);
    await this.auditLog.append({
      type: 'message.replied',
      chat_id: chatId,
      reply_mode: 'text',
      title,
    });
    return response;
  }

  private async sendCardReply(chatId: string, card: Record<string, unknown>, replyToMessageId?: string): Promise<FeishuMessageResponse> {
    if (this.config.service.reply_quote_user_message && replyToMessageId) {
      return this.feishuClient.sendCard(chatId, card, { replyToMessageId });
    }
    return this.feishuClient.sendCard(chatId, card);
  }

  private async sendRunLifecycleReply(input: {
    chatId: string;
    projectAlias: string;
    title: string;
    body: string;
    runStatus: string;
    runPhase?: string;
    runId?: string;
    replyToMessageId?: string;
    originalText?: string;
  }): Promise<FeishuMessageResponse> {
    const lifecycleMode = this.resolveRunLifecycleReplyMode();
    const lifecycleReplyOptions = input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : undefined;
    if (lifecycleMode === 'card') {
      const card = this.buildRunLifecycleCard({
        title: input.title,
        body: input.body,
        projectAlias: input.projectAlias,
        runStatus: input.runStatus,
        runPhase: input.runPhase,
      });
      const response = lifecycleReplyOptions
        ? await this.feishuClient.sendCard(input.chatId, card, lifecycleReplyOptions)
        : await this.sendCardReply(input.chatId, card);
      await this.auditLog.append({
        type: 'codex.run.replied',
        chat_id: input.chatId,
        project_alias: input.projectAlias,
        run_status: input.runStatus,
        run_phase: input.runPhase,
        ...(input.runId ? { run_id: input.runId } : {}),
      });
      return response;
    }
    if (lifecycleMode === 'post') {
      const postBody = this.sanitizeUserVisibleReply(this.formatQuotedReply(input.body, input.originalText));
      const title = this.buildReplyTitle(postBody);
      const post = buildFeishuPost(title, postBody);
      const response = lifecycleReplyOptions
        ? await this.feishuClient.sendPost(input.chatId, post, lifecycleReplyOptions)
        : await this.feishuClient.sendPost(input.chatId, post);
      await this.auditLog.append({
        type: 'codex.run.replied',
        chat_id: input.chatId,
        project_alias: input.projectAlias,
        run_status: input.runStatus,
        run_phase: input.runPhase,
        ...(input.runId ? { run_id: input.runId } : {}),
      });
      return response;
    }
    const response = lifecycleReplyOptions
      ? await this.feishuClient.sendText(
          input.chatId,
          this.sanitizeUserVisibleReply(this.formatQuotedReply(input.body, input.originalText)),
          lifecycleReplyOptions,
        )
      : await this.sendTextReply(input.chatId, input.body, input.replyToMessageId, input.originalText);
    await this.auditLog.append({
      type: 'codex.run.replied',
      chat_id: input.chatId,
      project_alias: input.projectAlias,
      run_status: input.runStatus,
      run_phase: input.runPhase,
      ...(input.runId ? { run_id: input.runId } : {}),
    });
    return response;
  }

  private buildInitialRunLifecycleReply(
    projectAlias: string,
    queued: QueuedExecutionNotice | null,
    mode: BridgeConfig['service']['reply_mode'],
  ): RunLifecycleReplyDraft {
    if (queued) {
      return {
        title: '已加入排队',
        body: this.buildAcknowledgedRunReply(projectAlias, '排队中', queued.detail, mode),
        runStatus: 'queued',
        runPhase: '排队中',
      };
    }

    return {
      title: '已接收请求',
      body: this.buildAcknowledgedRunReply(projectAlias, '已接收', '已收到你的消息，正在准备处理。', mode),
      runStatus: 'running',
      runPhase: '已接收',
    };
  }

  private async sendInitialRunLifecycleReply(input: {
    chatId: string;
    projectAlias: string;
    runId: string;
    queued: QueuedExecutionNotice | null;
    replyToMessageId?: string;
    originalText?: string;
  }): Promise<void> {
    const lifecycleMode = this.resolveRunLifecycleReplyMode();
    const draft = this.buildInitialRunLifecycleReply(input.projectAlias, input.queued, lifecycleMode);
    try {
      const response = await this.sendRunLifecycleReply({
        chatId: input.chatId,
        projectAlias: input.projectAlias,
        title: draft.title,
        body: draft.body,
        runStatus: draft.runStatus,
        runPhase: draft.runPhase,
        runId: input.runId,
        replyToMessageId: input.replyToMessageId,
        originalText: input.originalText,
      });
      await this.rememberRunReplyTarget(input.runId, response, lifecycleMode);
    } catch (error) {
      this.logger.warn({ error, runId: input.runId, projectAlias: input.projectAlias }, 'Failed to send initial lifecycle reply');
    }
  }

  private async rememberRunReplyTarget(
    runId: string,
    response: FeishuMessageResponse,
    mode: BridgeConfig['service']['reply_mode'] = this.resolveRunLifecycleReplyMode(),
  ): Promise<void> {
    this.runReplyTargets.set(runId, {
      messageId: response.message_id,
      mode,
    });
  }

  private async updateRunStartedReply(chatId: string, projectAlias: string, runId: string, backendLabel?: string): Promise<void> {
    const target = this.runReplyTargets.get(runId);
    if (!target?.messageId) {
      return;
    }
    const label = backendLabel ?? 'AI';
    const body = this.buildAcknowledgedRunReply(projectAlias, '处理中', '桥接器已开始处理你的请求。', target.mode);
    await this.updateRunLifecycleReply({
      chatId,
      projectAlias,
      title: `${label} 处理中`,
      body,
      runStatus: 'running',
      runPhase: '处理中',
      runId,
    });
  }

  private async updateRunProgressReply(
    input: {
      chatId: string;
      projectAlias: string;
      prompt: string;
      sessionKey: string;
      replyToMessageId?: string;
    },
    runId: string,
    progress: string,
    backendLabel?: string,
  ): Promise<void> {
    const target = this.runReplyTargets.get(runId);
    if (!target?.messageId) {
      return;
    }
    const label = backendLabel ?? 'AI';
    const body = [
      this.buildAcknowledgedRunReply(input.projectAlias, '处理中', '桥接器正在持续处理你的请求。', target.mode),
      '最新进展:',
      progress,
    ]
      .filter(Boolean)
      .join('\n\n');
    const updated = await this.updateRunLifecycleReply({
      chatId: input.chatId,
      projectAlias: input.projectAlias,
      title: `${label} 处理中`,
      body,
      runStatus: 'running',
      runPhase: '生成中',
      runId,
    });
    if (!updated) {
      return;
    }
  }

  private async sendOrUpdateRunOutcome(input: {
    input: {
      chatId: string;
      projectAlias: string;
      sessionKey: string;
      prompt: string;
      replyToMessageId?: string;
    };
    runId: string;
    title: string;
    body: string;
    runStatus: 'success' | 'failure' | 'cancelled';
    runPhase?: string;
    cardSummary: string;
    sessionId?: string;
  }): Promise<void> {
    const updated = await this.updateRunLifecycleReply({
      chatId: input.input.chatId,
      projectAlias: input.input.projectAlias,
      title: input.title,
      body: input.body,
      runStatus: input.runStatus,
      runPhase: input.runPhase,
      runId: input.runId,
      sessionKey: input.input.sessionKey,
      sessionId: input.sessionId,
      cardSummary: input.cardSummary,
    });
    if (updated) {
      return;
    }
    await this.sendTextReply(
      input.input.chatId,
      input.body,
      input.input.replyToMessageId,
      input.input.prompt,
      {
        status: input.runStatus,
      },
    );
    await this.auditLog.append({
      type: 'codex.run.replied',
      chat_id: input.input.chatId,
      project_alias: input.input.projectAlias,
      run_status: input.runStatus,
      run_phase: input.runPhase,
      run_id: input.runId,
    });
  }

  private async updateRunLifecycleReply(input: {
    chatId: string;
    projectAlias: string;
    title: string;
    body: string;
    runStatus: string;
    runPhase?: string;
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    cardSummary?: string;
  }): Promise<boolean> {
    const target = this.runReplyTargets.get(input.runId);
    if (!target?.messageId) {
      return false;
    }

    const sanitizedBody = this.sanitizeUserVisibleReply(input.body);
    if (target.mode === 'card') {
      const includeActions = input.runStatus === 'success' && this.supportsInteractiveCardActions() && input.sessionKey !== undefined;
      await this.feishuClient.updateCard(
        target.messageId,
        this.buildRunLifecycleCard({
          title: input.title,
          body: input.body,
          projectAlias: input.projectAlias,
          runStatus: input.runStatus,
          runPhase: input.runPhase,
          cardSummary: input.cardSummary,
          includeActions,
          rerunPayload: includeActions && input.sessionKey
            ? {
                action: 'rerun',
                conversation_key: input.sessionKey,
                project_alias: input.projectAlias,
                chat_id: input.chatId,
              }
            : undefined,
          newSessionPayload: includeActions && input.sessionKey
            ? {
                action: 'new',
                conversation_key: input.sessionKey,
                project_alias: input.projectAlias,
                chat_id: input.chatId,
              }
            : undefined,
          statusPayload: includeActions && input.sessionKey
            ? {
                action: 'status',
                conversation_key: input.sessionKey,
                project_alias: input.projectAlias,
                chat_id: input.chatId,
              }
            : undefined,
        }),
      );
    } else if (target.mode === 'post') {
      const title = this.buildReplyTitle(sanitizedBody);
      await this.feishuClient.updatePost(target.messageId, buildFeishuPost(title, sanitizedBody));
    } else {
      await this.feishuClient.updateText(target.messageId, sanitizedBody);
    }

    await this.auditLog.append({
      type: 'message.updated',
      chat_id: input.chatId,
      project_alias: input.projectAlias,
      run_id: input.runId,
      run_status: input.runStatus,
      run_phase: input.runPhase,
      reply_mode: target.mode,
    });
    await this.auditLog.append({
      type: 'codex.run.replied',
      chat_id: input.chatId,
      project_alias: input.projectAlias,
      run_status: input.runStatus,
      run_phase: input.runPhase,
      run_id: input.runId,
      update: true,
    });
    return true;
  }

  private formatQuotedReply(body: string, originalText?: string): string {
    return body;
  }

  private buildReplyTitle(body: string): string {
    const firstLine = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return truncateExcerpt(firstLine ?? '飞鹊 (Feique)', 40);
  }

  private sanitizeUserVisibleReply(body: string): string {
    return body
      .split(/\r?\n/)
      .filter((line) => !/^(运行|当前运行|阻塞运行|run[_ -]?id|session[_ -]?id|conversation[_ -]?key|chat[_ -]?id|tenant[_ -]?key|project[_ -]?root|pid):/i.test(line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private supportsInteractiveCardActions(): boolean {
    return this.config.feishu.transport === 'webhook';
  }

  private resolveRunLifecycleReplyMode(): BridgeConfig['service']['reply_mode'] {
    if (this.config.service.reply_mode === 'post') {
      return 'card';
    }
    return this.config.service.reply_mode;
  }

  private buildRunLifecycleCard(input: {
    title: string;
    body: string;
    projectAlias: string;
    runStatus?: string;
    runPhase?: string;
    cardSummary?: string;
    includeActions?: boolean;
    rerunPayload?: Record<string, unknown>;
    newSessionPayload?: Record<string, unknown>;
    statusPayload?: Record<string, unknown>;
    cancelPayload?: Record<string, unknown>;
  }): Record<string, unknown> {
    const sanitizedBody = this.sanitizeUserVisibleReply(input.body);
    if (input.includeActions) {
      return buildStatusCard({
        title: input.title,
        summary: input.cardSummary ?? truncateForFeishuCard(this.stripLifecycleMetadata(sanitizedBody)),
        projectAlias: input.projectAlias,
        runStatus: input.runStatus,
        runPhase: input.runPhase,
        includeActions: true,
        rerunPayload: input.rerunPayload,
        newSessionPayload: input.newSessionPayload,
        statusPayload: input.statusPayload,
        cancelPayload: input.cancelPayload,
      });
    }
    return buildMessageCard({
      title: input.title,
      body: this.stripLifecycleMetadata(sanitizedBody),
      status: input.runStatus,
      phase: input.runPhase,
      projectAlias: input.projectAlias,
    });
  }

  private stripLifecycleMetadata(body: string): string {
    return body
      .split(/\r?\n/)
      .filter((line) => !/^(项目|处理状态|会话|当前会话|已保存会话数):/.test(line.trim()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

export function buildQueueKey(conversationKey: string, projectAlias: string): string {
  return `${conversationKey}::project::${projectAlias}`;
}

export function buildProjectRootQueueKey(projectRoot: string): string {
  return `root::${path.resolve(projectRoot)}`;
}

function isExecutionRunStatus(status: RunState['status']): boolean {
  return status === 'running' || status === 'orphaned';
}

function isVisibleRunStatus(status: RunState['status']): boolean {
  return status === 'queued' || isExecutionRunStatus(status);
}

function buildMessageDedupeKey(context: IncomingMessageContext): string {
  return ['message', context.tenant_key ?? 'tenant', context.chat_id, context.message_id].join('::');
}

function buildCardDedupeKey(context: IncomingCardActionContext, action: string): string | null {
  if (!context.open_message_id) {
    return null;
  }
  return ['card', context.tenant_key ?? 'tenant', context.chat_id ?? 'chat', context.actor_id ?? 'actor', context.open_message_id, action].join('::');
}

/**
 * Extract [SEND_FILE:/path/to/file] markers from AI response text.
 * Returns cleaned text (markers removed) and list of file paths.
 */
function extractFileMarkers(text: string): { cleanText: string; filePaths: string[] } {
  const FILE_MARKER_RE = /\[SEND_FILE:([^\]]+)\]/g;
  const filePaths: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = FILE_MARKER_RE.exec(text)) !== null) {
    const filePath = match[1]?.trim();
    if (filePath) {
      filePaths.push(filePath);
    }
  }

  const cleanText = text.replace(FILE_MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, filePaths };
}

function truncateExcerpt(text: string, limit: number = 160): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Map raw error strings to user-friendly Chinese messages. */
function friendlyErrorMessage(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('econnreset')) {
    return '网络连接失败，请检查网络或稍后重试';
  }
  if (lower.includes('enoent') || lower.includes('enotdir')) {
    return '文件路径不存在，请检查项目配置';
  }
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return '权限不足，请检查文件权限';
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return '执行超时，请尝试拆分为更小的任务';
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return 'API 频率限制，请稍后重试';
  }
  if (lower.includes('enomem') || lower.includes('out of memory')) {
    return '内存不足，请关闭其他程序或减少并发任务';
  }
  // Default: show a truncated version of the raw error
  const truncated = error.length > 100 ? error.slice(0, 100) + '...' : error;
  return `执行异常: ${truncated}。如需帮助请联系管理员。`;
}

function splitCommaSeparatedValues(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveAdminListTarget(resource: 'viewer' | 'operator' | 'admin' | 'service-observer' | 'service-restart' | 'config-admin' | 'group' | 'chat'): { section: 'security' | 'feishu'; key: string } {
  switch (resource) {
    case 'viewer':
      return { section: 'security', key: 'viewer_chat_ids' };
    case 'operator':
      return { section: 'security', key: 'operator_chat_ids' };
    case 'admin':
      return { section: 'security', key: 'admin_chat_ids' };
    case 'service-observer':
      return { section: 'security', key: 'service_observer_chat_ids' };
    case 'service-restart':
      return { section: 'security', key: 'service_restart_chat_ids' };
    case 'config-admin':
      return { section: 'security', key: 'config_admin_chat_ids' };
    case 'group':
      return { section: 'feishu', key: 'allowed_group_ids' };
    case 'chat':
      return { section: 'feishu', key: 'allowed_chat_ids' };
  }
}

function buildConversationKeyForConversation(conversation: ConversationState): string {
  return buildConversationKey({
    tenantKey: conversation.tenant_key,
    chatId: conversation.chat_id,
    actorId: conversation.actor_id,
    scope: conversation.scope,
  });
}

function renderMemorySection(title: string, items: Array<{ title: string; content: string; pinned?: boolean }>, budget: number): string[] {
  if (items.length === 0) {
    return [];
  }

  const lines: string[] = ['', title];
  let used = 0;
  for (const item of items) {
    const line = `- ${item.title}${item.pinned ? ' [pinned]' : ''}: ${item.content}`;
    if (used + line.length > budget) {
      break;
    }
    lines.push(truncateExcerpt(line, 280));
    used += line.length;
  }
  return lines.length > 2 ? lines : [];
}

function formatAgeFromNow(isoTimestamp: string): string {
  const deltaMs = Date.now() - Date.parse(isoTimestamp);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return '0s';
  }
  const totalSeconds = Math.floor(deltaMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h`;
  }
  return `${Math.floor(totalHours / 24)}d`;
}

function parseJsonObject(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON payload must be an object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function clampListLimit(input: string | undefined, fallback: number, max: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}

function mapRunStatusToPhase(status: RunState['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'success':
      return '已完成';
    case 'failure':
      return '失败';
    case 'cancelled':
      return '已取消';
    case 'stale':
      return '中断';
    case 'orphaned':
      return '恢复中';
    default:
      return status;
  }
}

function replaceObject(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(next)) {
    target[key] = value;
  }
}

function replaceProjects(target: BridgeConfig['projects'], next: BridgeConfig['projects']): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) {
      delete target[key];
    }
  }
  for (const [alias, project] of Object.entries(next)) {
    target[alias] = project;
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
