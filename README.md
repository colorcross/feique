# 飞鹊 (Feique) v1.4.0

<div align="center">

**团队 AI 协作中枢 — 从个人提效到团队协作，让 AI 融入工作的每个环节。**

[![npm version](https://img.shields.io/npm/v/feique.svg?style=flat-square&color=5bb8b0)](https://www.npmjs.com/package/feique)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square&color=d4845a)](LICENSE)
[![Node.js Version](https://img.shields.io/node/v/feique.svg?style=flat-square)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[English](README.en.md) | [官网](https://colorcross.github.io/feique/) | [快速开始](docs/getting-started.md) | [架构设计](docs/architecture.md) | [FAQ](docs/faq.md)

</div>

---

飞鹊 (Feique) 是**团队 AI 协作中枢**。它通过飞书连接 Codex CLI、Claude Code 等 AI 能力，让团队成员协作配合、相互促进——帮助发现问题和瓶颈、提升效率，推动从个人能力的提升，到团队协作的顺畅，再到整体能力的持续迭代。

当前已支持 AI 编程场景的完整链路：项目绑定按 `chat_id` 持久化，本地会话可接管，同仓库自动串行，排队和运行态在飞书里直接可见；最终回复支持富文本和卡片，并默认收口成更干净的单条结果消息。

## 🌟 核心特性

| 特性 | 描述 |
| :--- | :--- |
| **项目路由 (Sticky Routing)** | 项目选择按 `chat_id` 记住。群里切一次项目，整群后续会继承；私聊也会记住各自的当前项目。 |
| **会话接管 (Session Adoption)** | 既能 resume 桥接器自己的 session，也能通过 `/session adopt` 直接接管 `~/.codex/sessions` 或 `~/.claude/sessions` 里的本地原生会话。 |
| **并发保护 (Runtime Guard)** | `queue key` + `project.root` 双层串行。同项目 thread 不会乱写，不同群同时操作同一仓库也会被自动收口并显示排队状态。 |
| **飞书对象工具面 (Docs / Base / Tasks)** | 除了 `/wiki` 和 `/kb search`，还支持直接读取/创建飞书文档、列任务/建任务/完结任务，以及查看/写入多维表格记录。 |
| **多模态上下文 (Media Aware)** | 图片、文件、音频、富文本消息会被解析成结构化元数据，并带进 Codex 提示词。 |
| **MCP 接口 (MCP Surface)** | 不只给飞书用，运行 `feique mcp` 即可通过 `stdio` 或 `HTTP/SSE` 暴露能力，支持多 token 轮换鉴权，并可给 OpenClaw 等客户端开放项目切换、会话接管和自然语言控制。 |
| **权限分层 (Access Roles)** | 支持 `viewer / operator / admin` 三档角色，并补了 session / run / config / service 级能力名单。 |
| **记忆系统 (Memory System)** | 支持项目记忆与群共享记忆，SQLite + FTS5 检索，可配置 TTL、置顶策略和后台定时清理。 |
| **项目隔离 (Project Isolation)** | 下载、临时文件、缓存和项目审计默认落到 `state/projects/<alias>/...`，也可按项目单独指定。 |
| **可观测性 (Observability)** | 内置 `/healthz`、`/readyz`、`/metrics`，支持 Prometheus / Alertmanager / Grafana，并补齐启动告警、运行链路日志和审计。 |
| **多后端支持 (Multi-Backend)** | 同一桥接器可同时管理 Codex 和 Claude Code 后端，通过 `[backend]` 配置全局默认或按项目覆盖。Claude 后端支持 `--model`、`--permission-mode`、`--max-budget-usd` 等高级选项。**v1.4 新增启动级 failover**：默认 backend 的 CLI 不可用时自动临时切到另一个 backend 跑当前请求。 |
| **Pairing UX (v1.4)** | 陌生 chat 首次 @ bot 时返回友好提示（附自己的 chat_id 和申请指引），同时一次性通知 admin，不再静默丢包。 |
| **团队协作态势 (Team Awareness)** | `/team` 实时查看谁在用 AI 做什么，自动冲突预警。 |
| **知识回路 (Knowledge Loop)** | `/learn` `/recall` 团队知识沉淀与语义检索，AI 自动提取。 |
| **接力评审 (Handoff & Review)** | `/handoff` `/pickup` `/review` `/approve` `/reject` 会话交接与评审流程。 |
| **瓶颈诊断 (Team Insights)** | `/insights` 重试模式 / 重复劳动 / 队列瓶颈 / 错误集群检测。 |
| **信任边界 (Trust Boundaries)** | `/trust` 渐进式信任：observe → suggest → execute → autonomous。 |
| **上下文连续性 (Context Continuity)** | `/timeline` 项目时间线，新人自动获得历史上下文。 |
| **团队日报 (Team Digest)** | `/digest` 定时推送团队 AI 协作日报。 |
| **Web 仪表板 (Dashboard)** | `GET /dashboard` 嵌入式 Web UI，可视化查看运行态和团队状态。 |
| **项目级定制 (Per-project Customization)** | 每个项目可独立配置 AI 模型版本、沙箱策略、MCP 工具服务器和技能包，并支持三层人格设定（全局 → 项目 → 后端指令）。 |
| **飞书文件发送 (File Sending)** | AI 可通过 `[SEND_FILE:path]` 标记或直接调 API 发送文件/图片到飞书对话。 |
| **主动告警 (Proactive Alerts)** | 连续失败、重试循环、成本阈值、长时间运行自动推送飞书告警。 |
| **知识缺口检测 (Knowledge Gaps)** | `/gaps` 命令分析团队反复提问但尚未沉淀的知识盲区。 |
| **成本追踪 (Cost Tracking)** | token 用量按项目 / 用户统计，预估成本。 |

## 🚀 快速开始

### 1. 安装

```bash
npm install -g feique
feique init --mode global

# 创建一个新项目目录并接入配置
feique create-project repo-new /srv/codex/repo-new

# 绑定已有目录为项目
feique bind repo-a /path/to/repo-a
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
feique doctor --remote

# 启动服务
feique start

# 查看日志
feique logs --follow
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

# 团队协作
/team                    # 查看谁在用 AI 做什么
/learn 部署前必须跑完 e2e  # 沉淀团队知识
/recall 部署流程           # 语义检索已有知识
/handoff @张三 继续修复    # 将当前会话交接给队友
/pickup                  # 接手交接给你的会话
/review                  # 发起评审
/approve                 # 批准评审
/reject 需要补测试用例     # 打回评审并注明原因
/insights                # 查看团队瓶颈诊断
/trust suggest           # 设置当前项目信任级别
/timeline                # 查看项目时间线
/digest                  # 手动触发团队日报

# 自然语言命令
切换到项目 repo-a
接管最新会话
查看详细状态
团队现在谁在忙？
帮我把会话交给小王
这个项目最近都发生了什么？
```

## 🏗️ 架构概览

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

详细的架构设计请参考 [架构文档](docs/architecture.md)。

## ⚙️ 最小配置示例

配置文件默认位于 `~/.feique/config.toml`：

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
dir = "~/.feique/state"

[embedding]
provider = "ollama"
ollama_model = "auto"  # 自动探测本地最优嵌入模型

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
download_dir = "/srv/feique/projects/repo-a/downloads"
temp_dir = "/srv/feique/projects/repo-a/tmp"
cache_dir = "/srv/feique/projects/repo-a/cache"
log_dir = "/srv/feique/projects/repo-a/logs"
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

- `feique mcp` 默认仍可跑 `stdio`
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
