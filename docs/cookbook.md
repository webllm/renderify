---
title: Integration cookbook
description: Production-oriented recipes for renderer-only embeds, trusted source, state, and failure handling.
---

# Cookbook: Common Integration Patterns

This cookbook focuses on production-friendly patterns that appear repeatedly in Renderify integrations.

## Pattern 1: Renderer-Only Embed (No Built-In LLM)

Use when plan generation happens on your backend or another model pipeline.

```ts
import { renderPlanInBrowser } from "renderify";
import type { RuntimePlan } from "@renderify/ir";

const plan: RuntimePlan = {
  specVersion: "runtime-plan/v1",
  id: "renderer_only_card",
  version: 1,
  root: {
    type: "element",
    tag: "section",
    children: [{ type: "text", value: "Hello from external plan" }],
  },
  capabilities: { domWrite: true },
};

await renderPlanInBrowser(plan, { target: "#mount" });
```

## Pattern 2: Manifest-Pinned Production Execution

Use when reproducibility matters and dependency drift is not acceptable.

```ts
import { renderPlanInBrowser } from "renderify";

await renderPlanInBrowser(planWithPinnedManifest, {
  target: "#mount",
  autoPinLatestModuleManifest: false,
  runtimeOptions: {
    enforceModuleManifest: true,
    enableDependencyPreflight: true,
    failOnDependencyPreflightError: true,
  },
});
```

Checklist:

- Pin every bare specifier in `moduleManifest`.
- In strict mode, include `integrity` for remote modules.
- Run `probe-plan` in CI before release.

## Pattern 3: Reviewed Source with Browser Containment

Use only after `plan.source` has crossed an application-defined review or trust
boundary. Browser sandbox modes add termination and containment, but they do
not make arbitrary hostile JavaScript safe.

```ts
import { renderTrustedPlanInBrowser } from "renderify";

await renderTrustedPlanInBrowser(reviewedPlan, {
  target: "#mount",
  runtimeOptions: {
    browserSourceSandboxMode: "worker",
    browserSourceSandboxTimeoutMs: 4000,
    browserSourceSandboxFailClosed: true,
  },
});
```

Recommended policy posture:

- `RENDERIFY_SECURITY_PROFILE=trusted`
- `RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true`
- Prefer an application-owned module allowlist and pinned `moduleManifest`.
- Keep unreviewed input on the declarative RuntimePlan path.

## Pattern 4: Streaming Prompt to Progressive UI

Use when chat UX needs preview updates before final render.

```ts
for await (const chunk of app.renderPromptStream(prompt, { previewEveryChunks: 2 })) {
  if (chunk.type === "llm-delta") {
    appendToken(chunk.delta);
  }

  if (chunk.type === "preview") {
    renderPreviewHtml(chunk.html);
  }

  if (chunk.type === "final") {
    commitFinalHtml(chunk.final.html);
  }

  if (chunk.type === "error") {
    showError(chunk.error.message);
  }
}
```

## Pattern 5: Probe Before Execute (CI Gate)

Use when you need deterministic "will this render?" signals without executing source/component code.

```bash
pnpm cli -- probe-plan examples/runtime/recharts-dashboard-plan.json
```

A practical CI flow:

1. Run `probe-plan` for generated plans.
2. Fail pipeline if `securityIssueCount > 0`.
3. Fail pipeline if `preflightIssueCount > 0` in strict production lanes.

## Pattern 6: Controlled Network Scope for Remote Modules

Use when outbound network egress must be restricted.

```ts
await renderPlanInBrowser(plan, {
  runtimeOptions: {
    allowArbitraryNetwork: false,
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io", "esm.sh"],
    remoteFallbackCdnBases: ["https://esm.sh"],
  },
});
```

Keep `allowedNetworkHosts` and `remoteFallbackCdnBases` aligned so fallback URLs do not violate runtime host policy.

## Pattern 7: Explicit JSX Helper Behavior

Use when you want stable transpilation behavior across environments.

```ts
await renderPlanInBrowser(planWithSource, {
  runtimeOptions: {
    runtimeSourceJsxHelperMode: "always", // "auto" | "always" | "never"
  },
});
```

- If `planWithSource.source?.runtime === "preact"`, use `renderTrustedPlanInBrowser(...)` instead of `renderPlanInBrowser(...)`.
- `auto`: runtime decides helper injection based on source/runtime mode.
- `always`: always inject helper path (predictable for heterogeneous input).
- `never`: only for advanced setups where helper wiring is external.

## Pattern 8: Serialized Target Renders (Avoid UI Race Conditions)

Use when multiple concurrent renders target the same mount element.

```ts
await Promise.all([
  renderPlanInBrowser(planA, { target: "#mount", serializeTargetRenders: true }),
  renderPlanInBrowser(planB, { target: "#mount", serializeTargetRenders: true }),
]);
```

`renderPlanInBrowser` serializes operations per target element by default (`serializeTargetRenders !== false`). Keep it enabled unless you have a custom scheduler.

## Related Docs

- [`docs/getting-started.md`](./getting-started.md)
- [`docs/runtime-execution.md`](./runtime-execution.md)
- [`docs/security.md`](./security.md)
- [`docs/troubleshooting-faq.md`](./troubleshooting-faq.md)
