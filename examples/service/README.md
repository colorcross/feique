# Service 安装模板样例

本目录存放 **launchd**（macOS）和 **systemd**（Linux）用户级服务定义的**静态示例**，
方便在没有安装 feique 的情况下预览模板长什么样。

> ⚠️ **不要直接复制这里的文件去用** —— 里面的路径是占位符。
> 正确流程如下。

## 推荐流程：用内置命令生成

feique 自带三个子命令，会基于你本机真实环境（Node 路径、CLI 入口、工作目录）渲染模板：

```bash
# 1. 预览（不落盘，只 stdout 打印）
feique service print --platform darwin   # 或 linux
feique service print --platform darwin --config ~/.feique/config.toml

# 2. 安装到用户目录
feique service install --platform darwin --config ~/.feique/config.toml
# macOS → ~/Library/LaunchAgents/feique.plist
# Linux → ~/.config/systemd/user/feique.service

# 3. 卸载
feique service uninstall --platform darwin
```

## 示例文件索引

| 文件 | 平台 | 对应命令 |
|---|---|---|
| [`feique.plist`](./feique.plist) | macOS (launchd, user agent) | `feique service print --platform darwin` |
| [`feique.service`](./feique.service) | Linux (systemd, user unit) | `feique service print --platform linux` |

两份文件中的 `<PLACEHOLDER>` 需要替换：

| 占位符 | 含义 | 典型值 |
|---|---|---|
| `<NODE_BIN>` | Node.js 可执行文件绝对路径 | `/opt/homebrew/bin/node` / `/usr/bin/node` |
| `<FEIQUE_CLI>` | feique CLI 入口脚本 | `/usr/local/lib/node_modules/feique/dist/cli.js` |
| `<WORKING_DIR>` | 工作目录 | `$HOME` |
| `<CONFIG_PATH>` | 配置文件路径 | `$HOME/.feique/config.toml` |
| `<LOG_DIR>` | 日志目录 | `$HOME/.feique/logs` |
| `<USER_HOME>` | 用户主目录 | `/Users/you` 或 `/home/you` |

## 为什么不直接提供 system-wide unit？

当前内置模板只生成 **user service**（用户级，无需 root）。理由：

- 个人 / 小团队部署的绝大多数场景用户级已足够稳
- 避免写 `/etc/systemd/system/` 或 `/Library/LaunchDaemons/` 带来的权限和 PATH 问题
- 飞书长连接只需要出站网络，不需要特权端口

如果你确有 system-wide 部署需求（多用户服务器、无登录会话守护等），可以把
`feique service print --platform linux` 的输出稍作改造后手动塞到
`/etc/systemd/system/feique.service`，并把 `WorkingDirectory` / `ExecStart`
/ 日志目录改成非 `$HOME` 路径，再用 `systemctl enable --now feique` 启动。
