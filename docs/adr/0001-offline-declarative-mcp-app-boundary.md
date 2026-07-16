## Context

An MCP App view receives data selected by a model and runs in a host-managed
iframe. A handwritten JSON-RPC bridge is easy to make subtly incompatible, and
allowing Renderify source or CDN modules would make host CSP behavior part of
the execution contract.

The adapter must be useful without claiming that source scanning or a host's
optional sandbox behavior is a complete code-execution boundary.

## Decision

The first `@renderify/mcp-app` release MUST:

- use `@modelcontextprotocol/ext-apps` for view and server protocol behavior;
- ship one self-contained, hash-CSP HTML resource;
- accept only offline `runtime-plan/v1` element/text trees;
- validate the plan on server and view sides;
- deny app-to-tool calls unless the exact tool is configured; and
- keep source, component modules, imports, external domains, timers, storage,
  and alternate execution profiles outside the contract.

## Options considered

### Handwritten protocol bridge

Rejected. It duplicates initialization, notification, request/response,
capability, source-validation, and teardown behavior already maintained by the
official SDK. Protocol-shaped mocks can hide incompatibilities.

### Declarative and arbitrary source in one package

Rejected for the initial release. Source execution requires a materially wider
CSP and a stronger isolation story. Static banned-pattern scans are not a hard
boundary for arbitrary JavaScript.

### Declarative shell with optional CDN mode

Rejected for the initial release. Optional external domains weaken portability
and make a server configuration change alter the trust boundary.

### Offline declarative-only shell

Accepted. It preserves local state and structured interactivity while keeping
code and network out of untrusted tool results.

## Consequences

- Hosts receive a deterministic resource with no external origins.
- Server authors cannot use React/Preact component modules through this adapter.
- Interactive server actions require explicit tool allowlisting and normal
  server authorization.
- Protocol upgrades largely follow the official dependency, but dependency
  updates still require conformance tests.
- A future source-capable tier is a separate security decision, not a flag added
  to this one.

## Risks

- The official SDK and Renderify runtime are part of the trusted computing base.
- Declarative UI can still mislead users or cause repeated local work.
- Model-context and tool arguments remain attacker-influenced data.
- Hosts may implement weaker iframe policies than the test host; the package
  cannot enforce the outer sandbox.

## Follow-up

- Maintain the official-bridge browser conformance test.
- Keep dependency and threat-model docs synchronized with any accepted surface
  change.
- Require a new ADR before adding source execution or external domains.

## Supersedes / Superseded by

None.
