# Changelog

## [1.4.0] — 2026-04-09

### 新功能
- **Backend 启动级 failover**: 当默认 backend 的 CLI 不可用（二进制缺失、PATH 坏掉、pre_exec 失败）时，自动临时切换到另一个 backend 跑当前请求
  - 60 秒 probe 结果缓存，避免重复探测
  - 双向支持（codex ↔ claude），可通过 `backend.failover = false` 全局关闭或 `projects.<alias>.failover = false` 单项目关闭
  - 触发时在用户回复中加一行 `⚠️ claude 不可用，已临时切换到 codex`
  - 向 `security.admin_chat_ids` 发送一次性通知（同一方向进程内只通知一次）
  - 审计事件 `backend.failover`
- **陌生 chat 的 pairing UX**: 陌生人首次 @ bot 时从「静默丢包」变为提示用户贴出自己的 chat_id 并联系 admin，同时通知 admin 有新接入请求
  - 旧行为：非空白名单下消息直接 drop，admin 不知情；空白名单下直接返回泛泛的"未授权"
  - 新行为：回复包含自己的 chat_id + 所需白名单字段名 + 申请指引；admin 收到带 `/admin chat add <id>` 可复制命令的通知
  - 进程内按 chat_id 去重，避免 admin 被反复骚扰
  - 审计事件 `chat.rejected`

### 重大重构 — `src/bridge/service.ts` 拆分
将 5344 行的 `src/bridge/service.ts` 拆分到 9 个聚焦模块，**净减少 2491 行（-46.6%）**。最终 service.ts 2853 行，只保留状态、构造器、消息分发、status/admin/project 命令分派。

拆出的 9 个新模块:
- `src/bridge/service-utils.ts` — 21 个纯 helper（queue key、diff、dedupe、memory section 渲染等）
- `src/bridge/feishu-commands.ts` — `/doc`、`/task`、`/base`、`/wiki` 四个 Feishu 子 SDK 命令
- `src/bridge/memory-commands.ts` — `/memory` 命令及内部 helper
- `src/bridge/collab-commands.ts` — `/learn`、`/recall`、`/handoff`、`/pickup`、`/review`、`/approve`、`/reject`、`/insights`、`/trust`、`/digest`、`/gaps`、`/timeline` 12 个协作命令
- `src/bridge/lifecycle.ts` — 运行时恢复、配置热重载、周期性 digest / memory maintenance / audit cleanup
- `src/bridge/reply-builders.ts` — 7 个纯回复 / 卡片构造器
- `src/bridge/admin-config.ts` — `/admin config history|rollback` + 项目字段 patch 解析
- `src/bridge/run-scheduler.ts` — 双 TaskQueue 调度 + 排队状态提示构造
- `src/bridge/run-pipeline.ts` — `executePrompt` 完整 20-phase run pipeline

### 修复与打磨
- 消除 `bridge-service.test.ts` 和 `collaboration-e2e.test.ts` 的长期 flake（v1.3.3 baseline 26-37 failed → v1.4.0 **529/529 全绿**）
  - 新增 `vitest.config.ts` 将默认 `testTimeout` 从 5s 提到 15s，`hookTimeout` 同步提升
  - 将 bridge-service.test.ts 内部 `waitFor` 的 deadline 从 3s 提到 10s，允许队列排队测试等待完整 pipeline 落盘
- 删除 `src/config/paths.ts` 和 `src/config/load.ts` 中对 `~/.codex-feishu` / `~/.feishu-bridge` 的 legacy fallback（**潜在 breaking**：仍在用老目录的用户需要迁移到 `~/.feique/`，否则配置会找不到）
- 清理 service.ts 里 ~35 个 dead imports 和 4 个 dead locals
- 新增 `examples/service/` 目录提供静态的 launchd plist / systemd unit 预览（README 读者无需安装 feique 就能看到模板）
- 新增 `docs/service-ts-map.md` — service.ts 的职责测绘文档，作为后续结构性重构的参考

