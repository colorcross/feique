# Feishu Bridge

<div align="center">

**Route Feishu into Codex / Claude Code's control plane.**

[![npm version](https://img.shields.io/npm/v/feishu-bridge.svg?style=flat-square&color=5bb8b0)](https://www.npmjs.com/package/feishu-bridge)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square&color=d4845a)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/feishu-bridge.svg?style=flat-square)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[简体中文](README.md) | [Website](https://colorcross.github.io/codex-feishu/en.html) | [Getting Started](docs/getting-started.md) | [Architecture](docs/architecture.md) | [FAQ](docs/faq.md)

</div>

---

Feishu Bridge is a Feishu (Lark) bridge designed for Codex CLI and Claude Code (Claude CLI). It is not just a message forwarding tool, but a **control plane with project awareness, session adoption, and concurrency protection**. Through its Backend abstraction layer, the same Feishu interaction experience seamlessly supports both Codex and Claude Code backends.

It routes Feishu messages directly into resumable Codex CLI or Claude Code sessions. Project bindings are persisted by `chat_id`, local sessions can be adopted, shared repositories are automatically serialized, and queued runtime states are directly visible within Feishu. Final replies support rich text and cards, and are intentionally collapsed into a cleaner single result message instead of exposing bridge-style `quote / project / duration` metadata.

## 🌟 Core Features

| Feature | Description |
| :--- | :--- |
| **Sticky Routing** | Project selection is remembered by `chat_id`. Switch once in a group, and the entire group inherits it; DMs also remember their own current project. |
| **Session Adoption** | Can resume the bridge's own sessions, or directly adopt native local sessions from `~/.codex/sessions` or `~/.claude/sessions` via `/session adopt`. |
| **Runtime Guard** | Dual-layer serialization with `queue key` + `project.root`. Threads in the same project won't conflict, and concurrent operations on the same repository across different chats are automatically queued with visible status. |
| **Docs / Base / Tasks** | Beyond `/wiki` and `/kb search`, the bridge can read/create Feishu Docs, list/create/complete Tasks, and list/write Base records. |
| **Media Aware** | Images, files, audio, and rich text messages are parsed into structured metadata and injected into Codex prompts. |
| **MCP Surface** | Not just for Feishu. Run `feishu-bridge mcp` to expose core capabilities through `stdio` or `HTTP/SSE`, with multi-token Bearer rotation for remote clients. |
| **Access Roles** | Supports `viewer / operator / admin` plus finer capability allow-lists for sessions, runs, config changes, and service operations. |
| **Memory System** | Supports project memory and group shared memory, SQLite + FTS5 retrieval, configurable TTL, pin strategies, and background cleanup. |
| **Project Isolation** | Downloads, temp files, cache, and project audit logs default to `state/projects/<alias>/...`, with per-project overrides available. |
| **Observability** | Built-in `/healthz`, `/readyz`, and `/metrics`, plus structured audit trails and Prometheus / Alertmanager / Grafana integration. |
| **Multi-Backend** | A single bridge can manage both Codex and Claude Code backends, configurable globally via `[backend]` or per-project. The Claude backend supports `--model`, `--permission-mode`, `--max-budget-usd`, and other advanced options. |

## 🚀 Quick Start

### 1. Installation

```bash
npm install -g feishu-bridge
feishu-bridge init --mode global

# Create a new project directory and bind it
feishu-bridge create-project repo-new /srv/codex/repo-new

# Bind an existing directory as a project
feishu-bridge bind repo-a /path/to/repo-a
```

### 2. Configure Environment Variables

Simply set the Feishu app credentials to start quickly (defaults to `long-connection` mode, no public IP required):

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=***
```

### 3. Check and Start

```bash
# Check environment and connectivity
feishu-bridge doctor --remote

# Start the service
feishu-bridge start

# View logs
feishu-bridge logs --follow
```

## 💬 Interaction Examples in Feishu

In Feishu, you can interact with Codex directly using natural language or slash commands:

```text
# Project Management
/projects
/project repo-a
/admin project create repo-new /srv/codex/repo-new

# Session Management
/session adopt latest
/session list

# Knowledge Base Operations
/wiki search deployment docs
/kb search architecture design
/doc read doxcn123
/task create Follow up the release checklist
/base records app_token tbl_id 5

# Natural Language Commands
Switch to project repo-a
Adopt the latest session
Show detailed status
```

## 🏗️ Architecture Overview

```text
[ Feishu App ] <---> [ Transport (WS/Webhook) ]
                            |
                            v
[ Project Router ] ---> [ Session Manager ] ---> [ Concurrency Queue ]
                            |                            |
                            v                            v
                    [ Memory / Wiki ]             [ Codex Runner ]
                                                         |
                                                         v
                                                [ Local Workspace ]
```

For detailed architecture design, please refer to the [Architecture Document](docs/architecture.md).

## ⚙️ Minimal Configuration Example

The configuration file is located at `~/.feishu-bridge/config.toml` by default:

```toml
version = 1

[service]
default_project = "default"
reply_mode = "card"  # text | post | card

[codex]
bin = "codex"
default_sandbox = "workspace-write"
run_timeout_ms = 1800000  # 30 minutes

[storage]
dir = "~/.feishu-bridge/state"

[mcp]
transport = "http"
active_auth_token_id = "primary"
[[mcp.auth_tokens]]
id = "primary"
token = "env:MCP_AUTH_TOKEN_PRIMARY"
enabled = true
[[mcp.auth_tokens]]
id = "rollover"
token = "env:MCP_AUTH_TOKEN_ROLLOVER"
enabled = true

[security]
allowed_project_roots = ["/srv/repos"]
admin_chat_ids = ["oc_admin_chat_1"]

[feishu]
app_id = "env:FEISHU_APP_ID"
app_secret = "env:FEISHU_APP_SECRET"
transport = "long-connection"

[projects.default]
root = "/srv/repos/repo-a"
session_scope = "chat"
run_priority = 200
```

Feishu object tools and status cards:

- `/doc read <url|token>` and `/doc create <title>` for native Feishu Docs
- `/task list|get|create|complete` for Feishu Tasks
- `/base tables|records|create|update` for Feishu Base
- write operations execute directly and update the same reply with current status
- runtime cards expose phases such as `queued / preparing context / generating / executing / completed / failed / cancelled`

## 📚 Documentation Navigation

- [Getting Started](docs/getting-started.md) - Complete guide from zero to one
- [Architecture](docs/architecture.md) - Deep dive into internal mechanisms
- [FAQ](docs/faq.md) - Frequently asked questions
- [Deployment Guide](docs/deployment.md) - Recommendations for production deployment
- [Contributing Guide](CONTRIBUTING.md) - How to participate in project development

## 🤝 Contributing

We welcome all forms of contributions! Whether it's submitting bugs, proposing new features, or directly submitting Pull Requests. Please read our [Contributing Guide](CONTRIBUTING.md) before contributing.

## 📄 License

This project is licensed under the [MIT License](LICENSE).
