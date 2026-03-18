import type { BridgeConfig, ProjectConfig } from '../config/schema.js';
import type { Backend, BackendName } from './types.js';
import { CodexBackend } from './codex.js';
import { ClaudeBackend } from './claude.js';
import { CodexSessionIndex } from '../codex/session-index.js';

export function createBackend(config: BridgeConfig, codexSessionIndex?: CodexSessionIndex): Backend {
  const backendName = resolveDefaultBackend(config);
  return createBackendByName(backendName, config, codexSessionIndex);
}

export function createBackendByName(name: BackendName, config: BridgeConfig, codexSessionIndex?: CodexSessionIndex): Backend {
  switch (name) {
    case 'codex':
      return new CodexBackend(
        {
          bin: config.codex.bin,
          shell: config.codex.shell,
          preExec: config.codex.pre_exec,
          defaultProfile: config.codex.default_profile,
          defaultSandbox: config.codex.default_sandbox,
          skipGitRepoCheck: config.codex.skip_git_repo_check,
          runTimeoutMs: config.codex.run_timeout_ms,
        },
        codexSessionIndex ?? new CodexSessionIndex(),
      );
    case 'claude':
      return new ClaudeBackend({
        bin: config.claude?.bin ?? 'claude',
        shell: config.claude?.shell ?? config.codex.shell,
        preExec: config.claude?.pre_exec ?? config.codex.pre_exec,
        defaultPermissionMode: config.claude?.default_permission_mode ?? 'auto',
        defaultModel: config.claude?.default_model,
        maxBudgetUsd: config.claude?.max_budget_usd,
        allowedTools: config.claude?.allowed_tools,
        systemPromptAppend: config.claude?.system_prompt_append,
        runTimeoutMs: config.claude?.run_timeout_ms ?? config.codex.run_timeout_ms,
      });
    default:
      throw new Error(`Unknown backend: ${name}`);
  }
}

export function resolveDefaultBackend(config: BridgeConfig): BackendName {
  return config.backend?.default ?? 'codex';
}

export function resolveProjectBackend(config: BridgeConfig, projectAlias: string, codexSessionIndex?: CodexSessionIndex): Backend {
  const project = config.projects[projectAlias];
  const backendName: BackendName = project?.backend ?? resolveDefaultBackend(config);
  return createBackendByName(backendName, config, codexSessionIndex);
}
