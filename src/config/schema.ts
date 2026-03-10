import { z } from 'zod';

export const sandboxSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export const sessionScopeSchema = z.enum(['chat', 'chat-user']);
export const transportSchema = z.enum(['long-connection', 'webhook']);
export const replyModeSchema = z.enum(['text', 'card']);

export const projectSchema = z.object({
  root: z.string(),
  profile: z.string().optional(),
  sandbox: sandboxSchema.optional(),
  session_scope: sessionScopeSchema.default('chat'),
  mention_required: z.boolean().default(false),
  description: z.string().optional(),
  instructions_prefix: z.string().optional(),
});

export const bridgeConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  service: z
    .object({
      name: z.string().default('codex-feishu'),
      default_project: z.string().optional(),
      reply_mode: replyModeSchema.default('text'),
      emit_progress_updates: z.boolean().default(false),
      progress_update_interval_ms: z.number().int().positive().default(4000),
      metrics_host: z.string().default('127.0.0.1'),
      metrics_port: z.number().int().positive().optional(),
      idempotency_ttl_seconds: z.number().int().positive().default(86400),
      session_history_limit: z.number().int().positive().default(20),
      log_tail_lines: z.number().int().positive().default(100),
      reply_quote_user_message: z.boolean().default(true),
      reply_quote_max_chars: z.number().int().positive().default(120),
    })
    .default({
      name: 'codex-feishu',
      reply_mode: 'text',
      emit_progress_updates: false,
      progress_update_interval_ms: 4000,
      metrics_host: '127.0.0.1',
      idempotency_ttl_seconds: 86400,
      session_history_limit: 20,
      log_tail_lines: 100,
      reply_quote_user_message: true,
      reply_quote_max_chars: 120,
    }),
  codex: z
    .object({
      bin: z.string().default('codex'),
      shell: z.string().optional(),
      pre_exec: z.string().optional(),
      default_profile: z.string().optional(),
      default_sandbox: sandboxSchema.default('workspace-write'),
      skip_git_repo_check: z.boolean().default(true),
      output_token_limit: z.number().int().positive().default(4000),
      bridge_instructions: z.string().default(''),
      run_timeout_ms: z.number().int().positive().default(600000),
    })
    .default({
      bin: 'codex',
      default_sandbox: 'workspace-write',
      skip_git_repo_check: true,
      output_token_limit: 4000,
      bridge_instructions: '',
      run_timeout_ms: 600000,
    }),
  storage: z
    .object({
      dir: z.string().default('~/.codex-feishu/state'),
    })
    .default({
      dir: '~/.codex-feishu/state',
    }),
  security: z
    .object({
      allowed_project_roots: z.array(z.string()).default([]),
      require_group_mentions: z.boolean().default(true),
    })
    .default({
      allowed_project_roots: [],
      require_group_mentions: true,
    }),
  feishu: z.object({
    app_id: z.string(),
    app_secret: z.string(),
    dry_run: z.boolean().default(false),
    encrypt_key: z.string().optional(),
    verification_token: z.string().optional(),
    bot_name: z.string().optional(),
    transport: transportSchema.default('long-connection'),
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(3333),
    event_path: z.string().default('/webhook/event'),
    card_path: z.string().default('/webhook/card'),
    allowed_chat_ids: z.array(z.string()).default([]),
    allowed_group_ids: z.array(z.string()).default([]),
  }),
  projects: z.record(z.string(), projectSchema).default({}),
});

export type BridgeConfig = z.infer<typeof bridgeConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type SandboxMode = z.infer<typeof sandboxSchema>;
export type SessionScope = z.infer<typeof sessionScopeSchema>;
export type BridgeTransport = z.infer<typeof transportSchema>;
export type ReplyMode = z.infer<typeof replyModeSchema>;
