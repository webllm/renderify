# Renderify Threat Model

> Status: living document. It describes what Renderify defends, where the trust
> boundaries are, and — critically — which defenses are **hard boundaries** versus
> **best-effort hints**. Renderify executes untrusted, model-generated code, so an
> honest account of its limits is part of the product. If you are evaluating
> Renderify for a security-sensitive deployment, read the "Guarantee levels" and
> "Residual risk" sections before the feature list.

Related:

- [`docs/security.md`](security.md) — the operational policy/profile reference.
- [`SECURITY.md`](../SECURITY.md) — vulnerability disclosure.
- [`tests/escape-corpus.fixtures.ts`](../tests/escape-corpus.fixtures.ts) — the
  attack corpus that pins these boundaries as regression tests.
- [`docs/mcp-apps.md`](mcp-apps.md) — the MCP Apps embedding boundary + CSP findings.

## 1. What Renderify is

Renderify takes UI descriptions produced by an LLM — either a structured
`RuntimePlan` (declarative IR) or raw TSX/JSX source — runs them through a
security policy, and renders the result in the browser with no backend build
step. Dependencies for source modules are resolved at runtime via JSPM/CDN.

The security-relevant fact: **the input is attacker-controlled.** A model can be
prompted (directly or via prompt injection upstream) to emit hostile code. The
question this document answers is "when that happens, what stops it, and what
doesn't."

## 2. Assets

| Asset                              | Why it matters                                                    |
| ---------------------------------- | ----------------------------------------------------------------- |
| Host page DOM, cookies, storage    | XSS / data theft if generated UI escapes its boundary.            |
| Host-origin network & credentials  | SSRF / exfiltration if generated code can make arbitrary requests. |
| End-user data shown in the UI      | Confidentiality of whatever the app feeds the plan/state.         |
| The user's session & clipboard     | Targets of UI-redress, tabnabbing, clipboard hijack.              |
| Supply chain integrity             | A swapped CDN module can run arbitrary code with the same rights. |
| Availability                       | Deep trees / hot loops / huge sources as a local DoS.             |

## 3. Trust boundaries

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │ TRUSTED: host application + Renderify TCB                            │
 │  - the embedding page, its origin, its real secrets                 │
 │  - @renderify/security policy engine  ← trusted to be correct       │
 │  - @renderify/runtime executor + UI renderer                        │
 │  - the shell document & bridge (when using @renderify/mcp-app)      │
 ├─────────────────────────────────────────────────────────────────────┤
 │ SEMI-TRUSTED: module supply chain (JSPM / CDNs)                      │
 │  - ga.jspm.io, cdn.jspm.io, optional esm.sh/unpkg/jsdelivr          │
 │  - pinned + integrity-checkable, but third-party availability/code  │
 ├─────────────────────────────────────────────────────────────────────┤
 │ UNTRUSTED: everything the model emits                               │
 │  - RuntimePlan structure, state paths, capability requests          │
 │  - TSX/JSX source, its imports, inline styles, attribute values     │
 └─────────────────────────────────────────────────────────────────────┘
