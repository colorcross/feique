import path from 'node:path';
import { PROJECT_CONFIG_RELATIVE_PATH, getGlobalConfigPath } from './paths.js';

export type InitMode = 'global' | 'project';

export function getInitTargetPath(mode: InitMode, cwd: string): string {
  return mode === 'global' ? getGlobalConfigPath() : path.join(cwd, PROJECT_CONFIG_RELATIVE_PATH);
}

export function buildInitialConfig(mode: InitMode, cwd: string): string {
  const defaultRoot = mode === 'project' ? '.' : cwd;
  return `version = 1

[service]
default_project = "default"
project_switch_auto_adopt_latest = true
reply_mode = "text"
emit_progress_updates = false
progress_update_interval_ms = 4000
metrics_host = "127.0.0.1"
idempotency_ttl_seconds = 86400
session_history_limit = 20
log_tail_lines = 100
log_rotate_max_bytes = 10485760
log_rotate_keep_files = 5
reply_quote_user_message = true
reply_quote_max_chars = 120
download_message_resources = false
transcribe_audio_messages = false
describe_image_messages = false
# openai_image_model = "gpt-4.1-mini"
memory_enabled = true
memory_search_limit = 3
memory_recent_limit = 5
memory_prompt_max_chars = 1600
thread_summary_max_chars = 1200
memory_group_enabled = false
memory_cleanup_interval_seconds = 1800
audit_archive_after_days = 7
audit_retention_days = 30
audit_cleanup_interval_seconds = 3600
memory_max_pinned_per_scope = 5
memory_pin_overflow_strategy = "age-out"
memory_pin_age_basis = "updated_at"
# memory_default_ttl_days = 30
# transcribe_cli_path = "~/.codex/skills/transcribe/scripts/transcribe_diarize.py"
# metrics_port = 9464

[codex]
bin = "codex"
# shell = "/bin/zsh"
# pre_exec = "proxy_on"
default_sandbox = "workspace-write"
skip_git_repo_check = true
output_token_limit = 4000
run_timeout_ms = 1800000
bridge_instructions = "Reply concisely for Feishu. Include changed files and verification when relevant."

[storage]
dir = "~/.feique/state"

[security]
allowed_project_roots = []
# viewer_chat_ids = ["oc_viewer_chat_1"]
# operator_chat_ids = ["oc_operator_chat_1"]
admin_chat_ids = []
# service_observer_chat_ids = ["oc_service_observer_1"]
# service_restart_chat_ids = ["oc_service_restart_1"]
# config_admin_chat_ids = ["oc_config_admin_1"]
require_group_mentions = true

[mcp]
transport = "stdio"
host = "127.0.0.1"
port = 8765
path = "/mcp"
sse_path = "/mcp/sse"
message_path = "/mcp/message"
# auth_token = "env:MCP_AUTH_TOKEN"
# active_auth_token_id = "primary"
# [[mcp.auth_tokens]]
# id = "primary"
# token = "env:MCP_AUTH_TOKEN_PRIMARY"
# enabled = true
# [[mcp.auth_tokens]]
# id = "rollover"
# token = "env:MCP_AUTH_TOKEN_ROLLOVER"
# enabled = true

[feishu]
app_id = "env:FEISHU_APP_ID"
app_secret = "env:FEISHU_APP_SECRET"
# dry_run = true
# transport = "long-connection" for local-only messaging; use "webhook" when you need interactive card callbacks.
transport = "long-connection"
# encrypt_key = "env:FEISHU_ENCRYPT_KEY"
# verification_token = "env:FEISHU_VERIFICATION_TOKEN"
# Optional but recommended for group mention gating. Get it with:
# feique feishu inspect --json
# bot_open_ids = ["ou_xxx"]
host = "0.0.0.0"
port = 3333
event_path = "/webhook/event"
card_path = "/webhook/card"
allowed_chat_ids = []
allowed_group_ids = []

[projects.default]
root = "${defaultRoot}"
session_scope = "chat"
mention_required = true
# viewer_chat_ids = ["oc_project_viewer_1"]
# operator_chat_ids = ["oc_project_operator_1"]
admin_chat_ids = []
# session_operator_chat_ids = ["oc_session_operator_1"]
# run_operator_chat_ids = ["oc_run_operator_1"]
# config_admin_chat_ids = ["oc_project_config_admin_1"]
chat_rate_limit_window_seconds = 60
chat_rate_limit_max_runs = 20
# profile = "default"
# sandbox = "workspace-write"
# description = "Main repo"
# download_dir = "./.feique/downloads"
# temp_dir = "./.feique/tmp"
# cache_dir = "./.feique/cache"
# log_dir = "./.feique/logs"
# run_priority = 100
`;
}
