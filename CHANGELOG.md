# Changelog

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
