#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="${ROOT_DIR}"
PROJECT_ALIAS="default"
FORCE_CONFIG="off"
SKIP_GLOBAL_INSTALL="off"

usage() {
  cat <<EOF
Usage: scripts/install.sh [options]

Options:
  --project-root <dir>    Bind this directory as the default project. Defaults to the current repo root.
  --alias <name>          Project alias to bind. Defaults to "default".
  --force-config          Overwrite ~/.codex-feishu/config.toml if it already exists.
  --skip-global-install   Skip \`npm install -g\` and use the local dist/cli.js for config bootstrap.
  --help                  Show this help text.
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

ensure_built() {
  if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
    if command -v pnpm >/dev/null 2>&1 && [[ -f "${ROOT_DIR}/pnpm-lock.yaml" ]]; then
      (cd "${ROOT_DIR}" && pnpm install)
    else
      (cd "${ROOT_DIR}" && npm install)
    fi
  fi

  if [[ ! -f "${ROOT_DIR}/dist/cli.js" ]] || find "${ROOT_DIR}/src" -type f -newer "${ROOT_DIR}/dist/cli.js" | grep -q .; then
    if command -v pnpm >/dev/null 2>&1 && [[ -f "${ROOT_DIR}/pnpm-lock.yaml" ]]; then
      (cd "${ROOT_DIR}" && pnpm build)
    else
      (cd "${ROOT_DIR}" && npm run build)
    fi
  fi
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project-root)
        PROJECT_ROOT="$2"
        shift 2
        ;;
      --alias)
        PROJECT_ALIAS="$2"
        shift 2
        ;;
      --force-config)
        FORCE_CONFIG="on"
        shift
        ;;
      --skip-global-install)
        SKIP_GLOBAL_INSTALL="on"
        shift
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  require_command node
  require_command npm
  ensure_built

  run_cli() {
    if [[ "${SKIP_GLOBAL_INSTALL}" == "off" ]]; then
      codex-feishu "$@"
      return
    fi

    env -u NODE_OPTIONS node "${ROOT_DIR}/dist/cli.js" "$@"
  }

  if [[ "${SKIP_GLOBAL_INSTALL}" == "off" ]]; then
    echo "Installing codex-feishu globally from ${ROOT_DIR}"
    npm install -g "${ROOT_DIR}"
  fi

  if [[ "${FORCE_CONFIG}" == "on" || ! -f "${HOME}/.codex-feishu/config.toml" ]]; then
    echo "Initializing global config at ${HOME}/.codex-feishu/config.toml"
    if [[ "${FORCE_CONFIG}" == "on" ]]; then
      run_cli init --mode global --force
    else
      run_cli init --mode global
    fi
  fi

  echo "Binding project ${PROJECT_ALIAS} -> ${PROJECT_ROOT}"
  run_cli bind "${PROJECT_ALIAS}" "${PROJECT_ROOT}" --config "${HOME}/.codex-feishu/config.toml"

  cat <<EOF

Install completed.

Next steps:
  1. Export Feishu credentials:
     export FEISHU_APP_ID='cli_xxx'
     export FEISHU_APP_SECRET='xxx'
  2. Inspect effective config:
     codex-feishu print-config
  3. Run startup checks:
     codex-feishu doctor
     codex-feishu doctor --remote
  4. Start the bridge:
     codex-feishu serve --detach
EOF
}

main "$@"
