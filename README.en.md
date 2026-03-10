# Codex Feishu

English | [简体中文](README.md)

[![GitHub tag](https://img.shields.io/github/v/tag/colorcross/codex-feishu?sort=semver)](https://github.com/colorcross/codex-feishu/tags)
[![License](https://img.shields.io/github/license/colorcross/codex-feishu)](https://github.com/colorcross/codex-feishu/blob/main/LICENSE)
[![Pages](https://github.com/colorcross/codex-feishu/actions/workflows/pages.yml/badge.svg)](https://github.com/colorcross/codex-feishu/actions/workflows/pages.yml)

Turn Feishu into Codex's working entry point.

Codex Feishu sends Feishu messages into resumable Codex sessions, keeps projects routable, replies traceable, and runtime state operable. It is not a disposable bot script. It is an engineering bridge meant to stay up.

## Links

- Repository: <https://github.com/colorcross/codex-feishu>
- Website: <https://colorcross.github.io/codex-feishu/>
- Chinese landing page: <https://colorcross.github.io/codex-feishu/>
- English landing page: <https://colorcross.github.io/codex-feishu/en.html>
- npm: `npm install -g codex-feishu`
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
npm install -g codex-feishu
codex-feishu init --mode global
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

- [English docs index](docs/README.en.md)
- [Chinese docs index](docs/README.md)
- [Feishu roadmap](docs/feishu-roadmap.md)
- [Changelog](CHANGELOG.md)

## Community

- Usage questions and deployment discussions: GitHub Discussions
- Reproducible defects and scoped feature work: GitHub Issues
- Support guide: [SUPPORT.md](SUPPORT.md)
- Security reports: follow [SECURITY](SECURITY.md)
