# @renderify/cli

![Node CI](https://github.com/webllm/renderify/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/@renderify/cli.svg)
![license](https://img.shields.io/npm/l/@renderify/cli)

CLI utilities for Renderify.

`@renderify/cli` is the fastest way to run prompts, inspect generated RuntimePlan JSON, probe plan dependencies, execute plan files, and open the browser playground.

## Install

```bash
pnpm add -D @renderify/cli
# or
npm i -D @renderify/cli
```

Run directly from your project:

```bash
npx renderify help
```

## Commands

```bash
renderify run <prompt>          # Render prompt and print HTML
renderify plan <prompt>         # Print RuntimePlan JSON
renderify probe-plan <file>     # Probe plan dependencies and policy compatibility
renderify render-plan <file>    # Execute RuntimePlan JSON file and print HTML
renderify playground [port] [--debug] [--no-llm-log]  # Start browser playground server
renderify auth codex login|status|logout              # Manage OpenAI Codex OAuth
```

## Quick Start

```bash
# Generate and render HTML from a prompt
renderify run "build a KPI dashboard with a chart"

# Generate RuntimePlan JSON
renderify plan "build a todo app"

# Probe and execute a local plan file
renderify probe-plan ./examples/runtime/recharts-dashboard-plan.json
renderify render-plan ./examples/runtime/recharts-dashboard-plan.json

# Use OpenAI Codex without installing Codex CLI
renderify auth codex login
RENDERIFY_LLM_PROVIDER=openai-codex renderify playground
```

## Useful Environment Variables

- `RENDERIFY_LLM_API_KEY`
- `RENDERIFY_LLM_PROVIDER` (`openai`, `openai-codex`, `anthropic`, `google`, `ollama`, `lmstudio`)
- `RENDERIFY_LLM_MODEL`
- `RENDERIFY_LLM_BASE_URL`
- `RENDERIFY_CODEX_ACCESS_TOKEN` (optional direct token override)
- `RENDERIFY_CODEX_AUTH_FILE` (defaults to `~/.renderify/auth.json`)
- `RENDERIFY_CODEX_BASE_URL` (defaults to `https://chatgpt.com/backend-api/codex`)
- `RENDERIFY_LLM_MAX_RETRIES` (e.g. `0` for single-attempt HTTP calls)
- `RENDERIFY_LLM_STRUCTURED_RETRY` (`true`, `false`)
- `RENDERIFY_LLM_STRUCTURED_FALLBACK_TEXT` (`true`, `false`)
- `RENDERIFY_SECURITY_PROFILE` (`strict`, `balanced`, `trusted`, `relaxed`)
- `RENDERIFY_PLAYGROUND_DEBUG` (`1`, `true`, `yes`, `on`)
- `RENDERIFY_PLAYGROUND_LLM_LOG` (`true`, `false`, default `true`)

Playground prints outbound LLM request/response payload logs to terminal by default (`[playground-llm]`) with sensitive values redacted.

When debug mode is enabled, playground also prints key inbound/outbound request summaries, exposes `/api/debug/stats`, and renders an in-page **Debug Stats** panel with manual/auto refresh.

The playground browser never transpiles or imports `plan.source.code`. It
displays the HTML returned by the server-side security/runtime pipeline and
keeps source available only for inspection. Source hash links use that same
server path and cannot enable browser-side source execution. Iframe display
mode is sandboxed without script permission.

See `../../docs/getting-started.md` and `../../docs/security.md` for runtime and policy options.

## Notes

- Node.js `>=22` is required.
- The CLI composes `@renderify/core`, `@renderify/runtime`, `@renderify/security`, `@renderify/llm`, and `@renderify/ir`.
