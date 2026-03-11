# 快速开始

## 目标

在 10 分钟内把飞书消息接到 Codex CLI，并让机器人能在飞书里回复你。

## 前置条件

- Node.js `>= 20.10`
- `codex` 已安装并可执行
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
npm install -g https://github.com/colorcross/codex-feishu/releases/download/v0.1.6/codex-feishu-0.1.6.tgz
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
codex-feishu bind repo-a /abs/path/to/repo-a
codex-feishu bind repo-b /abs/path/to/repo-b
```

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

```bash
codex-feishu start
codex-feishu status
codex-feishu logs --lines 100
codex-feishu ps
codex-feishu stop --force
codex-feishu restart
codex-feishu audit tail --limit 20
```

## 回复模式

配置项：

```toml
[service]
reply_mode = "text"
```

可选值：

- `text`：最简单的纯文本回复
- `post`：富文本回复，适合长文本、状态摘要和命令回显
- `card`：交互卡片；需要 `transport = "webhook"` 才能完整使用卡片回调

建议：

- 本机 long-connection 优先用 `post`
- 共享 webhook 服务如果需要按钮交互，再切到 `card`

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
/admin project add <alias> <root>
/admin project remove <alias>
/admin project set <alias> <field> <value>
/admin service restart
```

这组命令会直接更新当前实例对应的可写配置文件；`/admin service restart` 会保存后重启服务。

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

### 3. 想看实际生效配置

```bash
codex-feishu print-config
```
