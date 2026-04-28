import { describe, expect, it } from 'vitest';
import { extractIncomingMessage, shouldAllowChat } from '../src/feishu/extractors.js';

describe('feishu extractors', () => {
  it('extracts attachment metadata from image messages', () => {
    const message = extractIncomingMessage({
      header: { tenant_key: 'tenant' },
      event: {
        sender: {
          sender_id: { open_id: 'ou_1' },
          sender_type: 'user',
        },
        message: {
          chat_id: 'oc_chat',
          chat_type: 'group',
          message_id: 'om_1',
          message_type: 'image',
          content: JSON.stringify({ image_key: 'img_123' }),
          mentions: [],
        },
      },
    });

    expect(message).not.toBeNull();
    expect(message?.message_type).toBe('image');
    expect(message?.text).toBe('');
    expect(message?.attachments).toEqual([
      expect.objectContaining({
        kind: 'image',
        key: 'img_123',
      }),
    ]);
  });

  it('extracts plain text from post messages', () => {
    const message = extractIncomingMessage({
      header: { tenant_key: 'tenant' },
      event: {
        sender: {
          sender_id: { open_id: 'ou_1' },
          sender_type: 'user',
        },
        message: {
          chat_id: 'oc_chat',
          chat_type: 'p2p',
          message_id: 'om_2',
          message_type: 'post',
          content: JSON.stringify({
            zh_cn: {
              title: '发布说明',
              content: [[{ tag: 'text', text: '第一段' }, { tag: 'text', text: '第二段' }]],
            },
          }),
          mentions: [],
        },
      },
    });

    expect(message).not.toBeNull();
    expect(message?.message_type).toBe('post');
    expect(message?.text).toContain('第一段');
    expect(message?.text).toContain('第二段');
    expect(message?.attachments[0]?.kind).toBe('post');
  });

  it('allows configured group chat ids even when Feishu reports a non-group chat type', () => {
    const config = {
      allowed_chat_ids: ['oc_direct'],
      allowed_group_ids: ['oc_group'],
    };

    expect(shouldAllowChat(config, 'oc_group', 'p2p')).toBe(true);
    expect(shouldAllowChat(config, 'oc_group', 'unknown')).toBe(true);
    expect(shouldAllowChat(config, 'oc_other', 'p2p')).toBe(false);
  });
});
