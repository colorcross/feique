# 部署说明

## 本机单用户模式

适合个人开发：

1. `feique init --mode global`
2. 填好飞书应用配置
3. `transport = "long-connection"`
4. `feique serve`

如需在每次拉起后端 CLI 前先开代理，可在配置中加入：

```toml
[codex]
shell = "/bin/zsh"
pre_exec = "proxy_on"

[claude]
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
feique start
```

后台运行后可直接管理：

- `feique status`：查看服务状态、pid、日志路径
- `feique logs --lines 100`：查看最近日志
- `feique logs --follow`：实时跟随日志
- `feique logs --rotate`：轮转 runtime / audit 日志
- `feique ps`：查看当前任务状态
- `feique stop --force`：停止 bridge
- `feique restart`：重启 bridge
- `feique audit cleanup`：按 retention / archive 策略归档并清理审计日志
- `feique doctor --fix`：创建缺失状态目录、清理 stale pid、轮转超大日志并执行审计清理
- `feique upgrade --check`：检查 npm 最新版本
- `feique mcp`：暴露 MCP 服务给 OpenClaw 等外部工具
  - `stdio` 适合本机 agent
  - `http` 适合远端或多客户端接入
  - 包含项目切换、会话接管和自然语言控制命令解释 / 执行入口

优点：

- 不需要公网
- 飞书消息直接进入本机 Codex 或 Claude Code

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
- 如果你希望回复更接近飞书插件式工作台体验，默认把 `reply_mode = "card"` 作为共享服务起点；只有在你明确想保留更轻量的富文本消息时再退回 `reply_mode = "post"`
- 对不同项目使用不同的后端或 Codex profile（通过 `projects.<alias>.backend` 指定）
- 保持单实例运行；如果做主备切换，先释放旧实例锁再拉起新实例
- 在共享部署中显式配置 `service.metrics_port`，接入 Prometheus 或探针系统
- 对外暴露 MCP HTTP/SSE 时，始终配置 MCP token；推荐使用 `mcp.auth_tokens` 做平滑轮换
- 项目下载、临时文件、缓存和项目审计默认放在 `storage.dir/projects/<alias>/...`
- 如果多个项目共享同一个仓库锁，`projects.<alias>.run_priority` 更高的项目会优先获得执行权

补充：

- `reply_mode = "card"` 在 long-connection 模式下也能展示卡片，普通回答会带更清晰的标题、分段和状态元信息，但按钮回调仍需要 webhook
- 当前默认体验是只返回单条最终结果，不再先推送一条 `处理中`
- 最终回复会默认隐藏 `引用 / 项目 / 耗时` 这类工程化头部信息，前台更接近插件式工作台体验
- 自然语言命令和斜杠命令会直接执行，不再追加确认消息


## Docker 部署

适合团队服务器部署，提供 Dockerfile 和 docker-compose.yml。

### 快速启动

```bash
# 1. 准备配置文件
cp examples/config.global.toml config.toml
# 编辑 config.toml 填入飞书应用凭据和项目配置

# 2. 设置环境变量
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export REPOS_DIR=/path/to/your/repos

# 3. 启动
docker compose up -d

# 4. 查看状态
docker compose logs -f feique
curl http://localhost:9090/healthz
```

### 访问入口

| 端口 | 用途 |
|------|------|
| 3333 | Webhook 事件接收（飞书事件订阅和卡片回调） |
| 9090 | Metrics + Dashboard（`/metrics` `/healthz` `/readyz` `/dashboard`） |

### 启用 Ollama 嵌入

如需神经网络语义搜索：

```bash
# 启动 feique + ollama
docker compose --profile embedding up -d

# 在 ollama 容器中拉取模型
docker compose exec ollama ollama pull qwen3-embedding:8b
```

然后在 config.toml 中配置：

```toml
[embedding]
provider = "ollama"
ollama_base_url = "http://ollama:11434"  # docker compose 内部网络
ollama_model = "auto"
```

### 数据持久化

| 卷 | 内容 |
|----|------|
| `feique-data` | 运行状态、审计日志、记忆数据库、信任状态 |
| `ollama-models` | Ollama 模型文件（可选） |

### 仪表板

