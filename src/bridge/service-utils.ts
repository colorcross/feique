import path from 'node:path';
import type { BridgeConfig } from '../config/schema.js';
import type { IncomingCardActionContext, IncomingMessageContext } from './types.js';
import { buildConversationKey, type ConversationState } from '../state/session-store.js';
import type { RunState } from '../state/run-state-store.js';

// ---------------------------------------------------------------------------
// Queue keys
// ---------------------------------------------------------------------------

export function buildQueueKey(conversationKey: string, projectAlias: string): string {
  return `${conversationKey}::project::${projectAlias}`;
}

export function buildProjectRootQueueKey(projectRoot: string): string {
  return `root::${path.resolve(projectRoot)}`;
}

// ---------------------------------------------------------------------------
// Run status helpers
// ---------------------------------------------------------------------------

export function isExecutionRunStatus(status: RunState['status']): boolean {
  return status === 'running' || status === 'orphaned';
}

export function isVisibleRunStatus(status: RunState['status']): boolean {
  return status === 'queued' || isExecutionRunStatus(status);
}

export function mapRunStatusToPhase(status: RunState['status']): string {
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

// ---------------------------------------------------------------------------
// Idempotency dedupe keys
// ---------------------------------------------------------------------------

export function buildMessageDedupeKey(context: IncomingMessageContext): string {
  return ['message', context.tenant_key ?? 'tenant', context.chat_id, context.message_id].join('::');
}

export function buildCardDedupeKey(context: IncomingCardActionContext, action: string): string | null {
  if (!context.open_message_id) {
    return null;
  }
  return ['card', context.tenant_key ?? 'tenant', context.chat_id ?? 'chat', context.actor_id ?? 'actor', context.open_message_id, action].join('::');
}

// ---------------------------------------------------------------------------
// File send markers in AI response text
// ---------------------------------------------------------------------------

/**
 * Extract [SEND_FILE:/path/to/file] markers from AI response text.
 * Returns cleaned text (markers removed) and list of file paths.
 */
export function extractFileMarkers(text: string): { cleanText: string; filePaths: string[] } {
  const FILE_MARKER_RE = /\[SEND_FILE:([^\]]+)\]/g;
  const filePaths: string[] = [];

  for (const match of text.matchAll(FILE_MARKER_RE)) {
    const filePath = match[1]?.trim();
    if (filePath) {
      filePaths.push(filePath);
    }
  }

  const cleanText = text.replace(FILE_MARKER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, filePaths };
}

// ---------------------------------------------------------------------------
// Config diff for hot reload notifications
// ---------------------------------------------------------------------------

/**
 * Shallow diff two BridgeConfig objects, returning human-readable change descriptions.
 */