### 内部测试
- 新增 `tests/backend-probe.test.ts`（5 cases）: 覆盖 probe cache / ENOENT / 非零退出 / 多 backend 隔离
- 新增 `tests/backend-factory-failover.test.ts`（7 cases）: 覆盖主 backend ok / 主挂次成功 / 双挂 / per-project opt-out / 全局 opt-out / per-project 覆盖全局 / session override 作为 primary

## [1.3.1] — 2026-03-21

### 新功能
- 配置热加载: 编辑 config.toml 后自动生效，无需重启服务

## [1.3.0] — 2026-03-21

### 新功能
- 项目级完整定制: 每个项目可独立配置 AI 模型版本、沙箱策略、MCP 工具服务器和技能包
- 三层人格设定: service.persona (全局) → 项目级 persona → 后端指令
- 飞书文件发送: AI 可通过 [SEND_FILE:path] 标记或直接调 API 发送文件/图片到飞书
- 主动实时告警: 连续失败、重试循环、成本阈值、长时间运行自动推送飞书
- 知识缺口检测: /gaps 命令分析团队反复问但没沉淀的知识盲区
- AI 意图分类: 规则匹配失败时用 Claude/Codex 后端做意图识别

### 改进
- 精简 bridge system prompt (去重信条，7 条规则压缩为 1 行，每次调用省 ~300 tokens)
- 群聊回复 @提问人 (text/post 模式)
- 排队状态加入执行人、已运行时间和排队时间戳
- AI 回复智能截断保留末尾结论段落
- 团队态势显示人名而非 ID (ou_xxx → Alice)
- 友好错误提示替代原始报错
- /help 精简为 10 条常用命令, /help all 查看完整列表

### 修复
- 会话摘要递归嵌套 ("上次摘要: 上次摘要: ..." 退化)
- 知识自动提取模式大幅扩展 (9 → 28 种中英文匹配模式)
- "可以""OK""没问题" 不再误触发 /approve
- Card 模式 @mention 标签不再显示为原始文本
- AI 不再重复发文本消息 (禁止直接调飞书文本 API)
- Codex session ID 使用正确的文件 ID (非 OpenAI thread ID)

## [1.1.0] — 2026-03-19

### 重大变更
- 项目从 feishu-bridge 改名为 feique (飞鹊)
- 定位从「AI 编程控制面」升级为「团队 AI 协作中枢」

### 新功能
- 六大协作能力: /team, /learn, /recall, /handoff, /review, /insights, /trust, /timeline, /digest
- Web 仪表板 (GET /dashboard)
- 成本追踪: token 用量按项目/用户统计
- 混合语义搜索: 向量嵌入 + FTS5 + 中文支持
- Ollama 嵌入集成 (qwen3-embedding:8b，支持自动探测)
- 审批流: 信任边界触发 → 管理员审批 → 放行
- 多频道通知: per-project notification_chat_ids
- 全部命令支持自然语言触发

### 改进
- RunStateStore 迁移到 SQLite (索引查询 + 30天自动清理)
- 审计日志原子写 (防崩溃数据丢失)
- MemoryStore 单例连接 (10x 查询提速)
- Doctor 检查 Ollama 嵌入健康
- /status 展示协作上下文 (信任等级/团队活跃/待交接)
- 4 个新 MCP 工具: team.activity, team.insights, project.timeline, project.trust

## v0.1.17 - 2026-03-19

### Highlights

- 新增 Claude Code (Claude CLI) 后端支持。通过 Backend 抽象层，同一套飞书交互体验可以无缝对接 Codex 或 Claude Code 两种后端。
- 新增 `[backend]` 和 `[claude]` 配置段，支持全局默认后端选择和项目级后端覆盖。
- Claude 后端支持 `--model`、`--permission-mode`、`--max-budget-usd`、`--allowed-tools`、`--append-system-prompt` 等高级选项。
- `/session adopt` 可接管 `~/.claude/sessions` 中的 Claude Code 本地会话。
- `doctor` 命令同时检测 Codex 和 Claude CLI 可用性。

