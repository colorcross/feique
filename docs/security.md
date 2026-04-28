# 安全与运维

## 凭证

不要把以下内容提交进仓库：

- `FEISHU_APP_SECRET`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_VERIFICATION_TOKEN`
- Codex/OpenAI 相关认证文件
- Anthropic API key（Claude Code 后端）

建议：

- 飞书凭证全部走环境变量
- 生产环境通过 Secret Manager 或系统级环境注入
- 本地 dev stack 使用 `feishu.dry_run = true` 时，不要误以为已经验证了真实飞书出站权限
- 凭证一旦在聊天里贴出来，按泄露处理并立即轮换

日志默认也会对这些敏感字段做脱敏，包括：

- `app_secret`
- `access_token` / `refresh_token` / `tenant_access_token`
- 常见 `Authorization` header

## 运行权限

建议默认：

- `default_sandbox = "workspace-write"`
- 每个项目单独设置根目录
- 只绑定明确允许的 repo 路径
- 配置 `security.allowed_project_roots`，拒绝跑到白名单外的目录

## 群聊风险

多人群聊容易出现：

- 会话串线
- 项目切换误操作
- 未 @bot 的消息误触发

建议：

- 群聊项目默认启用 `mention_required = true`
- 敏感项目使用 `session_scope = "chat-user"`
- 用 `allowed_group_ids` 白名单收敛入口
- 管理员动态控制入口尽量放在单独的管理员私聊，或极小范围的受信群里
- 保持 `security.require_group_mentions = true`
- 配置 `feishu.bot_open_ids`，确保群聊只响应 `@机器人自己`，而不是任意 `@成员`
- 不要长期把 `allowed_chat_ids` / `allowed_group_ids` 留空；`doctor` 现在会明确告警
- **v1.4+**: 白名单外的陌生 chat 首次接入时，桥接器会自动提示用户其 `chat_id` 并一次性通知所有 admin_chat_ids。配置 `admin_chat_ids` 才能收到通知；**同一个 chat 在进程生命周期内只通知一次**，避免刷屏。这让「加入白名单」流程从「用户摸黑 → admin 无感知」变成「用户有反馈 → admin 有通知 → 一条 `/admin chat add <id>` 即可授权」

## 监控建议

至少记录：

- 飞书事件接收失败
- 后端 CLI（Codex / Claude Code）子进程启动失败
- 会话恢复失败
- 卡片回调失败
- 服务实例锁冲突
- 启动预检失败
- `doctor --remote` 中的飞书租户侧失败
- `/metrics` 中的 Codex 失败率和 Feishu 出站失败率
- 重复事件计数持续增长
- `orphaned` / `stale` run 长时间存在
- 活跃 Codex 运行数长期不归零
- 最近一次入站/出站时间戳长时间不更新


## 服务运行建议

- 生产环境使用专门的系统用户运行桥接器
- 日志目录与状态目录分离
- 如果是共享服务，限制项目根目录白名单，不要给任意路径绑定能力
- 对高风险仓库使用更保守的 Codex profile / Claude permission mode 和 sandbox
- 不要让多个 bridge 进程共享同一个 `storage.dir`
- 如果启用 `service.metrics_port`，优先绑定到内网地址并交给 Prometheus 抓取，不要直接暴露公网
- 如果启用 `examples/docker-compose.observability.yml`，上线前修改 Grafana 默认密码
- 后台运行时优先用 `status|stop|logs|ps|restart` 管理，不要手工删 pid 文件


## 审计日志

桥接器会把关键事件追加到：

- `~/.feique/state/audit.jsonl`
- `~/.feique/state/admin-audit.jsonl`

包括：

- 收到飞书消息
- 飞书回复已发送
- 重复消息被忽略
- 项目切换
- 会话重置
- 服务启动/停止
- 后端 CLI 开始/完成/失败/取消/恢复（含后端类型标记）
- 卡片动作回调
- 管理员对白名单、项目配置和配置回滚的变更

关键事件会带 `run_id`，用于把飞书消息、Codex 运行、审计日志和指标串起来。

查看方式：

```bash
feique audit tail --limit 50
```
