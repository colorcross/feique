import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '../src/config/schema.js';
import { findMissingEnvRefs, formatDoctorFinding, hasDoctorErrors, mapInspectResultToDoctorFindings, runDoctor } from '../src/config/doctor.js';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn((bin: string, args: string[]) => {
    if (args.join(' ') === '--version') {
      return { status: 0, stdout: 'codex 0.1.0\n' };
    }
    if (args.join(' ') === 'exec --help') {
      return { status: 0, stdout: 'Usage: codex exec\n  -C, --cd <DIR>\n  -s, --sandbox <MODE>\n  -p, --profile <PROFILE>\n  --json\n  -o, --output-last-message <FILE>\n' };
    }
    if (args.join(' ') === 'exec resume --help') {
      return { status: 0, stdout: 'Usage: codex exec resume\n  --json\n' };
    }
    return { status: 1, stdout: '' };
  }),
}));

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  delete process.env.DOCTOR_PRESENT_VAR;
  spawnSyncMock.mockClear();
});

describe('doctor', () => {
  it('reports config risks and project root state', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-doctor-'));
    tempDirs.push(workspace);

    const projectRoot = path.join(workspace, 'repo-a');
    await fs.mkdir(projectRoot, { recursive: true });

    const config: BridgeConfig = {
      version: 1,
      service: {
        name: 'feique',
        default_project: 'missing-project',
        project_switch_auto_adopt_latest: false,
        reply_mode: 'card',
        emit_progress_updates: true,
        progress_update_interval_ms: 4000,
        metrics_host: '127.0.0.1',
        idempotency_ttl_seconds: 30,
        session_history_limit: 20,
        log_tail_lines: 100,
        log_rotate_max_bytes: 10 * 1024 * 1024,
        log_rotate_keep_files: 5,
        reply_quote_user_message: false,
        reply_quote_max_chars: 120,
        download_message_resources: false,
        transcribe_audio_messages: true,
        describe_image_messages: true,
        openai_image_model: 'gpt-4.1-mini',
        memory_enabled: true,
        memory_search_limit: 3,
        memory_recent_limit: 5,
        memory_prompt_max_chars: 1600,
        thread_summary_max_chars: 1200,
        memory_group_enabled: true,
        memory_cleanup_interval_seconds: 30,
        audit_archive_after_days: 40,
        audit_retention_days: 30,
        audit_cleanup_interval_seconds: 120,
        memory_max_pinned_per_scope: 5,
        memory_pin_overflow_strategy: 'age-out',
        memory_pin_age_basis: 'updated_at', team_digest_enabled: false, team_digest_interval_hours: 24, team_digest_chat_ids: [],
      },
      codex: {
        bin: 'codex',
        default_sandbox: 'workspace-write',
        output_token_limit: 4000,
        skip_git_repo_check: true,
        bridge_instructions: '',
        run_timeout_ms: 500,
      },
      backend: { default: 'codex' },
      claude: { bin: 'claude', default_permission_mode: 'auto', output_token_limit: 4000 },
      storage: {
        dir: path.join(workspace, 'state'),
      },
      security: {
        allowed_project_roots: [workspace],
        admin_chat_ids: [],
        require_group_mentions: false,
      },
      mcp: {
        transport: 'http',
        host: '127.0.0.1',
        port: 8765,
        path: '/mcp',
        sse_path: '/mcp/sse',
        message_path: '/mcp/message',
        active_auth_token_id: 'missing',
        auth_tokens: [],
      },
      feishu: {
        app_id: 'app-id',
        app_secret: 'app-secret',
        dry_run: false,
        transport: 'webhook',
        host: '0.0.0.0',
        port: 3333,
        event_path: '/webhook/shared',
        card_path: '/webhook/shared',
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
        'repo-a': {
          root: projectRoot,
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

    const findings = await runDoctor(config);
    const messages = findings.map((finding) => `[${finding.level}] ${finding.message}`);

    expect(messages).toContain('[info] Codex detected: codex 0.1.0');
    expect(messages).toContain('[info] Codex resume capabilities: json=true output_last_message=false cd=false');
    expect(messages).toContain('[error] service.default_project does not exist: missing-project');
    expect(messages).toContain('[warn] Webhook mode is enabled but verification_token is empty.');
    expect(messages).toContain('[warn] Webhook mode is enabled but encrypt_key is empty.');
    expect(messages).toContain('[warn] feishu.allowed_chat_ids is empty; all p2p chats are allowed.');
    expect(messages).toContain('[warn] feishu.allowed_group_ids is empty; all groups are allowed.');
    expect(messages).toContain('[warn] service.idempotency_ttl_seconds is very low; duplicate message suppression may be ineffective.');
    expect(messages).toContain('[warn] codex.run_timeout_ms is very low; Codex runs may abort before producing output.');
    expect(messages).toContain('[warn] service.transcribe_audio_messages is enabled but download_message_resources is disabled; audio files cannot be transcribed.');
    expect(messages).toContain('[warn] service.transcribe_audio_messages is enabled but OPENAI_API_KEY is missing; audio transcription will be skipped.');
    expect(messages).toContain('[warn] service.describe_image_messages is enabled but download_message_resources is disabled; images cannot be described.');
    expect(messages).toContain('[warn] service.describe_image_messages is enabled but OPENAI_API_KEY is missing; image descriptions will be skipped.');
    expect(messages).toContain('[warn] service.memory_group_enabled is enabled while feishu.allowed_group_ids is empty; group shared memory will be available in every group.');
    expect(messages).toContain('[warn] service.memory_group_enabled is enabled while security.require_group_mentions=false; group memory can be influenced by non-@ messages if the project also disables mention_required.');
    expect(messages).toContain('[warn] service.memory_cleanup_interval_seconds is very low; background memory cleanup may generate unnecessary churn.');
    expect(messages).toContain('[warn] service.audit_cleanup_interval_seconds is very low; audit retention cleanup may generate unnecessary churn.');
    expect(messages).toContain('[warn] service.audit_archive_after_days should be lower than service.audit_retention_days, otherwise archived audit events may be removed immediately.');
    expect(messages).toContain('[error] feishu.event_path and feishu.card_path must not be identical.');
    expect(messages).toContain('[warn] mcp.transport=http is enabled without any MCP auth token; MCP HTTP/SSE endpoints will be exposed without authentication.');
    expect(messages).toContain('[warn] mcp.active_auth_token_id does not point to an enabled token: missing');
    expect(messages).toContain(`[info] Storage directory ready: ${path.join(workspace, 'state')}`);
    expect(messages).toContain(`[info] Project repo-a root found: ${projectRoot}`);
    expect(messages).toContain(`[warn] Project repo-a has mention_required=false; group chats can trigger runs without @mention.`);
    expect(messages).toContain(`[warn] Project repo-a is not a Git repository: ${projectRoot}`);
    expect(messages).toContain('[info] 使用本地向量化（无需外部服务）');
  });

  it('finds missing env references from config files', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-env-'));
    tempDirs.push(workspace);

    process.env.DOCTOR_PRESENT_VAR = 'present';

    const configPath = path.join(workspace, 'config.toml');
    await fs.writeFile(
      configPath,
      [
        'version = 1',
        '',
        '[feishu]',
        'app_id = "env:DOCTOR_MISSING_APP_ID"',
        'app_secret = "env:DOCTOR_PRESENT_VAR"',
        '',
        '[storage]',
        'dir = "env:DOCTOR_MISSING_STORAGE"',
      ].join('\n'),
      'utf8',
    );

    const findings = await findMissingEnvRefs([configPath]);
    expect(findings).toEqual([
      { level: 'error', message: 'Missing environment variable: DOCTOR_MISSING_APP_ID' },
      { level: 'error', message: 'Missing environment variable: DOCTOR_MISSING_STORAGE' },
    ]);
  });

  it('formats and classifies doctor findings', () => {
    expect(formatDoctorFinding({ level: 'warn', message: 'warning' })).toBe('[warn] warning');
    expect(hasDoctorErrors([{ level: 'info', message: 'ok' }, { level: 'error', message: 'broken' }])).toBe(true);
    expect(hasDoctorErrors([{ level: 'warn', message: 'watch this' }])).toBe(false);
  });

  it('checks Ollama embedding health when provider is ollama', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'feique-doctor-ollama-'));
    tempDirs.push(workspace);

    const projectRoot = path.join(workspace, 'repo-a');
    await fs.mkdir(projectRoot, { recursive: true });

    const baseConfig: BridgeConfig = {
      version: 1,
      service: {
        name: 'feique',
        default_project: 'repo-a',
        project_switch_auto_adopt_latest: false,
        reply_mode: 'text',
        emit_progress_updates: false,
        progress_update_interval_ms: 4000,
        metrics_host: '127.0.0.1',
        idempotency_ttl_seconds: 300,
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
        memory_enabled: false,
        memory_search_limit: 3,
        memory_recent_limit: 5,
        memory_prompt_max_chars: 1600,
        thread_summary_max_chars: 1200,
        memory_group_enabled: false,
        memory_cleanup_interval_seconds: 3600,
        audit_archive_after_days: 7,
        audit_retention_days: 30,
        audit_cleanup_interval_seconds: 3600,
        memory_max_pinned_per_scope: 5,
        memory_pin_overflow_strategy: 'age-out',
        memory_pin_age_basis: 'updated_at', team_digest_enabled: false, team_digest_interval_hours: 24, team_digest_chat_ids: [],
      },
      codex: {
        bin: 'codex',
        default_sandbox: 'workspace-write',
        output_token_limit: 4000,
        skip_git_repo_check: true,
        bridge_instructions: '',
        run_timeout_ms: 60000,
      },
      backend: { default: 'codex' },
      claude: { bin: 'claude', default_permission_mode: 'auto', output_token_limit: 4000 },
      storage: { dir: path.join(workspace, 'state') },
      security: {
        allowed_project_roots: [workspace],
        admin_chat_ids: [],
        require_group_mentions: true,
      },
      mcp: {
        transport: 'stdio' as 'stdio',
        host: '127.0.0.1',
        port: 8765,
        path: '/mcp',
        sse_path: '/mcp/sse',
        message_path: '/mcp/message',
        auth_tokens: [],
      },
      feishu: {
        app_id: 'app-id',
        app_secret: 'app-secret',
        dry_run: false,
        transport: 'webhook',
        host: '0.0.0.0',
        port: 3333,
        event_path: '/webhook/event',
        card_path: '/webhook/card',
        verification_token: 'tok',
        encrypt_key: 'key',
        allowed_chat_ids: ['c1'],
        allowed_group_ids: ['g1'],
      },
      embedding: {
        provider: 'ollama' as const,
        ollama_base_url: 'http://127.0.0.1:11434',
        ollama_model: 'auto',
        ollama_timeout_ms: 5000,
      },
      projects: {
        'repo-a': {
          root: projectRoot,
          session_scope: 'chat',
          mention_required: true,
          knowledge_paths: [],
          wiki_space_ids: [],
          admin_chat_ids: [],
          run_priority: 100,
          chat_rate_limit_window_seconds: 60,
          chat_rate_limit_max_runs: 20,
        },
      },
    };

    // Case 1: Ollama reachable, embedding model found
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: 'qwen3-embedding:8b', model: 'qwen3-embedding:8b', size: 0 }] }), { status: 200 }),
    );

    let findings = await runDoctor(baseConfig);
    let messages = findings.map((f) => `[${f.level}] ${f.message}`);
    expect(messages).toContain('[info] Ollama 嵌入服务可用，模型: qwen3-embedding:8b');

    fetchSpy.mockRestore();

    // Case 2: Ollama reachable, no embedding models (only non-embedding models)
    const fetchSpy2 = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: 'llama3:8b', model: 'llama3:8b', size: 0 }] }), { status: 200 }),
    );

    findings = await runDoctor(baseConfig);
    messages = findings.map((f) => `[${f.level}] ${f.message}`);
    expect(messages).toContain('[warn] Ollama 可用但未找到嵌入模型，将回退到本地向量化');

    fetchSpy2.mockRestore();

    // Case 3: Ollama not reachable
    const fetchSpy3 = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    findings = await runDoctor(baseConfig);
    messages = findings.map((f) => `[${f.level}] ${f.message}`);
    expect(messages).toContain('[error] Ollama 不可达 (http://127.0.0.1:11434)，嵌入功能降级');

    fetchSpy3.mockRestore();
  });

  it('maps remote Feishu diagnostics into doctor findings', () => {
    const findings = mapInspectResultToDoctorFindings({
      app_id: 'cli_test',
      transport: 'long-connection',
      token: { ok: true, code: 0, msg: 'ok', expire: 7200 },
      app: { ok: true, code: 0, msg: 'success', name: '源码牛', status: 2 },
      bot: { ok: true, code: 0, msg: 'ok', name: '源码牛', activate_status: 0, open_id: 'ou_test' },
      chats_probe: { ok: false, code: 232034, msg: 'The app is unavailable or inactivate in the tenant.' },
    });

    expect(findings).toContainEqual({ level: 'info', message: 'Feishu token check passed (expire=7200)' });
    expect(findings).toContainEqual({ level: 'warn', message: 'Feishu bot reachable: 源码牛 (activate_status=0)' });
    expect(findings).toContainEqual({
      level: 'error',
      message: 'Feishu IM availability check failed: code=232034 The app is unavailable or inactivate in the tenant.',
    });
  });
});
