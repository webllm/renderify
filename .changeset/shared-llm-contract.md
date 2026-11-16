---
"@renderify/ir": minor
"@renderify/llm": minor
---

Add one LLM contract for RuntimePlans to `@renderify/ir`: `RUNTIME_PLAN_JSON_SCHEMA` and `createRuntimePlanJsonSchema()`, `acceptRuntimePlanCandidate()`, and `diagnoseRuntimePlanCandidate()`. Every built-in provider now sends the same schema, accepts the same recoverable variants (such as a missing `id`), and returns the same specific diagnostics to the structured repair prompt. Previously only the OpenAI Codex provider normalized payloads and explained rejections, and the other providers' schemas had drifted apart.
