import fs from 'node:fs/promises';
import path from 'node:path';
import type { BridgeConfig } from './schema.js';
import { ensureDir } from '../utils/fs.js';
import { inspectFeishuEnvironment, type FeishuInspectResult } from '../feishu/diagnostics.js';
import { detectCodexCliCapabilities } from '../codex/capabilities.js';
import { spawnSync } from 'node:child_process';
import { getProjectCacheDir, getProjectDownloadsDir, getProjectLogDir, getProjectTempDir } from '../projects/paths.js';

export interface DoctorFinding {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export function hasDoctorErrors(findings: DoctorFinding[]): boolean {
  return findings.some((finding) => finding.level === 'error');
}

export function formatDoctorFinding(finding: DoctorFinding): string {
  return `[${finding.level}] ${finding.message}`;
}

export async function runDoctor(config: BridgeConfig): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  const defaultBackend = config.backend?.default ?? 'codex';
  findings.push({ level: 'info', message: `Default backend: ${defaultBackend}` });

  try {
    const capabilities = detectCodexCliCapabilities(config.codex.bin);
    findings.push({ level: 'info', message: `Codex detected: ${capabilities.version}` });
    findings.push({
      level: 'info',
      message: `Codex resume capabilities: json=${capabilities.resume.supportsJson} output_last_message=${capabilities.resume.supportsOutputLastMessage} cd=${capabilities.resume.supportsCd}`,
    });
  } catch {
    const level = defaultBackend === 'codex' ? 'error' : 'warn';
    findings.push({ level, message: `Codex binary not runnable: ${config.codex.bin}` });
  }

  const claudeBin = config.claude?.bin ?? 'claude';
  try {
    const claudeVersion = spawnSync(claudeBin, ['--version'], { encoding: 'utf8' });
    if (claudeVersion.status === 0) {
      findings.push({ level: 'info', message: `Claude CLI detected: ${claudeVersion.stdout.trim()}` });
    } else {
      const level = defaultBackend === 'claude' ? 'error' : 'info';
      findings.push({ level, message: `Claude CLI not available: ${claudeBin}` });
    }
  } catch {
    const level = defaultBackend === 'claude' ? 'error' : 'info';
    findings.push({ level, message: `Claude CLI not found: ${claudeBin}` });
  }

  const projectsUsingClaude = Object.entries(config.projects).filter(([, p]) => p.backend === 'claude');
  if (projectsUsingClaude.length > 0) {
    findings.push({ level: 'info', message: `Projects using Claude backend: ${projectsUsingClaude.map(([a]) => a).join(', ')}` });
  }

  if (!config.service.default_project) {
    findings.push({ level: 'warn', message: 'service.default_project is empty; first project alias will be used implicitly.' });
  } else if (!config.projects[config.service.default_project]) {
    findings.push({ level: 'error', message: `service.default_project does not exist: ${config.service.default_project}` });
  }

  if (config.service.reply_mode === 'card' && config.feishu.transport === 'long-connection') {
    findings.push({
      level: 'warn',
      message: 'Card display works in long-connection mode, but card callbacks still require webhook transport.',
    });
  }

  if (config.feishu.dry_run) {
    findings.push({
      level: 'warn',
      message: 'Feishu outbound dry_run is enabled. Incoming flows work, but replies are only logged locally.',
    });
  }

  if (config.feishu.allowed_chat_ids.length === 0) {
    findings.push({ level: 'warn', message: 'feishu.allowed_chat_ids is empty; all p2p chats are allowed.' });
  }

  if (config.feishu.allowed_group_ids.length === 0) {
    findings.push({ level: 'warn', message: 'feishu.allowed_group_ids is empty; all groups are allowed.' });
  }

  if (config.feishu.transport === 'webhook' && !config.feishu.verification_token) {
    findings.push({ level: 'warn', message: 'Webhook mode is enabled but verification_token is empty.' });
  }

  if (config.feishu.transport === 'webhook' && !config.feishu.encrypt_key) {
    findings.push({ level: 'warn', message: 'Webhook mode is enabled but encrypt_key is empty.' });
  }

  if (config.feishu.event_path === config.feishu.card_path) {
    findings.push({ level: 'error', message: 'feishu.event_path and feishu.card_path must not be identical.' });
  }

