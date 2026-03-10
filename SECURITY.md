# Security Policy

## Reporting

如果你发现了安全问题，请不要直接公开提交 issue。

建议通过私下渠道披露，并至少提供：

- 影响范围
- 复现步骤
- 可能的利用方式
- 建议修复方向

## 重点风险面

本项目最需要注意的风险包括：

- 飞书应用凭证泄露
- 过宽的 `security.allowed_project_roots`
- 群聊误触发和多用户串线
- 共享部署时目录权限过大
- 生产环境暴露管理端口 `/metrics`

## 运营建议

- 所有飞书凭证都通过环境变量或 Secret Manager 注入
- 生产环境不要长期使用 `allowed_project_roots = ["/"]`
- 保持 `security.require_group_mentions = true`，除非你明确接受误触发风险
- 优先使用更保守的 Codex sandbox 和 profile
- 定期检查 `audit.jsonl`、`runs.json`、`idempotency.json`

更多细节见：

- [docs/security.md](docs/security.md)