启动后访问 `http://localhost:9090/dashboard` 查看团队 AI 协作全局状态。

## 用户级服务安装

### macOS

1. 生成并写入 LaunchAgent：

```bash
feique service install --config ~/.feique/config.toml --platform darwin
```

2. 按命令输出执行：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/feique.plist
launchctl kickstart -k gui/$(id -u)/feique
```

### Linux

1. 生成并写入 systemd user unit：

```bash
feique service install --config ~/.feique/config.toml --platform linux
```

2. 按命令输出执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now feique.service
```

## 反向代理与探针

Webhook 模式建议暴露：

- 飞书事件入口：`/webhook/event`
- 飞书卡片回调：`/webhook/card`
- 健康探针：`/healthz`
- 就绪探针：`/readyz`

若启用管理端口：

- 指标入口：`/metrics`

返回契约建议按下面理解：

- `/healthz`：进程和 HTTP 面正常，返回 `ok/service/stage/timestamp/startupWarnings/startupErrors`
- `/readyz`：服务当前可接收流量，返回 `ok/ready/service/stage/timestamp/startupWarnings/startupErrors`
- `/metrics`：Prometheus 文本格式指标

## MCP HTTP/SSE

如果 OpenClaw 或其他客户端无法直接消费 `stdio`，可启用 MCP HTTP：

```toml
[mcp]
transport = "http"
host = "127.0.0.1"
port = 8765
path = "/mcp"
sse_path = "/mcp/sse"
message_path = "/mcp/message"
active_auth_token_id = "primary"
[[mcp.auth_tokens]]
id = "primary"
token = "env:MCP_AUTH_TOKEN_PRIMARY"
enabled = true
[[mcp.auth_tokens]]
id = "rollover"
token = "env:MCP_AUTH_TOKEN_ROLLOVER"
enabled = true
```

推荐暴露方式：

- `POST /mcp`：同步 JSON-RPC
- `GET /mcp/sse`：建立 SSE 会话
- `POST /mcp/message?sessionId=...`：向该 SSE 会话提交 JSON-RPC 请求

建议只对内网或反向代理后暴露，并始终开启 Bearer token。轮换时先加新 token，再移除旧 token。

补充：

- `starting` 阶段 `/healthz` 可为 `200`，但 `/readyz` 会返回 `503`
- `degraded` 或 `stopped` 阶段 `/healthz` / `/readyz` 都会返回 `503`
- `/metrics` 会暴露 `feique_service_live`、`feique_service_ready`、`feique_startup_warnings`、`feique_startup_errors`

Prometheus 示例文件：

- 抓取配置：`examples/prometheus.yml`
- 告警规则：`examples/alerts.yml`
- Alertmanager 配置：`examples/alertmanager.yml`
- 一键观测栈：`examples/docker-compose.observability.yml`
- Grafana dashboard：`examples/grafana/dashboards/feique-overview.json`

本地校验：

```bash
promtool check rules examples/alerts.yml
```

重点告警已放在 `examples/alerts.yml`：

- bridge down
- 30 分钟无新消息
- 飞书出站失败
- Codex 失败率过高
- 活跃运行长时间无成功完成

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
feique serve --config ~/.feique/config.toml
```

2. 回放消息事件：

```bash
feique webhook replay-message \
  --url http://127.0.0.1:3333/webhook/event \
  --chat-id oc_demo \
  --actor-id ou_demo \
  --text "hello from replay"
```

3. 回放卡片事件：

```bash
feique webhook replay-card \
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
feique webhook smoke --base-url http://127.0.0.1:3333
```

## 启动与停机

推荐启动顺序：

1. `feique doctor`
   或 `feique doctor --json`
   或 `feique doctor --remote`
   或 `feique doctor --fix`
2. `feique start`
3. 观察日志确认桥接已开始监听或已建立长连接

若必须绕过预检：

```bash
feique serve --skip-doctor
```

停机时建议向主进程发送：

- `SIGTERM`：生产环境常规停机
- `SIGINT`：本地前台调试停机

服务会关闭监听资源并写入 `service.stop` 审计事件。

如果 bridge 异常退出，下次启动会恢复遗留运行状态：

- pid 仍然存在的运行会标成 `orphaned`
- pid 不存在的运行会标成 `stale`
