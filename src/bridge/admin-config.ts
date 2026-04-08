import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { IncomingMessageContext } from './types.js';
import type { ConfigHistoryStore } from '../state/config-history-store.js';
import { writeUtf8Atomic } from '../utils/fs.js';
import { canAccessGlobalCapability } from '../security/access.js';
import { splitCommaSeparatedValues } from './service-utils.js';

/**
 * Minimal runtime control surface that the admin-config handler needs.
 * Matches the shape of FeiqueService's internal RuntimeControl interface
 * but is declared here so this module does not depend on service.ts.
 */
export interface AdminConfigRuntimeControl {
  configPath?: string;
}

/**
 * Subset of FeiqueService that the admin config mutation flows need.
 * Several fields are exposed because the shared helpers
 * (snapshotConfigForAdminMutation, reloadRuntimeConfigFromDisk,
 * appendAdminAudit) stay on FeiqueService — they are called from many
 * admin paths including the WIP /admin project setup flow. Moving them
 * here would create a tangle. Instead, this host interface just routes
 * calls back into the service instance.
 */
export interface AdminConfigHost {
  readonly config: BridgeConfig;
  readonly runtimeControl?: AdminConfigRuntimeControl;
  readonly configHistoryStore: ConfigHistoryStore;
  sendTextReply(
    chatId: string,
    body: string,
    replyToMessageId?: string,
    originalText?: string,
  ): Promise<unknown>;
  snapshotConfigForAdminMutation(
    context: IncomingMessageContext,
    action: string,
    summary?: string,
  ): Promise<{ id: string; content: string }>;
  reloadRuntimeConfigFromDisk(configPath: string): Promise<void>;
  appendAdminAudit(event: { type: string; [key: string]: unknown }): Promise<void>;
}

// ---------------------------------------------------------------------------
// /admin config history|rollback
// ---------------------------------------------------------------------------

export async function handleAdminConfigCommand(
  host: AdminConfigHost,
  context: IncomingMessageContext,
  command: { kind: 'admin'; resource: 'config'; action: 'history' | 'rollback'; value?: string },
): Promise<void> {
  const canMutate = canAccessGlobalCapability(host.config, context.chat_id, 'config:mutate');
  const canRead = canAccessGlobalCapability(host.config, context.chat_id, 'config:history') || canMutate;

  if (command.action === 'history' && !canRead) {
    await host.sendTextReply(context.chat_id, '当前 chat_id 无权查看配置历史。', context.message_id, context.text);
    return;
  }
  if (command.action === 'rollback' && !canMutate) {
    await host.sendTextReply(context.chat_id, '当前 chat_id 无权回滚配置。', context.message_id, context.text);
    return;
  }
  if (!host.runtimeControl?.configPath) {
    await host.sendTextReply(context.chat_id, '当前运行实例没有可写配置路径，无法执行配置历史操作。', context.message_id, context.text);
    return;
  }
  const configPath = host.runtimeControl.configPath;

  if (command.action === 'history') {
    const snapshots = await host.configHistoryStore.listSnapshots();
    if (snapshots.length === 0) {
      await host.sendTextReply(context.chat_id, '当前没有可回滚的配置快照。', context.message_id, context.text);
      return;
    }
    const lines = ['最近配置快照:'];
    for (const snapshot of snapshots) {
      lines.push(`- ${snapshot.id} | ${snapshot.at} | ${snapshot.action}${snapshot.summary ? ` | ${snapshot.summary}` : ''}`);
    }
    await host.sendTextReply(context.chat_id, lines.join('\n'), context.message_id, context.text);
    return;
  }

  const target = await host.configHistoryStore.getSnapshot(command.value);
  if (!target) {
    await host.sendTextReply(context.chat_id, '未找到指定配置快照。可先执行 `/admin config history`。', context.message_id, context.text);
    return;
  }

  const rollbackSnapshot = await host.snapshotConfigForAdminMutation(context, 'config.rollback', `rollback -> ${target.id}`);
  const previousContent = rollbackSnapshot.content;
  try {
    await writeUtf8Atomic(configPath, target.content);
    await host.reloadRuntimeConfigFromDisk(configPath);
  } catch (error) {
    await writeUtf8Atomic(configPath, previousContent);
    await host.reloadRuntimeConfigFromDisk(configPath);
    throw error;
  }
  await host.appendAdminAudit({
    type: 'admin.config.rollback',
    chat_id: context.chat_id,
    actor_id: context.actor_id,
    target_snapshot_id: target.id,
    snapshot_id: rollbackSnapshot.id,
    config_path: configPath,
  });
  await host.sendTextReply(
    context.chat_id,
    `已回滚配置。\n目标快照: ${target.id}\n回滚前快照: ${rollbackSnapshot.id}\n如需生效到某些运行时状态，请再执行 /admin service restart。`,
    context.message_id,
    context.text,
  );
}

// ---------------------------------------------------------------------------
// /admin project set — field patch parsing
// ---------------------------------------------------------------------------

/**
 * Resolve a list field patch with incremental add (+value) / remove (-value) support.
 * Plain values (no prefix) replace the entire list for backward compatibility.
 */
export function resolveListPatch(
  config: BridgeConfig,
  field: string,
  value: string,
  projectAlias?: string,
): string[] {
  const trimmed = value.trim();

  // Incremental add: "+oc_xxx" or "+oc_xxx,oc_yyy"
  if (trimmed.startsWith('+')) {
    const toAdd = splitCommaSeparatedValues(trimmed.slice(1));
    const existing = projectAlias ? (config.projects[projectAlias]?.[field as keyof ProjectConfig] as string[] ?? []) : [];
    return Array.from(new Set([...existing, ...toAdd]));
  }

  // Incremental remove: "-oc_xxx" or "-oc_xxx,oc_yyy"
  if (trimmed.startsWith('-')) {
    const toRemove = new Set(splitCommaSeparatedValues(trimmed.slice(1)));
    const existing = projectAlias ? (config.projects[projectAlias]?.[field as keyof ProjectConfig] as string[] ?? []) : [];
    return existing.filter((id) => !toRemove.has(id));
  }

  // Replace: "oc_xxx,oc_yyy"
  return splitCommaSeparatedValues(value);
}

export function parseProjectPatch(
  config: BridgeConfig,
  field: string,
  value: string,
  projectAlias?: string,
): Partial<ProjectConfig> | null {
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
    case 'operator_chat_ids':
    case 'admin_chat_ids':
    case 'session_operator_chat_ids':
    case 'run_operator_chat_ids':
    case 'config_admin_chat_ids':
    case 'notification_chat_ids':
      return { [field]: resolveListPatch(config, field, value, projectAlias) };
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
