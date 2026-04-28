# 飞鹊 (Feique) v1.5.8

<div align="center">

**Team AI Collaboration Hub — from individual productivity to team synergy, weave AI into every stage of work.**

[![npm version](https://img.shields.io/npm/v/feique.svg?style=flat-square&color=5bb8b0)](https://www.npmjs.com/package/feique)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square&color=d4845a)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/feique.svg?style=flat-square)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[简体中文](README.md) | [Website](https://colorcross.github.io/feique/en.html) | [Getting Started](docs/getting-started.md) | [Architecture](docs/architecture.md) | [FAQ](docs/faq.md)

</div>

---

Feique is a **Team AI Collaboration Hub**. It connects AI capabilities like Codex CLI and Claude Code through Feishu so team members collaborate, complement each other, uncover bottlenecks, and improve efficiency — driving the iteration from individual growth to smooth teamwork to continuous organizational capability building.

Currently supports the full AI coding workflow: project bindings persist by `chat_id`, local sessions can be adopted, shared repositories are automatically serialized, and queued runtime states are directly visible within Feishu. Final replies support rich text and cards, collapsed into cleaner single result messages.

## 🌟 Core Features

| Feature | Description |
| :--- | :--- |
| **Sticky Routing** | Project selection is remembered by `chat_id`. Switch once in a group, and the entire group inherits it; DMs also remember their own current project. |
| **Session Adoption** | Can resume the bridge's own sessions, or directly adopt native local sessions from `~/.codex/sessions` or `~/.claude/sessions` via `/session adopt`. |
| **Runtime Guard** | Dual-layer serialization with `queue key` + `project.root`. Threads in the same project won't conflict, and concurrent operations on the same repository across different chats are automatically queued with visible status. |
| **Docs / Base / Tasks** | Beyond `/wiki` and `/kb search`, the bridge can read/create Feishu Docs, list/create/complete Tasks, and list/write Base records. |
| **Media Aware** | Images, files, audio, and rich text messages are parsed into structured metadata and injected into Codex prompts. |
| **MCP Surface** | Not just for Feishu. Run `feique mcp` to expose core capabilities through `stdio` or `HTTP/SSE`, with multi-token Bearer rotation for remote clients. |
| **Access Roles** | Supports `viewer / operator / admin` plus finer capability allow-lists for sessions, runs, config changes, and service operations. |
| **Memory System** | Supports project memory and group shared memory, SQLite + FTS5 retrieval, configurable TTL, pin strategies, and background cleanup. |
| **Project Isolation** | Downloads, temp files, cache, and project audit logs default to `state/projects/<alias>/...`, with per-project overrides available. |
| **Observability** | Built-in `/healthz`, `/readyz`, and `/metrics`, plus structured audit trails and Prometheus / Alertmanager / Grafana integration. |
| **Multi-Backend** | **v1.5 ships three backends**: Codex, Claude Code, and Qwen Code. Configurable globally via `[backend]` or per-project. Claude supports `--model`/`--permission-mode`/`--max-budget-usd`; Qwen supports `--model`/`--approval-mode` (plan\|default\|auto-edit\|yolo). **Startup-level failover + configurable fallback chain**: if the primary CLI is unavailable, runs walk through `backend.fallback` until one probes ok. **Extensible registry**: adding a fourth backend is one file + one `registerBackend()` call. |
| **Pairing UX (v1.4)** | Unauthorized chats knocking for the first time now get a friendly reply with their chat_id and instructions to contact an admin; admins get a one-shot notification. No more silent drops. |
| **Team Awareness** | `/team` shows who is using AI on what in real time, with automatic conflict warnings. |
| **Knowledge Loop** | `/learn` and `/recall` for team knowledge capture and semantic retrieval, with AI-powered auto-extraction. |
| **Handoff & Review** | `/handoff` `/pickup` `/review` `/approve` `/reject` for session handoffs and code review workflows. |
| **Team Insights** | `/insights` detects retry patterns, duplicated effort, queue bottlenecks, and error clusters. |
| **Trust Boundaries** | `/trust` enables progressive trust levels: observe → suggest → execute → autonomous. |
| **Context Continuity** | `/timeline` shows the project timeline; newcomers automatically receive historical context. |
| **Team Digest** | `/digest` sends scheduled team AI collaboration daily digests. |
| **Dashboard** | `GET /dashboard` provides an embedded Web UI for runtime and team status visualization. |
| **Per-project Customization** | Each project can independently configure AI model version, sandbox policy, MCP tool servers, and skill packs, with three-layer persona settings (global → project → backend instructions). |
| **File Sending** | AI can send files and images to Feishu conversations via `[SEND_FILE:path]` markers or direct API calls. |
| **Proactive Alerts** | Consecutive failures, retry loops, cost thresholds, and long-running tasks automatically push alerts to Feishu. |
| **Knowledge Gaps** | `/gaps` analyzes frequently asked but undocumented knowledge gaps across the team. |
| **Cost Tracking** | Token usage stats broken down by project and user, with estimated costs. |

## 🚀 Quick Start

### 1. Installation

```bash
npm install -g feique
feique init --mode global

# Create a new project directory and bind it
feique create-project repo-new /srv/codex/repo-new

# Bind an existing directory as a project
feique bind repo-a /path/to/repo-a
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
feique doctor --remote

# Start the service
feique start

# View logs
feique logs --follow
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

# Team Collaboration
/team                          # See who's using AI on what
/learn always run e2e before deploy  # Capture team knowledge
/recall deploy process         # Semantic search existing knowledge
/handoff @alice continue fix   # Hand off session to a teammate
/pickup                        # Pick up a session handed to you
/review                        # Request a review
/approve                       # Approve a review
/reject needs more test cases  # Reject with reason
/insights                      # View team bottleneck diagnostics
/trust suggest                 # Set trust level for current project
/timeline                      # View project timeline
/digest                        # Manually trigger team digest

# Natural Language Commands
Switch to project repo-a
Adopt the latest session
Show detailed status
Who on the team is busy right now?
Hand off my session to Bob
What's been happening in this project lately?
```

## 🏗️ Architecture Overview

```text
[ Feishu App ] <---> [ Transport (WS/Webhook) ]
                            |
                            v
[ Project Router ] ---> [ Session Manager ] ---> [ Concurrency Queue ]
       |                    |                            |
       v                    v                            v
[ Team Awareness ]  [ Memory / Wiki ]             [ Backend (Codex / Claude) ]
[ Trust Boundaries] [ Knowledge Loop ]                   |
[ Cost Tracking ]   [ Context Continuity ]               v
       |                    |                     [ Local Workspace ]
       v                    v
[ Dashboard ]       [ Handoff & Review ]
[ Team Digest ]     [ Team Insights ]
```

For detailed architecture design, please refer to the [Architecture Document](docs/architecture.md).

## ⚙️ Minimal Configuration Example

The configuration file is located at `~/.feique/config.toml` by default:

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
dir = "~/.feique/state"

[embedding]
provider = "ollama"
ollama_model = "auto"  # Auto-detect best local embedding model

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
