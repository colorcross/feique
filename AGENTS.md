# Feishu Bridge Repo Workflow

This file only keeps repository-specific rules. Global workflow, verification grading, token hygiene, and self-iteration live in `~/.codex/AGENTS.md`.

## Commit discipline
- 每一轮开始前，如果工作区不是干净状态，先提交一个 checkpoint commit，再开始本轮改动。
- 每一轮结束后，如果本轮产生了改动且已完成对应验证，再提交一个结果 commit。
- 若一轮开始时工作区已干净，不创建空提交。
- 不 amend 已有提交，除非用户明确要求。

## Verification baseline
- 除非明确不适用，优先保留 `typecheck`、`test`、`build` 之一或多项作为收尾验证。

## External closure focus
- 本仓库涉及飞书、GitHub、npm、Webhook、long-connection、MCP、Pages 等外部系统；汇报时要单独标明哪些只是本地验证，哪些已完成真实闭环。
