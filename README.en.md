# Codex Feishu

English | [简体中文](README.md)

[![GitHub tag](https://img.shields.io/github/v/tag/colorcross/codex-feishu?sort=semver)](https://github.com/colorcross/codex-feishu/tags)
[![License](https://img.shields.io/github/license/colorcross/codex-feishu)](https://github.com/colorcross/codex-feishu/blob/main/LICENSE)
[![Pages](https://github.com/colorcross/codex-feishu/actions/workflows/pages.yml/badge.svg)](https://github.com/colorcross/codex-feishu/actions/workflows/pages.yml)

Codex Feishu connects Feishu to Codex CLI so you can continue Codex sessions, route messages to specific projects, and operate the bridge with production-oriented controls.

## Links

- Repository: <https://github.com/colorcross/codex-feishu>
- Website: <https://colorcross.github.io/codex-feishu/>
- Releases: <https://github.com/colorcross/codex-feishu/releases>
- Issues: <https://github.com/colorcross/codex-feishu/issues>
- Discussions: <https://github.com/colorcross/codex-feishu/discussions>

## What it does

- Supports both `long-connection` and `webhook` Feishu transports
- Routes one Feishu entry point to multiple project directories
- Starts new Codex sessions with `codex exec` and resumes existing ones with `codex exec resume`
- Exposes operational commands such as `serve status`, `serve logs`, `serve ps`, and `doctor`
- Keeps audit logs, idempotency state, run state, and Prometheus metrics local and inspectable

## Quick start

```bash
bash scripts/install.sh
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='xxx'
codex-feishu doctor --remote
codex-feishu serve --detach
```

Common Feishu commands:

- `/help`
- `/projects`
- `/project <alias>`
- `/status`
- `/new`
- `/cancel`
- `/session list`
- `/session use <thread_id>`

## Documentation

Most detailed docs are currently written in Chinese:

- [Getting started](docs/getting-started.md)
- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Security and operations](docs/security.md)
- [FAQ](docs/faq.md)
- [Community and support](docs/community.md)
- [Changelog](CHANGELOG.md)

## Community

- Usage questions and deployment discussions: GitHub Discussions
- Reproducible defects and scoped feature work: GitHub Issues
- Security reports: follow [SECURITY](SECURITY.md)
