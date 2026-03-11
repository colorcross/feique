export interface Mention {
  id?: string;
  name?: string;
}

export interface MessageAttachment {
  kind: 'image' | 'file' | 'audio' | 'media' | 'post' | 'unknown';
  key?: string;
  name?: string;
  mime_type?: string;
  duration_ms?: number;
  size_bytes?: number;
  downloaded_path?: string;
  transcript_text?: string;
  content_excerpt?: string;
  image_description?: string;
  summary: string;
}

export interface IncomingMessageContext {
  tenant_key?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group' | 'unknown';
  actor_id?: string;
  actor_name?: string;
  sender_type?: string;
  message_id: string;
  message_type: string;
  text: string;
  attachments: MessageAttachment[];
  mentions: Mention[];
  raw: unknown;
}

export interface IncomingCardActionContext {
  tenant_key?: string;
  chat_id?: string;
  actor_id?: string;
  open_message_id?: string;
  action_value: Record<string, unknown>;
  raw: unknown;
}

export interface BridgeReply {
  kind: 'text' | 'card';
  text?: string;
  card?: Record<string, unknown>;
}
