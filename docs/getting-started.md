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

```bash
cd /path/to/codex-feishu-bridge
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
codex-feishu serve --detach
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
codex-feishu serve --detach
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
codex-feishu serve status
codex-feishu serve logs --lines 100
codex-feishu serve ps
codex-feishu serve stop --force
codex-feishu audit tail --limit 20
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

### 3. 想看实际生效配置

```bash
codex-feishu print-config
```
