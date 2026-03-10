# 文档首页

这份文档面向两类读者：

- 想把项目拉起来直接用的人
- 想把桥接器部署成正式团队服务的人

## 建议阅读顺序

1. [快速开始](getting-started.md)
2. [部署说明](deployment.md)
3. [安全与运维](security.md)
4. [架构设计](architecture.md)
5. [FAQ](faq.md)
6. [官网部署说明](website.md)

## 文档地图

### 入门

- [快速开始](getting-started.md)
  - 一键安装
  - 最小配置
  - 飞书侧联调
  - 常用命令

### 深入理解

- [架构设计](architecture.md)
  - 飞书接入层
  - Bridge Service
  - 会话模型
  - 运行态保护
  - Observability

### 部署与运维

- [部署说明](deployment.md)
  - 本机单用户模式
  - 团队共享模式
  - systemd / launchd
  - Webhook / 反向代理 / 探针
- [安全与运维](security.md)
  - 凭证处理
  - 项目根目录白名单
  - 群聊风险
  - 指标与审计建议

### 常见问题

- [FAQ](faq.md)
  - 群聊为什么必须 `@机器人`
  - 怎么绑定项目
  - 怎么管理多个 session
  - 怎么收敛 `chat_id` 白名单
  - 怎么启用 `proxy_on`

### 项目对外页面

- [官网部署说明](website.md)
  - `website/` 目录说明
  - GitHub Pages 发布方式
  - 本地预览方式

## 发布信息

- [README](../README.md)
- [CHANGELOG](../CHANGELOG.md)
- [CONTRIBUTING](../CONTRIBUTING.md)
- [SECURITY](../SECURITY.md)
