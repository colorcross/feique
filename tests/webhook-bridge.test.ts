import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config/schema.js';
import type { FeiqueService } from '../src/bridge/service.js';
import { createWebhookBridgeServer } from '../src/feishu/webhook.js';
import { buildReplayCardAction, buildReplayMessageEvent, postWebhookPayload } from '../src/feishu/replay.js';

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as any;

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  logger.debug.mockClear();
});

describe('webhook bridge', () => {
  it('routes replayed message and card payloads through the webhook server', async () => {
    const handleIncomingMessage = vi.fn().mockResolvedValue(undefined);
    const handleCardAction = vi.fn().mockResolvedValue({
      header: {
        title: { tag: 'plain_text', content: 'ok' },
      },
      elements: [],
    });

    const config = buildWebhookConfig();
    const server = await createWebhookBridgeServer({
      config,
      service: {
        handleIncomingMessage,
        handleCardAction,
      } as unknown as FeiqueService,
      logger,
    });
    servers.push(server);

    const messageResponse = await postWebhookPayload({
      url: `http://127.0.0.1:${server.address.port}${config.feishu.event_path}`,
      payload: buildReplayMessageEvent({
        appId: config.feishu.app_id,
        tenantKey: 'tenant-local',
        chatId: 'oc_message',
        chatType: 'p2p',
        actorId: 'ou_message',
        text: 'hello from replay',
      }),
    });

    expect(messageResponse.statusCode).toBe(200);
    expect(handleIncomingMessage).toHaveBeenCalledTimes(1);
    expect(handleIncomingMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 'oc_message',
        actor_id: 'ou_message',
        text: 'hello from replay',
      }),
    );

    const cardResponse = await postWebhookPayload({
      url: `http://127.0.0.1:${server.address.port}${config.feishu.card_path}`,
      payload: buildReplayCardAction({
        appId: config.feishu.app_id,
        tenantKey: 'tenant-local',
        chatId: 'oc_card',
        actorId: 'ou_card',
        openMessageId: 'om_card',
        action: 'status',
        projectAlias: 'default',
        conversationKey: 'tenant-local/oc_card/ou_card',
      }),
    });

    expect(cardResponse.statusCode).toBe(200);
    expect(handleCardAction).toHaveBeenCalledTimes(1);
    expect(handleCardAction).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 'oc_card',
        actor_id: 'ou_card',
        open_message_id: 'om_card',
        action_value: expect.objectContaining({
          action: 'status',
          project_alias: 'default',
        }),
      }),
    );
    expect(JSON.parse(cardResponse.body)).toMatchObject({
      header: {
        title: {
          content: 'ok',
        },
      },
    });
  });

  it('ignores non-user messages to avoid bot self-trigger loops', async () => {
    const handleIncomingMessage = vi.fn().mockResolvedValue(undefined);

    const config = buildWebhookConfig();
    const server = await createWebhookBridgeServer({
      config,
      service: {
        handleIncomingMessage,
        handleCardAction: vi.fn(),
      } as unknown as FeiqueService,
      logger,
    });
    servers.push(server);

    const response = await postWebhookPayload({
      url: `http://127.0.0.1:${server.address.port}${config.feishu.event_path}`,
      payload: buildReplayMessageEvent({
        appId: config.feishu.app_id,
        tenantKey: 'tenant-local',
        chatId: 'oc_app',
        chatType: 'p2p',
        actorId: 'ou_app',
        senderType: 'app',
        text: '开始处理：default',
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(handleIncomingMessage).not.toHaveBeenCalled();
  });
});

function buildWebhookConfig(): BridgeConfig {
  return {
    version: 1,
    service: {
      name: 'test-bridge',
      default_project: 'default',
      project_switch_auto_adopt_latest: false,
      reply_mode: 'text',
      emit_progress_updates: true,
      progress_update_interval_ms: 4000,
      metrics_host: '127.0.0.1',
      idempotency_ttl_seconds: 86400,
      session_history_limit: 20,
      log_tail_lines: 100,
      log_rotate_max_bytes: 10 * 1024 * 1024,
      log_rotate_keep_files: 5,
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
      audit_archive_after_days: 7,
      audit_retention_days: 30,
      audit_cleanup_interval_seconds: 3600,
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
      run_timeout_ms: 1800000,
    },
    backend: { default: 'codex' },
    claude: { bin: 'claude', default_permission_mode: 'auto', output_token_limit: 4000 },
    storage: {
      dir: '/tmp/feique-test',
    },
    security: {
      allowed_project_roots: [],
      admin_chat_ids: [],
      require_group_mentions: true,
    },
    mcp: {
      transport: 'stdio',
      host: '127.0.0.1',
      port: 8765,
      path: '/mcp',
      sse_path: '/mcp/sse',
      message_path: '/mcp/message',
      auth_tokens: [],
    },
    feishu: {
      app_id: 'cli_test',
      app_secret: 'secret',
      dry_run: false,
      transport: 'webhook',
      host: '127.0.0.1',
      port: 0 as unknown as number,
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
        admin_chat_ids: [],
        run_priority: 100,
        chat_rate_limit_window_seconds: 60,
        chat_rate_limit_max_runs: 20,
      },
    },
  };
}
