---
"@renderify/cli": minor
---

Reuse the local OpenAI Codex CLI login for the `openai-codex` provider. Set
`RENDERIFY_CODEX_USE_CLI_AUTH=1` to import credentials from the official Codex
CLI `auth.json` (`$CODEX_HOME`/`~/.codex`, overridable via
`RENDERIFY_CODEX_CLI_AUTH_FILE`) so a locally hosted playground can run
`gpt-5.3-codex-spark` without a separate `renderify auth codex login`. Use
`only` to consult the Codex CLI file exclusively. Expiring access tokens are
refreshed and written back to the Codex CLI file in its native format,
preserving unknown keys, and `renderify auth codex status` now reports the
active credential source. Disabled by default, so existing behavior is
unchanged.
