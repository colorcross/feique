#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.tmp/dev-stack"
CONFIG_PATH="${RUNTIME_DIR}/config.toml"
PID_FILE="${RUNTIME_DIR}/bridge.pid"
LOG_FILE="${RUNTIME_DIR}/bridge.log"
STATE_DIR="${RUNTIME_DIR}/state"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-3333}"
METRICS_HOST="${METRICS_HOST:-127.0.0.1}"
METRICS_PORT="${METRICS_PORT:-9464}"
COMPOSE_FILE="${ROOT_DIR}/examples/docker-compose.observability.yml"
CLI_ENTRY="${ROOT_DIR}/dist/cli.js"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm)}"
CODEX_BIN="${CODEX_BIN:-codex}"
DEMO_APP_ID="${DEMO_APP_ID:-cli_dev_stack}"
DEMO_APP_SECRET="${DEMO_APP_SECRET:-dev-stack-secret}"

usage() {
  cat <<EOF
Usage: scripts/dev-stack.sh <up|down|smoke|status|logs> [--no-observability]

Commands:
  up      Build the project, write a local webhook config, and start the bridge.
  down    Stop the local bridge and observability stack.
  smoke   Run webhook smoke checks against the local bridge.
  status  Show bridge pid, health endpoint, and observability hint.
  logs    Tail the bridge log file.

Environment overrides:
  BRIDGE_HOST, BRIDGE_PORT, METRICS_HOST, METRICS_PORT
  CODEX_BIN, DEMO_APP_ID, DEMO_APP_SECRET
EOF
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local command="$1"
  shift

  local observability="on"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-observability)
        observability="off"
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
    shift
  done

  case "${command}" in
    up)
      ensure_common_prereqs
      ensure_bridge_prereqs
      cmd_up "${observability}"
      ;;
    down)
      ensure_common_prereqs
      cmd_down "${observability}"
      ;;
    smoke)
      ensure_common_prereqs
      cmd_smoke
      ;;
    status)
      ensure_common_prereqs
      cmd_status
      ;;
    logs)
      cmd_logs
      ;;
    *)
      echo "Unknown command: ${command}" >&2
      usage
      exit 1
      ;;
  esac
}

ensure_common_prereqs() {
  require_command "${NODE_BIN}" "node"
  require_command "${PNPM_BIN}" "pnpm"
  require_command "curl" "curl"
}

ensure_bridge_prereqs() {
  if [[ "${CODEX_BIN}" == *"/"* ]]; then
    if [[ ! -x "${CODEX_BIN}" ]]; then
      echo "Codex binary is not executable: ${CODEX_BIN}" >&2
      exit 1
    fi
  else
    require_command "${CODEX_BIN}" "${CODEX_BIN}"
  fi
}

require_command() {
  local candidate="$1"
  local label="$2"

  if command -v "${candidate}" >/dev/null 2>&1; then
    return 0
  fi

  echo "Missing required command: ${label}" >&2
  exit 1
}

cmd_up() {
  local observability="$1"
  mkdir -p "${RUNTIME_DIR}" "${STATE_DIR}"

  ensure_built
  write_demo_config

  if bridge_running; then
    echo "Bridge already running: pid=$(cat "${PID_FILE}")"
  else
    echo "Starting bridge on http://${BRIDGE_HOST}:${BRIDGE_PORT}"
    launch_bridge
  fi

  wait_for_health

  if [[ "${observability}" == "on" ]]; then
    require_command "docker" "docker"
    echo "Starting observability stack"
    docker compose -f "${COMPOSE_FILE}" up -d >/dev/null
  fi

  cmd_status
}

cmd_down() {
  local observability="$1"

  if bridge_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    echo "Stopping bridge pid=${pid}"
    kill "${pid}" >/dev/null 2>&1 || true
    wait_for_pid_exit "${pid}" || kill -9 "${pid}" >/dev/null 2>&1 || true
    rm -f "${PID_FILE}"
  else
    echo "Bridge not running"
    rm -f "${PID_FILE}"
  fi

  if [[ "${observability}" == "on" ]]; then
    require_command "docker" "docker"
    echo "Stopping observability stack"
    docker compose -f "${COMPOSE_FILE}" down >/dev/null || true
  fi
}

