# Memory Design

## 目标

Feishu Bridge 的记忆层要解决四件事：

1. 同一个项目在新旧会话之间可以继承关键上下文。
2. 当前 thread 很长时，仍然能把压缩后的工作状态带给下一轮。
3. 记忆边界清晰，不能跨项目、跨群、跨用户乱串。
4. 记忆可检索、可删除、可审计，而不是隐式黑箱。

## 非目标

1. 不做“永久人格记忆”。
2. 不做跨所有项目的全局自动记忆池。
3. v1 先不做用户偏好记忆；群共享记忆作为显式开启能力，而不是默认自动注入。
4. 不依赖额外在线服务来生成 thread summary。

## 约束

1. 当前桥接器以本地文件状态为主，适合小到中等规模部署。
2. 后端 CLI（Codex `resume` / Claude `--resume`）只能保证 thread 上下文，不等于长期记忆。
3. 飞书群聊是共享环境，默认要保守。
4. 记忆设计必须能在本地审计和清理。

## 方案

v1 只实现两层：

1. `thread summary`
2. `project memory`

### Thread Summary

用途：

- 给当前 `thread_id` 保存压缩后的工作摘要。
- 在下一轮 prompt 前注入，减少上下文漂移。
- 在换新 thread 后，仍然能保留上一轮关键结论。

边界：

- 作用域是 `conversation_key + project_alias + thread_id`
- 不跨项目
- 不跨群
- 不跨私聊/群聊 conversation

写入时机：

- 每次后端运行（Codex / Claude Code）成功结束后更新一次

存储字段：

- `conversation_key`
- `project_alias`
- `thread_id`
- `summary`
- `recent_prompt`
- `recent_response_excerpt`
- `files_touched`
- `open_tasks`
- `decisions`
- `created_at`
- `updated_at`

摘要策略：

- v1 不额外调用模型
- 用启发式方法把“最近目标 / 最近结果 / 涉及文件 / 下一步”压缩成一段文本
- 后续如果需要更高质量摘要，再加 assisted summarization

### Project Memory

用途：

- 保存跨会话仍然有效的项目知识
- 例如架构约定、发布步骤、环境约束、常见故障结论

边界：

- 默认作用域是 `project_alias`
- 群共享记忆扩展为 `project_alias + chat_id`
- 不支持 user scope，也不做跨群共享

写入方式：

- 项目级显式保存：`/memory save <text>`
- 群共享显式保存：`/memory save group <text>`
- 支持 `/memory pin`、`/memory unpin`、`/memory forget`、`/memory restore` 做人工治理
- 支持 `/memory recent --tag <tag>`、`/memory recent --source <source>` 做最近记忆筛选
- 支持 `/memory forget all-expired` 做批量过期清理
- 不做自动长期记忆写入，避免污染

存储字段：

- `id`
- `project_alias`
- `title`
- `content`
- `tags`
- `source`
- `pinned`
- `confidence`
- `created_by`
- `created_at`
- `updated_at`
- `last_accessed_at`
- `expires_at`

## 检索顺序

每次执行前，按以下顺序注入：

1. 当前 active thread 的 thread summary
2. 当前项目的 pinned memory
3. 与当前消息 query 相关的 project memory

说明：

- 先 thread summary，再 project memory，避免长期知识压过当前工作状态
- 如果显式开启 `service.memory_group_enabled` 且当前为群聊，再注入 group shared memory
- 不做用户偏好注入

## 存储设计

使用 `storage.dir/memory.db`，基于 SQLite。

表：

1. `thread_summaries`
2. `project_memories`
3. `memory_fts`（SQLite FTS5）

为什么选 SQLite：

- 本地可持久化
- 查询和排序比 JSON 文件更稳
- 已接入 FTS5，可优先做全文检索并保留 LIKE 回退
- 后续可平滑升级到过期清理和更复杂筛选

## 飞书命令

当前提供：

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
- `/memory pin <id>` / `/memory unpin <id>`
- `/memory forget <id>`
- `/memory forget all-expired`
- `/memory restore <id>`
- 默认 TTL 与 pinned 上限通过配置控制

设计原则：

- 项目级默认开启，群共享需显式命令 + 显式配置
- 行为明确，可搜索、可置顶、可删除
- 不做隐式自动长期记忆

## Prompt 注入

桥接层会在 `buildBridgePrompt` 前取回 memory context，并新增两个区块：

1. `Thread summary`
2. `Project memory`

注入预算受配置控制，防止记忆膨胀。

## 配置

新增配置项：

- `service.memory_enabled`
- `service.memory_search_limit`
- `service.memory_prompt_max_chars`
- `service.thread_summary_max_chars`
- `service.memory_group_enabled`
- `service.memory_recent_limit`
- `service.memory_default_ttl_days`
- `service.memory_cleanup_interval_seconds`
- `service.memory_max_pinned_per_scope`
- `service.memory_pin_overflow_strategy`
- `service.memory_pin_age_basis`

## 风险

1. 用户误把临时信息保存成长期记忆
2. 群共享记忆如果无白名单和 @mention 约束，边界会变宽
3. thread summary 采用启发式摘要，质量不如模型总结

## 任务拆分

### 第一阶段

1. 新增 `memory.db` 与 `MemoryStore`
2. 实现 `thread summary` 数据结构和更新逻辑
3. 实现 `/memory save|search|status`
4. 执行前注入 thread/project memory
5. `/status` 展示 memory 基本统计

### 第二阶段

1. 增加 pinned/unpinned
2. 支持删除/forget
3. 支持 group scope（显式开启）
4. 接入 FTS5
5. 增加 `/memory recent`
6. 增加默认 TTL 和 pinned 上限

### 第三阶段

1. 接入 wiki/docs 自动候选记忆
2. 增加 assisted memory write
3. 评估 user scope
4. 评估基于来源/标签的自动分类质量

## 验证标准

1. 新建一条 project memory 后，可被 `/memory search` 搜到
2. 同一 thread 连续运行后，prompt 内包含 thread summary
3. `/status` 能看到 memory 计数
4. 所有能力通过 `typecheck + test + build`
