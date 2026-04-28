# FAQ

## 1. 这个项目支持多个 session 同时存在吗？

支持。

- 每个项目可以保存多条历史 session
- 当前激活的 session 可以通过 `/session use <thread_id>` 切换
- 队列按 `session key + project alias` 隔离，所以同一聊天窗口下不同项目可以并行
- 如果同一项目或同一 `project.root` 已有运行，后续消息会先进入 `queued` 状态；`/status` 也会显示排队原因

## 2. 飞书里怎么和指定 session 聊天？

用这些命令：

```text
/session list
/session use <thread_id>
/session adopt latest
/session adopt list
/session adopt <thread_id>
/session new
/session drop [thread_id]
```

说明：

- `/session use` 只切换桥接器已经保存过的会话
- `/session adopt` 会去本机 `~/.codex/sessions`（Codex）或 `~/.claude/sessions`（Claude Code）里找当前项目可匹配的原生 CLI 会话，再把它接管为当前项目的 active session

## 3. 飞书消息怎么判断当前是哪个项目？

项目绑定默认按 `chat_id` 记住：

- 同一个私聊窗口会记住上次选中的项目
- 同一个群会共享一个项目绑定
- 在群里执行 `/project <alias>`，会直接更新这个群后续消息的默认项目
- 不同群之间互不影响

如果当前聊天还没切过项目，就回退到 `service.default_project`。

如果你希望 `/project <alias>` 后自动尝试续上该项目最近的本地会话（Codex 或 Claude Code，取决于当前后端），可启用：

```toml
[service]
project_switch_auto_adopt_latest = true
```

启用后：

- 如果当前聊天里这个项目已经有 active session，优先保留当前聊天自己的会话
- 如果当前聊天里还没有，会尝试从本机 `~/.codex/sessions` 或 `~/.claude/sessions` 里接管该项目最近的本地会话

## 4. 群聊为什么默认必须 `@机器人`？

因为这是更安全的默认值。

群聊里最常见的风险不是功能缺失，而是误触发和串线。默认配置：

```toml
[security]
require_group_mentions = true

[feishu]
bot_open_ids = ["ou_bot_open_id"]
```

`require_group_mentions = true` 只说明群聊要经过 @ 门禁；`bot_open_ids` 用来判断 @ 的是不是机器人自己。建议用 `feique feishu inspect --json` 读取 `bot.open_id` 后写入配置。配置后，群里 `@其他人` 不会触发 Feique。

如果未配置 `bot_open_ids` 或 `bot_name`，Feique 会为了兼容旧配置退回到“任意 @ 都算触发”。这适合临时测试，不建议用于生产群。

如果你明确接受风险，可以关闭：

```toml
[security]
require_group_mentions = false
```

## 5. 能否只允许几个私聊和群聊可用？

可以。

```toml
[feishu]
allowed_chat_ids = ["oc_private_1"]
allowed_group_ids = ["oc_group_1", "oc_group_2"]
```

这些值来自飞书事件里的 `chat_id`。最简单的收集方式是：

```bash
feique audit tail --limit 20
```

**v1.4+ 更简单**：把 bot 加入目标 chat 或群组后，让任意用户 @ 一下 bot。桥接器会自动：
1. 回复该 chat 一条友好提示，附上它自己的 `chat_id`
2. 同时通知所有 `security.admin_chat_ids` 里配置的管理员，附上可直接复制的 `/admin chat add <chat_id>` 或 `/admin group add <chat_id>` 命令
3. 同一 chat 在进程生命周期内只通知一次，不会刷屏

## 6. 回复为什么现在看起来像“回复某条消息”？

这是刻意做的。

当 `service.reply_quote_user_message = true` 时，桥接器优先走飞书原生 reply API，体验比简单文本前缀更清晰。

## 7. 怎么选择 `reply_mode`？

可以按交互复杂度来选：

- `text`：最简单的纯文本回复
- `post`：富文本回复，自动保留标题、列表、链接，适合大多数长连接和 webhook 回复场景
- `card`：卡片展示；long-connection 也能显示卡片，普通回复和结构化状态会更接近飞书工作台体验，卡片按钮回调仍需要 `transport = "webhook"`

补充：

- 普通回答和运行中/完成这类任务生命周期回复都会遵守同一个 `reply_mode`
- 普通回答在 `card` 模式下会带标题、分段、状态/阶段元信息，更适合长答案和结构化结果
- `text` 适合只想要聊天气泡文本、不需要卡片外观的场景
- `post` 适合想保留 Markdown 转换后的轻量富文本、但不需要卡片外观的场景；任务执行时只发送最终富文本结果，不尝试更新中间状态消息
- 变更类自然语言命令会直接执行，不再追加确认消息

如果你希望回复更接近 `openclaw-lark` 这种工作台风格，推荐优先用：

```toml
[service]
reply_mode = "card"
```

如果你希望群里只出现文本消息，可以切到：

```toml
[service]
reply_mode = "text"
```

## 8. `security.allowed_project_roots` 应该怎么配？