  if (config.service.idempotency_ttl_seconds < 60) {
    findings.push({ level: 'warn', message: 'service.idempotency_ttl_seconds is very low; duplicate message suppression may be ineffective.' });
  }

  if (config.codex.run_timeout_ms < 1000) {
    findings.push({ level: 'warn', message: 'codex.run_timeout_ms is very low; Codex runs may abort before producing output.' });
  }

  if (config.service.transcribe_audio_messages && !config.service.download_message_resources) {
    findings.push({
      level: 'warn',
      message: 'service.transcribe_audio_messages is enabled but download_message_resources is disabled; audio files cannot be transcribed.',
    });
  }

  if (config.service.transcribe_audio_messages && !process.env.OPENAI_API_KEY) {
    findings.push({
      level: 'warn',
      message: 'service.transcribe_audio_messages is enabled but OPENAI_API_KEY is missing; audio transcription will be skipped.',
    });
  }

  if (config.service.describe_image_messages && !config.service.download_message_resources) {
    findings.push({
      level: 'warn',
      message: 'service.describe_image_messages is enabled but download_message_resources is disabled; images cannot be described.',
    });
  }

  if (config.service.describe_image_messages && !process.env.OPENAI_API_KEY) {
    findings.push({
      level: 'warn',
      message: 'service.describe_image_messages is enabled but OPENAI_API_KEY is missing; image descriptions will be skipped.',
    });
  }

  if (config.service.memory_group_enabled && config.feishu.allowed_group_ids.length === 0) {
    findings.push({
      level: 'warn',
      message: 'service.memory_group_enabled is enabled while feishu.allowed_group_ids is empty; group shared memory will be available in every group.',
    });
  }

  if (config.service.memory_group_enabled && !config.security.require_group_mentions) {
    findings.push({
      level: 'warn',
      message: 'service.memory_group_enabled is enabled while security.require_group_mentions=false; group memory can be influenced by non-@ messages if the project also disables mention_required.',
    });
  }

  if (config.service.memory_cleanup_interval_seconds < 60) {
    findings.push({
      level: 'warn',
      message: 'service.memory_cleanup_interval_seconds is very low; background memory cleanup may generate unnecessary churn.',
    });
  }

  if (config.service.audit_cleanup_interval_seconds < 300) {
    findings.push({
      level: 'warn',
      message: 'service.audit_cleanup_interval_seconds is very low; audit retention cleanup may generate unnecessary churn.',
    });
  }

  if (config.service.audit_archive_after_days >= config.service.audit_retention_days) {
    findings.push({
      level: 'warn',
      message: 'service.audit_archive_after_days should be lower than service.audit_retention_days, otherwise archived audit events may be removed immediately.',
    });
  }

  try {
    await ensureDir(config.storage.dir);
    findings.push({ level: 'info', message: `Storage directory ready: ${config.storage.dir}` });
  } catch {
    findings.push({ level: 'error', message: `Storage directory is not writable: ${config.storage.dir}` });
  }

  const allowedRoots = config.security.allowed_project_roots.map((root) => path.resolve(root));

  const enabledMcpTokens = [
    ...(config.mcp.auth_token ? ['legacy'] : []),
    ...config.mcp.auth_tokens.filter((token) => token.enabled !== false).map((token) => token.id),
  ];

  if (config.mcp.transport === 'http' && enabledMcpTokens.length === 0) {
    findings.push({
      level: 'warn',
      message: 'mcp.transport=http is enabled without any MCP auth token; MCP HTTP/SSE endpoints will be exposed without authentication.',
    });
  }

  if (config.mcp.active_auth_token_id && !config.mcp.auth_tokens.some((token) => token.id === config.mcp.active_auth_token_id && token.enabled !== false)) {
    findings.push({
      level: 'warn',
      message: `mcp.active_auth_token_id does not point to an enabled token: ${config.mcp.active_auth_token_id}`,
    });
  }

