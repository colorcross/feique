# 部署说明

## 本机单用户模式

适合个人开发：

1. `codex-feishu init --mode global`
2. 填好飞书应用配置
3. `transport = "long-connection"`
4. `codex-feishu serve`

如需在每次拉起 Codex 前先开代理，可在配置中加入：

```toml
[codex]
shell = "/bin/zsh"
pre_exec = "proxy_on"
```

默认行为：

- 启动前自动跑预检
- 收到 `SIGINT` / `SIGTERM` 时优雅停机
- 在状态目录创建实例锁，防止重复启动
- 可选启动管理端口导出 `/metrics`
- 在状态目录写入 pid / runs / audit / idempotency 状态

如果不想让 bridge 占住当前终端，可直接后台启动：

```bash
codex-feishu start
```

后台运行后可直接管理：

- `codex-feishu status`：查看服务状态、pid、日志路径
- `codex-feishu logs --lines 100`：查看最近日志
- `codex-feishu logs --follow`：实时跟随日志
- `codex-feishu ps`：查看当前任务状态
- `codex-feishu stop --force`：停止 bridge
- `codex-feishu restart`：重启 bridge

优点：

- 不需要公网
- 飞书消息直接进入本机 Codex

限制：

- 卡片按钮不作为主交互路径
- 进程需要常驻

如果只是本地开发和回归验证，也可以直接用仓库自带脚本：

```bash
npm run demo:up
npm run demo:smoke
npm run demo:down
```

这套脚本会使用 `feishu.dry_run = true`，避免本地回放时真的向飞书出站发送消息。

## 团队共享模式

适合生产服务：

1. 部署在可公网访问的主机
2. `transport = "webhook"`
3. 飞书后台配置事件订阅 URL 和卡片回调
4. 建议通过反向代理接入 HTTPS
5. 使用 systemd / launchd / 容器编排保证服务常驻

建议：

- 将配置和状态目录挂载到持久卷
- 把项目根目录映射为只允许访问的工作区
- 配置 `security.allowed_project_roots`
- 默认把 `reply_mode = "post"` 作为共享服务起点；只有需要卡片展示或按钮交互时再切到 `reply_mode = "card"`
- 对不同项目使用不同的 Codex profile
- 保持单实例运行；如果做主备切换，先释放旧实例锁再拉起新实例
- 在共享部署中显式配置 `service.metrics_port`，接入 Prometheus 或探针系统

补充：

- `reply_mode = "card"` 在 long-connection 模式下也能展示卡片，但按钮回调仍需要 webhook
- 飞书用户发消息后，会先收到一条状态提示，确认消息已接收以及当前是 `running` 还是 `queued`


## 用户级服务安装

### macOS

1. 生成并写入 LaunchAgent：

```bash
codex-feishu service install --config ~/.codex-feishu/config.toml --platform darwin
```

2. 按命令输出执行：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/codex-feishu.plist
launchctl kickstart -k gui/$(id -u)/codex-feishu
```

### Linux

1. 生成并写入 systemd user unit：

```bash
codex-feishu service install --config ~/.codex-feishu/config.toml --platform linux
```

2. 按命令输出执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-feishu.service
```

## 反向代理与探针

Webhook 模式建议暴露：

- 飞书事件入口：`/webhook/event`
- 飞书卡片回调：`/webhook/card`
- 健康探针：`/healthz`
- 就绪探针：`/readyz`

若启用管理端口：

- 指标入口：`/metrics`

Prometheus 示例文件：

- 抓取配置：`examples/prometheus.yml`
- 告警规则：`examples/alerts.yml`
- Alertmanager 配置：`examples/alertmanager.yml`
- 一键观测栈：`examples/docker-compose.observability.yml`
- Grafana dashboard：`examples/grafana/dashboards/codex-feishu-overview.json`

本地校验：

```bash
promtool check rules examples/alerts.yml
```

本地启动完整观测栈：

```bash
docker compose -f examples/docker-compose.observability.yml up -d
```

默认入口：

- Prometheus: `http://127.0.0.1:9090`
- Alertmanager: `http://127.0.0.1:9093`
- Grafana: `http://127.0.0.1:3000`（登录账号与密码取决于 `examples/docker-compose.observability.yml` 里的环境变量）

注意：

- 如果继续使用示例 compose，首次进入 Grafana 后应立即修改默认密码
- `examples/prometheus.yml` 默认抓取 `host.docker.internal:9464`
- Linux 如需其他宿主机地址，可直接改 `examples/prometheus.yml`

## 本地回放闭环

当飞书租户还未激活，或需要先做本地回归时，可以直接回放 webhook：

1. 启动服务：

```bash
codex-feishu serve --config ~/.codex-feishu/config.toml
```

2. 回放消息事件：

```bash
codex-feishu webhook replay-message \
  --url http://127.0.0.1:3333/webhook/event \
  --chat-id oc_demo \
  --actor-id ou_demo \
  --text "hello from replay"
```

3. 回放卡片事件：

```bash
codex-feishu webhook replay-card \
  --url http://127.0.0.1:3333/webhook/card \
  --chat-id oc_demo \
  --actor-id ou_demo \
  --open-message-id om_demo \
  --action status \
  --project-alias default \
  --conversation-key tenant-local/oc_demo/ou_demo
```

这套回放现在覆盖：

- 文本消息接收
- 卡片 action 提交
- webhook server 真实 HTTP 解析路径
- 重复事件幂等拦截
- run state / audit / metrics 落盘

如果只需要快速探活，可直接执行：

```bash
codex-feishu webhook smoke --base-url http://127.0.0.1:3333
```

## 启动与停机

推荐启动顺序：

1. `codex-feishu doctor`
   或 `codex-feishu doctor --json`
   或 `codex-feishu doctor --remote`
2. `codex-feishu start`
3. 观察日志确认桥接已开始监听或已建立长连接

若必须绕过预检：

```bash
codex-feishu serve --skip-doctor
```

停机时建议向主进程发送：

- `SIGTERM`：生产环境常规停机
- `SIGINT`：本地前台调试停机

服务会关闭监听资源并写入 `service.stop` 审计事件。

如果 bridge 异常退出，下次启动会恢复遗留运行状态：

- pid 仍然存在的运行会标成 `orphaned`
- pid 不存在的运行会标成 `stale`
