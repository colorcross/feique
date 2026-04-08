# 架构设计

## 组件

### Feishu Transport

- `long-connection`: 用官方 SDK `WSClient` 直接接事件
- `webhook`: 用 `EventDispatcher` + `CardActionHandler` 接事件和卡片回调
- 两种模式都支持 `SIGINT` / `SIGTERM` 优雅停机

### Bridge Service

负责：

- 解析飞书文本命令
- 选择项目 alias
- 读取/更新会话状态
- 根据当前后端（Codex 或 Claude Code）构造桥接 prompt
- 调用对应的 Backend Runner
- 把结果回发到飞书

后端选择优先级：`/backend` 会话级覆盖 > `project.backend` > `backend.default`（默认 `codex`）。

**启动级 failover（v1.4+）**：每次 run 开始前会对候选 backend 的 CLI 做一次轻量级探测（`<bin> --version`，3s timeout，60s 缓存）。如果主 backend 探测失败（二进制缺失 / PATH 问题 / `pre_exec` 失败等）且另一个 backend 探测成功，会自动切换到它跑当前这一 run，并在飞书回复头部标注；admin 收到一次性通知。运行时抛错**不**触发 failover —— 避免白烧 token。可通过 `backend.failover = false`（全局）或 `projects.<alias>.failover = false`（单项目）关闭。

### Session Store

持久化在 `~/.feique/state/sessions.json`：

- 按 `chat_id` 持久化的当前选择项目
- 每个项目当前激活的 `thread_id`
- 每个项目保存过的 session 历史
- 上一轮 prompt / 响应摘要

### Idempotency Store

持久化在 `~/.feique/state/idempotency.json`：

- 按 `message_id` / `open_message_id` 去重
- 记录重复次数和最近一次时间
- 支持 TTL 清理，防止状态无限增长

### Run State Store

持久化在 `~/.feique/state/runs.json`：

- `run_id`
- `queue_key`
- `conversation_key`
- `project_alias`
- 运行状态：`running` / `success` / `failure` / `cancelled` / `stale` / `orphaned`
- 最近一次 pid、session_id、错误信息

### Runtime Guardrails

服务启动前后补了三层运行时保护：

1. 启动预检
- `serve` 默认内联执行 `doctor`
- 阻塞级错误直接拒绝启动
- 也支持 `doctor --json` 供外部自动化消费

2. 实例锁
- 在状态目录创建 `<service-name>.lock`
- 防止同一份状态目录被多个 bridge 实例同时消费

3. 优雅停机
- 收到 `SIGINT` / `SIGTERM` 后关闭 Webhook server 或 WSClient
- 写入 `service.stop` 审计事件

4. 运行态管理
- 在状态目录写 `<service-name>.pid`
- `status|stop|logs|ps` 直接读取 pid / log / run state
- 启动时会把遗留的 `running` run 恢复成 `stale` 或 `orphaned`

### Observability

桥接器内置轻量指标注册表，可导出 Prometheus 文本格式：

- `feique_incoming_messages_total`
- `feique_duplicate_events_total`
- `feique_card_actions_total`
- `feique_codex_turns_total`
- `feique_codex_turn_duration_seconds`
- `feique_outbound_messages_total`
- `feique_cancellations_total`
- `feique_active_codex_runs`
- `feique_last_incoming_message_timestamp_seconds`
- `feique_last_card_action_timestamp_seconds`
- `feique_last_codex_success_timestamp_seconds`
- `feique_last_codex_failure_timestamp_seconds`
- `feique_last_outbound_message_timestamp_seconds`
- `feique_last_outbound_failure_timestamp_seconds`
- `feique_last_run_timestamp_seconds`
- `feique_service_start_time_seconds`

当 `service.metrics_port` 配置后，会启动独立管理端口暴露 `/metrics`。

### Backend Runner

桥接器通过 Backend 抽象层统一管理两种 CLI 后端：

#### Codex Runner

通过 CLI 调用：

- 新会话：`codex exec --json --output-last-message ...`
- 续会话：`codex exec resume <thread_id> --json --output-last-message ...`

启动前会先探测本机 Codex CLI 能力：

- `codex --version`
- `codex exec --help`
- `codex exec resume --help`

然后按能力动态裁剪参数，避免把 `exec` 专属参数错误传给 `resume`。

桥接器同时消费：

- JSONL 事件流，用于进度更新
- `--output-last-message` 文件，用于稳定拿最终答复

#### Claude Runner

通过 Claude Code CLI 调用：

- 新会话：`claude -p --output-format stream-json ...`
- 续会话：`claude -p --resume <session_id> --output-format stream-json ...`

启动前探测：`claude --version`

会话存储在 `~/.claude/sessions/`，adopt 逻辑与 Codex 类似。

#### 共享能力

两种 Runner 都支持：

- `run_timeout_ms`
- `/cancel` 触发的 abort
- pid 回传到 run state

飞书回发层补充了瞬时失败重试：

- `429`
- `5xx`
- 常见网络抖动

为本地开发补充了一个 `feishu.dry_run` 开关：

- 仍然走完整的 bridge / session / metrics 链路
- 出站消息不会真的发送到飞书
- 适合本地 webhook 回放和 smoke

## 协作层 (Collaboration Layer)

v0.2 新增的团队协作模块位于 `src/collaboration/`，包含 6 个子模块：

| 模块 | 文件 | 职责 |
|------|------|------|
| Team Awareness | `team-awareness.ts` | 团队态势感知，追踪成员当前 AI 协作状态 |
| Knowledge | `knowledge.ts` | 知识沉淀与检索，支持手动记录和自动提取 |
| Insights | `insights.ts` | 效率诊断，生成团队 AI 协作健康报告 |
| Trust Boundary | `trust-boundary.ts` | 信任等级管理（observe → suggest → execute → autonomous） |
| Daily Digest | `daily-digest.ts` | 每日摘要自动生成与推送 |
| Cost Tracking | `cost-tracking.ts` | 按项目/用户统计 token 用量和预估成本 |

相关支撑模块：

- `src/memory/embeddings.ts` — 可插拔嵌入提供者（本地轻量 / Ollama / 自定义），为知识检索提供语义向量化
- `src/observability/dashboard-html.ts` — 嵌入式 Web 仪表板，通过 `metrics_port` 暴露，无需外部前端

## 会话模型

分两层：

1. `selection key`
- 保存当前对话选中了哪个项目
- 默认按 `chat_id` 维度保存，让同一个群共享项目绑定

2. `session key`
- 保存某个项目下对应的 Codex thread 或 Claude session
- 支持 `chat` 或 `chat-user` 两种 `session_scope`

3. `queue key`
- 由 `session key + project alias` 组成
- 同一飞书聊天窗口下，不同项目可以并行
- 同一项目内仍保持串行，避免 thread 串写

4. `project root lock`
- 按 `project.root` 全局串行
- 即使不同群、不同私聊、不同 alias 指向同一仓库，也不会并发执行 Codex / Claude run
- 如果命中锁，桥接器会先写入一个 `queued` 运行态，并向飞书提示当前是“项目内排队”还是“仓库正在被其他会话操作”

## 选择长连接 + Webhook 双模式的原因

官方 SDK README 明确：

- 长连接模式适合本地开发，不需要公网地址
- 但只支持 event subscription，不支持 callback subscription

因此：

- 文本消息收发可以用长连接
- 交互卡片按钮需要 Webhook 模式

这就是本项目同时保留两种运行模式的原因。
