import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMessageResources } from '../src/feishu/message-resource.js';

const tempDirs: string[] = [];
const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('message resource resolver', () => {
  it('downloads image resources and annotates local paths', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-resource-'));
    tempDirs.push(dir);
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, 'image-bytes', 'utf8');
    });

    const resolved = await resolveMessageResources(
      {
        im: {
          v1: {
            messageResource: {
              get: vi.fn().mockResolvedValue({ writeFile }),
            },
          },
        },
      } as any,
      dir,
      {
        tenant_key: 'tenant',
        chat_id: 'chat',
        chat_type: 'p2p',
        actor_id: 'user',
        message_id: 'om_1',
        message_type: 'image',
        text: '',
        attachments: [{ kind: 'image', key: 'img_123', summary: 'image | key=img_123' }],
        mentions: [],
        raw: {},
      },
      {
        downloadEnabled: true,
        transcribeAudio: false,
        logger,
      },
    );

    expect(resolved.attachments[0]?.downloaded_path).toContain(path.join('message-resources', 'om_1'));
    expect(writeFile).toHaveBeenCalled();
  });

  it('transcribes audio resources when enabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-audio-'));
    tempDirs.push(dir);
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, 'audio-bytes', 'utf8');
    });

    const resolved = await resolveMessageResources(
      {
        im: {
          v1: {
            messageResource: {
              get: vi.fn().mockResolvedValue({ writeFile }),
            },
          },
        },
      } as any,
      dir,
      {
        tenant_key: 'tenant',
        chat_id: 'chat',
        chat_type: 'p2p',
        actor_id: 'user',
        message_id: 'om_2',
        message_type: 'audio',
        text: '',
        attachments: [{ kind: 'audio', key: 'audio_123', summary: 'audio | key=audio_123' }],
        mentions: [],
        raw: {},
      },
      {
        downloadEnabled: true,
        transcribeAudio: true,
        logger,
        transcribe: vi.fn().mockResolvedValue('会议结论：先发 npm 包。'),
      },
    );

    expect(resolved.attachments[0]?.transcript_text).toBe('会议结论：先发 npm 包。');
  });

  it('extracts text excerpts from text-like file attachments', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-file-'));
    tempDirs.push(dir);
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, '# 发布说明\n请先执行 pnpm build，再执行 npm publish。', 'utf8');
    });

    const resolved = await resolveMessageResources(
      {
        im: {
          v1: {
            messageResource: {
              get: vi.fn().mockResolvedValue({ writeFile }),
            },
          },
        },
      } as any,
      dir,
      {
        tenant_key: 'tenant',
        chat_id: 'chat',
        chat_type: 'p2p',
        actor_id: 'user',
        message_id: 'om_3',
        message_type: 'file',
        text: '',
        attachments: [{ kind: 'file', key: 'file_123', name: 'release-notes.md', mime_type: 'text/markdown', summary: 'file | key=file_123' }],
        mentions: [],
        raw: {},
      },
      {
        downloadEnabled: true,
        transcribeAudio: false,
        logger,
      },
    );

    expect(resolved.attachments[0]?.downloaded_path).toContain(path.join('message-resources', 'om_3'));
    expect(resolved.attachments[0]?.content_excerpt).toContain('发布说明');
    expect(resolved.attachments[0]?.content_excerpt).toContain('npm publish');
  });

  it('describes image resources when image analysis is enabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-image-'));
    tempDirs.push(dir);
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, 'image-bytes', 'utf8');
    });

    const resolved = await resolveMessageResources(
      {
        im: {
          v1: {
            messageResource: {
              get: vi.fn().mockResolvedValue({ writeFile }),
            },
          },
        },
      } as any,
      dir,
      {
        tenant_key: 'tenant',
        chat_id: 'chat',
        chat_type: 'p2p',
        actor_id: 'user',
        message_id: 'om_4',
        message_type: 'image',
        text: '',
        attachments: [{ kind: 'image', key: 'img_456', name: 'ui.png', mime_type: 'image/png', summary: 'image | key=img_456' }],
        mentions: [],
        raw: {},
      },
      {
        downloadEnabled: true,
        transcribeAudio: false,
        describeImages: true,
        openaiImageModel: 'gpt-4.1-mini',
        logger,
        describeImage: vi.fn().mockResolvedValue('登录页截图，包含邮箱输入框和蓝色提交按钮。'),
      },
    );

    expect(resolved.attachments[0]?.image_description).toContain('登录页截图');
  });

  it('extracts excerpts from docx-like files through the rich document extractor hook', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-docx-'));
    tempDirs.push(dir);
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, 'fake-docx', 'utf8');
    });

    const resolved = await resolveMessageResources(
      {
        im: {
          v1: {
            messageResource: {
              get: vi.fn().mockResolvedValue({ writeFile }),
            },
          },
        },
      } as any,
      dir,
      {
        tenant_key: 'tenant',
        chat_id: 'chat',
        chat_type: 'p2p',
        actor_id: 'user',
        message_id: 'om_5',
        message_type: 'file',
        text: '',
        attachments: [{ kind: 'file', key: 'file_456', name: 'design-review.docx', summary: 'file | key=file_456' }],
        mentions: [],
        raw: {},
      },
      {
        downloadEnabled: true,
        transcribeAudio: false,
        logger,
        extractText: vi.fn().mockResolvedValue('设计评审纪要：先修复飞书会话去重，再上线 npm 包。'),
      },
    );

    expect(resolved.attachments[0]?.content_excerpt).toContain('设计评审纪要');
    expect(resolved.attachments[0]?.content_excerpt).toContain('npm 包');
  });
});
