# Security Policy

Renderify executes untrusted, LLM-generated UI code in the browser. We take that
responsibility seriously and welcome reports from security researchers.

Before reporting, the two documents that describe what Renderify does and does
not defend against:

- [Threat model](docs/threat-model.md) — trust boundaries, guarantee levels
  (hard boundary vs best-effort), and known accepted risks.
- [Security guide](docs/security.md) — profiles, policy object, and the
  defense-in-depth layers.

## Supported versions

Renderify is pre-1.0 and ships from a single release line. Security fixes land on
the latest published `0.x` minor; please verify against the latest release before
reporting.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | ✅ |
| older `0.x`  | ❌ (please upgrade) |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub Security Advisories:
<https://github.com/webllm/renderify/security/advisories/new>

If that is unavailable to you, open a minimal **public** issue that says only
"security report — request private channel" with no exploit details, and we will
follow up to establish a private channel.

Please include:

- A minimal reproduction: the smallest `RuntimePlan` or TSX/JSX source that
  triggers the issue, plus the security profile in effect.
- The impact you can demonstrate (XSS in host origin, data exfiltration, sandbox
  escape, prototype pollution, render-sanitizer bypass, host-matcher bypass, DoS).
- Environment: Renderify version, browser/runtime, and embedding mode
  (direct embed vs `@renderify/mcp-app` shell, and the CSP if known).

## Highest-severity classes

These map to the hard boundaries in the [threat model](docs/threat-model.md);
bypasses of them are prioritized:

1. **Sandbox escape** — code in a sandbox profile reaching host globals/network.
2. **Render-sanitizer bypass** — `javascript:`/`data:` URLs, `on*` handlers,
   `expression()`/`url()` styles, or blocked tags surviving the declarative
   render path.
3. **Host-matcher bypass** — a module specifier resolving to a non-allowlisted
   origin (e.g. a lookalike host that slips past `allowedNetworkHosts`).
4. **Prototype pollution** — a state path or plan field mutating `__proto__` /
   `prototype` / `constructor`.
5. **Policy engine correctness** — any input that should be rejected by a hard
   check (`blockedTags`, depth/size, capability budgets) but is not.

Note: that the regex-based **source banned-pattern scan is bypassable** is a
documented limitation, not a vulnerability — see
[`tests/escape-corpus.fixtures.ts`](tests/escape-corpus.fixtures.ts). Reports of
novel obfuscations are still welcome as test cases, but the real boundary for
hostile source is the sandbox + CSP.

## Disclosure

We aim to acknowledge reports within 5 business days and to ship a fix or
mitigation for confirmed high-severity issues before coordinated public
disclosure. We are happy to credit reporters in the advisory unless you prefer to
remain anonymous.

## Response expectations (pre-1.0, single-maintainer)

Renderify is currently maintained by a small team without a dedicated on-call
security rotation or a third-party audit. We are transparent about this: the
current evidence base is the in-repo escape corpus and CSP feasibility tests, and
an external audit is a planned milestone. For high-risk, multi-tenant production
use today, deploy behind the strongest posture (strict profile + sandbox profile
+ a restrictive embedding CSP) and treat all model output as hostile.
