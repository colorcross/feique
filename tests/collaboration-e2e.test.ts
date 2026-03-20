/**
 * End-to-end integration test for the full team collaboration workflow.
 *
 * Exercises /team, /learn, /recall, /handoff, /pickup, /review, /approve,
 * /insights, /trust, /timeline, /digest — and regular prompts — through
 * the real FeiqueService.handleIncomingMessage pipeline.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runCodexTurnMock = vi.fn();

vi.mock('../src/codex/runner.js', () => ({
  runCodexTurn: (...args: unknown[]) => runCodexTurnMock(...args),
  summarizeCodexEvent: vi.fn(() => null),
}));

import type { BridgeConfig, ProjectConfig } from '../src/config/schema.js';
import { FeiqueService } from '../src/bridge/service.js';
import { SessionStore } from '../src/state/session-store.js';
import { AuditLog } from '../src/state/audit-log.js';
import { IdempotencyStore } from '../src/state/idempotency-store.js';
import { RunStateStore } from '../src/state/run-state-store.js';
import { writeToml } from '../src/config/load.js';
import type { IncomingMessageContext } from '../src/bridge/types.js';

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

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
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ── Helpers ──────────────────────────────────────────────────────

interface TestConfigOverrides extends Partial<Omit<BridgeConfig, 'service' | 'codex' | 'storage' | 'security' | 'feishu' | 'projects'>> {
  service?: Partial<BridgeConfig['service']>;
  codex?: Partial<BridgeConfig['codex']>;
  storage?: Partial<BridgeConfig['storage']>;
  security?: Partial<BridgeConfig['security']>;
  feishu?: Partial<BridgeConfig['feishu']>;
  projects?: Record<string, Partial<ProjectConfig> & Pick<ProjectConfig, 'root'>>;
}

function normalizeProjects(projects: Record<string, Partial<ProjectConfig> & Pick<ProjectConfig, 'root'>>): BridgeConfig['projects'] {
  return Object.fromEntries(
    Object.entries(projects).map(([alias, project]) => [
      alias,
      {
        session_scope: 'chat' as const,
        mention_required: false,
        knowledge_paths: [],
        wiki_space_ids: [],
        admin_chat_ids: [],
        notification_chat_ids: [],
        run_priority: 100,
        chat_rate_limit_window_seconds: 60,
        chat_rate_limit_max_runs: 20,
        ...project,
      },
    ]),
  );
}

function buildConfig(dir: string, overrides: TestConfigOverrides): BridgeConfig {
  const base: BridgeConfig = {
    version: 1,
    service: {
      name: 'test-collab',
      default_project: 'alpha',
      project_switch_auto_adopt_latest: false,
      reply_mode: 'text',
      emit_progress_updates: false,
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
      team_digest_enabled: false,
      team_digest_interval_hours: 24,
      team_digest_chat_ids: [], intent_classifier_enabled: false, intent_classifier_model: 'qwen3.5:latest', intent_classifier_timeout_ms: 5000, intent_classifier_min_confidence: 0.8,
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
    storage: { dir },
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
      transport: 'long-connection',
      host: '127.0.0.1',
      port: 3333,
      event_path: '/webhook/event',
      card_path: '/webhook/card',
      allowed_chat_ids: [],
      allowed_group_ids: [],
    },
    embedding: {
      provider: 'local' as const,
      ollama_base_url: 'http://127.0.0.1:11434',
      ollama_model: 'auto',
      ollama_timeout_ms: 30000,
    },
    projects: {
      alpha: {
        root: '/tmp/alpha',
        session_scope: 'chat',
        mention_required: false,
        knowledge_paths: [],
        wiki_space_ids: [],
        admin_chat_ids: [],
        notification_chat_ids: [],
        run_priority: 100,
        chat_rate_limit_window_seconds: 60,
        chat_rate_limit_max_runs: 20,
      },
      beta: {
        root: '/tmp/beta',
        session_scope: 'chat',
        mention_required: false,
        knowledge_paths: [],
        wiki_space_ids: [],
        admin_chat_ids: [],
        notification_chat_ids: [],
        run_priority: 100,
        chat_rate_limit_window_seconds: 60,
        chat_rate_limit_max_runs: 20,
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
    projects: normalizeProjects(overrides.projects ?? base.projects),
  };
}

async function createService(overrides: TestConfigOverrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-collab-e2e-'));
  tempDirs.push(dir);

  const config = buildConfig(dir, overrides);
  const configPath = path.join(dir, 'config.toml');
  await writeToml(configPath, config as unknown as Record<string, unknown>);

  const sessionStore = new SessionStore(config.storage.dir);
  const auditLog = new AuditLog(config.storage.dir);
  const idempotencyStore = new IdempotencyStore(config.storage.dir);
  const runStateStore = new RunStateStore(config.storage.dir);

  const sendText = vi.fn().mockResolvedValue({ message_id: 'm-1', open_message_id: 'm-1' });
  const sendCard = vi.fn().mockResolvedValue({ message_id: 'm-card', open_message_id: 'm-card' });
  const sendPost = vi.fn().mockResolvedValue({ message_id: 'm-post', open_message_id: 'm-post' });
  const updateText = vi.fn().mockResolvedValue({ message_id: 'm-1', open_message_id: 'm-1' });
  const updateCard = vi.fn().mockResolvedValue({ message_id: 'm-card', open_message_id: 'm-card' });
  const updatePost = vi.fn().mockResolvedValue({ message_id: 'm-post', open_message_id: 'm-post' });
  const createSdkClient = vi.fn(() => ({}));
  const restart = vi.fn().mockResolvedValue(undefined);
  const feishuClient = { sendText, sendCard, sendPost, updateText, updateCard, updatePost, createSdkClient } as any;

  const service = new FeiqueService(
    config,
    feishuClient,
    sessionStore,
    auditLog,
    logger,
    undefined,         // metrics
    idempotencyStore,
    runStateStore,
    undefined,         // memoryStore — let default kick in
    undefined,         // codexSessionIndex — let default kick in
    { configPath, restart },
  );

  return {
    config,
    service,
    sendText,
    sendCard,
    updateText,
    updateCard,
    feishuClient,
    sessionStore,
    runStateStore,
    restart,
  };
}

let messageCounter = 0;

function buildMessage(
  text: string,
  overrides: Partial<IncomingMessageContext> = {},
): IncomingMessageContext {
  messageCounter += 1;
  return {
    tenant_key: 'tenant',
    chat_id: 'chat-collab',
    chat_type: 'p2p',
    actor_id: 'alice',
    message_id: overrides.message_id ?? `m-collab-${messageCounter}`,
    message_type: 'text',
    text,
    attachments: [],
    mentions: [],
    raw: {},
    ...overrides,
  };
}

function lastTextReply(sendText: ReturnType<typeof vi.fn>): string {
  return sendText.mock.calls.at(-1)?.[1] as string;
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

// ── Test Suite ───────────────────────────────────────────────────

describe('collaboration e2e: full team workflow', () => {
  /**
   * We reuse a single service instance across all sequential steps
   * so that state accumulates just like it would in production.
   */
  let setup: Awaited<ReturnType<typeof createService>>;

  beforeEach(async () => {
    messageCounter = 0;
    setup = await createService();
  });

  // ── Step 1: Trust check ──

  it('starts at execute trust level by default', async () => {
    await setup.service.handleIncomingMessage(buildMessage('/trust'));
    const reply = lastTextReply(setup.sendText);
    expect(reply).toContain('信任状态');
    expect(reply).toContain('执行');
  });

  // ── Step 2: Team activity (empty) ──

  it('shows no active members when nothing is running', async () => {
    await setup.service.handleIncomingMessage(buildMessage('/team'));
    const reply = lastTextReply(setup.sendText);
    expect(reply).toContain('没有活跃的团队成员');
  });

  // ── Step 3: Knowledge learn ──

  it('saves team knowledge via /learn', async () => {
    await setup.service.handleIncomingMessage(
      buildMessage('/learn 部署前必须跑完测试'),
    );
    const reply = lastTextReply(setup.sendText);
    expect(reply).toContain('团队知识已记录');
    expect(reply).toContain('部署前必须跑完测试');
  });

  // ── Step 4: Knowledge recall ──

  it('recalls saved knowledge via /recall', async () => {
    // First save something to recall
    await setup.service.handleIncomingMessage(
      buildMessage('/learn 部署前必须跑完测试'),
    );

    await setup.service.handleIncomingMessage(
      buildMessage('/recall 部署'),
    );
    const reply = lastTextReply(setup.sendText);
    expect(reply).toContain('团队知识检索');
    expect(reply).toContain('部署');
  });

  // ── Step 5: Start a Codex run ──

  it('triggers a codex run via a plain prompt', async () => {
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-collab-1',
      finalMessage: 'bug fixed successfully',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'codex-cli 0.98.0', exec: {}, resume: {} },
    });

    await setup.service.handleIncomingMessage(buildMessage('fix the bug'));

    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(setup.updateText.mock.calls.at(-1)?.[1]).toContain('bug fixed successfully');
  });

  // ── Step 6: Team activity during a run ──

  it('shows active members when a run is in progress', async () => {
    let resolveRun: ((value: unknown) => void) | undefined;
    runCodexTurnMock.mockImplementation(
      () => new Promise((resolve) => { resolveRun = resolve; }),
    );

    const runPromise = setup.service.handleIncomingMessage(buildMessage('long task'));
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(1));

    // Query /team from a second user while the run is active
    await setup.service.handleIncomingMessage(
      buildMessage('/team', { actor_id: 'bob', message_id: 'm-team-during-run' }),
    );
    const reply = lastTextReply(setup.sendText);
    expect(reply).toContain('团队 AI 协作态势');
    expect(reply).toContain('alice');
    expect(reply).toContain('alpha');

    // Resolve the run so the test finishes cleanly
    resolveRun?.({
      sessionId: 'thread-collab-run',
      finalMessage: 'done',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await runPromise;
  });

  // ── Step 7: Insights ──

  it('returns an insights health report', async () => {
    await setup.service.handleIncomingMessage(buildMessage('/insights'));
    const reply = lastTextReply(setup.sendText);
    // With minimal data, should show the "all normal" message or a report
    expect(reply).toContain('体检');
  });

  // ── Step 8: Handoff + Pickup ──

  it('creates a handoff and allows another actor to pick it up', async () => {
    // Run something first so there's session state
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-handoff',
      finalMessage: 'partial progress',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(buildMessage('start the work'));

    // Alice creates a handoff
    await setup.service.handleIncomingMessage(
      buildMessage('/handoff 做到一半了'),
    );
    const handoffReply = lastTextReply(setup.sendText);
    expect(handoffReply).toContain('会话交接');
    expect(handoffReply).toContain('alpha');
    expect(handoffReply).toContain('做到一半了');
    expect(handoffReply).toContain('/pickup');

    // Bob picks it up
    await setup.service.handleIncomingMessage(
      buildMessage('我来接手', { actor_id: 'bob', message_id: 'm-pickup' }),
    );
    const pickupReply = lastTextReply(setup.sendText);
    expect(pickupReply).toContain('已接手');
    expect(pickupReply).toContain('alice');
    expect(pickupReply).toContain('alpha');
  });

  // ── Step 9: Review + Approve ──

  it('creates a review and approves it', async () => {
    // We need a completed run for review to find
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-review',
      finalMessage: 'code changes ready',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(buildMessage('apply the patch'));

    // Create review
    await setup.service.handleIncomingMessage(
      buildMessage('/review', { message_id: 'm-review' }),
    );
    const reviewReply = lastTextReply(setup.sendText);
    expect(reviewReply).toContain('评审请求');
    expect(reviewReply).toContain('alpha');
    expect(reviewReply).toContain('/approve');

    // Approve the review (natural language)
    await setup.service.handleIncomingMessage(
      buildMessage('通过', { message_id: 'm-approve' }),
    );
    const approveReply = lastTextReply(setup.sendText);
    expect(approveReply).toContain('已批准');
  });

  // ── Step 10: Timeline ──

  it('shows project activity in the timeline', async () => {
    // Generate some activity first
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-timeline',
      finalMessage: 'done for timeline',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(buildMessage('do timeline work'));
    await setup.service.handleIncomingMessage(
      buildMessage('/learn 时间线测试知识'),
    );

    await setup.service.handleIncomingMessage(
      buildMessage('/timeline', { message_id: 'm-timeline' }),
    );
    const reply = lastTextReply(setup.sendText);
    // Timeline should have content (either events or "暂无活动记录")
    // Since we just ran something, it should show events
    expect(reply).toContain('项目时间线');
  });

  // ── Step 11: Digest ──

  it('generates a team digest', async () => {
    await setup.service.handleIncomingMessage(
      buildMessage('/digest', { message_id: 'm-digest' }),
    );
    const reply = lastTextReply(setup.sendText);
    // Digest always shows the header
    expect(reply).toContain('团队 AI 协作日报');
  });

  // ── Step 12: Trust set ──

  it('changes trust level via natural language', async () => {
    await setup.service.handleIncomingMessage(
      buildMessage('设置信任等级为建议', { message_id: 'm-trust-set' }),
    );
    const setReply = lastTextReply(setup.sendText);
    expect(setReply).toContain('信任等级已设置为');
    expect(setReply).toContain('suggest');

    // Verify the change persisted
    await setup.service.handleIncomingMessage(
      buildMessage('/trust', { message_id: 'm-trust-verify' }),
    );
    const verifyReply = lastTextReply(setup.sendText);
    expect(verifyReply).toContain('建议');
  });

  // ── Step 13: Full sequence in one service instance ──

  it('runs the entire collaboration flow end-to-end in sequence', async () => {
    // 1. Trust check → starts at execute
    await setup.service.handleIncomingMessage(
      buildMessage('/trust', { message_id: 'm-e2e-trust-1' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('执行');

    // 2. Team → no active members
    await setup.service.handleIncomingMessage(
      buildMessage('/team', { message_id: 'm-e2e-team-1' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('没有活跃的团队成员');

    // 3. Learn
    await setup.service.handleIncomingMessage(
      buildMessage('/learn 部署前必须跑完测试', { message_id: 'm-e2e-learn' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('团队知识已记录');

    // 4. Recall
    await setup.service.handleIncomingMessage(
      buildMessage('/recall 部署', { message_id: 'm-e2e-recall' }),
    );
    const recallReply = lastTextReply(setup.sendText);
    expect(recallReply).toContain('团队知识检索');
    expect(recallReply).toContain('部署');

    // 5. Start a run
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-e2e-1',
      finalMessage: 'bug fixed',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(
      buildMessage('fix the bug', { message_id: 'm-e2e-run' }),
    );
    expect(runCodexTurnMock).toHaveBeenCalledTimes(1);
    expect(setup.updateText.mock.calls.at(-1)?.[1]).toContain('bug fixed');

    // 6. Team during run — run already completed, but let's start another
    let resolveRun: ((value: unknown) => void) | undefined;
    runCodexTurnMock.mockImplementation(
      () => new Promise((resolve) => { resolveRun = resolve; }),
    );
    const runPromise = setup.service.handleIncomingMessage(
      buildMessage('long running task', { message_id: 'm-e2e-long-run' }),
    );
    await waitFor(() => expect(runCodexTurnMock).toHaveBeenCalledTimes(2));

    await setup.service.handleIncomingMessage(
      buildMessage('/team', { actor_id: 'bob', message_id: 'm-e2e-team-2' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('alice');

    resolveRun?.({
      sessionId: 'thread-e2e-long',
      finalMessage: 'long task done',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await runPromise;

    // 7. Insights
    await setup.service.handleIncomingMessage(
      buildMessage('/insights', { message_id: 'm-e2e-insights' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('体检');

    // 8. Handoff
    await setup.service.handleIncomingMessage(
      buildMessage('/handoff 做到一半了', { message_id: 'm-e2e-handoff' }),
    );
    const handoffReply = lastTextReply(setup.sendText);
    expect(handoffReply).toContain('会话交接');
    expect(handoffReply).toContain('做到一半了');

    // 9. Pickup (from bob)
    await setup.service.handleIncomingMessage(
      buildMessage('我来接手', { actor_id: 'bob', message_id: 'm-e2e-pickup' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('已接手');

    // 10. Review — need a completed run first (we have one from step 5)
    await setup.service.handleIncomingMessage(
      buildMessage('/review', { message_id: 'm-e2e-review' }),
    );
    const reviewReply = lastTextReply(setup.sendText);
    expect(reviewReply).toContain('评审请求');

    // 11. Approve
    await setup.service.handleIncomingMessage(
      buildMessage('通过', { message_id: 'm-e2e-approve' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('已批准');

    // 12. Timeline
    await setup.service.handleIncomingMessage(
      buildMessage('/timeline', { message_id: 'm-e2e-timeline' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('项目时间线');

    // 13. Digest
    await setup.service.handleIncomingMessage(
      buildMessage('/digest', { message_id: 'm-e2e-digest' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('团队 AI 协作日报');

    // 14. Trust set (natural language)
    await setup.service.handleIncomingMessage(
      buildMessage('设置信任等级为建议', { message_id: 'm-e2e-trust-set' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('信任等级已设置为');

    // 15. Verify trust changed
    await setup.service.handleIncomingMessage(
      buildMessage('/trust', { message_id: 'm-e2e-trust-verify' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('建议');
  });

  // ── Step 14: Cross-actor collaboration ──

  it('supports multi-actor collaboration across handoff and review', async () => {
    // Alice runs something
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-multi-1',
      finalMessage: 'alice progress',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(
      buildMessage('start feature work', { actor_id: 'alice', message_id: 'm-multi-run' }),
    );

    // Alice learns something
    await setup.service.handleIncomingMessage(
      buildMessage('/learn 注意：API 限流阈值改到 100/min', { actor_id: 'alice', message_id: 'm-multi-learn' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('团队知识已记录');

    // Alice hands off
    await setup.service.handleIncomingMessage(
      buildMessage('/handoff feature 做了一半，API 调通了', { actor_id: 'alice', message_id: 'm-multi-handoff' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('会话交接');

    // Bob recalls Alice's knowledge
    await setup.service.handleIncomingMessage(
      buildMessage('/recall API 限流', { actor_id: 'bob', message_id: 'm-multi-recall' }),
    );
    const recallReply = lastTextReply(setup.sendText);
    expect(recallReply).toContain('API');

    // Bob picks up the handoff
    await setup.service.handleIncomingMessage(
      buildMessage('我来接手', { actor_id: 'bob', message_id: 'm-multi-pickup' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('已接手');
    expect(lastTextReply(setup.sendText)).toContain('alice');

    // Bob continues working
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-multi-2',
      finalMessage: 'feature complete',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(
      buildMessage('finish the feature', { actor_id: 'bob', message_id: 'm-multi-continue' }),
    );

    // Bob requests a review
    await setup.service.handleIncomingMessage(
      buildMessage('/review', { actor_id: 'bob', message_id: 'm-multi-review' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('评审请求');

    // Charlie approves
    await setup.service.handleIncomingMessage(
      buildMessage('/approve 代码看着不错', { actor_id: 'charlie', message_id: 'm-multi-approve' }),
    );
    const approveReply = lastTextReply(setup.sendText);
    expect(approveReply).toContain('已批准');
    expect(approveReply).toContain('charlie');
    expect(approveReply).toContain('代码看着不错');
  });

  // ── Step 15: Reject flow ──

  it('supports review rejection', async () => {
    runCodexTurnMock.mockResolvedValue({
      sessionId: 'thread-reject',
      finalMessage: 'questionable output',
      stderr: '',
      exitCode: 0,
      capabilities: { version: 'v', exec: {}, resume: {} },
    });
    await setup.service.handleIncomingMessage(
      buildMessage('generate risky code', { message_id: 'm-reject-run' }),
    );

    await setup.service.handleIncomingMessage(
      buildMessage('/review', { message_id: 'm-reject-review' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('评审请求');

    await setup.service.handleIncomingMessage(
      buildMessage('/reject 需要加更多错误处理', { message_id: 'm-reject' }),
    );
    const rejectReply = lastTextReply(setup.sendText);
    expect(rejectReply).toContain('已打回');
    expect(rejectReply).toContain('需要加更多错误处理');
  });

  // ── Step 16: Trust level progression ──

  it('supports trust level transitions through all levels', async () => {
    // Start at execute (default)
    await setup.service.handleIncomingMessage(
      buildMessage('/trust', { message_id: 'm-trust-start' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('执行');

    // Set to observe
    await setup.service.handleIncomingMessage(
      buildMessage('/trust set observe', { message_id: 'm-trust-observe' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('信任等级已设置为');

    // Set to suggest
    await setup.service.handleIncomingMessage(
      buildMessage('/trust set suggest', { message_id: 'm-trust-suggest' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('信任等级已设置为');

    // Set to autonomous
    await setup.service.handleIncomingMessage(
      buildMessage('/trust set autonomous', { message_id: 'm-trust-auto' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('信任等级已设置为');

    // Verify final state
    await setup.service.handleIncomingMessage(
      buildMessage('/trust', { message_id: 'm-trust-final' }),
    );
    expect(lastTextReply(setup.sendText)).toContain('自主');
  });
});
