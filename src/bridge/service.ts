import fs from 'node:fs/promises';
import { watch as watchFile, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { BridgeConfig, ProjectConfig, SessionScope } from '../config/schema.js';
import {
  buildHelpText,
  buildFullHelpText,
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
import { resolveMessageResources } from '../feishu/message-resource.js';
import { MemoryStore } from '../state/memory-store.js';
import type { MemoryContext } from '../memory/retrieve.js';
import { CodexSessionIndex } from '../codex/session-index.js';
import type { Backend, BackendName } from '../backend/types.js';
import { resolveProjectBackendWithOverride, resolveProjectBackendName, resolveFallbackChain, type FailoverInfo } from '../backend/factory.js';
import { getBackendDefinition, listBackendNames } from '../backend/registry.js';
import {
  buildQueueKey,
  isExecutionRunStatus,
  isVisibleRunStatus,
  mapRunStatusToPhase,
  buildMessageDedupeKey,
  buildCardDedupeKey,
  truncateExcerpt,
  friendlyErrorMessage,
  resolveAdminListTarget,
  buildConversationKeyForConversation,
  renderMemorySection,
  formatAgeFromNow,
  replaceObject,
  replaceProjects,
} from './service-utils.js';
import {
  handleDocCommand as handleDocCommandImpl,
  handleTaskCommand as handleTaskCommandImpl,
  handleBaseCommand as handleBaseCommandImpl,
  handleWikiCommand as handleWikiCommandImpl,
} from './feishu-commands.js';
import { handleMemoryCommand as handleMemoryCommandImpl } from './memory-commands.js';
import {
  handleAdminConfigCommand as handleAdminConfigCommandImpl,
  parseProjectPatch as parseProjectPatchImpl,
} from './admin-config.js';
import {
  scheduleProjectExecution as scheduleProjectExecutionImpl,
  buildAcknowledgedRunReply,
  buildRunStatusSummary,
  type QueuedExecutionNotice,
  type ScheduledProjectExecution,
} from './run-scheduler.js';
import {
  formatQuotedReply,
  buildReplyTitle,
  sanitizeUserVisibleReply,
  supportsInteractiveCardActions,
  resolveRunLifecycleReplyMode,
  buildRunLifecycleCard,
} from './reply-builders.js';
import { executePrompt as executePromptImpl } from './run-pipeline.js';
import {
  recoverRuntimeState as recoverRuntimeStateImpl,
  reloadConfig as reloadConfigImpl,
  runDigestCycle as runDigestCycleImpl,
  runMemoryMaintenance as runMemoryMaintenanceImpl,
  runAuditMaintenance as runAuditMaintenanceImpl,
  runMaintenanceCycle as runMaintenanceCycleImpl,
} from './lifecycle.js';
import {
  handleLearnCommand as handleLearnCommandImpl,
  handleRecallCommand as handleRecallCommandImpl,
  handleHandoffCommand as handleHandoffCommandImpl,
  handlePickupCommand as handlePickupCommandImpl,
  handleReviewCommand as handleReviewCommandImpl,
  handleApproveCommand as handleApproveCommandImpl,
  handleRejectCommand as handleRejectCommandImpl,
  handleInsightsCommand as handleInsightsCommandImpl,
  handleTrustCommand as handleTrustCommandImpl,
  handleDigestCommand as handleDigestCommandImpl,
  handleGapsCommand as handleGapsCommandImpl,
  handleTimelineCommand as handleTimelineCommandImpl,
} from './collab-commands.js';
import { bindProjectAlias, createProjectAlias, removeProjectAlias, updateProjectConfig, updateStringList } from '../config/mutate.js';
import { buildFeishuPost } from '../feishu/text.js';
import { ConfigHistoryStore, type ConfigSnapshot } from '../state/config-history-store.js';
import { loadBridgeConfigFile } from '../config/load.js';
import { expandHomePath } from '../utils/path.js';
import { canAccessGlobalCapability, canAccessProject, canAccessProjectCapability, describeMinimumRole, filterAccessibleProjects, resolveProjectAccessRole, type AccessRole } from '../security/access.js';
import { adoptProjectSession as adoptSharedProjectSession, listBridgeSessions as listSharedBridgeSessions, switchProjectBinding as switchSharedProjectBinding } from '../control-plane/project-session.js';
import { getProjectAuditDir, getProjectCacheDir, getProjectDownloadsDir, getProjectTempDir } from '../projects/paths.js';
import { buildTeamActivityView, detectOverlaps, formatTeamView, formatOverlapAlerts } from '../collaboration/awareness.js';
import { createReview } from '../collaboration/handoff.js';
import { classifyOperation, enforceTrustBoundary } from '../collaboration/trust.js';
import { HandoffStore } from '../state/handoff-store.js';
import { TrustStore } from '../state/trust-store.js';
import { IntentClassifier } from './intent-classifier.js';
import { checkRunAlerts, formatAlert, DEFAULT_ALERT_RULES } from '../collaboration/proactive-alerts.js';

export interface ActiveRunHandle {
  runId: string;
  controller: AbortController;
  pid?: number;
  cancelReason?: 'user' | 'timeout' | 'recovery';
}

// QueuedExecutionNotice and ScheduledProjectExecution now live in run-scheduler.ts

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
  public readonly queue = new TaskQueue();
  public readonly projectRootQueue = new TaskQueue();
  public readonly activeRuns = new Map<string, ActiveRunHandle>();
  public readonly runReplyTargets = new Map<string, RunReplyTarget>();
  private readonly chatRateWindows = new Map<string, number[]>();
  /** Dedupe admin notifications for backend failover: one alert per (from→to) direction per process lifetime. */
  private readonly failoverNotified = new Set<string>();
  /** Dedupe rejected-chat notifications: one reply + one admin alert per chat_id per process lifetime. */
  private readonly rejectedChatNotified = new Set<string>();
  private maintenanceTimer?: NodeJS.Timeout;
  private digestTimer?: NodeJS.Timeout;
  private configWatcher?: FSWatcher;
  private readonly intentClassifier?: IntentClassifier;
  /** Tracks the current incoming message for @mention in replies. */
  private currentMessageContext?: IncomingMessageContext;

  public constructor(
    public config: BridgeConfig,
    public readonly feishuClient: FeishuClient,
    public readonly sessionStore: SessionStore,
    public readonly auditLog: AuditLog,
    public readonly logger: Logger,
    public readonly metrics?: MetricsRegistry,
    private readonly idempotencyStore: IdempotencyStore = new IdempotencyStore(config.storage.dir),
    public readonly runStateStore: RunStateStore = new RunStateStore(config.storage.dir),
    public readonly memoryStore: MemoryStore = new MemoryStore(config.storage.dir),
    public readonly codexSessionIndex: CodexSessionIndex = new CodexSessionIndex(),
    public readonly runtimeControl?: RuntimeControl,
    public readonly adminAuditLog: AuditLog = new AuditLog(config.storage.dir, 'admin-audit.jsonl'),
    public readonly configHistoryStore: ConfigHistoryStore = new ConfigHistoryStore(config.storage.dir),
    public readonly handoffStore: HandoffStore = new HandoffStore(config.storage.dir),
    public readonly trustStore: TrustStore = new TrustStore(config.storage.dir),
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
    return recoverRuntimeStateImpl(this);
  }

  public async reloadConfig(configPath: string): Promise<{ ok: boolean; error?: string; changes?: string[] }> {
    const result = await reloadConfigImpl(this, configPath);
    if (result.newConfig) {
      this.config = result.newConfig;
    }
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.changes ? { changes: result.changes } : {}) };
  }

  /**
   * Watch config file for changes and auto-reload with validation.
   */
  public startConfigWatcher(configPath: string): void {
    if (this.configWatcher) return;
    try {
      let debounce: NodeJS.Timeout | undefined;
      this.configWatcher = watchFile(configPath, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(async () => {
          await this.reloadConfig(configPath);
        }, 500);
        debounce.unref?.();
      });
      this.configWatcher.unref?.();
      this.logger.info({ configPath }, 'Config file watcher started');
    } catch (error) {
      this.logger.warn({ error, configPath }, 'Failed to start config file watcher');
    }
  }

  public stopConfigWatcher(): void {
    this.configWatcher?.close();
    this.configWatcher = undefined;
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
    this.stopConfigWatcher();
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
    return runDigestCycleImpl(this);
  }

  public async runMemoryMaintenance(): Promise<number> {
    return runMemoryMaintenanceImpl(this);
  }

  public async runAuditMaintenance(): Promise<{ scanned: number; archived: number; removed: number }> {
    return runAuditMaintenanceImpl(this);
  }

  public async runMaintenanceCycle(): Promise<void> {
    return runMaintenanceCycleImpl(this);
  }

  public async handleIncomingMessage(context: IncomingMessageContext): Promise<void> {
    context = this.normalizeIncomingChatContext(context);
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
          await this.handleBackendCommand(context, selectionKey, command.name, command.action);
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
          await this.handlePromptMessage(context, selectionKey, command.prompt);
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
    return executePromptImpl(this, input);
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
    this.requireProject(alias); // throws if missing — validates the alias before switching
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
      await this.handlePromptMessage(context, selectionKey, followupPrompt);
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
        await this.handleBackendCommand(context, selectionKey, command.name, command.action);
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
        await this.handlePromptMessage(context, selectionKey, followupPrompt);
        return;
      default:
        await this.handlePromptMessage(context, selectionKey, followupPrompt);
    }
  }

  private async handlePromptMessage(
    context: IncomingMessageContext,
    selectionKey: string,
    rawPrompt: string,
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
    if (context.chat_type === 'group' && this.shouldRequireMention(projectContext.project) && !this.messageMentionsBot(context)) {
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
    return handleLearnCommandImpl(this, context, projectContext, value);
  }

  private async handleRecallCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    query: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleRecallCommandImpl(this, context, projectContext, query);
  }

  private async handleHandoffCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    summary?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleHandoffCommandImpl(this, context, projectContext, summary);
  }

  private async handlePickupCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    id?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handlePickupCommandImpl(this, context, projectContext, id);
  }

  private async handleReviewCommand(
    context: IncomingMessageContext,
    selectionKey: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleReviewCommandImpl(this, context, projectContext);
  }

  private async handleApproveCommand(
    context: IncomingMessageContext,
    comment?: string,
  ): Promise<void> {
    return handleApproveCommandImpl(this, context, comment);
  }

  private async handleRejectCommand(
    context: IncomingMessageContext,
    reason?: string,
  ): Promise<void> {
    return handleRejectCommandImpl(this, context, reason);
  }

  private async handleInsightsCommand(context: IncomingMessageContext): Promise<void> {
    return handleInsightsCommandImpl(this, context);
  }

  private async handleTrustCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action?: 'set',
    level?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleTrustCommandImpl(this, context, projectContext, action, level);
  }

  private async handleDigestCommand(context: IncomingMessageContext): Promise<void> {
    return handleDigestCommandImpl(this, context);
  }

  // ── Proactive Alerts ──

  public async checkAndSendAlerts(completedRun: RunState): Promise<void> {
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
    return handleGapsCommandImpl(this, context);
  }

  // ── Direction 6: Timeline ──

  private async handleTimelineCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    projectArg?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleTimelineCommandImpl(this, context, projectContext, projectArg);
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
      if (command.action === 'add' || command.action === 'create' || command.action === 'setup') {
        if (!(globalAdmin || globalConfigAdmin)) {
          await this.sendTextReply(context.chat_id, '当前 chat_id 无权动态接入项目。', context.message_id, context.text);
          return;
        }
        if (!command.alias || !command.value) {
          await this.sendTextReply(
            context.chat_id,
            command.action === 'setup'
              ? '用法: /admin project setup <alias> <root>\n一键创建项目并将当前群设为 operator。'
              : command.action === 'create' ? '用法: /admin project create <alias> <root>' : '用法: /admin project add <alias> <root>',
            context.message_id,
            context.text,
          );
          return;
        }
        const isCreate = command.action === 'create' || command.action === 'setup';
        if (isCreate && this.config.projects[command.alias]) {
          await this.sendTextReply(context.chat_id, `项目已存在: ${command.alias}`, context.message_id, context.text);
          return;
        }
        const resolvedRoot = path.resolve(expandHomePath(command.value));
        const snapshot = await this.snapshotConfigForAdminMutation(context, `project.${command.action}`, `${command.alias} -> ${resolvedRoot}`);
        if (isCreate) {
          await createProjectAlias({ configPath: runtimeConfigPath!, alias: command.alias, root: command.value });
        } else {
          await bindProjectAlias({ configPath: runtimeConfigPath!, alias: command.alias, root: command.value });
        }
        // For setup: auto-add current chat as operator + viewer
        const autoOperator = command.action === 'setup' ? [context.chat_id] : [];
        this.config.projects[command.alias] = {
          root: resolvedRoot,
          session_scope: 'chat',
          mention_required: true,
          knowledge_paths: [],
          wiki_space_ids: [],
          viewer_chat_ids: [...autoOperator],
          operator_chat_ids: [...autoOperator],
          admin_chat_ids: [],
          notification_chat_ids: [...autoOperator],
          session_operator_chat_ids: [],
          run_operator_chat_ids: [],
          config_admin_chat_ids: [],
          mcp_servers: [],
          skills: [],
          run_priority: 100,
          chat_rate_limit_window_seconds: 60,
          chat_rate_limit_max_runs: 20,
        };
        // Persist the auto-added chat_ids to config file for setup
        if (command.action === 'setup') {
          await updateProjectConfig(runtimeConfigPath!, command.alias, {
            viewer_chat_ids: autoOperator,
            operator_chat_ids: autoOperator,
            notification_chat_ids: autoOperator,
          });
        }
        const replyLines = [
          `${isCreate ? '已创建并接入项目' : '已接入项目'}: ${command.alias}`,
          `根目录: ${resolvedRoot}`,
        ];
        if (command.action === 'setup') {
          replyLines.push(`已自动将当前群设为 operator + viewer + notification`);
          replyLines.push('');
          replyLines.push('可在其他群执行以下命令添加权限:');
          replyLines.push(`/admin project set ${command.alias} operator_chat_ids +<chat_id>`);
          replyLines.push('');
          replyLines.push(`切换到此项目: /project ${command.alias}`);
        }
        await this.sendTextReply(
          context.chat_id,
          replyLines.join('\n'),
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
          auto_operator: command.action === 'setup' ? context.chat_id : undefined,
        });
        this.logger.info(
          { alias: command.alias, root: resolvedRoot, actorId: context.actor_id, created: isCreate, setup: command.action === 'setup' },
          command.action === 'setup' ? 'Project setup by Feishu admin' : isCreate ? 'Project created by Feishu admin' : 'Project added by Feishu admin',
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
      const patch = parseProjectPatchImpl(this.config, command.field, command.value, command.alias);
      if (!patch) {
        await this.sendTextReply(
          context.chat_id,
          '支持字段: root, profile, sandbox, session_scope, mention_required, description, viewer_chat_ids, operator_chat_ids, admin_chat_ids, notification_chat_ids, session_operator_chat_ids, run_operator_chat_ids, config_admin_chat_ids, download_dir, temp_dir, cache_dir, log_dir, run_priority, chat_rate_limit_window_seconds, chat_rate_limit_max_runs\n\n列表字段支持增量操作: +value 添加, -value 移除',
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
    action?: 'list',
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);

    if (action === 'list') {
      const sessionOverride = await this.sessionStore.getProjectBackend(projectContext.sessionKey, projectContext.projectAlias);
      const primaryName = resolveProjectBackendName(this.config, projectContext.projectAlias, sessionOverride);
      const chain = resolveFallbackChain(this.config, projectContext.projectAlias, primaryName);
      const project = this.config.projects[projectContext.projectAlias];
      const failoverEnabled = project?.failover ?? this.config.backend?.failover ?? true;
      const failoverSource = project?.failover !== undefined
        ? '项目配置'
        : this.config.backend?.failover !== undefined ? '全局默认' : '注册表默认';

      const registered = listBackendNames();
      const lines = [
        `项目: ${projectContext.projectAlias}`,
        '',
        `当前主后端: ${primaryName}${sessionOverride ? '（会话级覆盖）' : project?.backend ? '（项目配置）' : '（全局默认）'}`,
        `Failover: ${failoverEnabled ? '启用' : '关闭'}（${failoverSource}）`,
        chain.length > 0
          ? `Fallback 链: ${primaryName} → ${chain.join(' → ')}`
          : `Fallback 链: 无（链为空）`,
        '',
        '已注册的后端:',
        ...registered.map((n) => {
          const marker = n === primaryName ? ' ← 当前' : chain.includes(n) ? ' (fallback)' : '';
          return `  • ${n}${marker}`;
        }),
        '',
        '用法:',
        `  /backend ${registered.join('|')} — 切换到指定后端`,
        '  /backend — 只查看当前后端',
        '  /backend list — 查看完整清单（本命令）',
      ];
      await this.sendTextReply(
        context.chat_id,
        lines.join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

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
    if (!getBackendDefinition(normalized)) {
      const known = listBackendNames().join(' | ');
      await this.sendTextReply(
        context.chat_id,
        `未知后端: ${name}\n可选值: ${known}`,
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
    const label = backendName === 'claude' ? 'Claude Code' : backendName === 'qwen' ? 'Qwen Code' : 'Codex';
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
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleMemoryCommandImpl(this, context, projectContext, action, scope, value, filters);
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
    return handleDocCommandImpl(this, context, projectContext, action, value, extra);
  }

  private async handleTaskCommand(
    context: IncomingMessageContext,
    selectionKey: string,
    action: 'list' | 'get' | 'create' | 'complete',
    value?: string,
  ): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    return handleTaskCommandImpl(this, context, projectContext, action, value);
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
    return handleBaseCommandImpl(this, context, projectContext, action, appToken, tableId, recordId, value);
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
    return handleWikiCommandImpl(this, context, projectContext, action, value, extra, target, role);
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
    const includeActions = supportsInteractiveCardActions(this.config);
    const actionChatId = conversation?.chat_id ?? activeRun?.chat_id ?? fallbackChatId;
    return buildStatusCard({
      title: '当前会话状态',
      summary: buildRunStatusSummary(session?.last_response_excerpt, activeRun),
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

  public async buildBridgePrompt(
    projectAlias: string,
    project: ProjectConfig,
    incomingMessage: IncomingMessageContext,
    userPrompt: string,
    memoryContext: MemoryContext,
  ): Promise<string> {
    // Persona: project-level overrides global
    const persona = project.persona ?? this.config.service.persona;
    const prefixParts = [
      persona
        ? `Replying via Feique (飞鹊). Persona: ${persona}`
        : 'Replying via Feique (飞鹊), a team AI collaboration hub for Feishu.',
      // Bridge rules — compact, one block
      'Feishu rules: Your text is auto-forwarded — do NOT send text to Feishu directly (causes duplicates). Files/images: send directly via Feishu APIs or use [SEND_FILE:/path] marker in response. Use project-relative paths. Do not expose internal IDs or secrets.',
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

    // Project-level tools and skills
    if (project.skills && project.skills.length > 0) {
      prefixParts.push(`Available skills for this project: ${project.skills.join(', ')}`);
    }
    if (project.mcp_servers && project.mcp_servers.length > 0) {
      prefixParts.push(`Project MCP servers: ${project.mcp_servers.map((s) => s.name).join(', ')}`);
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

  private messageMentionsBot(context: IncomingMessageContext): boolean {
    const botOpenIds = new Set(this.config.feishu.bot_open_ids ?? []);
    const botName = this.config.feishu.bot_name?.trim();
    if (botOpenIds.size === 0 && !botName) {
      return context.mentions.length > 0;
    }
    return context.mentions.some((mention) => {
      if (mention.id && botOpenIds.has(mention.id)) {
        return true;
      }
      return Boolean(botName && mention.name?.trim() === botName);
    });
  }

  private normalizeIncomingChatContext(context: IncomingMessageContext): IncomingMessageContext {
    if (context.chat_type !== 'group' && this.config.feishu.allowed_group_ids.includes(context.chat_id)) {
      return { ...context, chat_type: 'group' };
    }
    return context;
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
    return scheduleProjectExecutionImpl(this, projectContext, metadata, task);
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
    return handleAdminConfigCommandImpl(this, context, command);
  }

  public async snapshotConfigForAdminMutation(
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

  public async appendAdminAudit(event: { type: string; [key: string]: unknown }): Promise<void> {
    await this.adminAuditLog.append(event);
  }

  public async reloadRuntimeConfigFromDisk(configPath: string): Promise<void> {
    const { config: nextConfig } = await loadBridgeConfigFile(configPath);
    replaceObject(this.config.service, nextConfig.service);
    replaceObject(this.config.codex, nextConfig.codex);
    replaceObject(this.config.storage, nextConfig.storage);
    replaceObject(this.config.security, nextConfig.security);
    replaceObject(this.config.feishu, nextConfig.feishu);
    replaceProjects(this.config.projects, nextConfig.projects);
  }


  private resolveProjectDownloadDir(projectAlias: string, project: ProjectConfig): string {
    return getProjectDownloadsDir(this.config.storage.dir, projectAlias, project);
  }

  public resolveProjectTempDir(projectAlias: string, project: ProjectConfig): string {
    return getProjectTempDir(this.config.storage.dir, projectAlias, project);
  }

  public resolveProjectCacheDir(projectAlias: string, project: ProjectConfig): string {
    return getProjectCacheDir(this.config.storage.dir, projectAlias, project);
  }

  public async appendProjectAuditEvent(projectAlias: string, project: ProjectConfig, event: { type: string; [key: string]: unknown }): Promise<void> {
    const auditLog = new AuditLog(getProjectAuditDir(this.config.storage.dir, projectAlias, project), 'project-audit.jsonl');
    await auditLog.append(event);
  }

  public async notifyProjectChats(projectAlias: string, text: string): Promise<void> {
    const project = this.config.projects[projectAlias];
    const chatIds = project?.notification_chat_ids ?? [];
    for (const chatId of chatIds) {
      try {
        await this.feishuClient.sendText(chatId, text);
      } catch { /* best-effort */ }
    }
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


  public resolveBackendByName(projectAlias: string, sessionOverride?: BackendName): Backend {
    return resolveProjectBackendWithOverride(this.config, projectAlias, sessionOverride, this.codexSessionIndex);
  }

  /**
   * Called when resolveProjectBackendWithFailover returns a non-null failover.
   * Responsibilities:
   *   - Log a warning with structured context
   *   - Emit an audit event
   *   - Notify admin chats (deduped by from→to direction for the process lifetime)
   *   - Send a user-visible notice into the current chat so the user knows
   *     why their run is on a different backend than expected
   */
  public async handleBackendFailover(
    chatId: string,
    projectAlias: string,
    runId: string,
    info: FailoverInfo,
  ): Promise<void> {
    this.logger.warn(
      { projectAlias, runId, from: info.from, to: info.to, reason: info.reason },
      'Backend failover: primary probe failed, switched to alternate',
    );

    try {
      await this.auditLog.append({
        type: 'backend.failover',
        project_alias: projectAlias,
        run_id: runId,
        from: info.from,
        to: info.to,
        reason: info.reason,
      });
    } catch { /* best-effort */ }

    const userNotice = `⚠️ ${info.from} 不可用，已临时切换到 ${info.to} 运行本次请求。\n原因: ${info.reason}`;
    try { await this.feishuClient.sendText(chatId, userNotice); } catch { /* best-effort */ }

    const dedupeKey = `${info.from}->${info.to}`;
    if (this.failoverNotified.has(dedupeKey)) return;
    this.failoverNotified.add(dedupeKey);

    const adminChatIds = this.config.security.admin_chat_ids ?? [];
    if (adminChatIds.length === 0) return;
    const adminText = `🔁 Backend failover 已触发\n\n` +
      `方向: ${info.from} → ${info.to}\n` +
      `项目: ${projectAlias}\n` +
      `原因: ${info.reason}\n\n` +
      `后续同方向的切换不会重复通知，直到服务重启。`;
    for (const adminChat of adminChatIds) {
      try { await this.feishuClient.sendText(adminChat, adminText); } catch { /* best-effort */ }
    }
  }

  /**
   * Called by the transport layer when an incoming chat is rejected by the
   * allowlist (`feishu.allowed_chat_ids` / `allowed_group_ids`).
   *
   * Replaces the previous "silent drop" behavior with a pairing-style
   * experience: tell the user what their chat_id is so an admin can add it,
   * notify admins that a new chat is knocking, and record the rejection in
   * the audit log. Deduped per chat_id for the process lifetime so repeated
   * attempts from the same unauthorized chat do not spam either side.
   *
   * This is best-effort: any send failure is swallowed. We never want a
   * rejection flow to throw out of the transport dispatcher.
   */
  public async handleRejectedChat(chatId: string, chatType: 'p2p' | 'group' | 'unknown'): Promise<void> {
    if (this.rejectedChatNotified.has(chatId)) return;
    this.rejectedChatNotified.add(chatId);

    try {
      await this.auditLog.append({
        type: 'chat.rejected',
        chat_id: chatId,
        chat_type: chatType,
      });
    } catch { /* best-effort */ }

    const listHint = chatType === 'group'
      ? '`feishu.allowed_group_ids`（群聊）'
      : '`feishu.allowed_chat_ids`（私聊）';
    const userText = `抱歉，该 chat 未被授权访问本 bot。\n` +
      `你的 chat_id: ${chatId}\n\n` +
      `请联系管理员并附上这个 id，请求加入 ${listHint}。`;
    try { await this.feishuClient.sendText(chatId, userText); } catch { /* best-effort */ }

    const adminChatIds = this.config.security.admin_chat_ids ?? [];
    if (adminChatIds.length === 0) return;
    const adminCommand = chatType === 'group'
      ? `/admin group add ${chatId}`
      : `/admin chat add ${chatId}`;
    const adminText = `🔔 新 chat 请求接入\n\n` +
      `chat_id: ${chatId}\n` +
      `类型: ${chatType}\n\n` +
      `如需授权，运行:\n${adminCommand}\n\n` +
      `后续来自同一 chat 的请求不会重复通知，直到服务重启。`;
    for (const adminChat of adminChatIds) {
      try { await this.feishuClient.sendText(adminChat, adminText); } catch { /* best-effort */ }
    }
  }

  public async enforceSessionHistoryLimit(conversationKey: string, projectAlias: string): Promise<void> {
    const sessions = await this.sessionStore.listProjectSessions(conversationKey, projectAlias);
    const overflow = sessions.slice(this.config.service.session_history_limit);
    for (const session of overflow) {
      await this.sessionStore.dropProjectSession(conversationKey, projectAlias, session.thread_id);
    }
  }

  public async sendTextReply(
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

    const title = buildReplyTitle(sanitizeUserVisibleReply(body));
    // Card mode uses replyToMessageId for threading — @mention tags render as
    // literal text inside card JSON, so use the clean body for cards.
    const formattedBodyClean = sanitizeUserVisibleReply(formatQuotedReply(body, originalText));
    const formattedBodyWithMention = sanitizeUserVisibleReply(formatQuotedReply(bodyWithMention, originalText));
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
      const response = await this.feishuClient.sendText(chatId, sanitizeUserVisibleReply(bodyWithMention), { replyToMessageId });
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
    const lifecycleMode = resolveRunLifecycleReplyMode(this.config);
    const lifecycleReplyOptions = input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : undefined;
    if (lifecycleMode === 'card') {
      const card = buildRunLifecycleCard({
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
      const postBody = sanitizeUserVisibleReply(formatQuotedReply(input.body, input.originalText));
      const title = buildReplyTitle(postBody);
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
          sanitizeUserVisibleReply(formatQuotedReply(input.body, input.originalText)),
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
        body: buildAcknowledgedRunReply(projectAlias, '排队中', queued.detail, mode),
        runStatus: 'queued',
        runPhase: '排队中',
      };
    }

    return {
      title: '已接收请求',
      body: buildAcknowledgedRunReply(projectAlias, '已接收', '已收到你的消息，正在准备处理。', mode),
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
    const lifecycleMode = resolveRunLifecycleReplyMode(this.config);
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
    mode: BridgeConfig['service']['reply_mode'] = resolveRunLifecycleReplyMode(this.config),
  ): Promise<void> {
    this.runReplyTargets.set(runId, {
      messageId: response.message_id,
      mode,
    });
  }

  public async updateRunStartedReply(chatId: string, projectAlias: string, runId: string, backendLabel?: string): Promise<void> {
    const target = this.runReplyTargets.get(runId);
    if (!target?.messageId) {
      return;
    }
    const label = backendLabel ?? 'AI';
    const body = buildAcknowledgedRunReply(projectAlias, '处理中', '桥接器已开始处理你的请求。', target.mode);
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

  public async updateRunProgressReply(
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
      buildAcknowledgedRunReply(input.projectAlias, '处理中', '桥接器正在持续处理你的请求。', target.mode),
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

  public async sendOrUpdateRunOutcome(input: {
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

    const sanitizedBody = sanitizeUserVisibleReply(input.body);
    if (target.mode === 'card') {
      const includeActions = input.runStatus === 'success' && supportsInteractiveCardActions(this.config) && input.sessionKey !== undefined;
      await this.feishuClient.updateCard(
        target.messageId,
        buildRunLifecycleCard({
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
      const title = buildReplyTitle(sanitizedBody);
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
}

// Module-level helpers extracted to service-utils.ts (β step 1).
// Re-exported here for backward compatibility (src/mcp/server.ts and
// src/index.ts depend on these names being importable from this module).
export { buildQueueKey, buildProjectRootQueueKey } from './service-utils.js';