### Included

- Backend 抽象层：
  - `src/backend/types.ts`
  - `src/backend/codex.ts`
  - `src/backend/claude.ts`
  - `src/backend/factory.ts`
- 配置层扩展：
  - `src/config/schema.ts`
  - `src/config/doctor.ts`
- Service 适配：
  - `src/bridge/service.ts`
  - `src/control-plane/project-session.ts`
  - `src/mcp/server.ts`
  - `src/index.ts`
- 测试更新：
  - `tests/access-control.test.ts`
  - `tests/bridge-service.test.ts`
  - `tests/doctor.test.ts`
  - `tests/webhook-bridge.test.ts`
  - `tests/mcp-server.test.ts`
- 文档与官网：
  - `README.md`
  - `README.en.md`
  - `CHANGELOG.md`
  - `docs/getting-started.md`
  - `website/index.html`
  - `website/en.html`

## v0.1.16 - 2026-03-14

### Highlights

- 修复飞书私聊和群聊里 `切到 XLINE 项目` 这类带空格的自然语言切项目表达，避免被误当成普通 prompt 继续落到旧项目。
- 新增“创建项目”能力，可在指定目录下直接创建项目根目录并接入 `feique` 配置。
- 新能力覆盖三条控制面：
  - CLI：`feique create-project <alias> <root>`
  - 飞书管理员：`/admin project create <alias> <root>`
  - MCP：`project.create`

### Included

- 自然语言项目切换修复：
  - `src/bridge/commands.ts`
  - `tests/commands.test.ts`
- 项目创建能力：
  - `src/config/mutate.ts`
  - `src/cli.ts`
  - `src/bridge/service.ts`
  - `src/mcp/server.ts`
  - `tests/bridge-service.test.ts`
  - `tests/cli-flow.test.ts`
  - `tests/mcp-server.test.ts`
- 文档与官网：
  - `README.md`
  - `README.en.md`
  - `docs/getting-started.md`
  - `docs/faq.md`
  - `website/index.html`
  - `website/en.html`

## v0.1.15 - 2026-03-13

### Highlights

- 修复 `/status` 在“会话尚未落盘但运行已排队”场景下看不到排队状态的问题，队列状态展示与真实运行态重新对齐。
- 修复 release 链路中的队列状态回归测试，避免幂等消息 ID 和并发回复竞争导致 GitHub Actions 偶发失败。

### Included

- 状态查询兼容 queued 运行：
  - `src/bridge/service.ts`
- 排队状态回归测试稳定性：
  - `tests/bridge-service.test.ts`

## v0.1.14 - 2026-03-13

### Highlights

- 飞书文本请求恢复为“先有一条可更新的运行态回复，再原地更新到完成/失败”，用户发送后能立刻看到系统已经接单。
- 运行态回复会在排队、处理中、完成、失败之间切换，减少“消息发出去后像黑盒”的感受。
- `/admin config rollback latest` 重新按单文件配置回滚，避免被全局配置层污染。

### Included

- 飞书运行态状态回复：
  - `src/bridge/service.ts`
  - `tests/bridge-service.test.ts`
- 配置文件单独加载：
  - `src/config/load.ts`
- 文档：
  - `README.md`

## v0.1.13 - 2026-03-12

### Highlights

- 飞书回复从“处理中 + 最终结果”两条消息，收敛为单条最终回复，减少噪音。
- 回复展示升级为更适合飞书插件场景的富卡片，普通回答和最终结果都支持更清晰的标题、分段和中文状态。
- 用户侧回复去掉了 `引用 / 项目 / 耗时` 等工程化头部信息，前台只保留真正需要读的结果。

### Included

