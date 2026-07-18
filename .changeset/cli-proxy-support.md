---
"@renderify/cli": patch
---

Honor standard proxy environment variables for the CLI's outbound requests.
Node's built-in `fetch` (undici) ignores `HTTP(S)_PROXY` / `ALL_PROXY` /
`NO_PROXY`, so in a proxied network every request — LLM providers, Codex auth
refresh, and remote module fetches — failed with a connect timeout even though
`curl` and the official Codex CLI worked. When a proxy is configured, the CLI
now installs undici's `EnvHttpProxyAgent` as the global dispatcher so those
requests are routed through it. No effect when no proxy is set.