```

The Trusted Computing Base (TCB) is the policy engine, the runtime executor, the
UI renderer, and (for MCP Apps) the shell document and its bridge. A bug in any
of these is a real vulnerability. Everything the model produces is outside the
boundary and assumed hostile.

## 4. Attacker model

We assume the attacker controls the **entire** model output and wants to:

1. Execute script in the host origin (XSS) — steal cookies/tokens, act as the user.
2. Exfiltrate data to an attacker-controlled endpoint (SSRF / beacon).
3. Pull and run attacker code from an unexpected origin (supply-chain pivot).
4. Pollute prototypes / corrupt host state to escalate within the page.
5. Redress / phish the user (overlay, fake dialogs, tabnabbing, clipboard).
6. Deny service (CPU/memory exhaustion).

We do **not** defend against: a malicious host application; a compromised JSPM/CDN
serving a backdoored *but integrity-matching* module if you disabled integrity; a
browser 0-day that defeats iframe sandboxing or CSP; or the model leaking secrets
that the host itself placed into the plan/state.

## 5. Defense layers and their guarantee level

Renderify is defense-in-depth, but the layers are **not** equally strong. Be
precise about which is which.

| # | Layer | Mechanism | Guarantee level |
| - | ----- | --------- | --------------- |
| 1 | Plan policy | structural validation, capability budgets, blocked tags, state-path safety, tree/size limits | **Hard** for the structural checks it performs (e.g. `blockedTags`, `isSafePath`, depth/size). These are exact. |
| 2 | Module allowlist | scheme + host matching against `allowedNetworkHosts`; rejects builtins, traversal, lookalike hosts | **Hard** for resolution-time fetches that go through the loader. |
| 3 | Module manifest + integrity | pinned URLs + optional SRI (`requireModuleIntegrity` in strict) | **Hard** when integrity is required; pins what code actually loads. |
| 4 | Source banned-pattern scan | regex list (`eval(`, `fetch(`, `WebSocket`, `localStorage`, …) | **Best-effort / hint only.** Trivially bypassed by computed access (`g['fe'+'tch']`). NOT a boundary. |
| 5 | UI renderer sanitization | strips `on*`, rejects `javascript:`/`data:` URLs, screens inline styles, neutralizes blocked tags | **Hard** for the declarative RuntimeNode render path. Does NOT cover `source.runtime:"preact"` output (which renders through Preact directly). |
| 6 | Execution sandbox | optional Worker / iframe / ShadowRealm isolation + global hardening; fail-closed | **Hard** when enabled and when the host CSP cooperates (see §7). This is the real containment for code the static scanner can't reason about. |

### The load-bearing point

Layer 4 (the banned-pattern scan) is the one most likely to be **mistaken** for a
boundary. It is not. `tests/escape-corpus.fixtures.ts` includes
`obfuscated-fetch` and `obfuscated-eval` samples that pass the policy layer on
purpose — the regression test asserts they pass, documenting in code that static
analysis cannot stop computed property access. **The actual containment for
hostile source is the sandbox (layer 6) plus the embedding CSP.** If you run
untrusted model output, you must enable a sandbox execution profile and/or embed
under a CSP that forbids arbitrary network and `'unsafe-eval'`.

## 6. Residual risk by security profile

| Profile | Intended use | Residual risk |
| ------- | ------------ | ------------- |
| `strict` | multi-tenant / externally-facing | Lowest. Manifest + integrity required, JSPM-only egress, preact source disabled, tight budgets. Residual: regex-evadable source patterns (mitigate with a sandbox profile); supply-chain trust in JSPM. |
| `balanced` (default) | typical app | Integrity not required; source patterns still regex-evadable. Treat generated source as needing a sandbox. |
| `trusted` | reviewed source needing JSX/hooks/packages | Allows `source.runtime:"preact"`, which renders through Preact and **bypasses the layer-5 render sanitizer**. Only use for source you have reviewed or sandboxed. |
| `relaxed` | internal tools / dev | Inline handlers, dynamic imports, arbitrary network, extra CDNs allowed. Effectively "trusted code only". Do not point at untrusted model output. |

## 7. The MCP Apps embedding boundary

When embedded via [`@renderify/mcp-app`](mcp-apps.md), Renderify runs inside the
host's **sandboxed iframe** with a host-enforced **CSP**. This is the strongest
deployment posture and the recommended one for untrusted output, because the
iframe origin isolation and CSP are browser-enforced hard boundaries independent
of Renderify's own correctness.

Validated in `tests/e2e/mcp-csp-feasibility.test.ts` (real Chromium):

- **Declarative plans render fully offline** under a strict, hash-based CSP
  (`default-src 'none'`, no `'unsafe-inline'`, `connect-src 'none'`): zero
  network egress, zero CSP violations. Nothing the plan contains can phone home.
- **`script-src blob:` is load-bearing** for any tier that executes transpiled
  source: blob-URL module import is browser-refused without it. A host that
  forbids `blob:` confines Renderify to the declarative tier — which is a safe
  failure mode, not an escape.

Implication: the generative tiers that need module CDNs are exactly the tiers a
host CSP can (and may) restrict. Prefer the self-contained, offline tier for
untrusted output; reserve declared-domain module fetching for trusted contexts.

## 8. Known accepted risks

- **Regex source scanning is evadable.** Accepted; mitigated by sandbox + CSP.
  Tracked by the escape corpus so it can't be silently "trusted" later.
- **`source.runtime:"preact"` bypasses the render sanitizer.** Accepted for
  `trusted`/`relaxed` only; gated off in `strict`/`balanced`.
- **Supply-chain trust in JSPM/CDN.** Mitigated by pinning + optional SRI;
  residual trust remains unless integrity is required and pins are reviewed.
- **No third-party security audit yet.** Accepted and disclosed. The escape
  corpus + CSP feasibility tests are the current evidence base; an external audit
  is the planned next step before recommending Renderify for high-risk,
  multi-tenant production use.

## 9. Reporting

See [`SECURITY.md`](../SECURITY.md). Sandbox escapes, prototype-pollution paths,
render-sanitizer bypasses, and host-matcher bypasses are the highest-severity
classes; please include a minimal RuntimePlan or source that reproduces.