- 单条最终回复与元数据精简：
  - `src/bridge/service.ts`
  - `tests/bridge-service.test.ts`
- 富卡片回复模板：
  - `src/feishu/cards.ts`
  - `tests/cards.test.ts`
- 文档与示例配置：
  - `README.md`
  - `README.en.md`
  - `docs/faq.md`
  - `docs/getting-started.md`
  - `docs/deployment.md`
  - `examples/config.global.toml`
  - `website/index.html`

## v0.1.12 - 2026-03-12

### Highlights

- 运行中仍保留一条状态回复，但完成/失败时不再额外推送第二条最终结果消息，避免同一轮任务在飞书里产生重复通知。
- 运行态回复继续原地更新，适配“先看处理中，再在同一条回复里看最终状态”的使用方式。

### Included

- 飞书运行态回复策略：
  - `src/bridge/service.ts`
  - `tests/bridge-service.test.ts`

## v0.1.11 - 2026-03-12

### Highlights

- 新增 `viewer / operator / admin` 三档访问模型，把项目可见性、会话控制和服务级操作分层收口。
- 提升可观测性入口，`/healthz`、`/readyz`、`/metrics` 现在会携带 readiness 与启动告警信息。
- MCP 与飞书共用项目/会话控制层，项目切换、会话接管和状态查看不再重复维护两套逻辑。
- MCP 新增 `HTTP/SSE + Bearer token` 入口，便于 OpenClaw 等远端客户端接入。
- 权限从“角色”扩到“能力”，新增 session/run/config/service 级 allow-list。
- 项目默认拥有独立的下载、临时文件、缓存和项目审计目录，收口到 `storage.dir/projects/<alias>/...`。
- MCP 鉴权扩展为多 token / 轮换模式，并支持标记当前主 token。
- 项目锁调度新增 `run_priority`，同仓库竞争时可按项目优先级执行。
- 审计新增 retention / archive / cleanup 策略，并接入 `doctor --fix` 与后台维护循环。
- 飞书新增原生 `Doc / Task / Base` 工具命令，写操作统一走确认机制，并把运行态卡片阶段细化为排队、准备上下文、生成中、执行中、完成/失败/取消。
- MCP 集成测试放宽响应等待窗口，避免在整套测试负载下因为 5 秒门槛过紧而偶发超时。

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
- MCP token 轮换、项目优先级和审计清理：
  - `src/mcp/server.ts`
  - `src/bridge/task-queue.ts`
  - `src/state/audit-log.ts`
  - `src/bridge/service.ts`
  - `src/cli.ts`
  - `tests/task-queue.test.ts`
  - `tests/audit-log.test.ts`
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
- 飞书对象工具面与状态卡片：
  - `src/bridge/commands.ts`
  - `src/bridge/service.ts`
  - `src/feishu/doc.ts`
  - `src/feishu/task.ts`
  - `src/feishu/base.ts`
  - `src/feishu/cards.ts`
  - `tests/commands.test.ts`
  - `tests/bridge-service.test.ts`
  - `tests/cards.test.ts`
  - `tests/mcp-server.test.ts`
  - `tests/mcp-http-server.test.ts`

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
- 新增 `website/` 静态官网，并通过 GitHub Pages 自动发布到 `https://colorcross.github.io/feique/`。
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

- 发布 `飞鹊 (Feique)` 首个可部署版本，支持飞书 `long-connection` 和 `webhook` 两种接入模式。
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
  - `feique bind`
  - 可选 Codex skill 安装
  - 一键安装脚本 `scripts/install.sh`

### Default Behavior

- 群聊默认要求 `@机器人` 才触发，除非显式关闭 `security.require_group_mentions`。
- 启用 `service.reply_quote_user_message = true` 时，优先使用飞书原生 reply 回复触发消息。
- `bind` 默认优先使用最近项目配置；若不存在项目配置，则回退到全局 `~/.feique/config.toml`。

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
