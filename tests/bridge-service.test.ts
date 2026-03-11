import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCodexTurnMock = vi.fn();

vi.mock('../src/codex/runner.js', () => ({
  runCodexTurn: (...args: unknown[]) => runCodexTurnMock(...args),
  summarizeCodexEvent: vi.fn(() => null),
}));

import type { BridgeConfig } from '../src/config/schema.js';
import { CodexFeishuService } from '../src/bridge/service.js';
import { SessionStore, buildConversationKey } from '../src/state/session-store.js';
import { AuditLog } from '../src/state/audit-log.js';
import { IdempotencyStore } from '../src/state/idempotency-store.js';
import { RunStateStore } from '../src/state/run-state-store.js';
import { MemoryStore } from '../src/state/memory-store.js';

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

beforeEach(() => {
  runCodexTurnMock.mockReset();
  logger.debug.mockClear();
  logger.warn.mockClear();
  logger.info.mockClear();
  logger.error.mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('bridge service', () => {
  it('ignores duplicate inbound messages by message_id', async () => {
    const setup = await createService();
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-1',
      finalMessage: 'done',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'codex-cli 0.98.0', exec: {}, resume: {} },
    });

    const message = buildMessage('fix this');
    await setup.service.handleIncomingMessage(message);
    await setup.service.handleIncomingMessage(message);

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(setup.sendText).toHaveBeenCalledTimes(1);
    expect((await setup.idempotencyStore.tail(10))[0]?.duplicate_count).toBe(1);
  });

  it('uses native Feishu reply when reply_quote_user_message is enabled', async () => {
    const setup = await createService({
      service: {
        reply_quote_user_message: true,
        reply_quote_max_chars: 120,
        download_message_resources: false,
        transcribe_audio_messages: false,
        describe_image_messages: false,
        openai_image_model: 'gpt-4.1-mini',
        memory_enabled: true,
        memory_search_limit: 3,
        memory_recent_limit: 5,
        memory_prompt_max_chars: 1600,
        thread_summary_max_chars: 1200,
        memory_group_enabled: false,
        memory_cleanup_interval_seconds: 1800,
        memory_max_pinned_per_scope: 5,
        memory_pin_overflow_strategy: 'age-out',
        memory_pin_age_basis: 'updated_at',
      },
    });
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-1',
      finalMessage: 'done',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'codex-cli 0.98.0', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage(buildMessage('请帮我看下当前路径', { message_id: 'm-reply' }));
    expect(setup.sendText).toHaveBeenCalledWith(
      'chat',
      expect.stringContaining('项目: default'),
      expect.objectContaining({ replyToMessageId: 'm-reply' }),
    );
  });

  it('supports listing and switching saved sessions', async () => {
    const setup = await createService();
    runCodexTurnMock
      .mockResolvedValueOnce({ sessionId: 'thread-1', finalMessage: 'first', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } })
      .mockResolvedValueOnce({ sessionId: 'thread-2', finalMessage: 'second', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } });

    await setup.service.handleIncomingMessage(buildMessage('first'));
    await setup.service.handleIncomingMessage(buildMessage('/session new', { message_id: 'm-new' }));
    await setup.service.handleIncomingMessage(buildMessage('second', { message_id: 'm-2' }));
    await setup.service.handleIncomingMessage(buildMessage('/session use thread-1', { message_id: 'm-use' }));

    const sessionKey = buildConversationKey({ tenantKey: 'tenant', chatId: 'chat', actorId: 'user', scope: 'chat' });
    const conversation = await setup.sessionStore.getConversation(sessionKey);
    expect(conversation?.projects.default?.thread_id).toBe('thread-1');

    await setup.service.handleIncomingMessage(buildMessage('/session list', { message_id: 'm-list' }));
    const lastReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(lastReply).toContain('thread-1');
    expect(lastReply).toContain('thread-2');
  });

  it('cancels an active run and records cancelled status', async () => {
    const setup = await createService();
    runCodexTurnMock.mockImplementation(
      (options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const error = new Error(String(options.signal?.reason ?? 'aborted'));
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );

    const promptPromise = setup.service.handleIncomingMessage(buildMessage('long task'));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(1));

    await setup.service.handleIncomingMessage(buildMessage('/cancel', { message_id: 'm-cancel' }));
    await promptPromise;

    const runs = await setup.runStateStore.listRuns();
    expect(runs[0]?.status).toBe('cancelled');
    expect(setup.sendText).toHaveBeenCalledWith('chat', expect.stringContaining('已提交取消请求'));
  });

  it('runs different projects in parallel within the same Feishu chat', async () => {
    const setup = await createService({
      projects: {
        'repo-a': { root: '/tmp/repo-a', session_scope: 'chat', mention_required: false, knowledge_paths: [], wiki_space_ids: [] },
        'repo-b': { root: '/tmp/repo-b', session_scope: 'chat', mention_required: false, knowledge_paths: [], wiki_space_ids: [] },
      },
      service: { name: 'test-bridge', default_project: 'repo-a', reply_mode: 'text', emit_progress_updates: false, progress_update_interval_ms: 4000, metrics_host: '127.0.0.1', idempotency_ttl_seconds: 86400, session_history_limit: 20, log_tail_lines: 100, reply_quote_user_message: false, reply_quote_max_chars: 120, download_message_resources: false, transcribe_audio_messages: false, describe_image_messages: false, openai_image_model: 'gpt-4.1-mini', memory_enabled: true, memory_search_limit: 3, memory_recent_limit: 5, memory_prompt_max_chars: 1600, thread_summary_max_chars: 1200, memory_group_enabled: false, memory_cleanup_interval_seconds: 1800, memory_max_pinned_per_scope: 5, memory_pin_overflow_strategy: 'age-out', memory_pin_age_basis: 'updated_at' },
    });

    const resolvers: Array<(value: unknown) => void> = [];
    runCodexTurnMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const first = setup.service.handleIncomingMessage(buildMessage('run a'));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(1));

    await setup.service.handleIncomingMessage(buildMessage('/project repo-b', { message_id: 'm-project-b' }));
    const second = setup.service.handleIncomingMessage(buildMessage('run b', { message_id: 'm-run-b' }));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(2));

    resolvers.shift()?.({ sessionId: 'thread-a', finalMessage: 'done-a', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } });
    resolvers.shift()?.({ sessionId: 'thread-b', finalMessage: 'done-b', stderr: '', exitCode: 0, capabilities: { version: 'v', exec: {}, resume: {} } });

    await Promise.all([first, second]);
    expect(runCodexTurnMock).toHaveBeenCalledTimes(2);
  });

  it('injects attachment metadata into the Codex prompt for media messages', async () => {
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, 'audio-bytes', 'utf8');
    });
    const setup = await createService({
      service: {
        download_message_resources: true,
        transcribe_audio_messages: false,
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      im: {
        v1: {
          messageResource: {
            get: vi.fn().mockResolvedValue({ writeFile }),
          },
        },
      },
    });
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-media',
      finalMessage: 'processed media',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage({
      ...buildMessage('', { message_id: 'm-media' }),
      message_type: 'audio',
      attachments: [{ kind: 'audio', key: 'audio_123', summary: 'audio | key=audio_123' }],
      text: '',
    });

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('Message attachments:');
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('audio | key=audio_123');
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('downloaded_path:');
  });

  it('injects text excerpts from file attachments into the Codex prompt', async () => {
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, '# 发布说明\n先执行 pnpm build，再执行 npm publish。', 'utf8');
    });
    const setup = await createService({
      service: {
        download_message_resources: true,
        transcribe_audio_messages: false,
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      im: {
        v1: {
          messageResource: {
            get: vi.fn().mockResolvedValue({ writeFile }),
          },
        },
      },
    });
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-file',
      finalMessage: 'processed file',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage({
      ...buildMessage('', { message_id: 'm-file' }),
      message_type: 'file',
      attachments: [{ kind: 'file', key: 'file_123', name: 'release-notes.md', mime_type: 'text/markdown', summary: 'file | key=file_123' }],
      text: '',
    });

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('content_excerpt:');
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('发布说明');
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('npm publish');
  });

  it('injects image descriptions into the Codex prompt', async () => {
    const writeFile = vi.fn(async (filePath: string) => {
      await fs.writeFile(filePath, 'image-bytes', 'utf8');
    });
    const setup = await createService({
      service: {
        download_message_resources: true,
        describe_image_messages: true,
        openai_image_model: 'gpt-4.1-mini',
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      im: {
        v1: {
          messageResource: {
            get: vi.fn().mockResolvedValue({ writeFile }),
          },
        },
      },
    });
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: '登录页截图，顶部有品牌标题，下方有表单。',
              },
            ],
          },
        ],
      }),
    }) as any;
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-image',
      finalMessage: 'processed image',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });

    try {
      await setup.service.handleIncomingMessage({
        ...buildMessage('', { message_id: 'm-image' }),
        message_type: 'image',
        attachments: [{ kind: 'image', key: 'img_456', name: 'ui.png', mime_type: 'image/png', summary: 'image | key=img_456' }],
        text: '',
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalApiKey;
      }
    }

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('image_description:');
    expect(runCodexTurnMock.mock.calls[0]?.[0]?.prompt).toContain('登录页截图');
  });

  it('saves and searches project memory through commands', async () => {
    const setup = await createService();

    await setup.service.handleIncomingMessage(buildMessage('/memory save 发布前必须先 pnpm build，再执行 npm publish。', { message_id: 'm-memory-save' }));
    const saveReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(saveReply).toContain('已保存项目记忆');
    expect(saveReply).toContain('memory_id:');

    await setup.service.handleIncomingMessage(buildMessage('/memory search npm publish', { message_id: 'm-memory-search' }));
    const searchReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(searchReply).toContain('项目记忆搜索: npm publish');
    expect(searchReply).toContain('id:');
    expect(searchReply).toContain('pnpm build');

    await setup.service.handleIncomingMessage(buildMessage('/memory status', { message_id: 'm-memory-status' }));
    const statusReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(statusReply).toContain('项目记忆数: 1');

    await setup.service.handleIncomingMessage(buildMessage('/memory stats', { message_id: 'm-memory-stats' }));
    const statsReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(statsReply).toContain('项目记忆统计:');
    expect(statsReply).toContain('active_count: 1');
    expect(statsReply).toContain('pinned_count: 0');

    await setup.service.handleIncomingMessage(buildMessage('/memory recent', { message_id: 'm-memory-recent' }));
    const recentReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(recentReply).toContain('最近项目记忆');
    expect(recentReply).toContain('id:');
  });

  it('filters recent memories by tag, source, and created_by', async () => {
    const setup = await createService();
    const store = new MemoryStore(setup.config.storage.dir);
    await store.ensureReady();
    await store.saveProjectMemory({
      project_alias: 'default',
      title: '发布流程',
      content: '发布前先 pnpm build。',
      tags: ['release'],
      source: 'manual',
      created_by: 'ou_release',
    });
    await store.saveProjectMemory({
      project_alias: 'default',
      title: '值班文档',
      content: '来自飞书 wiki。',
      tags: ['ops'],
      source: 'wiki',
      created_by: 'ou_ops',
    });

    await setup.service.handleIncomingMessage(buildMessage('/memory recent --tag release', { message_id: 'm-memory-recent-tag' }));
    const tagReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(tagReply).toContain('tag: release');
    expect(tagReply).toContain('发布流程');
    expect(tagReply).not.toContain('值班文档');

    await setup.service.handleIncomingMessage(buildMessage('/memory recent --source wiki', { message_id: 'm-memory-recent-source' }));
    const sourceReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(sourceReply).toContain('source: wiki');
    expect(sourceReply).toContain('值班文档');
    expect(sourceReply).not.toContain('发布流程');

    await setup.service.handleIncomingMessage(buildMessage('/memory recent --created-by ou_release', { message_id: 'm-memory-recent-created-by' }));
    const createdByReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(createdByReply).toContain('created_by: ou_release');
    expect(createdByReply).toContain('发布流程');
    expect(createdByReply).not.toContain('值班文档');
  });

  it('filters memory search results by tag and source', async () => {
    const setup = await createService();
    const store = new MemoryStore(setup.config.storage.dir);
    await store.ensureReady();
    await store.saveProjectMemory({
      project_alias: 'default',
      title: '发布流水线',
      content: 'CI 成功后再执行 npm publish。',
      tags: ['release'],
      source: 'manual',
      created_by: 'ou_release',
    });
    await store.saveProjectMemory({
      project_alias: 'default',
      title: '发布值班说明',
      content: '发布前要同步 wiki 记录。',
      tags: ['release'],
      source: 'wiki',
      created_by: 'ou_ops',
    });

    await setup.service.handleIncomingMessage(buildMessage('/memory search --tag release --source wiki 发布', { message_id: 'm-memory-search-filtered' }));
    const searchReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(searchReply).toContain('tag: release');
    expect(searchReply).toContain('source: wiki');
    expect(searchReply).toContain('发布值班说明');
    expect(searchReply).not.toContain('发布流水线');
  });

  it('filters memory search results by created_by', async () => {
    const setup = await createService();
    const store = new MemoryStore(setup.config.storage.dir);
    await store.ensureReady();
    await store.saveProjectMemory({
      project_alias: 'default',
      title: 'A 发布说明',
      content: '由发布负责人维护。',
      created_by: 'ou_release',
      source: 'manual',
    });
    await store.saveProjectMemory({
      project_alias: 'default',
      title: 'B 值班说明',
      content: '由值班负责人维护。',
      created_by: 'ou_ops',
      source: 'manual',
    });

    await setup.service.handleIncomingMessage(buildMessage('/memory search --created-by ou_release 说明', { message_id: 'm-memory-search-created-by' }));
    const searchReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(searchReply).toContain('created_by: ou_release');
    expect(searchReply).toContain('A 发布说明');
    expect(searchReply).not.toContain('B 值班说明');
  });

  it('injects thread summary and project memory into the Codex prompt', async () => {
    const setup = await createService();
    runCodexTurnMock
      .mockResolvedValueOnce({
        sessionId: 'thread-memory',
        finalMessage: '已修改 src/app.ts，并建议下一步继续补测试。',
        stderr: '',
        exitCode: 0,
        capabilities: { version: 'v', exec: {}, resume: {} },
      })
      .mockResolvedValueOnce({
        sessionId: 'thread-memory',
        finalMessage: 'second turn',
        stderr: '',
        exitCode: 0,
        capabilities: { version: 'v', exec: {}, resume: {} },
      });

    await setup.service.handleIncomingMessage(buildMessage('先修复 src/app.ts 的问题', { message_id: 'm-memory-first' }));
    await setup.service.handleIncomingMessage(buildMessage('/memory save 发布前必须先 pnpm build', { message_id: 'm-memory-save2' }));
    await setup.service.handleIncomingMessage(buildMessage('继续处理并准备发布', { message_id: 'm-memory-second' }));

    const secondPrompt = runCodexTurnMock.mock.calls[1]?.[0]?.prompt as string;
    expect(secondPrompt).toContain('Thread summary:');
    expect(secondPrompt).toContain('最近目标');
    expect(secondPrompt).toContain('Project memory');
    expect(secondPrompt).toContain('发布前必须先 pnpm build');
  });

  it('manages group shared memory explicitly and injects it into group prompts', async () => {
    const setup = await createService({
      service: {
        memory_group_enabled: true,
      },
      security: {
        require_group_mentions: false,
      },
    });
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-group-memory',
      finalMessage: '已结合群共享记忆继续处理。',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage(buildMessage('/memory save group 本群发布窗口固定在周五 20:00。', {
      message_id: 'm-group-memory-save',
      chat_id: 'group-chat',
      chat_type: 'group',
    }));
    const saveReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(saveReply).toContain('已保存群共享记忆');
    const memoryId = saveReply.match(/memory_id: ([a-f0-9-]+)/i)?.[1];
    expect(memoryId).toBeTruthy();

    await setup.service.handleIncomingMessage(buildMessage(`/memory pin group ${memoryId}`, {
      message_id: 'm-group-memory-pin',
      chat_id: 'group-chat',
      chat_type: 'group',
    }));
    expect(setup.sendText.mock.calls.at(-1)?.[1]).toContain('群共享记忆已置顶');

    await setup.service.handleIncomingMessage(buildMessage('/memory search group 周五 20:00', {
      message_id: 'm-group-memory-search',
      chat_id: 'group-chat',
      chat_type: 'group',
    }));
    const searchReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(searchReply).toContain('群共享记忆搜索: 周五 20:00');
    expect(searchReply).toContain(memoryId as string);

    await setup.service.handleIncomingMessage(buildMessage('继续准备发布', {
      message_id: 'm-group-memory-prompt',
      chat_id: 'group-chat',
      chat_type: 'group',
      mentions: [{ id: 'ou_bot' }],
    }));
    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    const prompt = runCodexTurnMock.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('Group shared memory');
    expect(prompt).toContain('周五 20:00');

    await setup.service.handleIncomingMessage(buildMessage(`/memory forget group ${memoryId}`, {
      message_id: 'm-group-memory-forget',
      chat_id: 'group-chat',
      chat_type: 'group',
    }));
    expect(setup.sendText.mock.calls.at(-1)?.[1]).toContain('群共享记忆已归档');

    await setup.service.handleIncomingMessage(buildMessage(`/memory restore group ${memoryId}`, {
      message_id: 'm-group-memory-restore',
      chat_id: 'group-chat',
      chat_type: 'group',
    }));
    expect(setup.sendText.mock.calls.at(-1)?.[1]).toContain('群共享记忆已恢复');
  });

  it('ages out oldest pinned memory and can forget expired entries', async () => {
    const setup = await createService({
      service: {
        memory_default_ttl_days: 1,
        memory_max_pinned_per_scope: 1,
        memory_pin_overflow_strategy: 'age-out',
        memory_pin_age_basis: 'updated_at',
      },
    });
    const store = new MemoryStore(setup.config.storage.dir);
    await store.ensureReady();

    await setup.service.handleIncomingMessage(buildMessage('/memory save 第一条发布记忆', { message_id: 'm-pin-limit-save-1' }));
    const firstId = (setup.sendText.mock.calls.at(-1)?.[1] as string).match(/memory_id: ([a-f0-9-]+)/i)?.[1];
    expect(firstId).toBeTruthy();
    expect(setup.sendText.mock.calls.at(-1)?.[1]).toContain('expires_at:');

    await setup.service.handleIncomingMessage(buildMessage('/memory save 第二条发布记忆', { message_id: 'm-pin-limit-save-2' }));
    const secondId = (setup.sendText.mock.calls.at(-1)?.[1] as string).match(/memory_id: ([a-f0-9-]+)/i)?.[1];
    expect(secondId).toBeTruthy();

    await setup.service.handleIncomingMessage(buildMessage(`/memory pin ${firstId}`, { message_id: 'm-pin-limit-pin-1' }));
    expect(setup.sendText.mock.calls.at(-1)?.[1]).toContain('项目记忆已置顶');

    await setup.service.handleIncomingMessage(buildMessage(`/memory pin ${secondId}`, { message_id: 'm-pin-limit-pin-2' }));
    const agedReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(agedReply).toContain('项目记忆已置顶');
    expect(agedReply).toContain('已自动老化旧置顶');
    const firstMemory = await store.getMemory({ scope: 'project', project_alias: 'default' }, firstId as string);
    const secondMemory = await store.getMemory({ scope: 'project', project_alias: 'default' }, secondId as string);
    expect(firstMemory?.pinned).toBe(false);
    expect(secondMemory?.pinned).toBe(true);

    await store.saveProjectMemory({
      project_alias: 'default',
      title: '已过期记忆',
      content: '这条应该被清理',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await setup.service.handleIncomingMessage(buildMessage('/memory forget all-expired', { message_id: 'm-memory-forget-expired' }));
    const forgetReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(forgetReply).toContain('项目记忆已归档过期项: 1');
  });

  it('can age out pinned memories by last_accessed_at instead of updated_at', async () => {
    const setup = await createService({
      service: {
        memory_max_pinned_per_scope: 2,
        memory_pin_overflow_strategy: 'age-out',
        memory_pin_age_basis: 'last_accessed_at',
      },
    });
    const store = new MemoryStore(setup.config.storage.dir);
    await store.ensureReady();

    await setup.service.handleIncomingMessage(buildMessage('/memory save 第一条发布记忆', { message_id: 'm-pin-age-save-1' }));
    const firstId = (setup.sendText.mock.calls.at(-1)?.[1] as string).match(/memory_id: ([a-f0-9-]+)/i)?.[1];
    await setup.service.handleIncomingMessage(buildMessage('/memory save 第二条发布记忆', { message_id: 'm-pin-age-save-2' }));
    const secondId = (setup.sendText.mock.calls.at(-1)?.[1] as string).match(/memory_id: ([a-f0-9-]+)/i)?.[1];

    await setup.service.handleIncomingMessage(buildMessage(`/memory pin ${firstId}`, { message_id: 'm-pin-age-pin-1' }));
    await setup.service.handleIncomingMessage(buildMessage(`/memory pin ${secondId}`, { message_id: 'm-pin-age-pin-2' }));
    await setup.service.handleIncomingMessage(buildMessage('/memory search 第一条', { message_id: 'm-pin-age-search' }));
    await setup.service.handleIncomingMessage(buildMessage('/memory save 第三条发布记忆', { message_id: 'm-pin-age-save-3' }));
    const thirdId = (setup.sendText.mock.calls.at(-1)?.[1] as string).match(/memory_id: ([a-f0-9-]+)/i)?.[1];

    await setup.service.handleIncomingMessage(buildMessage(`/memory pin ${thirdId}`, { message_id: 'm-pin-age-pin-3' }));
    const ageReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(ageReply).toContain('已自动老化旧置顶');
    expect(ageReply).toContain(secondId as string);

    const firstMemory = await store.getMemory({ scope: 'project', project_alias: 'default' }, firstId as string);
    const secondMemory = await store.getMemory({ scope: 'project', project_alias: 'default' }, secondId as string);
    const thirdMemory = await store.getMemory({ scope: 'project', project_alias: 'default' }, thirdId as string);
    expect(firstMemory?.pinned).toBe(true);
    expect(secondMemory?.pinned).toBe(false);
    expect(thirdMemory?.pinned).toBe(true);
  });

  it('can clean expired memories through background maintenance', async () => {
    const setup = await createService();
    const store = new MemoryStore(setup.config.storage.dir);
    await store.ensureReady();
    await store.saveProjectMemory({
      project_alias: 'default',
      title: '过期后台清理项',
      content: '应由后台维护清理。',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const cleaned = await setup.service.runMemoryMaintenance();
    expect(cleaned).toBe(1);
    expect(await store.searchProjectMemories('default', '后台清理项', 5)).toHaveLength(0);
    const stats = await store.getMemoryStats({ scope: 'project', project_alias: 'default' });
    expect(stats.archived_count).toBe(1);
  });

  it('archives forgotten memories and can restore them later', async () => {
    const setup = await createService();

    await setup.service.handleIncomingMessage(buildMessage('/memory save 可恢复记忆', { message_id: 'm-memory-archive-save' }));
    const memoryId = (setup.sendText.mock.calls.at(-1)?.[1] as string).match(/memory_id: ([a-f0-9-]+)/i)?.[1];
    expect(memoryId).toBeTruthy();

    await setup.service.handleIncomingMessage(buildMessage(`/memory forget ${memoryId}`, { message_id: 'm-memory-archive-forget' }));
    const archiveReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(archiveReply).toContain('项目记忆已归档');
    expect(archiveReply).toContain('/memory restore');

    await setup.service.handleIncomingMessage(buildMessage('/memory stats', { message_id: 'm-memory-archive-stats' }));
    const statsReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(statsReply).toContain('archived_count: 1');

    await setup.service.handleIncomingMessage(buildMessage(`/memory restore ${memoryId}`, { message_id: 'm-memory-archive-restore' }));
    const restoreReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(restoreReply).toContain('项目记忆已恢复');

    await setup.service.handleIncomingMessage(buildMessage(`/memory search 可恢复`, { message_id: 'm-memory-archive-search' }));
    const searchReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(searchReply).toContain('可恢复记忆');
  });

  it('searches project knowledge base through /kb search', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-kb-service-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'docs', 'guide.md'), 'Use codex-feishu init --mode global\n', 'utf8');

    const setup = await createService({
      projects: {
        default: {
          root,
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: ['docs'],
          wiki_space_ids: [],
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/kb search init', { message_id: 'm-kb' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('知识库搜索: init');
    expect(reply).toContain('docs/guide.md');
  });

  it('searches Feishu wiki documents through /wiki search', async () => {
    const setup = await createService();
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v1: {
          node: {
            search: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                items: [
                  {
                    title: '部署手册',
                    space_id: 'space-1',
                    node_id: 'node-1',
                    obj_token: 'doxcn123',
                    url: 'https://example.feishu.cn/docx/doxcn123',
                  },
                ],
              },
            }),
          },
        },
        v2: {
          space: {
            list: vi.fn().mockResolvedValue({
              code: 0,
              data: { items: [], has_more: false },
            }),
          },
        },
      },
      docx: {
        v1: {
          document: {
            get: vi.fn(),
            rawContent: vi.fn(),
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki search 部署', { message_id: 'm-wiki' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('飞书知识库搜索: 部署');
    expect(reply).toContain('部署手册');
    expect(reply).toContain('doxcn123');
  });

  it('creates a Feishu wiki document through /wiki create', async () => {
    const setup = await createService({
      projects: {
        default: {
          root: '/tmp/project',
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: ['space-1'],
        },
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v2: {
          spaceNode: {
            create: vi.fn().mockResolvedValue({
              code: 0,
              data: {
                node: {
                  title: '部署手册',
                  space_id: 'space-1',
                  node_token: 'wikcn123',
                  obj_token: 'doxcn123',
                  obj_type: 'docx',
                },
              },
            }),
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki create 部署手册', { message_id: 'm-wiki-create' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('已创建飞书文档: 部署手册');
    expect(reply).toContain('空间: space-1');
    expect(reply).toContain('文档: doxcn123');
  });

  it('renames a Feishu wiki node through /wiki rename', async () => {
    const updateTitle = vi.fn().mockResolvedValue({ code: 0, data: {} });
    const setup = await createService({
      projects: {
        default: {
          root: '/tmp/project',
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: ['space-1'],
        },
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v2: {
          spaceNode: {
            updateTitle,
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki rename wikcn123 新标题', { message_id: 'm-wiki-rename' }));
    const reply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(reply).toContain('已更新知识库节点标题');
    expect(reply).toContain('节点: wikcn123');
    expect(reply).toContain('标题: 新标题');
    expect(updateTitle).toHaveBeenCalled();
  });

  it('copies and moves Feishu wiki nodes through commands', async () => {
    const copy = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        node: {
          title: '副本',
          space_id: 'space-1',
          node_token: 'wikcn-copy',
          obj_token: 'doxcn-copy',
          obj_type: 'docx',
        },
      },
    });
    const move = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        node: {
          title: '已移动',
          space_id: 'space-2',
          node_token: 'wikcn123',
          obj_token: 'doxcn123',
          obj_type: 'docx',
        },
      },
    });
    const setup = await createService({
      projects: {
        default: {
          root: '/tmp/project',
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: ['space-1'],
        },
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v2: {
          spaceNode: {
            copy,
            move,
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki copy wikcn123', { message_id: 'm-wiki-copy' }));
    const copyReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(copyReply).toContain('已复制知识库节点');
    expect(copyReply).toContain('目标空间: space-1');

    await setup.service.handleIncomingMessage(buildMessage('/wiki move space-src wikcn123 space-2', { message_id: 'm-wiki-move' }));
    const moveReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(moveReply).toContain('已移动知识库节点');
    expect(moveReply).toContain('源空间: space-src');
    expect(moveReply).toContain('目标空间: space-2');
  });

  it('lists and manages Feishu wiki space members through commands', async () => {
    const list = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        members: [
          {
            member_type: 'open_id',
            member_id: 'ou_123',
            member_role: 'admin',
            type: 'user',
          },
        ],
        has_more: false,
      },
    });
    const create = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        member: {
          member_type: 'open_id',
          member_id: 'ou_123',
          member_role: 'member',
          type: 'user',
        },
      },
    });
    const remove = vi.fn().mockResolvedValue({
      code: 0,
      data: {
        member: {
          member_type: 'open_id',
          member_id: 'ou_123',
          member_role: 'member',
          type: 'user',
        },
      },
    });
    const setup = await createService({
      projects: {
        default: {
          root: '/tmp/project',
          session_scope: 'chat',
          mention_required: false,
          knowledge_paths: [],
          wiki_space_ids: ['space-1'],
        },
      },
    });
    setup.feishuClient.createSdkClient.mockReturnValue({
      wiki: {
        v2: {
          spaceMember: {
            list,
            create,
            delete: remove,
          },
        },
      },
    });

    await setup.service.handleIncomingMessage(buildMessage('/wiki members', { message_id: 'm-wiki-members' }));
    const membersReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(membersReply).toContain('知识空间成员: space-1');
    expect(membersReply).toContain('ou_123');
    expect(membersReply).toContain('role: admin');

    await setup.service.handleIncomingMessage(buildMessage('/wiki grant space-1 open_id ou_123 admin', { message_id: 'm-wiki-grant' }));
    const grantReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(grantReply).toContain('已添加知识空间成员');
    expect(grantReply).toContain('空间: space-1');
    expect(grantReply).toContain('member_id: ou_123');

    await setup.service.handleIncomingMessage(buildMessage('/wiki revoke space-1 open_id ou_123 admin', { message_id: 'm-wiki-revoke' }));
    const revokeReply = setup.sendText.mock.calls.at(-1)?.[1] as string;
    expect(revokeReply).toContain('已移除知识空间成员');
    expect(revokeReply).toContain('空间: space-1');
    expect(revokeReply).toContain('member_id: ou_123');
  });
});

interface TestConfigOverrides extends Partial<Omit<BridgeConfig, 'service' | 'codex' | 'storage' | 'security' | 'feishu' | 'projects'>> {
  service?: Partial<BridgeConfig['service']>;
  codex?: Partial<BridgeConfig['codex']>;
  storage?: Partial<BridgeConfig['storage']>;
  security?: Partial<BridgeConfig['security']>;
  feishu?: Partial<BridgeConfig['feishu']>;
  projects?: BridgeConfig['projects'];
}

async function createService(overrides: TestConfigOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-feishu-service-'));
  tempDirs.push(dir);

  const config = buildConfig(dir, overrides);
  const sessionStore = new SessionStore(config.storage.dir);
  const auditLog = new AuditLog(config.storage.dir);
  const idempotencyStore = new IdempotencyStore(config.storage.dir);
  const runStateStore = new RunStateStore(config.storage.dir);
  const sendText = vi.fn().mockResolvedValue({ message_id: 'm-1', open_message_id: 'm-1' });
  const sendCard = vi.fn().mockResolvedValue({ message_id: 'm-card', open_message_id: 'm-card' });
  const createSdkClient = vi.fn(() => ({}));
  const feishuClient = { sendText, sendCard, createSdkClient } as any;
  const service = new CodexFeishuService(config, feishuClient, sessionStore, auditLog, logger, undefined, idempotencyStore, runStateStore);

  return {
    config,
    service,
    sendText,
    sendCard,
    feishuClient,
    sessionStore,
    idempotencyStore,
    runStateStore,
  };
}

function buildConfig(dir: string, overrides: TestConfigOverrides): BridgeConfig {
  const base: BridgeConfig = {
    version: 1,
    service: {
      name: 'test-bridge',
      default_project: 'default',
      reply_mode: 'text',
      emit_progress_updates: false,
      progress_update_interval_ms: 4000,
      metrics_host: '127.0.0.1',
      idempotency_ttl_seconds: 86400,
      session_history_limit: 20,
      log_tail_lines: 100,
      reply_quote_user_message: false,
      reply_quote_max_chars: 120,
      download_message_resources: false,
      transcribe_audio_messages: false,
      describe_image_messages: false,
      openai_image_model: 'gpt-4.1-mini',
      memory_enabled: true,
      memory_search_limit: 3,
      memory_recent_limit: 5,
      memory_prompt_max_chars: 1600,
      thread_summary_max_chars: 1200,
      memory_group_enabled: false,
      memory_cleanup_interval_seconds: 1800,
      memory_max_pinned_per_scope: 5,
      memory_pin_overflow_strategy: 'age-out',
      memory_pin_age_basis: 'updated_at',
    },
    codex: {
      bin: 'codex',
      default_sandbox: 'workspace-write',
      skip_git_repo_check: true,
      output_token_limit: 4000,
      bridge_instructions: '',
      run_timeout_ms: 600000,
    },
    storage: {
      dir,
    },
    security: {
      allowed_project_roots: [],
      require_group_mentions: true,
    },
    feishu: {
      app_id: 'cli_test',
      app_secret: 'secret',
      dry_run: false,
      transport: 'long-connection',
      host: '127.0.0.1',
      port: 3333,
      event_path: '/webhook/event',
      card_path: '/webhook/card',
      allowed_chat_ids: [],
      allowed_group_ids: [],
    },
    projects: {
      default: {
        root: '/tmp/project',
        session_scope: 'chat',
        mention_required: false,
        knowledge_paths: [],
        wiki_space_ids: [],
      },
    },
  };

  return {
    ...base,
    ...overrides,
    service: { ...base.service, ...overrides.service },
    codex: { ...base.codex, ...overrides.codex },
    storage: { ...base.storage, ...overrides.storage },
    security: { ...base.security, ...overrides.security },
    feishu: { ...base.feishu, ...overrides.feishu },
    projects: overrides.projects ?? base.projects,
  };
}

function buildMessage(text: string, overrides: Partial<Parameters<CodexFeishuService['handleIncomingMessage']>[0]> = {}) {
  return {
    tenant_key: 'tenant',
    chat_id: 'chat',
    chat_type: 'p2p' as const,
    actor_id: 'user',
    message_id: overrides.message_id ?? `m-${Math.random()}`,
    message_type: 'text',
    text,
    attachments: [],
    mentions: [],
    raw: {},
    ...overrides,
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assertion();
}