生产环境建议填明确的仓库父目录，例如：

```toml
[security]
allowed_project_roots = ["/srv/repos", "/opt/repos"]
```

不建议长期使用：

```toml
allowed_project_roots = ["/"]
```

这会让目录边界保护失效。

## 9. `bind` 现在为什么可以不带 `--config`？

因为 CLI 已经做了默认路由：

- 优先找最近的项目配置 `.feique/config.toml`
- 找不到时回退到全局 `~/.feique/config.toml`

## 10. 如何后台运行、停机、看日志？

- `feique start`：后台启动 bridge
- `feique status`：查看运行状态、pid、日志路径
- `feique logs --lines 100`：查看最近日志
- `feique logs --follow`：实时跟随日志输出
- `feique logs --rotate`：轮转 runtime / audit 日志
- `feique ps`：查看当前任务列表
- `feique stop --force`：停止 bridge
- `feique restart`：重启 bridge
- `feique doctor --fix`：创建缺失状态目录、清理 stale pid、轮转超大日志
- `feique upgrade --check`：查看 npm 是否有更新
- `feique mcp`：暴露 stdio MCP 服务给外部应用
  - 可直接调用 `project.switch`、`session.adopt`
  - 也可通过 `command.interpret`、`command.execute` 对自然语言控制命令做解释和直接执行

如果你是在飞书里联调，当前处理状态会直接回写到同一条飞书回复或卡片里。

飞书侧进一步排障时，可直接用：

- `/status detail`
- `/admin runs`
- `/admin config history`
- `/admin config rollback <id|latest>`

## 11. 管理员怎么动态开通 chat / group / project？

先把管理员 chat_id 配进去：

```toml
[security]
admin_chat_ids = ["oc_admin_chat_1"]
```

然后在这个管理员 chat 里执行：

```text
/admin group add <chat_id>
/admin chat add <chat_id>
/admin project create <alias> <root>
/admin project add <alias> <root>
/admin project set <alias> <field> <value>
/admin config history
/admin config rollback <id|latest>
/admin service restart
```

其中：

- `/admin project create <alias> <root>`：会先创建目录，再把它接入项目配置
- `/admin project add <alias> <root>`：只接入已有目录

如果只想把单个项目授权给专门的管理员 chat，可在项目里单独加：

```toml
[projects.repo-a]
admin_chat_ids = ["oc_repo_admin_1"]
chat_rate_limit_window_seconds = 60
chat_rate_limit_max_runs = 20
```

这组命令会直接修改当前实例对应的配置文件；如果改动需要重启生效，再执行 `/admin service restart`。

## 12. 本地没有公网，能不能先做闭环验证？

可以。

```bash
npm run demo:up
npm run demo:smoke
npm run demo:down
```

它会启用 `feishu.dry_run = true`，本地跑完整链路但不真实向飞书出站。

## 13. 这个项目适合直接开源到 GitHub 吗？

可以，但上线前至少要做两件事：

- 确保没把真实密钥、状态文件、打包产物提交进去
- 把 `App Secret` 视为敏感信息，必要时立即轮换

## 14. 怎么在 Codex 和 Claude Code 之间切换？

在飞书里用：

```text
/backend              # 查看当前后端
/backend codex        # 切换到 Codex
/backend claude       # 切换到 Claude Code
```

也支持自然语言：`后端切换到 claude`、`查看当前后端`。

切换只影响当前会话，不影响全局配置。优先级链：`/backend` 会话级覆盖 > `project.backend` > `backend.default`。

如果你想把某个项目固定到特定后端：

```toml
[projects.repo-a]
root = "/srv/repos/repo-a"
backend = "claude"
```

## 15. 这里的项目 / session 和 Codex App 里的项目 / 线程是同一个东西吗？

不建议把它们当成同一个抽象。

- 这个项目里的“项目”是桥接器配置里的 `projects.<alias>.root`
- 这个项目里的”session”是本地桥接层维护的 Codex CLI / Claude Code 会话句柄和历史映射
- Codex App / Codex Cloud 里还存在单独的“过去的项目”和“cloud threads”概念

根据 OpenAI 官方文档：

- Codex App 登录 ChatGPT 账号时，可能带有 `cloud threads` 能力；如果只用 API key 登录，部分能力可能不可用
- Codex App、CLI、IDE Extension 之间会显示“过去的项目”
- Codex CLI 本地会把会话转录保存到 `history.jsonl`，`codex resume` / `codex exec resume` 也是按本地会话继续

这意味着：

- “过去的项目”看起来是跨 App / CLI / IDE 可见的工作区历史
- 但本桥接器实际依赖的是 CLI 本地 session / resume 机制，不直接操作 Codex App 的 cloud thread

截至目前，我没有在官方公开文档里找到一个面向 Codex App 项目 / 线程的公开 CRUD API，所以不建议把它设计成“直接管理 Codex App 线程”的系统。

参考：

