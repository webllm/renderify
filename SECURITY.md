# Security policy

Renderify renders dynamic UI and includes trusted-source runtime modes. Review
the [threat model](docs/threat-model.md) and
[security guide](docs/security.md) before using it with untrusted input.

## Supported versions

Security fixes target the latest published pre-1.0 release line. Reproduce a
report against the latest release or the current `main` branch when possible.
Older `0.x` releases may require upgrading rather than a backport.

## Report a vulnerability

Do not publish exploit details in a GitHub issue. Use a private
[GitHub Security Advisory](https://github.com/webllm/renderify/security/advisories/new).
If that channel is unavailable, open an issue containing only a request for a
private contact channel.

Include:

- the smallest reproducing `RuntimePlan`, source, or MCP result;
- Renderify/package version, browser and operating system;
- security profile and runtime execution profile;
- direct embed or MCP App mode, including iframe sandbox/CSP when relevant; and
- demonstrated impact and any required user interaction.

## High-impact classes

- Runtime source or module execution through the declarative MCP boundary.
- Sandbox, CSP, or postMessage source-validation bypass.
- Declarative renderer XSS or active-URL bypass.
- Module host/integrity policy bypass.
- Prototype pollution through state/action paths.
- Tool allowlist bypass that reaches an MCP server tool.
- Resource exhaustion that bypasses documented limits.

Source banned-pattern matching is documented as best-effort, not a complete
JavaScript security boundary. A report is most actionable when it demonstrates
impact beyond a novel spelling that bypasses a regex.

## Disclosure

The project will coordinate scope, remediation, release, and credit through the
private advisory. No response-time or fix-time guarantee is made by this
repository; avoid public disclosure until coordination is complete.
