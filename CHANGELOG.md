# Changelog

## Unreleased

### Highlights

- 新增 `viewer / operator / admin` 三档访问模型，把项目可见性、会话控制和服务级操作分层收口。
- 提升可观测性入口，`/healthz`、`/readyz`、`/metrics` 现在会携带 readiness 与启动告警信息。
- MCP 与飞书共用项目/会话控制层，项目切换、会话接管和状态查看不再重复维护两套逻辑。
- MCP 新增 `HTTP/SSE + Bearer token` 入口，便于 OpenClaw 等远端客户端接入。
- 权限从“角色”扩到“能力”，新增 session/run/config/service 级 allow-list。
- 项目默认拥有独立的下载、临时文件、缓存和项目审计目录，收口到 `storage.dir/projects/<alias>/...`。

### Included

- 权限与共享控制层：
  - `src/security/access.ts`
  - `src/control-plane/project-session.ts`
  - `src/bridge/service.ts`
  - `src/mcp/server.ts`
- MCP HTTP/SSE 与项目隔离：
  - `src/projects/paths.ts`
  - `src/codex/runner.ts`
  - `tests/mcp-http-server.test.ts`
- readiness / metrics：
  - `src/observability/readiness.ts`
  - `src/observability/metrics.ts`
  - `src/observability/server.ts`
  - `src/feishu/webhook.ts`
  - `src/feishu/long-connection.ts`
  - `src/cli.ts`
- 文档与官网：
  - `README.md`
  - `README.en.md`
  - `docs/getting-started.md`
  - `docs/deployment.md`
  - `website/index.html`
  - `website/en.html`

## v0.1.10 - 2026-03-11

### Highlights

- MCP 接口扩展为可切项目、接管本地 Codex 会话，并支持对自然语言控制命令做解释和确认式执行，方便 OpenClaw 等外部客户端接入。
- 清理两处已确认无用的内部字段，避免继续暴露未使用的运行态回复元数据和无效重启参数。
- README、部署文档、FAQ、官网和文档索引同步更新，统一说明新的 MCP 控制面能力。

### Included

- MCP / 会话控制：
  - `src/mcp/server.ts`
  - `tests/mcp-server.test.ts`
- 废弃内部字段清理：
  - `src/bridge/service.ts`
- 文档与官网：
  - `README.md`
  - `README.en.md`
  - `docs/README.md`
  - `docs/README.en.md`
  - `docs/getting-started.md`
  - `docs/deployment.md`
  - `docs/faq.md`
  - `website/index.html`
  - `website/en.html`

## v0.1.9 - 2026-03-11

### Highlights

- 仓库最低 Node 版本要求升级到 Node 24，本地与 CI 口径保持一致。
- GitHub Actions 工作流里的官方 actions 主版本同步升级到 Node 24 对应版本，进一步消除 Node 20 弃用告警来源。

### Included

- Node/runtime：
  - `package.json`
  - `.github/workflows/release.yml`
  - `.github/workflows/pages.yml`
  - `.github/workflows/issue-triage.yml`
  - `.github/workflows/pr-labeler.yml`
- 文档：
  - `README.md`
  - `README.en.md`
  - `docs/getting-started.md`

## v0.1.8 - 2026-03-11

### Highlights

- 仓库最低 Node 版本要求升级到 Node 24，本地与 CI 口径保持一致。
- GitHub Actions 工作流显式切到 Node 24 JavaScript action runtime，避免继续触发 Node 20 弃用告警。

### Included

- Node/runtime：
  - `package.json`
  - `.github/workflows/release.yml`
  - `.github/workflows/pages.yml`
  - `.github/workflows/issue-triage.yml`
  - `.github/workflows/pr-labeler.yml`
- 文档：
  - `README.md`
  - `docs/getting-started.md`

## v0.1.7 - 2026-03-11

### Highlights

- 清理文档和示例里的本机强相关口径，统一改为可迁移的占位路径和环境变量引用。
- 飞书回复链路支持 `post` 富文本模式与管理员动态控制；运行态回复不再暴露用户侧 `run_id`。
- 运行管理 CLI 补齐 `start|status|logs|ps|stop|restart`，并让 `status/logs/ps/stop` 不再依赖飞书密钥环境变量。
- 日志增加敏感字段脱敏和 `queued/running/completed/cancelled/failed` 关键运行态结构化记录。

### Included

- 配置与 CLI：
  - `src/config/load.ts`
  - `src/config/mutate.ts`
  - `src/cli.ts`
  - `examples/config.global.toml`
- 飞书回复与管理员控制：
  - `src/bridge/service.ts`
  - `src/bridge/commands.ts`
  - `src/feishu/client.ts`
  - `src/feishu/text.ts`
  - `src/feishu/cards.ts`
