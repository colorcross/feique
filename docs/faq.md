# FAQ

## 1. 这个项目支持多个 Codex session 同时存在吗？

支持。

- 每个项目可以保存多条历史 session
- 当前激活的 session 可以通过 `/session use <thread_id>` 切换
- 队列按 `session key + project alias` 隔离，所以同一聊天窗口下不同项目可以并行

## 2. 飞书里怎么和指定 session 聊天？

用这些命令：

```text
/session list
/session use <thread_id>
/session new
/session drop [thread_id]
```

## 3. 群聊为什么默认必须 `@机器人`？

因为这是更安全的默认值。

群聊里最常见的风险不是功能缺失，而是误触发和串线。默认配置：

```toml
[security]
require_group_mentions = true
```

如果你明确接受风险，可以关闭：

```toml
[security]
require_group_mentions = false
```

## 4. 能否只允许几个私聊和群聊可用？

可以。

```toml
[feishu]
allowed_chat_ids = ["oc_private_1"]
allowed_group_ids = ["oc_group_1", "oc_group_2"]
```

这些值来自飞书事件里的 `chat_id`。最简单的收集方式是：

```bash
codex-feishu audit tail --limit 20
```

## 5. 回复为什么现在看起来像“回复某条消息”？

这是刻意做的。

当 `service.reply_quote_user_message = true` 时，桥接器优先走飞书原生 reply API，体验比简单文本前缀更清晰。

## 6. `security.allowed_project_roots` 应该怎么配？

生产环境建议填明确的仓库父目录，例如：

```toml
[security]
allowed_project_roots = ["/srv/repos", "/Users/dh/workspace"]
```

不建议长期使用：

```toml
allowed_project_roots = ["/"]
```

这会让目录边界保护失效。

## 7. `bind` 现在为什么可以不带 `--config`？

因为 CLI 已经做了默认路由：

- 优先找最近的项目配置 `.codex-feishu/config.toml`
- 找不到时回退到全局 `~/.codex-feishu/config.toml`

## 8. 如何后台运行、停机、看日志？

```bash
codex-feishu serve --detach
codex-feishu serve status
codex-feishu serve logs --lines 100
codex-feishu serve stop --force
```

## 9. 本地没有公网，能不能先做闭环验证？

可以。

```bash
pnpm demo:up
pnpm demo:smoke
pnpm demo:down
```

它会启用 `feishu.dry_run = true`，本地跑完整链路但不真实向飞书出站。

## 10. 这个项目适合直接开源到 GitHub 吗？

可以，但上线前至少要做两件事：

- 确保没把真实密钥、状态文件、打包产物提交进去
- 把 `App Secret` 视为敏感信息，必要时立即轮换

## 11. 这里的项目 / session 和 Codex App 里的项目 / 线程是同一个东西吗？

不建议把它们当成同一个抽象。

- 这个项目里的“项目”是桥接器配置里的 `projects.<alias>.root`
- 这个项目里的“session”是本地桥接层维护的 Codex CLI 会话句柄和历史映射
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
