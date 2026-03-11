import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig, ProjectConfig, SessionScope } from '../config/schema.js';
import { buildHelpText, normalizeIncomingText, parseBridgeCommand, type MemoryCommandFilters, type MemoryScopeTarget } from './commands.js';
import type { IncomingCardActionContext, IncomingMessageContext } from './types.js';
import { SessionStore, buildConversationKey, type ConversationState } from '../state/session-store.js';
import type { Logger } from '../logging.js';
import { FeishuClient } from '../feishu/client.js';
import { buildStatusCard } from '../feishu/cards.js';
import { runCodexTurn, summarizeCodexEvent } from '../codex/runner.js';
import { TaskQueue } from './task-queue.js';
import { AuditLog } from '../state/audit-log.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { IdempotencyStore } from '../state/idempotency-store.js';
import { RunStateStore, type RunState } from '../state/run-state-store.js';
import { isProcessAlive, terminateProcess } from '../runtime/process.js';
import { resolveKnowledgeRoots, searchKnowledgeBase } from '../knowledge/search.js';
import { FeishuWikiClient } from '../feishu/wiki.js';
import { resolveMessageResources } from '../feishu/message-resource.js';
import { MemoryStore } from '../state/memory-store.js';
import { retrieveMemoryContext, type MemoryContext } from '../memory/retrieve.js';
import { summarizeThreadTurn } from '../memory/summarize.js';
import { CodexSessionIndex, renderSessionMatchLabel, type IndexedCodexSession } from '../codex/session-index.js';
import { bindProjectAlias, removeProjectAlias, updateBridgeConfigFile, updateProjectConfig, updateStringList } from '../config/mutate.js';
import { buildFeishuPost, truncateForFeishuCard } from '../feishu/text.js';

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
  queued: QueuedExecutionNotice | null;
  completion: Promise<void>;
}

interface RuntimeControl {
  configPath?: string;
  restart?: () => Promise<void>;
}

