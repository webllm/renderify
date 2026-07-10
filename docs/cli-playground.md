# CLI & Playground

Renderify provides a CLI tool and a browser-based playground for development, testing, and interactive exploration.

## CLI Commands

### `run` — Render a Prompt

Sends a prompt to the LLM, generates a RuntimePlan, executes it, and prints the resulting HTML.

```bash
pnpm cli -- run "Build a welcome card with a greeting message"
```

If no command is specified, `run` is the default:

```bash
pnpm cli -- "Build a welcome card"
```

### `plan` — Generate RuntimePlan JSON

Sends a prompt to the LLM and prints the generated RuntimePlan as formatted JSON, without executing it.

```bash
pnpm cli -- plan "Build a counter with increment/decrement buttons"
```

Useful for inspecting what the LLM produces before rendering.

### `probe-plan` — Probe Plan Compatibility

Validates a RuntimePlan file against the security policy and probes all dependencies without executing any code.

```bash
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json
```

Output includes:

```json
{
  "planId": "recharts-dashboard-v3",
  "safe": true,
  "securityIssueCount": 0,
  "runtimeErrorCount": 0,
  "preflightIssueCount": 0,
  "ok": true,
  "securityIssues": [],
  "dependencyStatuses": [
    { "usage": "import", "specifier": "recharts", "ok": true },
    { "usage": "source-import", "specifier": "preact", "ok": true }
  ],
  "runtimeDiagnostics": []
}
```

This is side-effect free — no source or component logic is executed.
The command exits with a non-zero status when the report's `ok` field is
`false`, so it can be used directly as a CI compatibility gate.

### `render-plan` — Execute a Plan File

Loads a RuntimePlan JSON file and executes it through the full pipeline, printing the rendered HTML.

```bash
pnpm cli -- render-plan examples/runtime/counter-plan.json
```

### `auth codex` — Manage OpenAI Codex OAuth

Authenticates Renderify against the OpenAI Codex backend with Renderify's own auth store. This does not require the Codex CLI.

```bash
pnpm cli -- auth codex login
pnpm cli -- auth codex status
pnpm cli -- auth codex logout
```

### `playground` — Start Browser Playground

Starts a local HTTP server with an interactive playground UI.

```bash
pnpm playground
# or
pnpm cli -- playground [port] [--host <host>]
```

By default, the server listens only on `127.0.0.1` and uses port `4317`.
Override either value explicitly:

```bash
RENDERIFY_PLAYGROUND_PORT=8080 pnpm playground
# or
PORT=8080 pnpm playground
# or
pnpm cli -- playground 8080

# Opt in to access from another host on a trusted network
pnpm cli -- playground --host 0.0.0.0
# or
RENDERIFY_PLAYGROUND_HOST=0.0.0.0 pnpm playground
```

Binding to a non-loopback address exposes the development server to the
reachable network. Keep the default unless remote access is intentional.

Browser writes to Playground API endpoints must come from the Playground's
own origin. Cross-origin `POST` requests are rejected with HTTP 403. CLI and
SDK clients that do not send browser provenance headers remain supported.

### `help` — Print Usage

```bash
pnpm cli -- help
```

## Playground

The playground is a single-page web application that provides:

### Prompt Input

Enter a natural language prompt and submit it. The playground sends the prompt to the configured LLM and renders the result.

### Streaming Preview

The playground provides a dedicated streaming action (`Stream Prompt`) powered by `/api/prompt-stream`. As the LLM generates tokens, you see:

1. **LLM delta chunks** — raw tokens appearing in real-time
2. **Preview renders** — intermediate UI renders during generation
3. **Final render** — the complete, fully-rendered UI

### Plan Input

Switch to Plan mode to submit a raw RuntimePlan JSON object. This bypasses the LLM and goes directly through security → runtime → render.

The browser only displays the serialized HTML returned by the playground
server. It never transpiles, imports, or evaluates `plan.source.code` in the
playground page. Source remains available in the source inspector, while all
source handling stays behind the configured server-side security and runtime
boundary. The optional iframe display mode also omits script permission from
its sandbox.

### Probe Mode

The playground can probe a plan for compatibility without executing it, similar to the `probe-plan` CLI command.

## Playground API Endpoints

The playground server exposes these HTTP endpoints:

### `GET /`

Returns the playground HTML page.

### `GET /api/health`

Health check endpoint.

```json
{ "ok": true, "status": "ready" }
```

### `POST /api/prompt`

Execute a prompt through the full pipeline.

**Request:**

```json
{ "prompt": "Build a welcome card" }
```

**Response:**

```json
{
  "traceId": "trace_abc123",
  "html": "<div>...</div>",
  "plan": { "id": "welcome-card", "version": 1 },
  "planDetail": {
    /* full RuntimePlan */
  },
  "diagnostics": [],
  "state": {}
}
```

### `POST /api/prompt-stream`

Streaming prompt execution via NDJSON (newline-delimited JSON).

**Request:**

```json
{ "prompt": "Build a dashboard" }
```

