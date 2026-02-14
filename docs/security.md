# Security Guide

Renderify enforces a security-first execution model. Every RuntimePlan passes through a policy checker **before any code runs**. This is critical because LLM output is fundamentally untrusted — the model could generate script tags, eval calls, or unsafe network requests.

## Security Profiles

Three built-in profiles provide graduated security postures:

### Strict

Tight limits, full integrity enforcement. Best for production, multi-tenant, and externally-facing deployments.

```bash
RENDERIFY_SECURITY_PROFILE=strict
```

| Policy | Value |
|--------|-------|
| Blocked tags | script, iframe, object, embed, link, meta |
| Max tree depth | 8 |
| Max node count | 250 |
| Inline event handlers | Disabled |
| Max imports | 80 |
| Max execution time | 5,000 ms |
| Max component invocations | 120 |
| Max source size | 20,000 bytes |
| Max source imports | 30 |
| Module manifest required | Yes (for bare specifiers) |
| Module integrity required | Yes |
| Spec version required | Yes |
| Dynamic imports in source | Disabled |
| Allowed network hosts | ga.jspm.io, cdn.jspm.io |
| Arbitrary network | Disabled |

**Banned source patterns (strict):** `eval()`, `new Function()`, `fetch()`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `document.cookie`, `localStorage`, `sessionStorage`, `indexedDB`, `navigator.sendBeacon`, `child_process`, `process.env`

### Balanced (Default)

Moderate limits suitable for most applications. Relaxes integrity requirements while maintaining code safety.

```bash
RENDERIFY_SECURITY_PROFILE=balanced
```

| Policy | Value |
|--------|-------|
| Blocked tags | script, iframe, object, embed, link, meta |
| Max tree depth | 12 |
| Max node count | 500 |
| Inline event handlers | Disabled |
| Max imports | 200 |
| Max execution time | 15,000 ms |
| Max component invocations | 500 |
| Max source size | 80,000 bytes |
| Max source imports | 120 |
| Module manifest required | Yes (for bare specifiers) |
| Module integrity required | No |
| Spec version required | Yes |
| Dynamic imports in source | Disabled |
| Allowed network hosts | ga.jspm.io, cdn.jspm.io |
| Arbitrary network | Disabled |

**Banned source patterns (balanced):** `eval()`, `new Function()`, `fetch()`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `document.cookie`, `localStorage`, `sessionStorage`, `child_process`

### Relaxed

Permissive limits for trusted environments, internal tools, and development.

```bash
RENDERIFY_SECURITY_PROFILE=relaxed
```

| Policy | Value |
|--------|-------|
| Blocked tags | script, iframe, object, embed |
| Max tree depth | 24 |
| Max node count | 2,000 |
| Inline event handlers | Allowed |
| Max imports | 1,000 |
| Max execution time | 60,000 ms |
| Max component invocations | 4,000 |
| Max source size | 200,000 bytes |
| Max source imports | 500 |
| Module manifest required | No |
| Module integrity required | No |
| Spec version required | No |
| Dynamic imports in source | Allowed |
| Allowed network hosts | ga.jspm.io, cdn.jspm.io, esm.sh, unpkg.com |
| Arbitrary network | Allowed |

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
  allowedExecutionProfiles: Array<"standard" | "isolated-vm" | "sandbox-worker" | "sandbox-iframe">;
  maxTransitionsPerPlan: number;
  maxActionsPerTransition: number;
  maxAllowedImports: number;
  maxAllowedExecutionMs: number;
  maxAllowedComponentInvocations: number;
  allowRuntimeSourceModules: boolean;
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

The UI renderer also provides a second layer of tag sanitization, converting blocked tags to `<div data-renderify-sanitized-tag="script"></div>`.

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
    "maxImports": 500,        // Checked against policy maxAllowedImports
    "maxExecutionMs": 30000,  // Checked against policy maxAllowedExecutionMs
    "maxComponentInvocations": 1000
  }
}
```

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
      "integrity": "sha384-abc123..."  // Required in strict mode
    }
  }
}
```

Missing manifest entries for bare specifiers or missing integrity hashes for remote modules generate policy violations.

## UI Renderer Security

The UI renderer provides additional XSS protection beyond the policy checker (including light DOM + shadow DOM subtree sanitization):

### Blocked Tags at Render Time

Even if a tag passes the policy check, the renderer blocks: `script`, `style`, `iframe`, `object`, `embed`, `link`, `meta`, `base`, `form`.

Blocked tags are rendered as: `<div data-renderify-sanitized-tag="script"></div>`

### Attribute Sanitization

- **Event handlers** — `on*` attributes are stripped (converted to runtime event bindings instead)
- **URL validation** — `href` and `src` attributes reject `javascript:` and `data:` protocols
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
RENDERIFY_SECURITY_PROFILE=strict|balanced|relaxed

# Runtime manifest enforcement
RENDERIFY_RUNTIME_ENFORCE_MANIFEST=true|false

# Sandbox mode
RENDERIFY_RUNTIME_BROWSER_SANDBOX_MODE=none|worker|iframe
RENDERIFY_RUNTIME_BROWSER_SANDBOX_TIMEOUT_MS=4000
RENDERIFY_RUNTIME_BROWSER_SANDBOX_FAIL_CLOSED=true|false
```

## Programmatic Usage

```ts
import { DefaultSecurityChecker } from "@renderify/security";
import type { RuntimePlan } from "@renderify/ir";

const checker = new DefaultSecurityChecker();
checker.initialize({ profile: "balanced" });

const plan: RuntimePlan = { /* ... */ };
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

| Layer | Component | Protection |
|-------|-----------|------------|
| 1 | Policy checker | Validates plan structure, capabilities, modules, source |
| 2 | Runtime budgets | Enforces import count, execution time, component limits |
| 3 | Module resolver | Rejects Node.js builtins, file:// URLs, unknown schemes |
| 4 | Source analysis | Static pattern matching for dangerous APIs |
| 5 | UI renderer | XSS sanitization, attribute filtering, URL validation |
| 6 | Sandbox | Optional Worker/iframe isolation for untrusted source |
