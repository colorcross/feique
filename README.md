# Feishu Bridge

<div align="center">

**把飞书接到 Codex / Claude Code 的控制面。**

[![npm version](https://img.shields.io/npm/v/feishu-ai-bridge.svg?style=flat-square&color=5bb8b0)](https://www.npmjs.com/package/feishu-ai-bridge)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square&color=d4845a)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/feishu-ai-bridge.svg?style=flat-square)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[English](README.en.md) | [官网](https://colorcross.github.io/feishu-bridge/) | [快速开始](docs/getting-started.md) | [架构设计](docs/architecture.md) | [FAQ](docs/faq.md)

</div>

---

Feishu Bridge 是一个为 Codex CLI 和 Claude Code (Claude CLI) 设计的飞书桥接器。它不仅仅是一个消息转发工具，而是一个**带有项目感知、会话接管和并发保护的控制面**。通过 Backend 抽象层，同一套飞书交互体验可以无缝对接 Codex 或 Claude Code 两种后端。

它让飞书消息直接进入可续接的 Codex CLI 或 Claude Code 会话。项目绑定按 `chat_id` 持久化，本地会话可接管，同仓库自动串行，排队和运行态在飞书里直接可见；最终回复支持富文本和卡片，并默认收口成更干净的单条结果消息，不再夹带 `引用 / 项目 / 耗时` 这类工程化头部信息。

## 🌟 核心特性

| 特性 | 描述 |
| :--- | :--- |
| **项目路由 (Sticky Routing)** | 项目选择按 `chat_id` 记住。群里切一次项目，整群后续会继承；私聊也会记住各自的当前项目。 |
| **会话接管 (Session Adoption)** | 既能 resume 桥接器自己的 session，也能通过 `/session adopt` 直接接管 `~/.codex/sessions` 或 `~/.claude/sessions` 里的本地原生会话。 |
| **并发保护 (Runtime Guard)** | `queue key` + `project.root` 双层串行。同项目 thread 不会乱写，不同群同时操作同一仓库也会被自动收口并显示排队状态。 |
| **飞书对象工具面 (Docs / Base / Tasks)** | 除了 `/wiki` 和 `/kb search`，还支持直接读取/创建飞书文档、列任务/建任务/完结任务，以及查看/写入多维表格记录。 |
| **多模态上下文 (Media Aware)** | 图片、文件、音频、富文本消息会被解析成结构化元数据，并带进 Codex 提示词。 |
| **MCP 接口 (MCP Surface)** | 不只给飞书用，运行 `feishu-bridge mcp` 即可通过 `stdio` 或 `HTTP/SSE` 暴露能力，支持多 token 轮换鉴权，并可给 OpenClaw 等客户端开放项目切换、会话接管和自然语言控制。 |
| **权限分层 (Access Roles)** | 支持 `viewer / operator / admin` 三档角色，并补了 session / run / config / service 级能力名单。 |
| **记忆系统 (Memory System)** | 支持项目记忆与群共享记忆，SQLite + FTS5 检索，可配置 TTL、置顶策略和后台定时清理。 |
| **项目隔离 (Project Isolation)** | 下载、临时文件、缓存和项目审计默认落到 `state/projects/<alias>/...`，也可按项目单独指定。 |
| **可观测性 (Observability)** | 内置 `/healthz`、`/readyz`、`/metrics`，支持 Prometheus / Alertmanager / Grafana，并补齐启动告警、运行链路日志和审计。 |
| **多后端支持 (Multi-Backend)** | 同一桥接器可同时管理 Codex 和 Claude Code 后端，通过 `[backend]` 配置全局默认或按项目覆盖。Claude 后端支持 `--model`、`--permission-mode`、`--max-budget-usd` 等高级选项。 |

## 🚀 快速开始

### 1. 安装

```bash
npm install -g feishu-ai-bridge
feishu-bridge init --mode global

# 创建一个新项目目录并接入配置
feishu-bridge create-project repo-new /srv/codex/repo-new

# 绑定已有目录为项目
feishu-bridge bind repo-a /path/to/repo-a
```

### 2. 配置环境变量

只需设置飞书应用的凭证即可快速启动（默认使用 `long-connection` 模式，无需公网 IP）：

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=***
```

### 3. 检查与启动

```bash
# 检查环境与连通性
feishu-bridge doctor --remote

# 启动服务
feishu-bridge start

# 查看日志
feishu-bridge logs --follow
```

## 💬 飞书内交互示例

在飞书里，你可以直接使用自然语言或斜杠命令与 Codex 交互：

```text
# 项目管理
/projects
/project repo-a
/admin project create repo-new /srv/codex/repo-new

# 会话管理
/session adopt latest
/session list

# 知识库操作
/wiki search 部署文档
/kb search 架构设计
/doc read doxcn123
/task create 跟进发布检查
/base records app_token tbl_id 5

# 自然语言命令
切换到项目 repo-a
接管最新会话
查看详细状态
```

## 🏗️ 架构概览

```text
[ Feishu App ] <---> [ Transport (WS/Webhook) ]
                            |
                            v
[ Project Router ] ---> [ Session Manager ] ---> [ Concurrency Queue ]
                            |                            |
                            v                            v
                    [ Memory / Wiki ]             [ Backend (Codex / Claude) ]
                                                         |
                                                         v
                                                [ Local Workspace ]
```

详细的架构设计请参考 [架构文档](docs/architecture.md)。

## ⚙️ 最小配置示例

配置文件默认位于 `~/.feishu-bridge/config.toml`：

```toml
version = 1

[service]
default_project = "default"
reply_mode = "card"  # text | post | card

[codex]
bin = "codex"
default_sandbox = "workspace-write"
run_timeout_ms = 1800000  # 30 minutes

# (可选) 如果要使用 Claude Code 后端
# [backend]
# default = "claude"  # codex | claude
#
# [claude]
# bin = "claude"
# default_permission_mode = "auto"
# default_model = "sonnet"

[storage]
dir = "~/.feishu-bridge/state"

[security]
allowed_project_roots = ["/srv/repos"]
viewer_chat_ids = ["oc_viewer_chat_1"]
operator_chat_ids = ["oc_operator_chat_2"]
admin_chat_ids = ["oc_admin_chat_1"]
service_observer_chat_ids = ["oc_service_observer_1"]
service_restart_chat_ids = ["oc_service_restart_1"]
config_admin_chat_ids = ["oc_config_admin_1"]

[mcp]
transport = "http"   # stdio | http
host = "127.0.0.1"
port = 8765
path = "/mcp"
sse_path = "/mcp/sse"
message_path = "/mcp/message"
active_auth_token_id = "primary"
[[mcp.auth_tokens]]
id = "primary"
token = "env:MCP_AUTH_TOKEN_PRIMARY"
enabled = true
[[mcp.auth_tokens]]
id = "rollover"
token = "env:MCP_AUTH_TOKEN_ROLLOVER"
enabled = true

[feishu]
app_id = "env:FEISHU_APP_ID"
app_secret = "env:FEISHU_APP_SECRET"
transport = "long-connection"

[projects.default]
root = "/srv/repos/repo-a"
session_scope = "chat"
run_priority = 200
operator_chat_ids = ["oc_repo_operator_1"]
session_operator_chat_ids = ["oc_repo_session_operator_1"]
run_operator_chat_ids = ["oc_repo_run_operator_1"]
config_admin_chat_ids = ["oc_repo_config_admin_1"]
download_dir = "/srv/feishu-bridge/projects/repo-a/downloads"
temp_dir = "/srv/feishu-bridge/projects/repo-a/tmp"
cache_dir = "/srv/feishu-bridge/projects/repo-a/cache"
log_dir = "/srv/feishu-bridge/projects/repo-a/logs"
# backend = "claude"  # 项目级后端覆盖
```

权限说明：

- `viewer`：可见项目、查看 `/projects`、`/status`、`/session list`
- `operator`：额外可切项目、接管会话、取消运行、查看 `/admin runs`
- `admin`：额外可改配置、增删项目、重启服务
- `session_operator_chat_ids`：只放宽会话接管和会话切换
- `run_operator_chat_ids`：只放宽运行和取消运行
- `service_observer_chat_ids / service_restart_chat_ids / config_admin_chat_ids`：把运行观察、服务重启、配置治理拆开授权

MCP 说明：

- `feishu-bridge mcp` 默认仍可跑 `stdio`
- 加 `--transport http` 或配置 `[mcp] transport = "http"` 后，会暴露 JSON-RPC + SSE 端点
- 如启用 HTTP，建议使用 `mcp.auth_tokens` 做多 token 轮换，并通过 `active_auth_token_id` 标记当前主 token
- 老配置里的 `mcp.auth_token` 仍兼容，但更适合单机本地接入

飞书对象与状态卡片：

- `/doc read <url|token>`、`/doc create <title>`：直接读写飞书文档
- `/task list|get|create|complete`：在飞书任务里查看、创建和完成任务
- `/base tables|records|create|update`：查看或写入多维表格
- 对文档、任务、多维表格这类飞书对象写操作，会直接执行并回写同一条状态消息
- 文本执行请求会先立即回复一条运行态消息，再更新为 `已接收 / 排队中 / 处理中 / 已完成 / 失败`
- 运行态卡片会区分 `排队中 / 准备上下文 / 生成中 / 执行中 / 已完成 / 失败 / 已取消`

## 📚 文档导航

- [快速开始](docs/getting-started.md) - 从零到一的完整指南
- [架构设计](docs/architecture.md) - 深入了解内部机制
- [FAQ](docs/faq.md) - 常见问题解答
- [部署指南](docs/deployment.md) - 生产环境部署建议
- [贡献指南](CONTRIBUTING.md) - 如何参与项目开发

## 🤝 参与贡献

我们欢迎各种形式的贡献！无论是提交 Bug、提出新功能建议，还是直接提交 Pull Request。请在贡献前阅读我们的 [贡献指南](CONTRIBUTING.md)。

## 📄 开源协议

本项目采用 [MIT License](LICENSE) 开源协议。
