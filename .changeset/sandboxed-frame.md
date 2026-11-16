---
"@renderify/frame": minor
---

New package: `@renderify/frame` runs model-written JSX, TSX, and RuntimePlans in an opaque-origin `sandbox="allow-scripts"` iframe with a strict CSP, a parent-only MessagePort handshake, an action allowlist, transpile-time loop guards, a render watchdog that replaces hung frames, auto-sizing, theme variables, and an SRI-pinned runner, which `runnerSource` can inline where the frame must not fetch scripts. The website Playground now uses it.
