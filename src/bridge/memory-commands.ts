import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { IncomingMessageContext } from './types.js';
import type { FeishuClient } from '../feishu/client.js';
import type { AuditLog } from '../state/audit-log.js';
import type { SessionStore } from '../state/session-store.js';
import type { MemoryStore } from '../state/memory-store.js';
import type { MemoryCommandFilters, MemoryScopeTarget } from './commands.js';
import { truncateExcerpt } from './service-utils.js';

/**
 * Subset of FeiqueService that the /memory command handler needs. Same
 * pattern as feishu-commands.ts: a structural interface keeps the new
 * module honest about its dependencies and unit-testable in isolation.
 */
export interface MemoryCommandHost {
  readonly config: BridgeConfig;
  readonly feishuClient: FeishuClient;
  readonly auditLog: AuditLog;
  readonly sessionStore: SessionStore;
  readonly memoryStore: MemoryStore;
  sendTextReply(
    chatId: string,
    body: string,
    replyToMessageId?: string,
    originalText?: string,
  ): Promise<unknown>;
}

export interface MemoryProjectContext {
  projectAlias: string;
  project: ProjectConfig;
  sessionKey: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (formerly private methods on FeiqueService)
// ---------------------------------------------------------------------------

function renderMemoryFilterLines(filters?: MemoryCommandFilters): string[] {
  return [
    ...(filters?.tag ? [`tag: ${filters.tag}`] : []),
    ...(filters?.source ? [`source: ${filters.source}`] : []),
    ...(filters?.created_by ? [`created_by: ${filters.created_by}`] : []),
  ];
}

function resolveMemoryTarget(
  config: BridgeConfig,
  context: Pick<IncomingMessageContext, 'chat_id' | 'chat_type'>,
  requestedScope?: MemoryScopeTarget,
): { scope: 'project' | 'group'; chatId?: string; label: string } {
  if (requestedScope === 'group') {
    if (!config.service.memory_group_enabled) {
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

function buildMemoryExpiresAt(config: BridgeConfig): string | undefined {
  const ttlDays = config.service.memory_default_ttl_days;
  if (!ttlDays) {
    return undefined;
  }
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// /memory — full command body
// ---------------------------------------------------------------------------

export async function handleMemoryCommand(
  host: MemoryCommandHost,
  context: IncomingMessageContext,
  projectContext: MemoryProjectContext,
  action: 'status' | 'stats' | 'search' | 'recent' | 'save' | 'pin' | 'unpin' | 'forget' | 'restore',
  scope: MemoryScopeTarget | undefined,
  value?: string,
  filters?: MemoryCommandFilters,
): Promise<void> {
  if (!host.config.service.memory_enabled) {
    await host.sendTextReply(context.chat_id, '当前未启用记忆功能。请在配置里设置 `service.memory_enabled = true`。', context.message_id, context.text);
    return;
  }

  try {
    const explicitExpiredCleanup = action === 'forget' && value?.trim() === 'all-expired';
    if (!explicitExpiredCleanup) {
      await host.memoryStore.cleanupExpiredMemories();
    }
    const conversation = await host.sessionStore.getConversation(projectContext.sessionKey);
    const activeThreadId = conversation?.projects[projectContext.projectAlias]?.thread_id;
    const groupMemoryAvailable = host.config.service.memory_group_enabled && context.chat_type === 'group';

    if (action === 'status') {
      if (scope === 'group') {
        const target = resolveMemoryTarget(host.config, context, 'group');
        const [count, pinnedCount] = await Promise.all([
          host.memoryStore.countGroupMemories(projectContext.projectAlias, target.chatId!),
          host.memoryStore.countPinnedGroupMemories(projectContext.projectAlias, target.chatId!),
        ]);
        await host.sendTextReply(
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
        host.memoryStore.countProjectMemories(projectContext.projectAlias),
        host.memoryStore.countPinnedProjectMemories(projectContext.projectAlias),
        activeThreadId ? host.memoryStore.getThreadSummary(projectContext.sessionKey, projectContext.projectAlias, activeThreadId) : Promise.resolve(null),
        groupMemoryAvailable ? host.memoryStore.countGroupMemories(projectContext.projectAlias, context.chat_id) : Promise.resolve(0),
        groupMemoryAvailable ? host.memoryStore.countPinnedGroupMemories(projectContext.projectAlias, context.chat_id) : Promise.resolve(0),
      ]);
      await host.sendTextReply(
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
      const target = resolveMemoryTarget(host.config, context, scope);
      const stats = await host.memoryStore.getMemoryStats({
        scope: target.scope,
        project_alias: projectContext.projectAlias,
        chat_id: target.chatId,
      });
      await host.sendTextReply(
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
      const target = resolveMemoryTarget(host.config, context, scope);
      const recent = await host.memoryStore.listRecentMemories(
        { scope: target.scope, project_alias: projectContext.projectAlias, chat_id: target.chatId },
        host.config.service.memory_recent_limit,
        filters,
      );
      if (recent.length === 0) {
        await host.sendTextReply(
          context.chat_id,
          [
            `项目: ${projectContext.projectAlias}`,
            `当前没有可展示的${target.label}。`,
            ...renderMemoryFilterLines(filters),
          ].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }
      await host.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `最近${target.label}:`,
          ...renderMemoryFilterLines(filters),
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
        await host.sendTextReply(context.chat_id, '用法: /memory search [--tag <tag>] [--source <source>] [--created-by <actor_id>] <query>', context.message_id, context.text);
        return;
      }
      const target = resolveMemoryTarget(host.config, context, scope);
      const hits = await host.memoryStore.searchMemories(
        { scope: target.scope, project_alias: projectContext.projectAlias, chat_id: target.chatId },
        value,
        host.config.service.memory_search_limit,
        filters,
      );
      await host.auditLog.append({
        type: 'memory.search',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        scope: target.scope,
        query: value,
        result_count: hits.length,
      });
      if (hits.length === 0) {
        await host.sendTextReply(
          context.chat_id,
          [`项目: ${projectContext.projectAlias}`, `${target.label}搜索: ${value}`, ...renderMemoryFilterLines(filters), '未找到匹配记忆。'].join('\n'),
          context.message_id,
          context.text,
        );
        return;
      }
      await host.sendTextReply(
        context.chat_id,
        [
          `项目: ${projectContext.projectAlias}`,
          `${target.label}搜索: ${value}`,
          ...renderMemoryFilterLines(filters),
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
        await host.sendTextReply(context.chat_id, usage, context.message_id, context.text);
        return;
      }

      const target = resolveMemoryTarget(host.config, context, scope);
      const selector = { scope: target.scope, project_alias: projectContext.projectAlias, chat_id: target.chatId };
      if (action === 'forget' && value === 'all-expired') {
        const cleaned = await host.memoryStore.cleanupExpiredMemories(selector);
        await host.auditLog.append({
          type: 'memory.archive.expired',
          chat_id: context.chat_id,
          actor_id: context.actor_id,
          project_alias: projectContext.projectAlias,
          scope: target.scope,
          count: cleaned,
        });
        await host.sendTextReply(
          context.chat_id,
          `${target.label}已归档过期项: ${cleaned}`,
          context.message_id,
          context.text,
        );
        return;
      }
      const existing = await host.memoryStore.getMemoryById(selector, value, { includeArchived: action === 'restore', includeExpired: action === 'restore' });
      if (!existing) {
        await host.sendTextReply(context.chat_id, `未找到可更新的${target.label} ID: ${value}`, context.message_id, context.text);
        return;
      }
      if (action === 'forget') {
        const archived = await host.memoryStore.archiveMemory(selector, value, { archived_by: context.actor_id, reason: 'manual' });
        if (archived) {
          await host.auditLog.append({
            type: 'memory.archive',
            chat_id: context.chat_id,
            actor_id: context.actor_id,
            project_alias: projectContext.projectAlias,
            scope: target.scope,
            memory_id: value,
          });
        }
        await host.sendTextReply(
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
        const restored = await host.memoryStore.restoreMemory(selector, value, context.actor_id);
        if (restored) {
          await host.auditLog.append({
            type: 'memory.restore',
            chat_id: context.chat_id,
            actor_id: context.actor_id,
            project_alias: projectContext.projectAlias,
            scope: target.scope,
            memory_id: value,
          });
        }
        await host.sendTextReply(
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
        const pinnedCount = await host.memoryStore.countPinnedMemories(selector);
        if (pinnedCount >= host.config.service.memory_max_pinned_per_scope) {
          if (host.config.service.memory_pin_overflow_strategy === 'age-out') {
            const oldest = await host.memoryStore.getOldestPinnedMemory(selector, host.config.service.memory_pin_age_basis);
            if (oldest && oldest.id !== existing.id) {
              await host.memoryStore.setMemoryPinned(selector, oldest.id, false);
              agedOutMemoryTitle = oldest.title;
              agedOutMemoryId = oldest.id;
              await host.auditLog.append({
                type: 'memory.pin.aged_out',
                chat_id: context.chat_id,
                actor_id: context.actor_id,
                project_alias: projectContext.projectAlias,
                scope: target.scope,
                memory_id: oldest.id,
                replaced_by: existing.id,
              });
            } else {
              await host.sendTextReply(
                context.chat_id,
                `${target.label}置顶数量已达上限 (${host.config.service.memory_max_pinned_per_scope})。请先取消置顶旧记录。`,
                context.message_id,
                context.text,
              );
              return;
            }
          } else {
            await host.sendTextReply(
              context.chat_id,
              `${target.label}置顶数量已达上限 (${host.config.service.memory_max_pinned_per_scope})。请先取消置顶旧记录。`,
              context.message_id,
              context.text,
            );
            return;
          }
        }
      }
      const updated = await host.memoryStore.setMemoryPinned(selector, value, pinned);
      if (!updated) {
        await host.sendTextReply(context.chat_id, `未找到可更新的${target.label} ID: ${value}`, context.message_id, context.text);
        return;
      }
      await host.auditLog.append({
        type: pinned ? 'memory.pin' : 'memory.unpin',
        chat_id: context.chat_id,
        actor_id: context.actor_id,
        project_alias: projectContext.projectAlias,
        scope: target.scope,
        memory_id: value,
      });
      await host.sendTextReply(
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

    // Default: action === 'save'
    const content = value?.trim();
    if (!content) {
      await host.sendTextReply(context.chat_id, '用法: /memory save <text> 或 /memory save group <text>', context.message_id, context.text);
      return;
    }
    const target = resolveMemoryTarget(host.config, context, scope);
    const title = truncateExcerpt(content.replace(/\s+/g, ' ').trim(), 60);
    const expiresAt = buildMemoryExpiresAt(host.config);
    const saved = await host.memoryStore.saveMemory({
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
    await host.auditLog.append({
      type: 'memory.save',
      chat_id: context.chat_id,
      actor_id: context.actor_id,
      project_alias: projectContext.projectAlias,
      scope: target.scope,
      memory_id: saved.id,
      title: saved.title,
    });
    await host.sendTextReply(
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
    await host.sendTextReply(context.chat_id, message, context.message_id, context.text);
  }
}
