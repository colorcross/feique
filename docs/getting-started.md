# 快速开始

## 目标

在 10 分钟内把飞书消息接到 Codex CLI 或 Claude Code，并让机器人能在飞书里回复你。

## 前置条件

- Node.js `>= 24`
- `codex` 或 `claude` (Claude Code) 已安装并可执行
- 已创建飞书自建应用，并开启机器人能力
- 飞书应用已配置事件订阅

## 路径 A：本机最快接入

适合个人使用。

### 1. 安装

直接从 npm 全局安装：

```bash
npm install -g codex-feishu
codex-feishu init --mode global
```

如果你想固定到某个 release 产物，也可以直接安装 GitHub Release 的 tgz：

```bash
npm install -g https://github.com/colorcross/codex-feishu/releases/download/v0.1.11/codex-feishu-0.1.11.tgz
codex-feishu init --mode global
```

如果你是从源码目录直接调试，也可以：

```bash
cd /path/to/codex-feishu
bash scripts/install.sh
```

### 2. 填环境变量

```bash
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='xxx'
```

### 3. 检查配置

```bash
codex-feishu print-config
codex-feishu doctor
codex-feishu doctor --remote
```

### 4. 启动服务

```bash
codex-feishu start
codex-feishu status
```

### 5. 在飞书里发消息

先私聊机器人，然后发送：

```text
/help
```

## 路径 B：团队共享部署

适合公共 bot 服务。

### 1. 使用 webhook 模式

配置里设置：

```toml
[feishu]
transport = "webhook"
host = "0.0.0.0"
port = 3333
event_path = "/webhook/event"
card_path = "/webhook/card"
verification_token = "env:FEISHU_VERIFICATION_TOKEN"
encrypt_key = "env:FEISHU_ENCRYPT_KEY"
```

### 2. 提供公网 HTTPS

至少暴露：

- `/webhook/event`
- `/webhook/card`
- `/healthz`
- `/readyz`

### 3. 飞书后台配置回调地址

把公网地址写进飞书开发者后台。

### 4. 启动服务

```bash
codex-feishu start
codex-feishu status
```

## 绑定多个项目

```bash
codex-feishu create-project repo-new /abs/path/to/repo-new
codex-feishu bind repo-a /abs/path/to/repo-a
codex-feishu bind repo-b /abs/path/to/repo-b
```

- `create-project`：目录不存在时，递归创建目录并接入项目
- `bind`：目录已经存在时，直接接入项目

飞书里切换项目：

```text
/project repo-a
/project repo-b
```

项目绑定默认按 `chat_id` 持久化：

- 私聊里切一次，后续这个私聊窗口会继续用该项目
- 群里切一次，后续这个群会继续用该项目
- 在群里再次执行 `/project <alias>` 会更新整群的默认项目

如果你希望切项目时自动接上该项目最近的本地 Codex 会话，可打开：

```toml
[service]
project_switch_auto_adopt_latest = true
```

如果你想手工指定要续接的原生 Codex 会话，可直接在飞书里用：

```text
/session adopt list
/session adopt latest
/session adopt <thread_id>
```

这会去本机 `~/.codex/sessions` 里找当前项目可匹配的 Codex CLI 会话，并把它设成当前 chat 下该项目的 active session。

## 权限模型

桥接器现在支持三档 `chat_id` 角色：

- `viewer`：可见项目、查看 `/projects`、`/status`、`/session list`
- `operator`：可切项目、接管会话、取消运行、查看 `/admin runs`
- `admin`：可修改配置、增删项目、回滚配置、重启服务

细粒度能力名单：

- `session_operator_chat_ids`：只授予会话接管 / 切换，不放开运行
- `run_operator_chat_ids`：只授予运行 / 取消运行
- `config_admin_chat_ids`：只授予单项目配置修改
- `service_observer_chat_ids`：只授予全局运行观察和服务状态查看
- `service_restart_chat_ids`：只授予服务重启

可在全局或项目级配置：

```toml
[security]
viewer_chat_ids = ["oc_viewer_chat_1"]
operator_chat_ids = ["oc_operator_chat_1"]
admin_chat_ids = ["oc_admin_chat_1"]

[projects.repo-a]
root = "/srv/repos/repo-a"
viewer_chat_ids = ["oc_repo_viewer_1"]
operator_chat_ids = ["oc_repo_operator_1"]
admin_chat_ids = ["oc_repo_admin_1"]
session_operator_chat_ids = ["oc_repo_session_operator_1"]
run_operator_chat_ids = ["oc_repo_run_operator_1"]
config_admin_chat_ids = ["oc_repo_config_admin_1"]
```

