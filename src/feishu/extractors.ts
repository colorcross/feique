import { tryParseJson } from '../utils/json.js';
import type { IncomingCardActionContext, IncomingMessageContext, Mention, MessageAttachment } from '../bridge/types.js';

interface FeishuTextContent {
  text?: string;
}

export function extractIncomingMessage(raw: unknown): IncomingMessageContext | null {
  const body = asObject(raw);
  const event = asObject(body?.event);
  const source = event ?? body;
  const header = asObject(body?.header);
  const message = asObject(source?.message);
  if (!message) {
    return null;
  }

  const messageType = firstString(message.message_type) ?? 'unknown';
  const extracted = extractMessagePayload(messageType, message.content);
  if (!extracted.text && extracted.attachments.length === 0) {
    return null;
  }

  const sender = asObject(source?.sender);
  const senderId = firstString(asObject(sender?.sender_id)?.open_id, asObject(sender?.sender_id)?.user_id, asObject(sender?.sender_id)?.union_id);
  const senderName = typeof sender?.sender_type === 'string' ? undefined : firstString((sender as Record<string, unknown>).name);
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.map((mention) => {
        const mentionObject = asObject(mention);
        const mentionId = firstString(
          asObject(mentionObject?.id)?.open_id,
          asObject(mentionObject?.id)?.user_id,
          asObject(mentionObject?.id)?.union_id,
        );
        const mentionName = firstString(mentionObject?.name, asObject(mentionObject?.name)?.name);
        return { id: mentionId, name: mentionName } satisfies Mention;
      })
    : [];

  return {
    tenant_key: firstString(header?.tenant_key, body?.tenant_key),
    chat_id: firstString(message.chat_id) ?? '',
    chat_type: normalizeChatType(firstString(message.chat_type)),
    actor_id: senderId,
    actor_name: senderName,
    sender_type: firstString(sender?.sender_type),
    message_id: firstString(message.message_id) ?? '',
    message_type: messageType,
    text: extracted.text,
    attachments: extracted.attachments,
    mentions,
    raw,
  };
}

export function extractCardAction(raw: unknown): IncomingCardActionContext | null {
  const body = asObject(raw);
  const event = asObject(body?.event);
  const source = event ?? body;
  const openMessageId = firstString(source?.open_message_id, source?.openMessageId);
  const operator = asObject(source?.operator);
  const action = asObject(source?.action);
  const tenantKey = firstString(source?.tenant_key, asObject(source?.tenant_key)?.tenant_key, body?.tenant_key, asObject(body?.tenant_key)?.tenant_key);
  const chatId = firstString(source?.open_chat_id, source?.chat_id);
  const actorId = firstString(asObject(operator?.open_id)?.open_id, operator?.open_id, operator?.user_id, operator?.union_id);
  const actionValue = asObject(action?.value) ?? {};

  return {
    tenant_key: tenantKey,
    chat_id: chatId,
    actor_id: actorId,
    open_message_id: openMessageId,
    action_value: actionValue,
    raw,
  };
}

export function shouldAllowChat(config: { allowed_chat_ids: string[]; allowed_group_ids: string[] }, chatId: string, chatType: string): boolean {
  if (config.allowed_group_ids.includes(chatId)) {
    return true;
  }
  if (chatType === 'p2p') {
    return config.allowed_chat_ids.length === 0 || config.allowed_chat_ids.includes(chatId);
  }
  return config.allowed_group_ids.length === 0 || config.allowed_group_ids.includes(chatId);
}

function extractMessagePayload(messageType: string, content: unknown): { text: string; attachments: MessageAttachment[] } {
  switch (messageType) {
    case 'text':
      return {
        text: extractTextContent(content) ?? '',
        attachments: [],
      };
    case 'post': {
      const text = extractPostContent(content);
      return {
        text,
        attachments: text ? [{ kind: 'post', summary: '富文本消息', name: 'post' }] : [],
      };
    }
    case 'image':
      return {
        text: '',
        attachments: buildSingleAttachment(content, 'image'),
      };
    case 'file':
      return {
        text: '',
        attachments: buildSingleAttachment(content, 'file'),
      };
    case 'audio':
      return {
        text: '',
        attachments: buildSingleAttachment(content, 'audio'),
      };
    case 'media':
      return {
        text: '',
        attachments: buildSingleAttachment(content, 'media'),
      };
    default:
      return {
        text: extractTextContent(content) ?? '',
        attachments: [],
      };
  }
}

function extractTextContent(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }
  const parsed = tryParseJson<FeishuTextContent>(content);
  if (parsed?.text) {
    return parsed.text.trim();
  }
  return null;
}

function extractPostContent(content: unknown): string {
  if (typeof content !== 'string') {
    return '';
  }

  const parsed = tryParseJson<Record<string, unknown>>(content);
  if (!parsed) {
    return '';
  }

  const texts = collectTextFragments(parsed);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === 'string') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextFragments(item));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  const result: string[] = [];
  if (typeof record.text === 'string' && record.text.trim()) {
    result.push(record.text.trim());
  }
  for (const nested of Object.values(record)) {
    result.push(...collectTextFragments(nested));
  }
  return result;
}

function buildSingleAttachment(content: unknown, kind: MessageAttachment['kind']): MessageAttachment[] {
  if (typeof content !== 'string') {
    return [{ kind, summary: renderAttachmentSummary(kind, {}) }];
  }
  const parsed = tryParseJson<Record<string, unknown>>(content) ?? {};
  const key = firstString(parsed.file_key, parsed.image_key, parsed.media_key);
  const name = firstString(parsed.file_name, parsed.title);
  const mimeType = firstString(parsed.file_type, parsed.mime_type);
  const durationMs = firstNumber(parsed.duration, parsed.duration_ms);
  const sizeBytes = firstNumber(parsed.file_size, parsed.size, parsed.size_bytes);

  return [
    {
      kind,
      key,
      name,
      mime_type: mimeType,
      duration_ms: durationMs,
      size_bytes: sizeBytes,
      summary: renderAttachmentSummary(kind, {
        key,
        name,
        mimeType,
        durationMs,
        sizeBytes,
      }),
    },
  ];
}

function renderAttachmentSummary(
  kind: MessageAttachment['kind'],
  metadata: {
    key?: string;
    name?: string;
    mimeType?: string;
    durationMs?: number;
    sizeBytes?: number;
  },
): string {
  const parts: string[] = [kind];
  if (metadata.name) {
    parts.push(`name=${metadata.name}`);
  }
  if (metadata.key) {
    parts.push(`key=${metadata.key}`);
  }
  if (metadata.mimeType) {
    parts.push(`type=${metadata.mimeType}`);
  }
  if (typeof metadata.durationMs === 'number') {
    parts.push(`duration_ms=${metadata.durationMs}`);
  }
  if (typeof metadata.sizeBytes === 'number') {
    parts.push(`size_bytes=${metadata.sizeBytes}`);
  }
  return parts.join(' | ');
}

function normalizeChatType(input: string | undefined): IncomingMessageContext['chat_type'] {
  if (input === 'p2p') {
    return 'p2p';
  }
  if (input === 'group') {
    return 'group';
  }
  return 'unknown';
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value) => typeof value === 'string' && value.length > 0) as string | undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value)) as number | undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
