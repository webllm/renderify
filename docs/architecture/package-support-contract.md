# Package Support Contract

Renderify's "any package from JSPM" promise is implemented as a compatibility
contract with explicit tiers, not as an unlimited guarantee.

## Support Tiers

1. **Tier A - Guaranteed**
   - Runtime compatibility aliases and pinned overrides that are part of the
     core runtime contract.
   - Examples: `preact`, `preact/hooks`, `preact/compat`,
     `react`/`react-dom` (`preact/compat` bridge), `recharts`.
2. **Tier B - Best-effort Browser ESM**
   - Pure ESM browser packages resolved through JSPM CDN, without Node builtin
     dependencies.
   - Examples: `lodash-es`, `date-fns`, `@mui/material`.
3. **Tier C - Unsupported**
   - Node.js builtin modules and unsupported schemes.
   - Examples: `node:fs`, `fs`, `child_process`, `file://...`, `jsr:...`.

## Runtime Enforcement

`JspmModuleLoader.resolveSpecifier` now fails fast for unsupported input:

- rejects Node.js builtin modules with a deterministic error
- rejects unsupported module schemes (`file:`, `jsr:`, etc.)
- keeps explicit overrides for Tier A packages
- resolves Tier B packages to `https://ga.jspm.io/npm:<specifier>`

This prevents silent fallback behavior and makes failures observable early in
`probePlan` and runtime diagnostics.

## CI Verification

Compatibility expectations are verified in unit CI via:

- `tests/runtime-jspm.test.ts`
  - validates Tier A pinned mappings
  - validates Tier B resolution prefixes
  - validates Tier C deterministic rejection

Because unit tests run in Node 22/24 CI matrix, this contract is continuously
checked across supported runtime environments.
