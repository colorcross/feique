# 文档首页

[English Docs Index](README.en.md)

这份文档面向两类读者：

- 想把项目拉起来直接用的人
- 想把桥接器部署成正式团队服务的人

## 建议阅读顺序

1. [快速开始](getting-started.md)
2. [部署说明](deployment.md)
3. [安全与运维](security.md)
4. [架构设计](architecture.md)
5. [FAQ](faq.md)
6. [记忆设计](memory-design.md)
7. [社区与支持](community.md)
8. [飞书交互路线图](feishu-roadmap.md)
9. [官网部署说明](website.md)

## 文档地图

### 入门

- [快速开始](getting-started.md)
  - 一键安装
  - 最小配置
  - 飞书侧联调
  - 常用命令
  - `reply_mode` / 富文本 / 卡片
  - 管理员动态接入与 `/admin` 命令
  - `/session adopt` 续接本地 Codex 会话
  - `queued` / 仓库占用提示

### 深入理解

- [架构设计](architecture.md)
  - 飞书接入层
  - Bridge Service
  - 会话模型
  - 运行态保护
  - Observability
- [飞书交互路线图](feishu-roadmap.md)
  - 文档与知识库
  - 多媒体沟通
  - 审批与工作流
  - 阶段里程碑
- [记忆设计](memory-design.md)
  - thread summary
  - project memory
  - 检索与注入顺序
  - 存储模型与任务拆分

### 部署与运维

- [部署说明](deployment.md)
  - 本机单用户模式
  - 团队共享模式
  - `start|status|logs|ps|stop|restart`
  - systemd / launchd
  - Webhook / 反向代理 / 探针
- [安全与运维](security.md)
  - 凭证处理
  - 日志脱敏
  - 项目根目录白名单
  - 群聊风险
  - 指标与审计建议

### 常见问题

- [FAQ](faq.md)
  - 群聊为什么必须 `@机器人`
  - 怎么绑定项目
  - 怎么管理多个 session
  - 怎么选择 `reply_mode`
  - 切项目后怎么自动续上最新会话
  - 管理员怎么动态开通 chat / group / project
  - 排队和仓库锁怎么判断
  - 怎么收敛 `chat_id` 白名单
  - 怎么启用 `proxy_on`

### 社区协作

- [社区与支持](community.md)
  - 什么时候用 Discussions
  - 什么时候开 Issues
  - 怎么带最小复现信息

### 项目对外页面

- [官网部署说明](website.md)
  - `website/` 目录说明
  - GitHub Pages 发布方式
  - 本地预览方式

## 发布信息

- [README](../README.md)
- [CHANGELOG](../CHANGELOG.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
- [SUPPORT](../SUPPORT.md)
- [SECURITY](../SECURITY.md)