默认规则：

- 没有配置任一角色名单时，项目默认开放
- 一旦某个项目或全局配置了角色名单，该项目会按最小权限收口

## 排队与仓库占用提示

如果当前 chat 下同一项目已经有运行，或者别的 chat 正在操作同一个 `project.root`，新消息不会静默等待，而是会先收到一条 `queued` 提示：

- 同 chat 内排队：`当前项目 <alias> 已有任务在处理，已进入排队。`
- 跨 chat 命中仓库锁：`当前仓库正在被其他会话操作，已进入排队。`

这时可以继续用：

```text
/status
```

查看当前运行状态和排队原因。

## 群聊建议

默认建议：

```toml
[security]
require_group_mentions = true
```

这样群里只有 `@机器人` 才会触发，能显著减少误触发。

如果要把入口再收紧，补白名单：

```toml
[feishu]
allowed_group_ids = ["oc_group_1", "oc_group_2"]
```

## 常用命令

- `codex-feishu start`：后台启动 bridge
- `codex-feishu status`：查看服务是否在运行、pid、日志路径和 active runs
- `codex-feishu logs --lines 100`：查看最近日志
- `codex-feishu logs --follow`：实时观察日志追加内容
- `codex-feishu logs --rotate`：轮转 runtime / audit 日志
- `codex-feishu ps`：查看当前任务列表和运行态
- `codex-feishu stop --force`：停止服务，必要时强制终止
- `codex-feishu restart`：重启后台服务
- `codex-feishu audit tail --limit 20`：查看最近审计事件
- `codex-feishu audit cleanup`：按 retention / archive 策略归档并清理审计日志
- `codex-feishu doctor --fix`：创建缺失状态目录、清理 stale pid、轮转超大日志并执行审计清理
- `codex-feishu upgrade --check`：检查 npm 是否有新版本
- `codex-feishu upgrade --yes`：从 npm 全局升级到最新版本
- `codex-feishu mcp`：启动 MCP 服务，供 OpenClaw 等外部工具接入
  - 可通过 `project.create` / `project.switch` / `session.adopt` 做项目创建、切换和本地会话接管
  - 可通过 `command.interpret` / `command.execute` 安全解释并执行自然语言控制命令
  - `--transport http` 可直接暴露 HTTP/SSE MCP 入口
  - 可使用 `mcp.auth_tokens` 或 `--auth-token --auth-token-id` 做多 token/轮换

常用飞书端运维命令：

- `/status detail`：查看当前项目的详细运行状态、排队耗时和最近失败
- `/admin runs`：管理员查看所有 active / queued 运行和最近失败
- `/admin config history`：查看最近 5 次配置快照
- `/admin config rollback <id|latest>`：回滚配置快照

飞书对象命令：

- `/doc read <url|token>`：读取飞书文档纯文本摘要
- `/doc create <title>`：创建飞书文档
- `/task list [limit]`：列出最近任务
- `/task get <task_guid>`：查看任务详情
- `/task create <summary>`：创建任务
- `/task complete <task_guid>`：完成任务
- `/base tables <app_token>`：列出多维表格中的数据表
- `/base records <app_token> <table_id> [limit]`：列出多维表格记录
- `/base create <app_token> <table_id> <json>`：新建多维表格记录
- `/base update <app_token> <table_id> <record_id> <json>`：更新多维表格记录

探针与指标：

- `/healthz`：进程活性和 HTTP 面是否正常
- `/readyz`：当前是否 ready，可用于流量接入和启动探针
- `/metrics`：Prometheus 文本格式指标，包含 readiness / live / startup warning / startup error

## MCP HTTP/SSE

如果外部客户端不方便走 `stdio`，可直接启 HTTP：

```bash
codex-feishu mcp --transport http --host 127.0.0.1 --port 8765 --auth-token "$MCP_AUTH_TOKEN_PRIMARY" --auth-token-id primary
```

对应配置：

```toml
[mcp]
transport = "http"
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
```

建议：

- `POST /mcp`：同步 JSON-RPC
- `GET /mcp/sse` + `POST /mcp/message?sessionId=...`：SSE 会话
- HTTP 模式下始终配置 MCP token；推荐主 token + rollover token 共存一段时间后再移除旧 token

## 项目隔离目录

未显式设置时，每个项目默认会在 `storage.dir` 下落到独立目录：