- 日志与清理：
  - `src/logging.ts`
  - `src/bridge/types.ts`
- 文档：
  - `README.md`
  - `README.en.md`
  - `docs/README.md`
  - `docs/README.en.md`
  - `docs/getting-started.md`
  - `docs/deployment.md`
  - `docs/security.md`
  - `docs/faq.md`
  - `docs/architecture.md`
  - `docs/website.md`

## v0.1.6 - 2026-03-11

### Highlights

- 官网模块标题和说明文案改为用户视角，移除“这轮迭代”“首页应该反映”这类内部叙事。
- 首页现在更直接聚焦项目做什么、为什么适合真实团队使用，以及用户下一步该怎么开始。
- 中英文页面的 How it works / Capabilities / Quick Start / Docs / CTA 文案已同步收口。

### Included

- 官网：
  - `website/index.html`
  - `website/en.html`

### Verification

- 本地静态预览检查通过（中文页 / 英文页）

## v0.1.5 - 2026-03-11

### Highlights

- 优化官网所有超大号标题的字体与排版密度，降低拥挤感，提升中英文首屏和模块标题的可读性。
- 英文展示字体切到更克制的 serif 风格，中文大标题与模块标题同步放松行高、字号和段内节奏。
- 重生成官网社交预览图，让分享图与新的首屏排版保持一致。

### Included

- 官网：
  - `website/index.html`
  - `website/en.html`
  - `website/styles.css`
  - `website/social-preview.png`
  - `.github/assets/social-preview.png`

### Verification

- `npm run typecheck`
- `npm run test`
- `npm run build`
- 本地静态预览检查通过（中文页 / 英文页）

## v0.1.4 - 2026-03-11

### Highlights

- 官网重做为更明确的产品控制面风格，首页直接突出 npm 安装、`chat_id` 项目绑定、`/session adopt`、`project.root` 串行和 `queued` 运行态。
- README、上手文档、FAQ、部署文档和官网说明统一切到“npm 已发布”的最新口径，不再保留首发前的占位表述。
- 更新中英文首页共用视觉系统，并刷新仓库可用的社交预览图资源。
- 修复 release workflow 在无 lockfile 仓库里的失败路径，并允许手动补发时同时执行 npm publish。
- 修复运行态存储在同一毫秒内连续写入时的时间戳排序不稳定问题，避免 `queued` / `running` 可见顺序漂移。

### Included

- 官网：
  - `website/index.html`
  - `website/en.html`
  - `website/styles.css`
  - `website/social-preview.png`
  - `.github/assets/social-preview.png`
- 运行态与发布：
  - `src/state/run-state-store.ts`
  - `.github/workflows/release.yml`
- 文档：
  - `README.md`
  - `README.en.md`
  - `docs/getting-started.md`
  - `docs/deployment.md`
  - `docs/faq.md`
  - `docs/website.md`
  - `docs/website-redesign.md`

### Verification

- `npm run typecheck`
- `npm run test`
- `npm run build`
- 本地静态预览检查通过（中文页 / 英文页）

## v0.1.2 - 2026-03-11

### Highlights

- 官网继续收敛为更克制的高端极简风格，优化中文大标题的字体、节奏和层次。
- 新增英文官网落地页，并和中文官网共用同一套视觉系统。
- 增加 npm 发布准备，包括公共发布配置、npm 安装方式和相关文档更新。
- 新增飞书交互路线图，明确文档 / 知识库 / 多媒体沟通的下一阶段范围。
- 新增 `/kb status`、`/kb search <query>`，支持项目内文档搜索。
- 图片、文件、音频、富文本消息会解析成结构化元数据并注入 Codex 提示词。
- 新增 `/session adopt latest|list|<thread_id>`，可在飞书里直接接管本机 `~/.codex/sessions` 下的原生 Codex CLI 会话。
- 项目绑定改为按 `chat_id` 持久化；群里切一次项目后，整群后续消息会继承该项目。
- 新增 `service.project_switch_auto_adopt_latest = true`，切项目时可自动续上该项目最近的本地 Codex 会话。
- 运行串行从 `queue key` 扩展到 `project.root`，避免不同群、不同私聊同时操作同一仓库。
- 新增 `queued` 可见运行态，命中项目内队列或仓库锁时会先返回排队提示，`/status` 与卡片状态也能看到排队原因。
- 新增飞书知识库写操作：创建、改名、复制、移动和知识空间成员管理。

### Included

- 官网：
  - `website/index.html`
  - `website/en.html`
  - `website/styles.css`
- 文档：
  - `README.md`
  - `README.en.md`
  - `docs/getting-started.md`
  - `docs/README.md`
  - `docs/README.en.md`
  - `docs/faq.md`
  - `docs/feishu-roadmap.md`
