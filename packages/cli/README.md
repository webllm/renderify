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
renderify playground [port] [--debug]  # Start browser playground server
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
```

## Useful Environment Variables

- `RENDERIFY_LLM_API_KEY`
- `RENDERIFY_LLM_PROVIDER` (`openai`, `anthropic`, `google`)
- `RENDERIFY_LLM_MODEL`
- `RENDERIFY_LLM_BASE_URL`
- `RENDERIFY_LLM_MAX_RETRIES` (e.g. `0` for single-attempt HTTP calls)
- `RENDERIFY_LLM_STRUCTURED_RETRY` (`true`, `false`)
- `RENDERIFY_LLM_STRUCTURED_FALLBACK_TEXT` (`true`, `false`)
- `RENDERIFY_SECURITY_PROFILE` (`strict`, `balanced`, `relaxed`)
- `RENDERIFY_PLAYGROUND_DEBUG` (`1`, `true`, `yes`, `on`)

When debug mode is enabled, playground prints key inbound/outbound request logs, exposes `/api/debug/stats`, and renders an in-page **Debug Stats** panel with manual/auto refresh.

See `../../docs/getting-started.md` and `../../docs/security.md` for runtime and policy options.

## Notes

- Node.js `>=22` is required.
- The CLI composes `@renderify/core`, `@renderify/runtime`, `@renderify/security`, `@renderify/llm`, and `@renderify/ir`.