export function diffConfigs(oldConfig: BridgeConfig, newConfig: BridgeConfig): string[] {
  const changes: string[] = [];

  // Projects added/removed
  const oldProjects = new Set(Object.keys(oldConfig.projects));
  const newProjects = new Set(Object.keys(newConfig.projects));
  for (const p of newProjects) {
    if (!oldProjects.has(p)) changes.push(`项目新增: ${p}`);
  }
  for (const p of oldProjects) {
    if (!newProjects.has(p)) changes.push(`项目移除: ${p}`);
  }

  // Project-level changes
  for (const alias of newProjects) {
    if (!oldProjects.has(alias)) continue;
    const oldP = oldConfig.projects[alias];
    const newP = newConfig.projects[alias];
    if (!oldP || !newP) continue;

    const fields: Array<keyof typeof newP> = ['root', 'backend', 'persona', 'codex_model', 'claude_model', 'mention_required', 'description', 'session_scope'];
    for (const f of fields) {
      const ov = String(oldP[f] ?? '');
      const nv = String(newP[f] ?? '');
      if (ov !== nv) changes.push(`${alias}.${f}: ${ov || '(空)'} → ${nv || '(空)'}`);
    }

    // Array fields
    const arrayFields: Array<keyof typeof newP> = ['skills', 'admin_chat_ids', 'operator_chat_ids', 'notification_chat_ids'];
    for (const f of arrayFields) {
      const ov = JSON.stringify(oldP[f] ?? []);
      const nv = JSON.stringify(newP[f] ?? []);
      if (ov !== nv) changes.push(`${alias}.${f} 变更`);
    }
  }

  // Service-level changes
  const serviceFields = ['default_project', 'reply_mode', 'persona', 'team_digest_enabled', 'intent_classifier_enabled'] as const;
  for (const f of serviceFields) {
    const ov = String((oldConfig.service as Record<string, unknown>)[f] ?? '');
    const nv = String((newConfig.service as Record<string, unknown>)[f] ?? '');
    if (ov !== nv) changes.push(`service.${f}: ${ov || '(空)'} → ${nv || '(空)'}`);
  }

  // Backend default
  if (oldConfig.backend?.default !== newConfig.backend?.default) {
    changes.push(`backend.default: ${oldConfig.backend?.default ?? 'codex'} → ${newConfig.backend?.default ?? 'codex'}`);
  }

  // Security admin changes
  if (JSON.stringify(oldConfig.security.admin_chat_ids) !== JSON.stringify(newConfig.security.admin_chat_ids)) {
    changes.push('security.admin_chat_ids 变更');
  }

  // Embedding provider
  if (oldConfig.embedding.provider !== newConfig.embedding.provider) {
    changes.push(`embedding.provider: ${oldConfig.embedding.provider} → ${newConfig.embedding.provider}`);
  }
  if (oldConfig.embedding.ollama_model !== newConfig.embedding.ollama_model) {
    changes.push(`embedding.ollama_model: ${oldConfig.embedding.ollama_model} → ${newConfig.embedding.ollama_model}`);
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function truncateExcerpt(text: string, limit: number = 160): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

/** Map raw error strings to user-friendly Chinese messages. */
export function friendlyErrorMessage(error: string): string {
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

export function splitCommaSeparatedValues(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Admin list resolution
// ---------------------------------------------------------------------------

export function resolveAdminListTarget(resource: 'viewer' | 'operator' | 'admin' | 'service-observer' | 'service-restart' | 'config-admin' | 'group' | 'chat'): { section: 'security' | 'feishu'; key: string } {
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

// ---------------------------------------------------------------------------
// Conversation key
// ---------------------------------------------------------------------------

export function buildConversationKeyForConversation(conversation: ConversationState): string {
  return buildConversationKey({
    tenantKey: conversation.tenant_key,
    chatId: conversation.chat_id,
    actorId: conversation.actor_id,
    scope: conversation.scope,
  });
}

// ---------------------------------------------------------------------------
// Memory section rendering (used in prompt assembly)
// ---------------------------------------------------------------------------

export function renderMemorySection(title: string, items: Array<{ title: string; content: string; pinned?: boolean }>, budget: number): string[] {
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

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

export function formatAgeFromNow(isoTimestamp: string): string {
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

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export function parseJsonObject(input: string): Record<string, unknown> {
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

export function clampListLimit(input: string | undefined, fallback: number, max: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.trunc(parsed), max);
}

// ---------------------------------------------------------------------------
// In-place object replacement (used by hot config reload)
// ---------------------------------------------------------------------------

export function replaceObject(target: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) {
      delete target[key];
    }
  }
  for (const [key, value] of Object.entries(next)) {
    target[key] = value;
  }
}

export function replaceProjects(target: BridgeConfig['projects'], next: BridgeConfig['projects']): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) {
      delete target[key];
    }
  }
  for (const [alias, project] of Object.entries(next)) {
    target[alias] = project;
  }
}

// ---------------------------------------------------------------------------
// Deferred promise primitive
// ---------------------------------------------------------------------------

export function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