- 下载文件：`state/projects/<alias>/downloads`
- 临时文件：`state/projects/<alias>/tmp`
- 缓存：`state/projects/<alias>/cache`
- 项目审计：`state/projects/<alias>/logs/project-audit.jsonl`
- 项目归档：`state/projects/<alias>/archive/project-audit.jsonl`

也可以单独覆盖：

```toml
[projects.repo-a]
root = "/srv/repos/repo-a"
run_priority = 200
download_dir = "/srv/codex-feishu/downloads/repo-a"
temp_dir = "/srv/codex-feishu/tmp/repo-a"
cache_dir = "/srv/codex-feishu/cache/repo-a"
log_dir = "/srv/codex-feishu/logs/repo-a"
```

当多个项目共享同一个 `project.root` 锁时，`run_priority` 更高的项目会优先执行；相同优先级仍按 FIFO 排队。

## 回复模式

配置项：

```toml
[service]
reply_mode = "card"
```

可选值：

- `text`：最简单的纯文本回复
- `post`：富文本回复，自动保留标题、列表、链接，适合长文本、状态摘要和命令回显
- `card`：卡片展示；long-connection 也能显示卡片，但卡片按钮回调仍需要 `transport = "webhook"`

建议：

- 本机 long-connection 如果希望回复更像工作台卡片，优先用 `card`
- 如果只想保留轻量富文本、减少卡片视觉密度，再退回 `post`
- 共享 webhook 服务如果需要按钮交互，再切到 `card`

补充：

- 当前默认体验是直接返回单条最终结果，不再先发一条 `处理中`
- `card` 模式下最终结果会以更清晰的卡片返回，状态值用中文展示
- 用户可见回复默认隐藏内部 `运行:` 标识，也不会再附带 `引用 / 项目 / 耗时` 这类工程化头部
- 飞书里也支持高置信度自然语言命令，例如 `查看状态`、`切换到项目 repo-a`、`接管最新会话`
- 自然语言命令和斜杠命令会直接执行，不再额外要求回复 `确认`

## 管理员入口

管理员入口按 `chat_id` 控制：

```toml
[security]
admin_chat_ids = ["oc_admin_chat_1"]
```

常用管理员命令：

```text
/admin status
/admin admin add <chat_id>
/admin admin remove <chat_id>
/admin group add <chat_id>
/admin group remove <chat_id>
/admin chat add <chat_id>
/admin chat remove <chat_id>
/admin project list
/admin project create <alias> <root>
/admin project add <alias> <root>
/admin project remove <alias>
/admin project set <alias> <field> <value>
/admin config history
/admin config rollback <id|latest>
/admin service restart
```

说明：
- `/admin project create <alias> <root>`：在指定目录递归创建项目根目录，并把它接入当前实例配置。
- `/admin project add <alias> <root>`：目录已经存在时，把它接入当前实例配置。

这组命令会直接更新当前实例对应的可写配置文件；`/admin service restart` 会保存后重启服务。

如果你要给单个项目单独授权管理员或限流，可以加：

```toml
[projects.repo-a]
admin_chat_ids = ["oc_repo_admin_1"]
chat_rate_limit_window_seconds = 60
chat_rate_limit_max_runs = 20
download_dir = "/srv/codex-feishu/downloads/repo-a"
temp_dir = "/srv/codex-feishu/tmp/repo-a"
```

## 常见联调问题

### 1. 机器人收不到消息

先检查：

```bash
codex-feishu feishu inspect
codex-feishu doctor --remote
```

### 2. Codex 启动前需要先开代理

在配置里加入：

```toml
[codex]
shell = "/bin/zsh"
pre_exec = "proxy_on"
```

长连接模式会继承当前 shell 的 `HTTP_PROXY` / `HTTPS_PROXY`，所以飞书 WebSocket 也会走代理，不需要再单独给事件通道做一份代理配置。

### 4. 使用 Claude Code 后端

如果你想用 Claude Code 替代 Codex：

```toml
[backend]
default = "claude"

[claude]
bin = "claude"
default_permission_mode = "auto"
default_model = "sonnet"
# max_budget_usd = 5.0
# allowed_tools = ["Bash", "Read", "Edit", "Write"]
```

也可以只在特定项目上使用 Claude：

```toml
[projects.my-claude-project]
root = "/path/to/project"
backend = "claude"
claude_model = "opus"
claude_permission_mode = "auto"
```

Claude 后端会自动调用 `claude -p --output-format stream-json`，并支持 `--resume` 续接会话。

### 3. 想看实际生效配置

```bash
codex-feishu print-config
```
