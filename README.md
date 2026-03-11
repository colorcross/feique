# Codex Feishu

[English](README.en.md) | 简体中文

[![GitHub tag](https://img.shields.io/github/v/tag/colorcross/codex-feishu?sort=semver)](https://github.com/colorcross/codex-feishu/tags)
[![License](https://img.shields.io/github/license/colorcross/codex-feishu)](https://github.com/colorcross/codex-feishu/blob/main/LICENSE)
[![Pages](https://github.com/colorcross/codex-feishu/actions/workflows/pages.yml/badge.svg)](https://github.com/colorcross/codex-feishu/actions/workflows/pages.yml)
[![Node >=20.10](https://img.shields.io/badge/node-%3E%3D20.10-0f172a)](https://nodejs.org/)
[![Feishu](https://img.shields.io/badge/feishu-supported-0ea5e9)](https://open.feishu.cn/)
[![Codex CLI](https://img.shields.io/badge/codex_cli-session--aware-c2410c)](https://developers.openai.com/codex/)

把飞书消息桥接到 Codex CLI，让你可以在飞书私聊或群聊里直接驱动本机或远端仓库里的 Codex 会话，同时保留项目路由、会话续接、运行审计和运维能力。

把飞书变成 Codex 的工作入口。

Codex Feishu 让飞书消息直接进入可续接的 Codex 会话。项目可路由，回复可追踪，运行可运维。它不是一段 prompt，也不是一次性 bot 脚本，而是一层能长期运行的工程桥接器。

## 链接

- 仓库：<https://github.com/colorcross/codex-feishu>
- 官网：<https://colorcross.github.io/codex-feishu/>
- 英文页：<https://colorcross.github.io/codex-feishu/en.html>
- npm：`npm install -g codex-feishu`
- Releases：<https://github.com/colorcross/codex-feishu/releases>
- Issues：<https://github.com/colorcross/codex-feishu/issues>
- Discussions：<https://github.com/colorcross/codex-feishu/discussions>

## 为什么存在

飞书是沟通入口，Codex CLI 是执行引擎。两者之间天然缺一层稳定的会话路由和运维控制。本项目补的就是这层：

- 飞书收消息，Codex 真正做事
- 一个飞书入口，可以路由到多个项目目录
- 一个项目，可以保留多轮 Codex session 历史
- 运行状态、审计日志、幂等去重、指标导出都在本地可控

## 核心能力

- `long-connection` 和 `webhook` 双模式接入飞书
- 项目级路由：`/project <alias>` 切换当前仓库
- Codex 会话续接：新会话走 `codex exec`，续会话走 `codex exec resume`
- 飞书命令控制：`/status`、`/new`、`/cancel`、`/session list|use|new|drop`
- 项目知识库搜索：`/kb status`、`/kb search <query>`
- 多媒体上下文透传：图片、文件、音频、富文本消息会带元数据进入 Codex 提示词；下载文本类附件和 `doc/docx/odt/rtf` 后会自动摘录内容片段；图片可选生成简短视觉说明
- 飞书知识库接入：`/wiki spaces`、`/wiki search <query>`、`/wiki read <url|token>`
- 飞书知识库创建：`/wiki create <title>`、`/wiki create <space_id> <title>`
- 飞书知识库节点改名：`/wiki rename <node_token> <title>`
- 飞书知识库节点复制/移动：`/wiki copy <node_token> [target_space_id]`、`/wiki move <source_space_id> <node_token> [target_space_id]`
- 飞书知识空间成员管理：`/wiki members [space_id]`、`/wiki grant <space_id> <member_type> <member_id> [member|admin]`、`/wiki revoke <space_id> <member_type> <member_id> [member|admin]`
- 多会话历史和当前激活 session 持久化
- 消息幂等去重，避免飞书重投或自激回环
- 原生飞书消息回复 UI，优先 reply 触发消息
- 启动预检、实例锁、后台运行、优雅停机
- 审计日志、Prometheus 指标、Grafana/Alertmanager 示例
- 一键全局安装脚本，默认生成 `~/.codex-feishu/config.toml`

## 运行模式

| 模式 | 适合场景 | 优点 | 限制 |
| --- | --- | --- | --- |
| `long-connection` | 本机开发、个人使用、无公网环境 | 不需要公网回调地址，接入快 | 卡片交互不是主路径 |
| `webhook` | 团队共享服务、生产部署 | 事件和卡片回调完整，便于扩展 | 需要公网 HTTPS 地址 |

## 快速开始

### 1. 环境要求

- Node.js `>= 20.10`
- 已安装并可执行的 `codex`
- 一个已启用机器人能力的飞书自建应用

### 2. 安装

优先使用 npm 全局安装：

```bash
npm install -g codex-feishu
codex-feishu init --mode global
```

如果 npm 包还没完成最终发布，可以先用 GitHub Release 产物：

```bash
npm install -g https://github.com/colorcross/codex-feishu/releases/download/v0.1.2/codex-feishu-0.1.2.tgz
codex-feishu init --mode global
```

如果你是从源码仓库本地联调，也可以继续用：

```bash
cd /path/to/codex-feishu
bash scripts/install.sh
```

这会完成三件事：

- 全局安装 `codex-feishu`
- 生成 `~/.codex-feishu/config.toml`
- 把当前仓库绑定为默认项目

如果要绑定别的仓库：

```bash
bash scripts/install.sh --project-root /abs/path/to/repo --alias repo-a
```

### 3. 配置环境变量

```bash
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='xxx'
```

如果你在启动 Codex 前要先开代理，可以在配置里加：

```toml
[codex]
shell = "/bin/zsh"
pre_exec = "proxy_on"
```

### 4. 启动服务

```bash
codex-feishu doctor
codex-feishu serve --detach
```

### 5. 在飞书里直接对话

常用命令：

- `/help`
- `/projects`
- `/project <alias>`
- `/status`
- `/new`
- `/cancel`
- `/kb status`
- `/kb search <query>`
- `/memory status`
- `/memory stats`
- `/memory status group`
- `/memory stats group`
- `/memory recent`
- `/memory recent group`
- `/memory recent --tag <tag>`
- `/memory recent --source <source>`
- `/memory recent --created-by <actor_id>`
- `/memory search <query>`
- `/memory search --tag <tag> <query>`
- `/memory search --source <source> <query>`
- `/memory search --created-by <actor_id> <query>`
- `/memory search group <query>`
- `/memory save <text>`
- `/memory save group <text>`
- `/memory pin <id>`
- `/memory unpin <id>`
- `/memory forget <id>`
- `/memory forget all-expired`
- `/memory restore <id>`
- `/wiki spaces`
- `/wiki search <query>`
- `/wiki read <url|token>`
- `/wiki create <title>`
- `/wiki rename <node_token> <title>`
- `/wiki copy <node_token> [target_space_id]`
- `/wiki move <source_space_id> <node_token> [target_space_id]`
- `/wiki members [space_id]`
- `/wiki grant <space_id> <member_type> <member_id> [member|admin]`
- `/wiki revoke <space_id> <member_type> <member_id> [member|admin]`
- `/session list`
- `/session use <thread_id>`

## 一个最小配置示例

```toml
version = 1

[service]
default_project = "default"
reply_mode = "text"
reply_quote_user_message = true
metrics_host = "127.0.0.1"
memory_enabled = true
memory_group_enabled = false
memory_cleanup_interval_seconds = 1800
memory_recent_limit = 5
memory_max_pinned_per_scope = 5
memory_pin_overflow_strategy = "age-out"
memory_pin_age_basis = "updated_at"
# memory_default_ttl_days = 30

[codex]
bin = "codex"
default_sandbox = "workspace-write"
skip_git_repo_check = true
run_timeout_ms = 600000

[storage]
dir = "~/.codex-feishu/state"

[security]
allowed_project_roots = ["/Users/dh/workspace"]
require_group_mentions = true

[feishu]
app_id = "env:FEISHU_APP_ID"
app_secret = "env:FEISHU_APP_SECRET"
transport = "long-connection"
allowed_chat_ids = []
allowed_group_ids = []

[projects.default]
root = "/Users/dh/workspace/repo-a"
session_scope = "chat"
mention_required = true
knowledge_paths = ["docs", "README.md"]
wiki_space_ids = ["space_xxx"]
```

如果已配置 `wiki_space_ids`，下面这条会在默认知识空间直接创建一篇 docx 文档：

```text
/wiki create 发布手册
```

知识空间成员管理示例：

```text
/wiki members
/wiki grant space_xxx open_id ou_xxx admin
/wiki revoke space_xxx open_id ou_xxx admin
```

## 飞书端交互模型

### 项目路由

- `selection key` 负责记住当前聊天窗口选中了哪个项目
- `session key` 负责记住当前项目对应的 Codex 会话
- `queue key = session key + project alias`，保证同一项目串行，不同项目可并行

### 群聊触发规则

默认更保守：

- 群聊默认必须 `@机器人` 才会触发
- 你也可以通过配置放开
- `allowed_group_ids` 可以限制只有白名单群可用

## 记忆设计

- `thread summary`：每个项目会话在每轮执行后都会更新压缩摘要，用于下一轮 prompt 注入
- `project memory`：支持显式保存、最近查看、搜索、置顶、归档、恢复项目级长期记忆
- `group shared memory`：可显式开启，仅在群聊内按 `project + chat_id` 生效，不跨群复用
- 检索：项目记忆默认走 SQLite + FTS5，中文等查询自动回退到 LIKE 搜索
- 生命周期：可通过 `memory_default_ttl_days` 给新记忆设置默认过期时间，并通过自动清理删除过期项
- 治理：支持按 `tag/source/created_by` 筛选 recent，也支持在 `/memory search` 上使用 `--tag` 和 `--source`
- 搜索治理：`/memory search` 支持 `--tag`、`--source`、`--created-by`
- 过期治理：支持 `/memory forget all-expired` 批量归档当前作用域下的过期项
- 统计治理：`/memory stats` 可直接查看 active / expired / pinned / archived / 最近访问时间
- 置顶治理：`memory_max_pinned_per_scope` 约束每个作用域的 pinned 数量，`memory_pin_overflow_strategy = "age-out"` 时会自动老化最旧 pinned 项；`memory_pin_age_basis` 可切换按 `updated_at` 或 `last_accessed_at` 决定淘汰对象
- 后台治理：`memory_cleanup_interval_seconds` 会定时清理过期记忆，不再只依赖用户命令或 prompt 注入
- 飞书命令：
  - `/memory status`
  - `/memory stats`
  - `/memory status group`
  - `/memory stats group`
  - `/memory recent` / `/memory recent group`
  - `/memory recent --tag <tag>`
  - `/memory recent --source <source>`
  - `/memory recent --created-by <actor_id>`
  - `/memory search <query>`
  - `/memory search --tag <tag> <query>`
  - `/memory search --source <source> <query>`
  - `/memory search --created-by <actor_id> <query>`
  - `/memory search group <query>`
  - `/memory save <text>`
  - `/memory save group <text>`
  - `/memory pin <id>` / `/memory unpin <id>`
  - `/memory forget <id>`
  - `/memory forget all-expired`
  - `/memory restore <id>`
- 详细设计见：[docs/memory-design.md](docs/memory-design.md)

### 回复行为

当 `service.reply_quote_user_message = true` 时：

- 优先用飞书原生 reply 回复触发消息
- 如果拿不到 `message_id`，才退回文本前缀引用

## 常用运维命令

```bash
codex-feishu serve status
codex-feishu serve logs --lines 100
codex-feishu serve ps
codex-feishu serve stop --force
codex-feishu audit tail --limit 20
codex-feishu doctor --remote
codex-feishu feishu inspect
```

## 仓库结构

```text
src/        核心实现
scripts/    安装和本地开发脚本
docs/       使用文档与架构说明
examples/   配置、监控、观测栈示例
skills/     可选 Codex skill
website/    官网静态站点，可直接用于 GitHub Pages
```

## 文档导航

- [文档首页](docs/README.md)
- [快速开始](docs/getting-started.md)
- [架构设计](docs/architecture.md)
- [部署说明](docs/deployment.md)
- [安全与运维](docs/security.md)
- [FAQ](docs/faq.md)
- [飞书交互路线图](docs/feishu-roadmap.md)
- [社区与支持](docs/community.md)
- [官网部署说明](docs/website.md)
- [变更记录](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)
- [支持入口](SUPPORT.md)
- [安全披露](SECURITY.md)

## 官网

静态官网源码在：

- [website/index.html](website/index.html)

GitHub Pages 目标地址：

- <https://colorcross.github.io/codex-feishu/>

如果你已经把代码推到 GitHub，Pages workflow 会在 `main` 分支更新后自动发布 `website/` 目录。

## 社区与支持

- 使用问题和部署讨论：GitHub Discussions
- 明确缺陷和可实现需求：GitHub Issues
- 安全问题：按 [SECURITY](SECURITY.md) 里的方式私下披露

## 开发与验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

本地 webhook 回放：

```bash
pnpm demo:up
pnpm demo:smoke
pnpm demo:down
```

## 发布

当前版本：`v0.1.1`

- [CHANGELOG.md](CHANGELOG.md)
- 当前发布 tag：`v0.1.1`

## License

MIT. See [LICENSE](LICENSE).
