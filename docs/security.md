# Security Guide

Renderify enforces a security-first execution model. Every RuntimePlan passes through policy validation before runtime execution proceeds. When browser auto-pin is enabled, Renderify performs a lightweight precheck first, hydrates missing manifest entries, and then reruns the full plan check before execution. This is critical because LLM output is fundamentally untrusted: the model could generate script tags, eval calls, or unsafe network requests.

## Security Profiles

Four built-in profiles provide graduated security postures:

### Strict

Tight limits, full integrity enforcement. Best for production, multi-tenant, and externally-facing deployments.

```bash
RENDERIFY_SECURITY_PROFILE=strict
```

| Policy                    | Value                                     |
| ------------------------- | ----------------------------------------- |
| Blocked tags              | script, iframe, object, embed, link, meta |
| Max tree depth            | 8                                         |
| Max node count            | 250                                       |
| Inline event handlers     | Disabled                                  |
| Max imports               | 80                                        |
| Max execution time        | 5,000 ms                                  |
| Max component invocations | 120                                       |
| Max source size           | 20,000 bytes                              |
| Max source imports        | 30                                        |
| Runtime source modules    | Disabled                                  |
| `source.runtime=preact`   | Disabled                                  |
| Module manifest required  | Yes (for bare specifiers)                 |
| Module integrity required | Yes                                       |
| Spec version required     | Yes                                       |
| Dynamic imports in source | Disabled                                  |
| Allowed network hosts     | ga.jspm.io, cdn.jspm.io                   |
| Arbitrary network         | Disabled                                  |

**Banned source patterns (strict):** `eval()`, `new Function()`, `fetch()`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `document.cookie`, `localStorage`, `sessionStorage`, `indexedDB`, `navigator.sendBeacon`, `child_process`, `process.env`

### Balanced (Default)

Moderate limits suitable for most applications. Relaxes integrity requirements while maintaining code safety.

```bash
RENDERIFY_SECURITY_PROFILE=balanced
```

| Policy                    | Value                                     |
| ------------------------- | ----------------------------------------- |
| Blocked tags              | script, iframe, object, embed, link, meta |
| Max tree depth            | 12                                        |
| Max node count            | 500                                       |
| Inline event handlers     | Disabled                                  |
| Max imports               | 200                                       |
| Max execution time        | 15,000 ms                                 |
| Max component invocations | 500                                       |
| Max source size           | 80,000 bytes                              |
| Max source imports        | 120                                       |
| Runtime source modules    | Disabled                                  |
| `source.runtime=preact`   | Disabled                                  |
| Module manifest required  | Yes (for bare specifiers)                 |
| Module integrity required | No                                        |
| Spec version required     | Yes                                       |
| Dynamic imports in source | Disabled                                  |
| Allowed network hosts     | ga.jspm.io, cdn.jspm.io                   |
| Arbitrary network         | Disabled                                  |

**Banned source patterns (balanced):** `eval()`, `new Function()`, `fetch()`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `document.cookie`, `localStorage`, `sessionStorage`, `child_process`

### Trusted

Purpose-built for reviewed browser source modules that need JSX, hooks, and package imports without opening the full relaxed profile.

```bash
RENDERIFY_SECURITY_PROFILE=trusted
```

| Policy                    | Value                                     |
| ------------------------- | ----------------------------------------- |
| Blocked tags              | script, iframe, object, embed, link, meta |
| Max tree depth            | 16                                        |
| Max node count            | 1,000                                     |
| Inline event handlers     | Disabled                                  |
| Max imports               | 400                                       |
| Max execution time        | 30,000 ms                                 |
| Max component invocations | 1,000                                     |
| Max source size           | 120,000 bytes                             |
| Max source imports        | 180                                       |
| Runtime source modules    | Allowed for reviewed source               |
| `source.runtime=preact`   | Allowed                                   |
| Module manifest required  | Yes (for bare specifiers)                 |
| Module integrity required | No                                        |
| Spec version required     | Yes                                       |
| Dynamic imports in source | Disabled                                  |
| Allowed network hosts     | ga.jspm.io, cdn.jspm.io                   |
| Arbitrary network         | Disabled                                  |

**Banned source patterns (trusted):** `eval()`, `new Function()`, `fetch()`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `document.cookie`, `localStorage`, `sessionStorage`, `child_process`

### Relaxed

Permissive limits for trusted environments, internal tools, and development.

```bash
RENDERIFY_SECURITY_PROFILE=relaxed
```

| Policy                    | Value                                      |
| ------------------------- | ------------------------------------------ |
| Blocked tags              | script, iframe, object, embed              |
| Max tree depth            | 24                                         |
| Max node count            | 2,000                                      |
| Inline event handlers     | Allowed                                    |
| Max imports               | 1,000                                      |
| Max execution time        | 60,000 ms                                  |
| Max component invocations | 4,000                                      |
| Max source size           | 200,000 bytes                              |
| Max source imports        | 500                                        |
| Runtime source modules    | Allowed for reviewed source                |
| `source.runtime=preact`   | Allowed                                    |
| Module manifest required  | No                                         |
| Module integrity required | No                                         |
| Spec version required     | No                                         |
| Dynamic imports in source | Allowed                                    |
| Allowed network hosts     | ga.jspm.io, cdn.jspm.io, esm.sh, unpkg.com |
| Arbitrary network         | Allowed                                    |