- Codex App getting started：<https://developers.openai.com/codex/app/#getting-started>
- Codex CLI reference：<https://developers.openai.com/codex/cli/reference/>
- Codex config reference：<https://developers.openai.com/codex/config-reference/#configtoml>

## 16. 现在支持在飞书里处理图片、文件、音频和项目文档吗？

支持第一版：

- 图片、文件、音频、富文本消息会被解析成结构化元数据，并带进后端提示词
- 如果开启 `download_message_resources = true`，文本类附件会额外抽取内容摘要带进上下文
- `doc/docx/odt/rtf` 这类文档附件也会尝试抽取正文摘要
- 如果同时开启 `transcribe_audio_messages = true`，音频附件会尝试走转写脚本生成 transcript
- 如果同时开启 `describe_image_messages = true`，图片附件会尝试生成简短视觉说明
- 项目内文档可以用 `/kb status` 和 `/kb search <query>` 搜索
- 默认搜索项目根下的 `docs/`、`README.md`、`README.en.md`、`CHANGELOG.md`
- 也可以在项目配置里用 `knowledge_paths` 自定义知识库目录

边界也要明确：

- 当前仍然不是”把任意二进制原样上传给后端 CLI”；增强的是元数据、文本摘要和音频转写
- 如果你要更深入的文档 / 知识库管理，下一步应该接飞书文档、知识库或外部检索后端，而不是继续堆 prompt

## 17. 飞书知识库为什么搜不到结果？

优先检查这几项：

- 机器人 / 应用是否真的被加入了目标知识空间
- 当前 access token 是否对目标空间有阅读权限
- 项目配置里是否设置了 `wiki_space_ids`，并且这些 `space_id` 是对的
- 你搜的是不是 wiki / docx，当前第一版主要覆盖知识空间搜索和 docx 纯文本读取

可先执行：

```text
/wiki spaces
```

如果这里就是空的，问题基本不在桥接器，而在飞书空间权限。

## 18. 能直接在飞书里创建知识库文档吗？

现在可以做第一版：

```text
/wiki create 发布手册
```

前提：

- 当前项目配置了 `wiki_space_ids`
- 机器人 / 应用对目标知识空间拥有父节点容器编辑权限

如果你不想依赖默认空间，也可以显式指定：

```text
/wiki create space_xxx 发布手册
```

更新标题也支持：

```text
/wiki rename wikcn123 发布手册（正式版）
```

复制和移动也支持最小版本：

```text
/wiki copy wikcn123
/wiki copy wikcn123 space_target
/wiki move space_src wikcn123 space_target
```

知识空间成员管理也已经接入：

```text
/wiki members
/wiki members space_xxx
/wiki grant space_xxx open_id ou_xxx member
/wiki grant space_xxx open_id ou_xxx admin
/wiki revoke space_xxx open_id ou_xxx admin
```

注意：

- `member_type` 需要和你提供的成员 ID 对应，常见值是 `open_id` 或 `user_id`
- 写操作要求机器人或当前身份是该知识空间管理员

## 19. 记忆会一直保留吗？怎么治理？

默认不会无限失控，但也不是自动全知。现在有三层治理手段：

- 查看最近记忆：

```text
/memory stats
/memory stats group
/memory recent
/memory recent group
/memory recent --tag release
/memory recent --source wiki
/memory recent --created-by ou_123
/memory search --tag release 发布
/memory search --source wiki 发布
/memory search --created-by ou_123 发布
```

- 手动治理：

```text
/memory pin <id>
/memory unpin <id>
/memory forget <id>
/memory forget all-expired
/memory restore <id>
```

- 配置治理：

```toml
[service]
memory_cleanup_interval_seconds = 1800
memory_recent_limit = 5
memory_max_pinned_per_scope = 5
memory_pin_overflow_strategy = "age-out"
memory_pin_age_basis = "updated_at"
# memory_default_ttl_days = 30
```

说明：

- `memory_default_ttl_days` 打开后，新保存的记忆会带默认过期时间
- 过期记忆会在后续检索和执行前被自动清理
- `/memory stats` 可直接看 active / expired / pinned / archived / 最近访问时间
- `/memory forget` 现在默认是归档，不是物理删除
- `/memory forget all-expired` 会把当前作用域下已过期的记忆批量归档
- `/memory restore <id>` 可把已归档的记忆恢复回来
- `/memory recent --tag`、`--source`、`--created-by` 可快速筛选最近记忆
- `/memory search --tag`、`--source`、`--created-by` 可把搜索范围压到指定标签、来源或创建者
- `memory_max_pinned_per_scope` 可以限制项目记忆或群共享记忆的 pinned 数量
- `memory_pin_overflow_strategy = "age-out"` 时，新 pin 会自动老化最旧的 pinned 项，而不是直接拒绝
- `memory_pin_age_basis = "last_accessed_at"` 时，系统会优先淘汰最久未被访问的 pinned 项
- `memory_cleanup_interval_seconds` 会在后台定时清理过期记忆
- 群共享记忆建议只在白名单群、且默认要求 `@机器人` 的前提下开启