export class CodexFeishuService {
  private readonly queue = new TaskQueue();
  private readonly projectRootQueue = new TaskQueue();
  private readonly activeRuns = new Map<string, ActiveRunHandle>();
  private maintenanceTimer?: NodeJS.Timeout;

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
  ) {}

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
    if (!this.config.service.memory_enabled || this.maintenanceTimer) {
      return;
    }
    const intervalMs = this.config.service.memory_cleanup_interval_seconds * 1000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      void this.runMemoryMaintenance();
    }, intervalMs);
    this.maintenanceTimer.unref?.();
  }

  public stopMaintenanceLoop(): void {
    if (!this.maintenanceTimer) {
      return;
    }
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
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

  public async handleIncomingMessage(context: IncomingMessageContext): Promise<void> {
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
      await this.sendTextReply(context.chat_id, '未配置任何项目。请先执行 `codex-feishu bind <alias> <path>`。', context.message_id, context.text);
      return;
    }

    const command = parseBridgeCommand(context.text);
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
    const selectionKey = await this.getSelectionConversationKey(context);

    switch (command.kind) {
      case 'help':
        await this.sendTextReply(context.chat_id, buildHelpText(), context.message_id, context.text);
        return;
      case 'projects':
        await this.sendTextReply(context.chat_id, await this.buildProjectsText(selectionKey), context.message_id, context.text);
        return;
      case 'project':
        await this.handleProjectCommand(context, selectionKey, command.alias);
        return;
      case 'status':
        await this.handleStatusCommand(context, selectionKey);
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
      case 'memory':
        await this.handleMemoryCommand(context, selectionKey, command.action, command.scope, command.value, command.filters);
        return;
      case 'wiki':
        await this.handleWikiCommand(context, selectionKey, command.action, command.value, command.extra, command.target, command.role);
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
        await this.handleAdminCommand(context, command);
        return;
      case 'prompt': {
        const prompt = normalizeIncomingText(command.prompt) || (context.attachments.length > 0 ? '请结合这条飞书消息附带的多媒体信息继续处理。' : '');
        if (!prompt) {
          return;
        }
        const projectContext = await this.resolveProjectContext(context, selectionKey);
        const resolvedContext = await resolveMessageResources(this.feishuClient.createSdkClient?.(), this.config.storage.dir, context, {
          downloadEnabled: this.config.service.download_message_resources,
          transcribeAudio: this.config.service.transcribe_audio_messages,
          transcribeCliPath: this.config.service.transcribe_cli_path,
          describeImages: this.config.service.describe_image_messages,
          openaiImageModel: this.config.service.openai_image_model,
          logger: this.logger,
        });
        if (context.chat_type === 'group' && this.shouldRequireMention(projectContext.project) && context.mentions.length === 0) {
          return;
        }
        await this.sessionStore.selectProject(selectionKey, projectContext.projectAlias);

        const scheduled = await this.scheduleProjectExecution(
          projectContext,
          {
            chatId: context.chat_id,
            actorId: context.actor_id,
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
        if (scheduled.queued) {
          await this.sendRunLifecycleReply({
            chatId: context.chat_id,
            projectAlias: projectContext.projectAlias,
            title: '已加入排队',
            body: this.buildQueuedReplyText(projectContext.projectAlias, scheduled.queued),
            runStatus: 'queued',
            replyToMessageId: context.message_id,
            originalText: context.text,
          });
        } else {
          await this.sendRunLifecycleReply({
            chatId: context.chat_id,
            projectAlias: projectContext.projectAlias,
            title: 'Codex 处理中',
            body: `项目: ${projectContext.projectAlias}\n状态: running\n\n已收到消息，正在处理。`,
            runStatus: 'running',
            replyToMessageId: context.message_id,
            originalText: context.text,
          });
        }
        await scheduled.completion;
      }
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
      void scheduled.completion.catch((error) => {
        this.logger.error({ error, projectAlias }, 'Queued rerun execution failed unexpectedly');
      });
      return buildStatusCard({
        title: scheduled.queued ? '已加入排队' : '已提交重试',
        summary: scheduled.queued?.detail ?? '桥接器正在重新执行上一轮，结果会通过消息回传。',
        projectAlias,
        sessionId: conversation.projects[projectAlias]?.thread_id,
        runStatus: scheduled.queued ? 'queued' : undefined,
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
    const currentSession = conversation.projects[input.projectAlias];
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
    const bridgePrompt = await this.buildBridgePrompt(input.projectAlias, input.project, input.incomingMessage, input.prompt, memoryContext);
    const startedAt = Date.now();
    const projectRoot = this.resolveProjectRoot(input.project);
    const runId = input.runId ?? randomUUID();
    let lastProgressUpdate = 0;
    const activeRun: ActiveRunHandle = {
      runId,
      controller: new AbortController(),
    };
    this.activeRuns.set(input.queueKey, activeRun);

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

    this.metrics?.recordCodexTurnStarted(input.projectAlias, runId);

    try {
      const result = await runCodexTurn({
        bin: this.config.codex.bin,
        shell: this.config.codex.shell,
        preExec: this.config.codex.pre_exec,
        workdir: input.project.root,
        prompt: bridgePrompt,
        sessionId: currentSession?.thread_id,
        profile: input.project.profile ?? this.config.codex.default_profile,
        sandbox: input.project.sandbox ?? this.config.codex.default_sandbox,
        skipGitRepoCheck: this.config.codex.skip_git_repo_check,
        timeoutMs: this.config.codex.run_timeout_ms,
        signal: activeRun.controller.signal,
        logger: this.logger,
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
        onEvent: async (event) => {
          if (!this.config.service.emit_progress_updates) {
            return;
          }
          const message = summarizeCodexEvent(event);
          if (!message) {
            return;
          }
          const now = Date.now();
          if (now - lastProgressUpdate < this.config.service.progress_update_interval_ms) {
            return;
          }
          lastProgressUpdate = now;
          await this.sendTextReply(input.chatId, message, input.replyToMessageId, input.prompt);
        },
      });

      const excerpt = result.finalMessage.slice(0, this.config.codex.output_token_limit);
      const cardSummary = truncateForFeishuCard(excerpt || 'Codex 已完成，但没有返回可显示文本。');
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
      });
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
      });
      this.metrics?.recordCodexTurn('success', input.projectAlias, (Date.now() - startedAt) / 1000, runId);

      if (this.config.service.reply_mode === 'card' && this.config.feishu.transport === 'webhook') {
        await this.sendCardReply(
          input.chatId,
          buildStatusCard({
            title: 'Codex 已完成',
            summary: cardSummary,
            projectAlias: input.projectAlias,
            sessionId: result.sessionId,
            runStatus: 'success',
            sessionCount: (await this.sessionStore.listProjectSessions(input.sessionKey, input.projectAlias)).length,
            includeActions: true,
            rerunPayload: {
              action: 'rerun',
              conversation_key: input.sessionKey,
              project_alias: input.projectAlias,
              chat_id: input.chatId,
            },
            newSessionPayload: {
              action: 'new',
              conversation_key: input.sessionKey,
              project_alias: input.projectAlias,
              chat_id: input.chatId,
            },
            statusPayload: {
              action: 'status',
              conversation_key: input.sessionKey,
              project_alias: input.projectAlias,
              chat_id: input.chatId,
            },
          }),
          input.replyToMessageId,
        );
      } else {
        const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        await this.sendRunLifecycleReply({
          chatId: input.chatId,
          projectAlias: input.projectAlias,
          title: 'Codex 已完成',
          body: [`项目: ${input.projectAlias}`, `耗时: ${durationSeconds}s`, '', excerpt || 'Codex 已完成，但没有返回可显示文本。'].join('\n'),
          runStatus: 'success',
          replyToMessageId: input.replyToMessageId,
          originalText: input.prompt,
        });
      }
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
      this.logger.error({ error, project: input.projectAlias, runId }, 'Codex run failed');
      await this.sendRunLifecycleReply({
        chatId: input.chatId,
        projectAlias: input.projectAlias,
        title: cancelled ? '运行已取消' : '执行失败',
        body: cancelled ? [`项目: ${input.projectAlias}`, '当前运行已取消。'].join('\n') : [`项目: ${input.projectAlias}`, '执行失败。', '', message].join('\n'),
        runStatus: cancelled ? 'cancelled' : 'failure',
        replyToMessageId: input.replyToMessageId,
        originalText: input.prompt,
      });
    } finally {
      this.activeRuns.delete(input.queueKey);
    }
  }

  private async handleProjectCommand(context: IncomingMessageContext, selectionKey: string, alias?: string): Promise<void> {
    if (!alias) {
      const currentAlias = await this.resolveProjectAlias(selectionKey);
      const project = this.requireProject(currentAlias);
      await this.sendTextReply(context.chat_id, `当前项目: ${currentAlias}${project.description ? `\n说明: ${project.description}` : ''}`, context.message_id, context.text);
      return;
    }

    const project = this.requireProject(alias);
    await this.sessionStore.ensureConversation(selectionKey, {
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      tenant_key: context.tenant_key,
      scope: this.getSelectionScope(context),
    });
    await this.sessionStore.selectProject(selectionKey, alias);
    await this.auditLog.append({
      type: 'project.selected',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: alias,
    });
    const replyLines = [`已切换到项目: ${alias}${project.description ? `\n说明: ${project.description}` : ''}`];
    if (this.config.service.project_switch_auto_adopt_latest) {
      const projectContext = await this.resolveProjectContext(context, selectionKey);
      const adoption = await this.tryAutoAdoptLatestSessionForProject(projectContext);
      if (adoption.kind === 'existing') {
        replyLines.push(`已保留当前聊天下该项目的会话: ${adoption.threadId}`);
      } else if (adoption.kind === 'adopted') {
        replyLines.push(`已自动接管本地 Codex 会话: ${adoption.session.threadId}`);
        replyLines.push(`match: ${renderSessionMatch(adoption.session)}`);
        replyLines.push(`source cwd: ${adoption.session.cwd}`);
      } else {
        replyLines.push('未找到可自动接管的本地 Codex 会话。下一条消息会新开会话。');
      }
    }
    await this.sendTextReply(context.chat_id, replyLines.join('\n'), context.message_id, context.text);
  }

  private async tryAutoAdoptLatestSessionForProject(projectContext: {
    projectAlias: string;
    project: ProjectConfig;
    sessionKey: string;
    queueKey: string;
  }): Promise<
    | { kind: 'existing'; threadId: string }
    | { kind: 'adopted'; session: IndexedCodexSession }
    | { kind: 'missing' }
  > {
    const conversation = await this.sessionStore.getConversation(projectContext.sessionKey);
    const existingThreadId = conversation?.projects[projectContext.projectAlias]?.thread_id;
    if (existingThreadId) {
      return { kind: 'existing', threadId: existingThreadId };
    }

    const adopted = await this.codexSessionIndex.findLatestProjectSession(projectContext.project.root);
    if (!adopted) {
      return { kind: 'missing' };
    }

    await this.sessionStore.upsertProjectSession(projectContext.sessionKey, projectContext.projectAlias, {
      thread_id: adopted.threadId,
    });
    await this.auditLog.append({
      type: 'session.adopted',
      project_alias: projectContext.projectAlias,
      conversation_key: projectContext.sessionKey,
      thread_id: adopted.threadId,
      source_cwd: adopted.cwd,
      source: adopted.source,
      match_kind: adopted.matchKind,
      trigger: 'project-switch',
    });
    return { kind: 'adopted', session: adopted };
  }

  private async handleStatusCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
    const conversation = await this.sessionStore.getConversation(projectContext.sessionKey);
    if (!conversation) {
      await this.sendTextReply(context.chat_id, `项目 ${projectContext.projectAlias} 还没有会话。发送任意文本即可开始。`, context.message_id, context.text);
      return;
    }

    const activeRun = await this.runStateStore.getLatestVisibleRun(projectContext.queueKey);
    if (this.config.service.reply_mode === 'card' && this.config.feishu.transport === 'webhook') {
      await this.sendCardReply(
        context.chat_id,
        this.buildStatusCardFromConversation(projectContext.projectAlias, projectContext.sessionKey, conversation, activeRun),
        context.message_id,
      );
      return;
    }

    await this.sendTextReply(context.chat_id, await this.buildStatusText(projectContext.projectAlias, conversation, activeRun), context.message_id, context.text);
  }

  private async handleNewCommand(context: IncomingMessageContext, selectionKey: string): Promise<void> {
    const projectContext = await this.resolveProjectContext(context, selectionKey);
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
        if (sessions.length === 0) {
          await this.sendTextReply(context.chat_id, `项目 ${projectContext.projectAlias} 还没有保存的会话。`, context.message_id, context.text);
          return;
        }
        const lines = sessions.map((session, index) => {
          const prefix = session.thread_id === activeSessionId ? '*' : `${index + 1}.`;
          return `${prefix} ${session.thread_id} (${session.updated_at})${session.last_response_excerpt ? `\n   ${truncateExcerpt(session.last_response_excerpt, 80)}` : ''}`;
        });
        await this.sendTextReply(
          context.chat_id,
          [`项目: ${projectContext.projectAlias}`, `当前会话: ${activeSessionId ?? '未选择'}`, '', ...lines].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }
      case 'use': {
        if (!threadId) {
          await this.sendTextReply(context.chat_id, '用法: /session use <thread_id>', context.message_id, context.text);
          return;
        }
        await this.sessionStore.setActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias, threadId);
        await this.sendTextReply(context.chat_id, `已切换到会话: ${threadId}`, context.message_id, context.text);
        return;
      }
      case 'new': {
        await this.sessionStore.clearActiveProjectSession(projectContext.sessionKey, projectContext.projectAlias);
        await this.sendTextReply(context.chat_id, '已切换为新会话模式。下一条消息会新开会话。', context.message_id, context.text);
        return;
      }
      case 'drop': {
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
        await this.handleSessionAdoptCommand(context, projectContext, threadId);
        return;
      }
    }
  }

  private async handleAdminCommand(
    context: IncomingMessageContext,
    command:
      | { kind: 'admin'; resource: 'admin' | 'group' | 'chat'; action: 'status' | 'list' | 'add' | 'remove'; value?: string }
      | { kind: 'admin'; resource: 'project'; action: 'add' | 'remove' | 'set' | 'list'; alias?: string; field?: string; value?: string }
      | { kind: 'admin'; resource: 'service'; action: 'status' | 'restart' },
  ): Promise<void> {
    if (!this.isAdminChat(context.chat_id)) {
      await this.sendTextReply(context.chat_id, '当前 chat_id 没有管理员权限。请先在配置里加入 `security.admin_chat_ids`。', context.message_id, context.text);
      return;
    }

    if (!this.runtimeControl?.configPath) {
      await this.sendTextReply(context.chat_id, '当前运行实例没有可写配置路径，无法执行管理员动态操作。', context.message_id, context.text);
      return;
    }

    if (command.resource === 'service') {
      if (command.action === 'restart') {
        await this.sendTextReply(context.chat_id, '配置已保存，正在重启服务。预计数秒内恢复。', context.message_id, context.text);
        this.logger.warn({ chatId: context.chat_id, actorId: context.actor_id }, 'Restart requested by Feishu admin');
        await this.runtimeControl.restart?.();
        return;
      }
      await this.sendTextReply(context.chat_id, this.buildAdminStatusText(), context.message_id, context.text);
      return;
    }

    if (command.resource === 'project') {
      if (command.action === 'list') {
        await this.sendTextReply(context.chat_id, this.buildProjectsAdminText(), context.message_id, context.text);
        return;
      }
      if (command.action === 'add') {
        if (!command.alias || !command.value) {
          await this.sendTextReply(context.chat_id, '用法: /admin project add <alias> <root>', context.message_id, context.text);
          return;
        }
        await bindProjectAlias({ configPath: this.runtimeControl.configPath, alias: command.alias, root: command.value });
        this.config.projects[command.alias] = {
          root: path.resolve(command.value),
          session_scope: 'chat',
          mention_required: true,
          knowledge_paths: [],
          wiki_space_ids: [],
        };
        await this.sendTextReply(context.chat_id, `已接入项目: ${command.alias}\n根目录: ${path.resolve(command.value)}`, context.message_id, context.text);
        this.logger.info({ alias: command.alias, root: path.resolve(command.value), actorId: context.actor_id }, 'Project added by Feishu admin');
        return;
      }
      if (command.action === 'remove') {
        if (!command.alias) {
          await this.sendTextReply(context.chat_id, '用法: /admin project remove <alias>', context.message_id, context.text);
          return;
        }
        if (this.config.service.default_project === command.alias) {
          await this.sendTextReply(context.chat_id, `不能移除默认项目: ${command.alias}。请先切换 service.default_project。`, context.message_id, context.text);
          return;
        }
        await removeProjectAlias(this.runtimeControl.configPath, command.alias);
        delete this.config.projects[command.alias];
        await this.sendTextReply(context.chat_id, `已移除项目: ${command.alias}`, context.message_id, context.text);
        this.logger.info({ alias: command.alias, actorId: context.actor_id }, 'Project removed by Feishu admin');
        return;
      }
      if (!command.alias || !command.field || !command.value) {
        await this.sendTextReply(context.chat_id, '用法: /admin project set <alias> <field> <value>', context.message_id, context.text);
        return;
      }
      const patch = this.parseProjectPatch(command.field, command.value);
      if (!patch) {
        await this.sendTextReply(context.chat_id, '支持字段: root, profile, sandbox, session_scope, mention_required, description', context.message_id, context.text);
        return;
      }
      const nextProject = await updateProjectConfig(this.runtimeControl.configPath, command.alias, patch);
      this.config.projects[command.alias] = {
        ...this.requireProject(command.alias),
        ...nextProject,
      };
      await this.sendTextReply(context.chat_id, `已更新项目 ${command.alias}\n字段: ${command.field}\n值: ${command.value}`, context.message_id, context.text);
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
    const { section, key } = resolveAdminListTarget(command.resource);
    const nextValues = await updateStringList(this.runtimeControl.configPath, section, key, command.value, command.action);
    this.applyAdminListValues(command.resource, nextValues);
    await this.sendTextReply(context.chat_id, `已${command.action === 'add' ? '添加' : '移除'} ${command.resource}:\n${command.value}`, context.message_id, context.text);
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
    const normalizedTarget = target?.trim();
    if (normalizedTarget === 'list') {
      const candidates = await this.codexSessionIndex.listProjectSessions(projectContext.project.root, 10);
      if (candidates.length === 0) {
        await this.sendTextReply(
          context.chat_id,
          [
            `项目: ${projectContext.projectAlias}`,
            `项目根: ${projectContext.project.root}`,
            '未找到可接管的本地 Codex 会话。',
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }

      const lines = candidates.map((session, index) =>
        [
          `${index + 1}. ${session.threadId}`,
          `   updated_at: ${session.updatedAt}`,
          `   cwd: ${session.cwd}`,
          `   match: ${renderSessionMatch(session)}`,
          `   source: ${session.source}`,
        ].join('\n'),
      );
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `项目根: ${projectContext.project.root}`,
          '可接管的本地 Codex 会话:',
          '',
          ...lines,
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    const adopted = !normalizedTarget || normalizedTarget === 'latest'
      ? await this.codexSessionIndex.findLatestProjectSession(projectContext.project.root)
      : await this.codexSessionIndex.findProjectSessionById(projectContext.project.root, normalizedTarget);
    if (!adopted) {
      await this.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          normalizedTarget ? `未找到可接管的本地 Codex 会话: ${normalizedTarget}` : '未找到可接管的本地 Codex 会话。',
          '用法: /session adopt latest | /session adopt list | /session adopt <thread_id>',
        ].join('\n'),
        context.message_id,
        context.text,
      );
      return;
    }

    await this.sessionStore.upsertProjectSession(projectContext.sessionKey, projectContext.projectAlias, {
      thread_id: adopted.threadId,
    });
    await this.auditLog.append({
      type: 'session.adopted',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      conversation_key: projectContext.sessionKey,
      thread_id: adopted.threadId,
      source_cwd: adopted.cwd,
      source: adopted.source,
      match_kind: adopted.matchKind,
    });
    await this.sendTextReply(
      context.chat_id,
      [
        `项目: ${projectContext.projectAlias}`,
        `已接管本地 Codex 会话: ${adopted.threadId}`,
        `match: ${renderSessionMatch(adopted)}`,
        `source cwd: ${adopted.cwd}`,
        `updated_at: ${adopted.updatedAt}`,
        '下一条消息会直接续接这个会话。',
      ].join('\n'),
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

  private async buildProjectsText(selectionKey: string): Promise<string> {
    const selected = await this.resolveProjectAlias(selectionKey);
    const lines = Object.entries(this.config.projects).map(([alias, project]) => {
      const marker = alias === selected ? '*' : '-';
      const description = project.description ? ` | ${project.description}` : '';
      return `${marker} ${alias}: ${project.root}${description}`;
    });
    return ['可用项目:', ...lines].join('\n');
  }

  private async buildStatusText(projectAlias: string, conversation: ConversationState, activeRun?: RunState | null): Promise<string> {
    const session = conversation.projects[projectAlias];
    const sessions = await this.sessionStore.listProjectSessions(buildConversationKeyForConversation(conversation), projectAlias);
    const memoryCount = this.config.service.memory_enabled ? await this.memoryStore.countProjectMemories(projectAlias) : 0;
    const threadSummary =
      this.config.service.memory_enabled && session?.thread_id
        ? await this.memoryStore.getThreadSummary(buildConversationKeyForConversation(conversation), projectAlias, session.thread_id)
        : null;
    return [
      `项目: ${projectAlias}`,
      `当前会话: ${session?.thread_id ?? '未开始'}`,
      `已保存会话数: ${sessions.length}`,
      `项目记忆数: ${memoryCount}`,
      `最近更新时间: ${session?.updated_at ?? conversation.updated_at}`,
      `当前运行状态: ${activeRun?.status ?? '无'}`,
      ...(activeRun?.status === 'queued' && activeRun.status_detail ? ['', activeRun.status_detail] : []),
      '',
      threadSummary?.summary ?? session?.last_response_excerpt ?? '暂无回复摘要。',
    ].join('\n');
  }

  private buildStatusCardFromConversation(projectAlias: string, sessionKey: string, conversation: ConversationState, activeRun?: RunState | null): Record<string, unknown> {
    const session = conversation.projects[projectAlias];
    const sessionCount = Object.keys(session?.sessions ?? {}).length;
    const isExecutableRun = activeRun ? isExecutionRunStatus(activeRun.status) : false;
    return buildStatusCard({
      title: '当前会话状态',
      summary: this.buildRunStatusSummary(session?.last_response_excerpt, activeRun),
      projectAlias,
      sessionId: session?.thread_id,
      runStatus: activeRun?.status,
      sessionCount,
      includeActions: true,
      rerunPayload: session?.last_prompt && !activeRun
        ? {
            action: 'rerun',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: conversation.chat_id,
          }
        : undefined,
      newSessionPayload: {
        action: 'new',
        conversation_key: sessionKey,
        project_alias: projectAlias,
        chat_id: conversation.chat_id,
      },
      cancelPayload: isExecutableRun
        ? {
            action: 'cancel',
            conversation_key: sessionKey,
            project_alias: projectAlias,
            chat_id: conversation.chat_id,
          }
        : undefined,
      statusPayload: {
        action: 'status',
        conversation_key: sessionKey,
        project_alias: projectAlias,
        chat_id: conversation.chat_id,
      },
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
      'You are replying through a Feishu bridge connected to Codex CLI.',
      'Keep the final response concise and action-oriented.',
      'When files change, summarize key paths and verification.',
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
      prompt: string;
    },
    task: (runId?: string) => Promise<void>,
  ): Promise<ScheduledProjectExecution> {
    const queued = await this.prepareQueuedExecution(projectContext, metadata);
    const rootKey = buildProjectRootQueueKey(projectContext.project.root);
    return {
      queued,
      completion: this.queue.run(projectContext.queueKey, async () => {
        await this.projectRootQueue.run(rootKey, async () => {
          await task(queued?.runId);
        });
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
      prompt: string;
    },
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
    const runId = randomUUID();

    await this.runStateStore.upsertRun(runId, {
      queue_key: projectContext.queueKey,
      conversation_key: projectContext.sessionKey,
      project_alias: projectContext.projectAlias,
      chat_id: metadata.chatId,
      actor_id: metadata.actorId,
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

    return {
      runId,
      detail,
      reason,
    };
  }

  private buildQueuedReplyText(projectAlias: string, queued: QueuedExecutionNotice): string {
    return [`项目: ${projectAlias}`, '状态: queued', '', queued.detail].join('\n');
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
      blockingRun ? `阻塞状态: ${blockingRun.status}` : null,
      reason === 'project-root' && blockingRun?.project_alias && blockingRun.project_alias !== projectAlias ? `占用项目: ${blockingRun.project_alias}` : null,
    ];
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

  private buildAdminStatusText(): string {
    return [
      '管理员配置',
      '',
      `管理员 chat_id 数: ${this.config.security.admin_chat_ids.length}`,
      `允许私聊数: ${this.config.feishu.allowed_chat_ids.length}`,
      `允许群聊数: ${this.config.feishu.allowed_group_ids.length}`,
      `项目数: ${Object.keys(this.config.projects).length}`,
      `默认项目: ${this.config.service.default_project ?? '未设置'}`,
      `回复模式: ${this.config.service.reply_mode}`,
      `可写配置: ${this.runtimeControl?.configPath ?? '无'}`,
    ].join('\n');
  }

  private buildAdminListText(resource: 'admin' | 'group' | 'chat'): string {
    const items =
      resource === 'admin'
        ? this.config.security.admin_chat_ids
        : resource === 'group'
          ? this.config.feishu.allowed_group_ids
          : this.config.feishu.allowed_chat_ids;
    return [`当前${resource}列表:`, ...(items.length > 0 ? items : ['(empty)'])].join('\n');
  }

  private buildProjectsAdminText(): string {
    const lines = Object.entries(this.config.projects).map(([alias, project]) => {
      const flags = [`scope=${project.session_scope}`, `mention=${project.mention_required ? 'on' : 'off'}`].join(' ');
      return `- ${alias}: ${project.root} | ${flags}`;
    });
    return ['当前项目列表:', ...(lines.length > 0 ? lines : ['(empty)'])].join('\n');
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
      default:
        return null;
    }
  }

  private applyAdminListValues(resource: 'admin' | 'group' | 'chat', values: string[]): void {
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

  private async enforceSessionHistoryLimit(conversationKey: string, projectAlias: string): Promise<void> {
    const sessions = await this.sessionStore.listProjectSessions(conversationKey, projectAlias);
    const overflow = sessions.slice(this.config.service.session_history_limit);
    for (const session of overflow) {
      await this.sessionStore.dropProjectSession(conversationKey, projectAlias, session.thread_id);
    }
  }

  private async sendTextReply(chatId: string, body: string, replyToMessageId?: string, originalText?: string): Promise<void> {
    if (this.config.service.reply_mode === 'post') {
      const post = buildFeishuPost(this.buildReplyTitle(body), this.formatQuotedReply(body, originalText));
      if (this.config.service.reply_quote_user_message && replyToMessageId) {
        await this.feishuClient.sendPost(chatId, post, { replyToMessageId });
        return;
      }
      await this.feishuClient.sendPost(chatId, post);
      return;
    }
    if (this.config.service.reply_quote_user_message && replyToMessageId) {
      await this.feishuClient.sendText(chatId, body, { replyToMessageId });
      return;
    }
    await this.feishuClient.sendText(chatId, this.formatQuotedReply(body, originalText));
  }

  private async sendCardReply(chatId: string, card: Record<string, unknown>, replyToMessageId?: string): Promise<void> {
    if (this.config.service.reply_quote_user_message && replyToMessageId) {
      await this.feishuClient.sendCard(chatId, card, { replyToMessageId });
      return;
    }
    await this.feishuClient.sendCard(chatId, card);
  }

  private async sendRunLifecycleReply(input: {
    chatId: string;
    projectAlias: string;
    title: string;
    body: string;
    runStatus: string;
    replyToMessageId?: string;
    originalText?: string;
  }): Promise<void> {
    if (this.config.service.reply_mode === 'card' && this.config.feishu.transport === 'webhook') {
      await this.sendCardReply(
        input.chatId,
        buildStatusCard({
          title: input.title,
          summary: truncateForFeishuCard(input.body),
          projectAlias: input.projectAlias,
          runStatus: input.runStatus,
          includeActions: false,
        }),
        input.replyToMessageId,
      );
      return;
    }
    await this.sendTextReply(input.chatId, input.body, input.replyToMessageId, input.originalText);
  }

  private formatQuotedReply(body: string, originalText?: string): string {
    if (!this.config.service.reply_quote_user_message || !originalText?.trim()) {
      return body;
    }

    const normalized = originalText.replace(/\s+/g, ' ').trim();
    const quoted = truncateExcerpt(normalized, this.config.service.reply_quote_max_chars);
    return [`引用: ${quoted}`, '', body].join('\n');
  }

  private buildReplyTitle(body: string): string {
    const firstLine = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return truncateExcerpt(firstLine ?? 'Codex Feishu', 40);
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

function buildMessageDedupeKey(context: IncomingMessageContext): string {
  return ['message', context.tenant_key ?? 'tenant', context.chat_id, context.message_id].join('::');
}

function buildCardDedupeKey(context: IncomingCardActionContext, action: string): string | null {
  if (!context.open_message_id) {
    return null;
  }
  return ['card', context.tenant_key ?? 'tenant', context.chat_id ?? 'chat', context.actor_id ?? 'actor', context.open_message_id, action].join('::');
}

function truncateExcerpt(text: string, limit: number = 160): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function resolveAdminListTarget(resource: 'admin' | 'group' | 'chat'): { section: 'security' | 'feishu'; key: string } {
  switch (resource) {
    case 'admin':
      return { section: 'security', key: 'admin_chat_ids' };
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

function renderSessionMatch(session: Pick<IndexedCodexSession, 'matchKind' | 'matchScore'>): string {
  const label = renderSessionMatchLabel(session);
  return session.matchScore ? `${label} (${session.matchScore})` : label;
}
