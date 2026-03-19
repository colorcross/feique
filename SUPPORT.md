# Support

## Use the right channel

### GitHub Discussions

Use Discussions for:

- usage questions
- deployment questions
- configuration tradeoffs
- architecture discussion
- workflow ideas that are not yet implementation-ready

Link:

- <https://github.com/colorcross/codex-feishu/discussions>

### GitHub Issues

Use Issues for:

- reproducible defects
- documentation mismatches
- scoped feature requests with a clear implementation target

Link:

- <https://github.com/colorcross/codex-feishu/issues>

### Security reports

Do not file public issues for security problems.

See:

- [SECURITY.md](SECURITY.md)

## What to include

When asking for help, include:

1. `feishu-bridge doctor` output
2. `feishu-bridge feishu inspect` output when relevant
3. deployment mode: `long-connection` or `webhook`
4. the smallest reproducible message flow
5. only the relevant log excerpt, with secrets removed

## Automatic labels

The repository uses two automatic labeling paths:

1. Issues
- Issue forms assign `bug` or `enhancement`
- A triage workflow adds `area/*` labels from issue text
- When the report is too thin, it can add `status/needs-feedback` or `status/needs-repro`

2. Pull requests
- A labeler workflow adds `area/*` labels from changed files
- This keeps triage and release notes easier to scan