- 会话 / 项目路由：
  - `src/codex/session-index.ts`
  - `src/bridge/service.ts`
  - `src/state/session-store.ts`
  - `src/bridge/task-queue.ts`
  - `src/state/run-state-store.ts`
- 飞书交互：
  - `src/feishu/extractors.ts`
  - `src/knowledge/search.ts`
  - `src/bridge/service.ts`
- 飞书 wiki：
  - `src/feishu/wiki.ts`
  - `src/bridge/commands.ts`
  - `tests/bridge-service.test.ts`
- 发布准备：
  - `package.json`
  - `src/cli.ts`

### Verification

- `npm run build`
- `npm run test`
- `npm run typecheck`
- `npm pack --dry-run`
- GitHub Pages 中英文页面可访问

## v0.1.1 - 2026-03-10

### Highlights

- 完成 GitHub 开源发布收口，补齐 README、文档首页、FAQ、贡献指南和安全披露文档。
- 新增 `website/` 静态官网，并通过 GitHub Pages 自动发布到 `https://colorcross.github.io/codex-feishu/`。
- 增加 GitHub Pages workflow 与仓库元信息，使仓库首页、Release、官网三处入口保持一致。

### Included

- GitHub README 重写，补齐项目定位、安装方式、文档导航和官网入口
- 新增开源配套文档：
  - `docs/README.md`
  - `docs/getting-started.md`
  - `docs/faq.md`
  - `docs/website.md`
  - `CONTRIBUTING.md`
  - `SECURITY.md`
- 新增官网静态站点：
  - `website/index.html`
  - `website/styles.css`
  - `website/favicon.svg`
- 新增 GitHub Actions workflow：
  - `.github/workflows/pages.yml`

### Verification

- `npm run build`
- 文档/官网链接检查通过
- GitHub Pages workflow 发布成功

## v0.1.0 - 2026-03-10

### Highlights

- 发布 `Codex Feishu` 首个可部署版本，支持飞书 `long-connection` 和 `webhook` 两种接入模式。
- 建立项目路由、会话续接、多会话历史和飞书命令控制链路，可在飞书侧按项目驱动 Codex CLI。
- 提供面向生产的运行能力，包括实例锁、启动预检、后台运行、运行超时、取消、stale/orphaned run 恢复和运行态管理命令。
- 增加消息幂等去重、审计日志、Prometheus 指标、Alertmanager/Grafana 示例，满足基础观测和排障需求。
- 支持飞书原生消息回复、私聊/群聊白名单、群聊 `@mention` 控制，以及一键全局安装脚本。

### Included

- 飞书接入：
  - `long-connection` 文本消息桥接
  - `webhook` 事件订阅与卡片回调
  - 原生消息回复、卡片状态回复、手工回放和 smoke 测试
- Codex 编排：
  - `codex exec` 新会话
  - `codex exec resume` 续会话
  - CLI 能力探测与版本兼容
  - `pre_exec` 预执行命令支持，例如 `proxy_on`
- 会话与项目：
  - `/help`
  - `/projects`
  - `/project <alias>`
  - `/status`
  - `/new`
  - `/cancel`
  - `/session list|use|new|drop`
  - 同聊天窗口下按项目隔离队列
- 运行与运维：
  - `serve --detach`
  - `serve status`
  - `serve logs`
  - `serve ps`
  - `serve stop`
  - `doctor`
  - `doctor --remote`
  - `feishu inspect`
  - 用户级 `launchd/systemd` 服务模板
- 可观测性：
  - 审计日志 `audit.jsonl`
  - Prometheus `/metrics`
  - Alertmanager 配置示例
  - Grafana provisioning 与 dashboard 示例
- 安装与交付：
  - 全局/项目级配置
  - `codex-feishu bind`
  - 可选 Codex skill 安装
  - 一键安装脚本 `scripts/install.sh`

### Default Behavior

- 群聊默认要求 `@机器人` 才触发，除非显式关闭 `security.require_group_mentions`。
- 启用 `service.reply_quote_user_message = true` 时，优先使用飞书原生 reply 回复触发消息。
- `bind` 默认优先使用最近项目配置；若不存在项目配置，则回退到全局 `~/.codex-feishu/config.toml`。

### Known Limitations

- `long-connection` 主要适合文本消息接入；复杂卡片交互仍以 `webhook` 模式为主。
- 真实飞书联调依赖租户侧应用可用性、机器人能力和事件订阅配置。
- `security.allowed_project_roots = ["/"]` 仅适合临时联调，不适合作为长期生产配置。

### Verification

- `npm run test`
- `npm run typecheck`
- `npm run build`

当前版本在发布前验证结果：

- `21` 个测试文件通过
- `59` 个测试用例通过