**Banned source patterns (relaxed):** `child_process` only

## Security Policy Object

The full policy interface:

```ts
interface RuntimeSecurityPolicy {
  blockedTags: string[];
  maxTreeDepth: number;
  maxNodeCount: number;
  allowInlineEventHandlers: boolean;
  allowedModules: string[];
  allowedNetworkHosts: string[];
  allowArbitraryNetwork: boolean;
  allowedExecutionProfiles: Array<
    "standard" | "isolated-vm" | "sandbox-worker" | "sandbox-iframe" | "sandbox-shadowrealm"
  >;
  maxTransitionsPerPlan: number;
  maxActionsPerTransition: number;
  maxAllowedImports: number;
  maxAllowedExecutionMs: number;
  maxAllowedComponentInvocations: number;
  allowRuntimeSourceModules: boolean;
  allowPreactSourceRuntime: boolean;
  maxRuntimeSourceBytes: number;
  supportedSpecVersions: string[];
  requireSpecVersion: boolean;
  requireModuleManifestForBareSpecifiers: boolean;
  requireModuleIntegrity: boolean;
  allowDynamicSourceImports: boolean;
  sourceBannedPatternStrings: string[];
  maxSourceImportSpecifiers: number;
}
```

Custom source-ban entries are compiled as regular expressions during security
initialization. An invalid expression fails initialization atomically instead
of being ignored and weakening the active policy.

## Custom Policy Overrides

You can override individual policy settings while keeping a base profile:

```ts
import { DefaultSecurityChecker } from "@renderify/security";

const checker = new DefaultSecurityChecker();
checker.initialize({
  profile: "balanced",
  overrides: {
    maxTreeDepth: 20,
    maxNodeCount: 1000,
    allowedNetworkHosts: ["ga.jspm.io", "cdn.jspm.io", "my-cdn.example.com"],
    sourceBannedPatternStrings: [
      "\\beval\\s*\\(",
      "\\bnew\\s+Function\\b",
      "\\bcrypto\\b",
    ],
  },
});
```

## Security Check Categories

### 1. HTML Tag Blocking

Element nodes with blocked tags are rejected:

```json
{ "type": "element", "tag": "script" }  // REJECTED
{ "type": "element", "tag": "iframe" }  // REJECTED
{ "type": "element", "tag": "div" }     // OK
```

The UI renderer also provides a second layer of tag sanitization for declarative RuntimeNode rendering, converting blocked tags to `<div data-renderify-sanitized-tag="script"></div>`.

### 2. Module Specifier Validation

Module specifiers are validated against the allowlist:

```
"lodash-es"                          → Checked against allowedModules prefixes
"https://ga.jspm.io/npm:lodash..."   → Host checked against allowedNetworkHosts
"https://evil.com/malware.js"        → REJECTED (host not in allowlist)
"../../../etc/passwd"                 → REJECTED (path traversal)
```

### 3. Capability Budget Enforcement

Plan capabilities are validated against policy limits:

```json
{
  "capabilities": {
    "maxImports": 500, // Checked against policy maxAllowedImports
    "maxExecutionMs": 30000, // Checked against policy maxAllowedExecutionMs
    "maxComponentInvocations": 1000
  }
}
```

The same `maxAllowedImports` policy also caps the number of entries accepted in
`moduleManifest`, so an unused or alias-heavy manifest cannot bypass the
policy's import resource ceiling.

### 4. State Path Safety

All state paths are checked for prototype pollution:

```
"user.name"          → OK
"__proto__.polluted"  → REJECTED
"constructor.hack"    → REJECTED
"prototype.inject"    → REJECTED
```

### 5. Runtime Source Analysis

Source code undergoes static analysis:

- **Size limit** — source byte count must be within `maxRuntimeSourceBytes`
- **Import count** — source import specifiers must be within `maxSourceImportSpecifiers`
- **Banned patterns** — regex patterns matched against source (e.g., `eval()`, `fetch()`)
- **Dynamic imports** — `import()` expressions are blocked unless explicitly allowed
- **Manifest coverage** — bare import specifiers must have manifest entries (when required)

### 6. Module Manifest Verification

In strict profile:

```json
{
  "moduleManifest": {
    "recharts": {
      "resolvedUrl": "https://ga.jspm.io/npm:recharts@3.3.0/es6/index.js",
      "integrity": "sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb"
    }
  }
}
```

Strict integrity coverage applies to every executable module reference in
`plan.imports`, component nodes, `capabilities.allowedModules`, and static
source imports. Bare specifiers require an exact-key manifest entry. Direct
HTTP(S) references also require an exact-key entry whose `resolvedUrl` matches
the referenced URL, so a URL cannot bypass manifest enforcement.

