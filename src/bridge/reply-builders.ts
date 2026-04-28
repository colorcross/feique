import type { BridgeConfig } from '../config/schema.js';
import { buildMessageCard, buildStatusCard } from '../feishu/cards.js';
import { truncateForFeishuCard } from '../feishu/text.js';
import { truncateExcerpt } from './service-utils.js';

/**
 * Pure reply / card builders pulled out of FeiqueService.
 *
 * Nothing in this module touches instance state — they are all pure
 * functions of their inputs (plus `config` for the two functions that
 * consult service settings). The stateful reply orchestration
 * (runReplyTargets map, sendTextReply, updateRunLifecycleReply) stays
 * on FeiqueService for now; that's a future β step.
 */

export function formatQuotedReply(body: string, _originalText?: string): string {
  return body;
}

export function buildReplyTitle(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return truncateExcerpt(firstLine ?? '飞鹊 (Feique)', 40);
}

export function sanitizeUserVisibleReply(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^(运行|当前运行|阻塞运行|run[_ -]?id|session[_ -]?id|conversation[_ -]?key|chat[_ -]?id|tenant[_ -]?key|project[_ -]?root|pid):/i.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripLifecycleMetadata(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^(项目|处理状态|会话|当前会话|已保存会话数):/.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function supportsInteractiveCardActions(config: BridgeConfig): boolean {
  return config.feishu.transport === 'webhook';
}

export function resolveRunLifecycleReplyMode(config: BridgeConfig): BridgeConfig['service']['reply_mode'] {
  return config.service.reply_mode;
}

export interface RunLifecycleCardInput {
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
}

export function buildRunLifecycleCard(input: RunLifecycleCardInput): Record<string, unknown> {
  const sanitizedBody = sanitizeUserVisibleReply(input.body);
  if (input.includeActions) {
    return buildStatusCard({
      title: input.title,
      summary: input.cardSummary ?? truncateForFeishuCard(stripLifecycleMetadata(sanitizedBody)),
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
    body: stripLifecycleMetadata(sanitizedBody),
    status: input.runStatus,
    phase: input.runPhase,
    projectAlias: input.projectAlias,
  });
}
