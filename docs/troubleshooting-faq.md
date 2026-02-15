# Troubleshooting & FAQ

This guide is a practical runbook for diagnosing Renderify failures in production and local development.

## Fast Triage Flow

1. Validate security and dependency availability before execution:

```bash
pnpm cli -- probe-plan path/to/plan.json
```

2. If probe passes but render fails, run execution with strict env and inspect diagnostics:

```bash
RENDERIFY_SECURITY_PROFILE=strict \
RENDERIFY_RUNTIME_PREFLIGHT=true \
pnpm cli -- render-plan path/to/plan.json
```

3. If runtime source is involved (`plan.source`), force browser sandbox and fail-closed:

```bash
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=worker \
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true \
pnpm playground
```

4. If dependency fetch is unstable, tune timeout/retry and fallback CDN list:

```bash
RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS=15000 \
RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES=3 \
RENDERIFY_RUNTIME_REMOTE_FALLBACK_CDNS=https://esm.sh,https://cdn.jsdelivr.net \
pnpm playground
```

## Symptom → Cause → Fix

| Symptom | Typical cause | Recommended fix |
| --- | --- | --- |
| `Security policy rejected runtime plan: ...` | Plan violates policy (blocked tags, blocked source pattern, disallowed module host, budget policy) | Run `probe-plan` and inspect `securityIssues`. If intentional, adjust `securityInitialization.overrides` instead of disabling checks globally. |
| `Missing moduleManifest entry for bare specifier: ...` | Strict/balanced policy plus bare imports without manifest coverage | Keep `autoPinLatestModuleManifest` enabled for DX, or pre-generate/pin `moduleManifest` for deterministic production. |
| `Remote module URL is blocked by runtime network policy: ...` | Runtime fallback URL host is outside `allowedNetworkHosts` | Align security allowlist with runtime fallback CDNs, or disable fallback (`RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE=true` for strict JSPM-only mode). |
| `Dependency preflight timed out` | Slow CDN/network and low fetch timeout | Increase `RENDERIFY_RUNTIME_REMOTE_FETCH_TIMEOUT_MS`; keep retries bounded (`RENDERIFY_RUNTIME_REMOTE_FETCH_RETRIES`) to avoid request storms. |
| `Worker sandbox timed out` / `Iframe sandbox timed out` | Source execution exceeded sandbox timeout | Raise `RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS`, reduce source complexity, or optimize remote imports. |
| `Babel standalone is not available...` | Browser runtime source path used without Babel standalone in page scope | Load `@babel/standalone` before TSX/JSX execution, or provide a custom `sourceTranspiler`. |
| `Runtime execution timed out` | `maxExecutionMs` is too low for current plan/dependencies | Increase `plan.capabilities.maxExecutionMs` (or runtime default), then profile root cause in dependencies/source. |

## Frequently Asked Questions

### Which security profile should I use?

- `strict`: internet-facing, untrusted model output, compliance-sensitive environments.
- `balanced`: default for most production workloads.
- `relaxed`: trusted internal tools and prototyping.

See [`docs/security.md`](./security.md) for full policy details.

### Should I disable `autoPinLatestModuleManifest`?

- Keep it enabled for rapid prototyping and playground flows.
- Disable it in production (`autoPinLatestModuleManifest: false`) and provide pinned `moduleManifest` entries for deterministic deploys.

### How do I debug dependency issues without executing code?

Use preflight probing:

```bash
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json
```

This checks policy and dependency loadability without running component/source logic.

### Why does the same plan behave differently between environments?

Common reasons:

- Different security profile (`strict` vs `balanced`).
- Different fallback CDN configuration.
- Different browser runtime capabilities (`Worker`/`ShadowRealm` availability).
- Different module versions when using latest auto-pin behavior.

### How do I collect a useful bug report?

Include:

- Plan snippet (`specVersion`, `imports`, `source` section, `moduleManifest` if present).
- Security profile and runtime env variables.
- Full `probe-plan` output.
- Runtime diagnostics from `execution.diagnostics`.
- Browser/version and whether sandbox mode was enabled.

## Related Docs

- [`docs/security.md`](./security.md)
- [`docs/runtime-execution.md`](./runtime-execution.md)
- [`docs/performance-tuning.md`](./performance-tuning.md)
- [`docs/cookbook.md`](./cookbook.md)