**Response** (NDJSON stream):

```
{"type":"llm-delta","traceId":"...","llmText":"...","delta":"..."}
{"type":"preview","traceId":"...","html":"...","diagnostics":[],"planId":"..."}
{"type":"final","traceId":"...","html":"...","final":{...}}
```

Content-Type: `application/x-ndjson; charset=utf-8`

### `POST /api/plan`

Execute a RuntimePlan directly (no LLM involved).

**Request:**

```json
{
  "plan": {
    "specVersion": "runtime-plan/v1",
    "id": "test",
    "version": 1,
    "root": { "type": "text", "value": "Hello" },
    "capabilities": {}
  }
}
```

### `POST /api/probe-plan`

Probe a RuntimePlan for compatibility without execution.

**Request:**

```json
{
  "plan": {
    /* RuntimePlan JSON */
  }
}
```

**Response:**

```json
{
  "safe": true,
  "securityIssues": [],
  "securityDiagnostics": [],
  "dependencies": [{ "usage": "import", "specifier": "recharts", "ok": true }],
  "runtimeDiagnostics": []
}
```

## Hash Deep-Links

The playground supports URL hash payloads for sharing and embedding:

### Plan Deep-Link

```bash
# Encode a RuntimePlan as base64url
PLAN64=$(node -e '
  const plan = {
    specVersion: "runtime-plan/v1",
    id: "demo",
    version: 1,
    root: { type: "text", value: "Hello from hash" },
    capabilities: {}
  };
  process.stdout.write(Buffer.from(JSON.stringify(plan)).toString("base64url"));
')

open "http://127.0.0.1:4317/#plan64=${PLAN64}"
```

### Source Deep-Link

```bash
# Encode JSX/TSX source as base64url
JSX64=$(node -e '
  const code = "export default function App() { return <div>Hello JSX</div>; }";
  process.stdout.write(Buffer.from(code).toString("base64url"));
')

open "http://127.0.0.1:4317/#jsx64=${JSX64}&runtime=preact"
```

Opening a source deep-link submits the decoded plan to the local playground
server. The page renders the server response but does not import the decoded
source into its own JavaScript realm. Hash parameters cannot opt into a
browser-side source execution mode.

### Supported Hash Parameters

| Parameter    | Description                                   |
| ------------ | --------------------------------------------- |
| `plan64`     | Base64url-encoded RuntimePlan JSON            |
| `jsx64`      | Base64url-encoded JSX source                  |
| `tsx64`      | Base64url-encoded TSX source                  |
| `js64`       | Base64url-encoded JavaScript source           |
| `ts64`       | Base64url-encoded TypeScript source           |
| `runtime`    | JSX runtime: `"preact"` or `"renderify"`      |
| `exportName` | Named export to render (default: `"default"`) |
| `manifest64` | Base64url-encoded module manifest JSON        |

### Auto-Manifest Hydration

When a source deep-link contains bare import specifiers (e.g., `import { LineChart } from "recharts"`), the playground automatically resolves them via JSPM and hydrates the `moduleManifest`. You can override with explicit `manifest64`.

When the active policy requires integrity, Playground hashes missing entries
with the same network allowlist applied to every redirect. Integrity reads are
limited to 8 MiB per module and successful hashes use a bounded cache.

## Environment Variables

All CLI and playground behavior can be configured via environment:

```bash
# LLM Configuration
RENDERIFY_LLM_PROVIDER=openai|openai-codex|anthropic|google|ollama|lmstudio
RENDERIFY_LLM_API_KEY=...
RENDERIFY_LLM_MODEL=gpt-5-mini
RENDERIFY_LLM_BASE_URL=https://api.openai.com/v1
RENDERIFY_LLM_USE_STRUCTURED_OUTPUT=true|false
RENDERIFY_CODEX_ACCESS_TOKEN=...
RENDERIFY_CODEX_AUTH_FILE=~/.renderify/auth.json
RENDERIFY_CODEX_BASE_URL=https://chatgpt.com/backend-api/codex

# Security
RENDERIFY_SECURITY_PROFILE=strict|balanced|trusted|relaxed

# Runtime
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true|false
RENDERIFY_RUNTIME_ALLOW_ISOLATION_FALLBACK=false
RENDERIFY_RUNTIME_SPEC_VERSIONS=runtime-plan/v1
RENDERIFY_RUNTIME_PREFLIGHT=true
RENDERIFY_RUNTIME_PREFLIGHT_FAIL_FAST=true
RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS=12000
RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES=2
RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS=https://esm.sh,https://cdn.jsdelivr.net
RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE=true

# Sandbox
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=worker|iframe|shadowrealm|none
RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS=4000
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true

# Playground
RENDERIFY_PLAYGROUND_HOST=127.0.0.1
RENDERIFY_PLAYGROUND_PORT=4317
RENDERIFY_PLAYGROUND_LLM_LOG=true
PORT=4317
```

LLM terminal logs contain bounded metadata summaries only. Prompt text,
generated content, and non-allowlisted header values are redacted.