  for (const [alias, project] of Object.entries(config.projects)) {
    const resolvedRoot = path.resolve(project.root);
    try {
      const stats = await fs.stat(resolvedRoot);
      if (!stats.isDirectory()) {
        findings.push({ level: 'error', message: `Project ${alias} root is not a directory: ${resolvedRoot}` });
        continue;
      }
      findings.push({ level: 'info', message: `Project ${alias} root found: ${resolvedRoot}` });

      if (allowedRoots.length > 0 && !allowedRoots.some((allowedRoot) => isSubPath(resolvedRoot, allowedRoot))) {
        findings.push({ level: 'error', message: `Project ${alias} root is outside security.allowed_project_roots: ${resolvedRoot}` });
      }

      if (!project.mention_required && !config.security.require_group_mentions) {
        findings.push({ level: 'warn', message: `Project ${alias} has mention_required=false; group chats can trigger runs without @mention.` });
      }

      for (const [label, dir] of [
        ['download dir', getProjectDownloadsDir(config.storage.dir, alias, project)],
        ['temp dir', getProjectTempDir(config.storage.dir, alias, project)],
        ['cache dir', getProjectCacheDir(config.storage.dir, alias, project)],
        ['log dir', getProjectLogDir(config.storage.dir, alias, project)],
      ] as const) {
        try {
          await ensureDir(dir);
          findings.push({ level: 'info', message: `Project ${alias} ${label} ready: ${dir}` });
        } catch {
          findings.push({ level: 'error', message: `Project ${alias} ${label} is not writable: ${dir}` });
        }
      }

      const gitDir = path.join(resolvedRoot, '.git');
      try {
        await fs.access(gitDir);
      } catch {
        findings.push({ level: 'warn', message: `Project ${alias} is not a Git repository: ${resolvedRoot}` });
      }
    } catch {
      findings.push({ level: 'error', message: `Project ${alias} root does not exist: ${resolvedRoot}` });
    }
  }

  if (Object.keys(config.projects).length === 0) {
    findings.push({ level: 'error', message: 'No projects configured.' });
  }

  return findings;
}

export async function findMissingEnvRefs(configPaths: string[]): Promise<DoctorFinding[]> {
  const missing = new Set<string>();

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, 'utf8');
      for (const match of content.matchAll(/env:([A-Z0-9_]+)/g)) {
        const envKey = match[1];
        if (envKey && !process.env[envKey]) {
          missing.add(envKey);
        }
      }
    } catch {
      // ignore missing files here
    }
  }

  return Array.from(missing)
    .sort()
    .map((envKey) => ({ level: 'error' as const, message: `Missing environment variable: ${envKey}` }));
}

export async function runRemoteDoctor(config: BridgeConfig): Promise<DoctorFinding[]> {
  const result = await inspectFeishuEnvironment(config.feishu);
  return mapInspectResultToDoctorFindings(result);
}

export function mapInspectResultToDoctorFindings(result: FeishuInspectResult): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  if (result.token.ok) {
    findings.push({ level: 'info', message: `Feishu token check passed (expire=${result.token.expire ?? '-'})` });
  } else {
    findings.push({ level: 'error', message: `Feishu token check failed: ${result.token.msg ?? 'unknown error'}` });
  }

  if (result.app.ok) {
    findings.push({
      level: 'info',
      message: `Feishu app reachable: ${result.app.name ?? result.app_id ?? 'unknown app'} (status=${result.app.status ?? '-'})`,
    });
  } else {
    findings.push({ level: 'error', message: `Feishu app check failed: ${result.app.msg ?? 'unknown error'}` });
  }

  if (result.bot.ok) {
    findings.push({
      level: result.bot.activate_status === 0 ? 'warn' : 'info',
      message: `Feishu bot reachable: ${result.bot.name ?? 'unknown bot'} (activate_status=${result.bot.activate_status ?? '-'})`,
    });
  } else {
    findings.push({ level: 'error', message: `Feishu bot check failed: ${result.bot.msg ?? 'unknown error'}` });
  }

  if (result.chats_probe.ok) {
    findings.push({ level: 'info', message: `Feishu IM availability check passed (visible chats=${result.chats_probe.count ?? 0})` });
  } else {
    const code = result.chats_probe.code !== undefined ? ` code=${result.chats_probe.code}` : '';
    findings.push({
      level: 'error',
      message: `Feishu IM availability check failed:${code} ${result.chats_probe.msg ?? 'unknown error'}`.trim(),
    });
  }

  return findings;
}

function isSubPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
