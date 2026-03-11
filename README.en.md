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
- Supports `/kb status` and `/kb search <query>` for project-local documentation search
- Carries image/file/audio/rich-text metadata into the Codex prompt for media-aware conversations, auto-extracts excerpts from text-like attachments and `doc/docx/odt/rtf` files after download, and can generate concise image descriptions
- Supports `/wiki spaces`, `/wiki search <query>`, and `/wiki read <url|token>` for Feishu knowledge-base access
- Supports `/wiki create <title>` and `/wiki create <space_id> <title>` for creating docx pages in Feishu wiki
- Supports `/wiki rename <node_token> <title>` for retitling wiki nodes
- Supports `/wiki copy <node_token> [target_space_id]` and `/wiki move <source_space_id> <node_token> [target_space_id]` for node flow management
- Supports `/wiki members [space_id]`, `/wiki grant <space_id> <member_type> <member_id> [member|admin]`, and `/wiki revoke <space_id> <member_type> <member_id> [member|admin]` for space membership management
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

If the npm package is not live yet, install directly from the GitHub Release artifact:

```bash
npm install -g https://github.com/colorcross/codex-feishu/releases/download/v0.1.2/codex-feishu-0.1.2.tgz
codex-feishu init --mode global
```

Common Feishu commands:

- `/help`
- `/projects`
- `/project <alias>`
- `/status`
- `/new`
- `/cancel`
- `/kb status`
- `/kb search <query>`
- `/memory status`
- `/memory stats`
- `/memory status group`
- `/memory stats group`
- `/memory recent`
- `/memory recent group`
- `/memory recent --tag <tag>`
- `/memory recent --source <source>`
- `/memory recent --created-by <actor_id>`
- `/memory search <query>`
- `/memory search --tag <tag> <query>`
- `/memory search --source <source> <query>`
- `/memory search --created-by <actor_id> <query>`
- `/memory search group <query>`
- `/memory save <text>`
- `/memory save group <text>`
- `/memory pin <id>`
- `/memory unpin <id>`
- `/memory forget <id>`
- `/memory forget all-expired`
- `/memory restore <id>`
- `/wiki spaces`
- `/wiki search <query>`
- `/wiki read <url|token>`
- `/wiki create <title>`
- `/wiki rename <node_token> <title>`
- `/wiki copy <node_token> [target_space_id]`
- `/wiki move <source_space_id> <node_token> [target_space_id]`
- `/wiki members [space_id]`
- `/wiki grant <space_id> <member_type> <member_id> [member|admin]`
- `/wiki revoke <space_id> <member_type> <member_id> [member|admin]`
- `/session list`
- `/session use <thread_id>`

## Documentation

- [English docs index](docs/README.en.md)
- [Chinese docs index](docs/README.md)
- [Memory design](docs/memory-design.md)
- [Feishu roadmap](docs/feishu-roadmap.md)
- [Changelog](CHANGELOG.md)

## Community

- Usage questions and deployment discussions: GitHub Discussions
- Reproducible defects and scoped feature work: GitHub Issues
- Support guide: [SUPPORT.md](SUPPORT.md)
- Security reports: follow [SECURITY](SECURITY.md)