Remote descriptors must provide at least one syntactically valid `sha256`,
`sha384`, or `sha512` SRI token. Missing entries, mismatched direct-URL targets,
missing hashes, and unsupported hash formats generate policy violations. The
runtime separately verifies the declared digest against loaded module content.

## UI Renderer Security

The UI renderer provides additional XSS protection beyond the policy checker (including light DOM + shadow DOM subtree sanitization):

### Blocked Tags at Render Time

Even if a tag passes the policy check, the renderer blocks: `script`, `style`, `iframe`, `object`, `embed`, `link`, `meta`, `base`, `form`.

Blocked tags are rendered as: `<div data-renderify-sanitized-tag="script"></div>`

This render-time tag sanitization applies to the declarative RuntimeNode path. `source.runtime: "preact"` renders through Preact directly and should be treated as trusted source output instead of relying on RuntimeNode tag sanitization.

### Attribute Sanitization

- **Event handlers** — valid declarative bindings such as
  `onClick: "increment"` or `onClick: { type: "increment", payload: {...} }`
  become delegated RuntimeEvents and never become HTML attributes or evaluated
  code. Malformed/lowercase `on*` values are rejected or stripped. IR,
  security, and runtime share `parseRuntimeEventBinding` so validation and
  rendering use the same grammar.
- **URL validation** — request-capable attributes such as `href`, `src`,
  `srcset`, `ping`, `action`, `poster`, legacy media attributes, and SVG
  functional IRIs reject active protocols and are checked against the security
  policy's network allowlist. The declarative renderer fails closed after
  template resolution: it emits only relative URLs plus `mailto:` and `tel:`
  on link attributes, so interpolated context or state cannot turn an
  attribute into a cross-origin request.
- **Style validation** — inline `style` values are checked for XSS patterns:
  - `expression()`
  - `javascript:`
  - `data:` (non-image)
  - `@import`
  - `url()` (blocked in render layer for defense-in-depth)
  - CSS escape obfuscation patterns
  - Null byte injection

### Link Safety

Links with `target="_blank"` automatically receive `rel="noopener noreferrer"` to prevent reverse tabnapping.

## Environment Variables

```bash
# Security profile
RENDERIFY_SECURITY_PROFILE=strict|balanced|trusted|relaxed

# Runtime manifest enforcement
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true|false

# Sandbox mode
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=none|worker|iframe|shadowrealm
RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS=4000
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true|false
```

## JSPM-Only Strict Mode Preset

For production deployments that require deterministic supplier boundaries, enable:

```bash
RENDERIFY_RUNTIME_JSPM_ONLY_STRICT_MODE=true
```

This preset enforces:

- security profile = `strict`
- module manifest required for bare specifiers
- integrity required for remote modules
- dependency preflight fail-fast
- fallback CDNs disabled (JSPM-only resolution path)

## Programmatic Usage

```ts
import { DefaultSecurityChecker } from "@renderify/security";
import type { RuntimePlan } from "@renderify/ir";

const checker = new DefaultSecurityChecker();
checker.initialize({ profile: "balanced" });

const plan: RuntimePlan = {
  /* ... */
};
const result = await checker.checkPlan(plan);

if (!result.safe) {
  console.error("Security issues:", result.issues);
  console.error("Diagnostics:", result.diagnostics);
}

// Check a single module specifier
const moduleCheck = checker.checkModuleSpecifier("https://evil.com/script.js");
console.log(moduleCheck.safe); // false
```

## Defense-in-Depth Layers

| Layer | Component       | Protection                                              |
| ----- | --------------- | ------------------------------------------------------- |
| 1     | Policy checker  | Validates plan structure, capabilities, modules, source |
| 2     | Runtime budgets | Enforces import count, execution time, component limits |
| 3     | Module resolver | Rejects Node.js builtins, file:// URLs, unknown schemes |
| 4     | Source analysis | Static pattern matching for dangerous APIs              |
| 5     | UI renderer     | XSS sanitization, attribute filtering, URL validation   |
| 6     | Sandbox         | Optional Worker/iframe isolation for untrusted source   |

## MCP Apps Offline Boundary

`@renderify/mcp-app` is intentionally narrower than the general runtime. It
accepts only explicit `runtime-plan/v1` element/text trees and rejects source,
component nodes, imports, module manifests, network hosts, storage, timers, and
non-standard execution profiles on both server and view sides.

The generated resource uses hashed inline scripts, no `unsafe-eval`, no script
`unsafe-inline`, no external MCP resource/connect/frame domains, and no browser
permissions. The official `PostMessageTransport` validates that messages come
from `window.parent`; app-to-server tool calls additionally require an exact
local allowlist and host capability.

These controls do not authorize server tools and cannot force a host to create
a strong outer iframe sandbox. See the
[architecture decision](adr/0001-offline-declarative-mcp-app-boundary.md) and
[threat model](threat-model.md) for the complete contract and residual risk.