cmd_smoke() {
  ensure_built
  "${NODE_BIN}" "${CLI_ENTRY}" webhook smoke --base-url "http://${BRIDGE_HOST}:${BRIDGE_PORT}"
}

cmd_status() {
  if bridge_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    echo "bridge_pid=${pid}"
  else
    echo "bridge_pid=stopped"
  fi

  echo "bridge_url=http://${BRIDGE_HOST}:${BRIDGE_PORT}"
  echo "metrics_url=http://${METRICS_HOST}:${METRICS_PORT}/metrics"
  echo "health_url=http://${BRIDGE_HOST}:${BRIDGE_PORT}/healthz"
  echo "log_file=${LOG_FILE}"

  curl -fsS "http://${BRIDGE_HOST}:${BRIDGE_PORT}/healthz" >/dev/null 2>&1 && echo "health=ok" || echo "health=down"
}

cmd_logs() {
  mkdir -p "${RUNTIME_DIR}"
  touch "${LOG_FILE}"
  tail -n 100 -f "${LOG_FILE}"
}

ensure_built() {
  if [[ ! -f "${CLI_ENTRY}" ]]; then
    echo "Building dist/cli.js"
    "${PNPM_BIN}" build >/dev/null
    return
  fi

  if find "${ROOT_DIR}/src" -type f -newer "${CLI_ENTRY}" | grep -q .; then
    echo "Rebuilding dist/cli.js"
    "${PNPM_BIN}" build >/dev/null
  fi
}

write_demo_config() {
  cat >"${CONFIG_PATH}" <<EOF
version = 1

[service]
name = "feishu-bridge-dev-stack"
default_project = "demo"
reply_mode = "text"
emit_progress_updates = true
progress_update_interval_ms = 1000
metrics_host = "${METRICS_HOST}"
metrics_port = ${METRICS_PORT}

[codex]
bin = "${CODEX_BIN}"
default_sandbox = "workspace-write"
skip_git_repo_check = true
bridge_instructions = "Reply concisely for local dev-stack smoke runs."

[storage]
dir = "${STATE_DIR}"

[feishu]
app_id = "${DEMO_APP_ID}"
app_secret = "${DEMO_APP_SECRET}"
dry_run = true
transport = "webhook"
host = "${BRIDGE_HOST}"
port = ${BRIDGE_PORT}
event_path = "/webhook/event"
card_path = "/webhook/card"
allowed_chat_ids = []
allowed_group_ids = []

[projects.demo]
root = "${ROOT_DIR}"
session_scope = "chat"
mention_required = false
EOF
}

bridge_running() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  if kill -0 "${pid}" >/dev/null 2>&1; then
    return 0
  fi

  rm -f "${PID_FILE}"
  return 1
}

wait_for_health() {
  local attempts=20
  local delay=0.5

  while (( attempts > 0 )); do
    if curl -fsS "http://${BRIDGE_HOST}:${BRIDGE_PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${delay}"
    attempts=$((attempts - 1))
  done

  echo "Bridge health check did not become ready. Recent logs:" >&2
  tail -n 50 "${LOG_FILE}" >&2 || true
  return 1
}

wait_for_pid_exit() {
  local pid="$1"
  local attempts=20

  while (( attempts > 0 )); do
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    attempts=$((attempts - 1))
  done

  return 1
}

launch_bridge() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "${NODE_BIN}" "${CLI_ENTRY}" serve --config "${CONFIG_PATH}" >"${LOG_FILE}" 2>&1 < /dev/null &
    echo $! >"${PID_FILE}"
    return
  fi

  nohup "${NODE_BIN}" "${CLI_ENTRY}" serve --config "${CONFIG_PATH}" >"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"
}

main "$@"
