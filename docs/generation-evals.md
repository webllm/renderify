---
title: Generation evals
description: Measure how often each model produces renderable, policy-compliant RuntimePlans on the first try.
---

# Generation evals

Renderify is only as useful as the plans models produce for it. The generation
eval runs a fixed prompt suite through the real pipeline — structured
generation, repair, security policy, and runtime rendering — for every
configured provider, and reports how often the result is usable.

## One contract for every provider

All built-in providers share the RuntimePlan contract exported by
`@renderify/ir`:

- `RUNTIME_PLAN_JSON_SCHEMA` (or `createRuntimePlanJsonSchema()`) is the
  structured-output schema sent to OpenAI, OpenAI Codex, Anthropic, Google,
  and LM Studio. Ollama requests JSON mode for compatibility with older local
  servers and relies on the same local validation.
- `acceptRuntimePlanCandidate()` accepts canonical plans unchanged, normalizes
  recoverable variants such as a missing `id`, and rejects everything else.
- `diagnoseRuntimePlanCandidate()` explains rejections in terms a model can
  act on, such as `root.tag must be a non-empty string for an element node`.
  Those diagnostics feed the structured repair prompt for every provider.

Because the schema is shared, a provider test fails if any provider sends a
different schema.

## Metrics

| Metric | Meaning |
| --- | --- |
| Rendered | The pipeline produced a plan that passed policy and rendered. |
| Valid on first try | The first structured response was a valid RuntimePlan, with no repair. |
| Checks passed | The rendered plan also met the case's structural checks (for example, a `button` exists or the source uses `useState`). |
| Policy rejections | Plans the active security profile rejected. Declarative cases run under `balanced`; source cases under `trusted`. |
| Avg. model calls | Model calls per case, including repairs and text fallback. Lower is better. |
| p50 / p95 latency | End-to-end time per case, including rendering. |

## Run locally

Without credentials, the harness runs deterministic fixtures that still
exercise generation, repair, policy, and rendering:

```bash
pnpm eval:generation -- --mock
```

For live providers, set credentials and optionally pick providers and cases:

```bash
RENDERIFY_EVAL_OPENAI_API_KEY=sk-... \
RENDERIFY_EVAL_ANTHROPIC_API_KEY=sk-ant-... \
RENDERIFY_EVAL_CASES=counter,jsx-todo \
pnpm eval:generation
```

| Variable | Purpose |
| --- | --- |
| `RENDERIFY_EVAL_PROVIDERS` | Comma-separated `openai`, `anthropic`, `google`, `ollama`, `lmstudio`, `openai-codex`. Defaults to every hosted provider with an API key. |
| `RENDERIFY_EVAL_<PROVIDER>_API_KEY` | Provider credential, for example `RENDERIFY_EVAL_GOOGLE_API_KEY`. Codex uses `RENDERIFY_EVAL_OPENAI_CODEX_ACCESS_TOKEN` and `..._ACCOUNT_ID`. |
| `RENDERIFY_EVAL_<PROVIDER>_MODEL` | Model override. |
| `RENDERIFY_EVAL_<PROVIDER>_BASE_URL` | Endpoint override, required for local Ollama or LM Studio hosts that are not on their defaults. |
| `RENDERIFY_EVAL_CASES` | Comma-separated case ids. |
| `RENDERIFY_EVAL_OUTPUT_DIR` | Report directory; defaults to `.artifacts/evals`. |

Each run writes a JSON report and a Markdown summary, and appends the summary
to `$GITHUB_STEP_SUMMARY` when present.

## Nightly results

`.github/workflows/generation-eval.yml` runs every night and on demand. It
evaluates each provider whose `RENDERIFY_EVAL_*_API_KEY` repository secret is
set (model overrides come from repository variables of the same name). The
summary table is published on the workflow run page, and the JSON report is
attached as the `generation-eval` artifact.

## Add a case

Cases live in `tests/evals/generation-cases.json`:

```json
{
  "id": "counter",
  "prompt": "Build a counter with increment, decrement, and reset buttons.",
  "lane": "declarative",
  "checks": { "tags": ["button"], "minTransitions": 2 }
}
```

`lane` selects the security profile and the expected output: `declarative`
plans must not contain source, and `source` plans must. Keep checks structural
so they stay stable across models; `pnpm unit` verifies that ids are unique and
that the harness itself works.
