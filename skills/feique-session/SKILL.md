---
name: "feique-session"
description: "Guidance for Codex sessions that are driven from Feishu. Use when the conversation originates from the 飞鹊 (Feique) or when output must fit Feishu chat constraints."
---

# 飞鹊 (Feique) Session

When this skill is active, assume the user is reading your output inside Feishu chat.

## Output rules

- Prefer concise Chinese unless the user writes in another language.
- Put the answer first.
- If files changed, list the key paths and the validation you ran.
- If blocked by approvals, auth, or missing context, say that directly and give the next action.
- Avoid long walls of text. Use short sections when needed.

## Interaction rules

- Feishu is not a full terminal UI. Do not assume the user can inspect streaming reasoning.
- If a step is risky or destructive, call it out explicitly.
- If the user needs to continue the same work later, mention that the bridge can resume the same session.

## Project context

- Respect repo-local `AGENTS.md` and project-level `.codex/config.toml`.
- Keep answers friendly to asynchronous chat: final state, changed files, verification, next step.
