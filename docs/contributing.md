# Contributing Guide

This guide covers the development workflow, conventions, and tooling for contributing to Renderify.

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 10.29.3

The `preinstall` script enforces pnpm usage. Running `npm install` or `yarn install` will error.

## Setup

```bash
git clone https://github.com/unadlib/renderify.git
cd renderify
pnpm install
```

## Monorepo Structure

```
renderify/
├── packages/
│   ├── ir/           # @renderify/ir — Intermediate representation
│   ├── runtime/      # @renderify/runtime — Execution engine
│   ├── security/     # @renderify/security — Security policies
│   ├── core/         # @renderify/core — Orchestration facade
│   ├── llm/          # @renderify/llm — LLM providers
│   └── cli/          # @renderify/cli — CLI and playground
├── tests/            # Unit, integration, e2e, and benchmark tests
├── examples/         # Browser and runtime examples
├── scripts/          # Build and CI helper scripts
└── docs/             # Documentation
```

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development mode (preconstruct dev)
pnpm dev

# Start the playground
pnpm playground

# Type checking
pnpm typecheck

# Linting (biome)
pnpm lint

# Auto-format
pnpm format

# Unit tests
pnpm unit

# Compatibility tests (JSPM module resolution)
pnpm compat

# End-to-end tests (Playwright-based)
pnpm e2e

# Benchmarks
pnpm bench

# All quality gates (typecheck + unit)
pnpm test

# Full test suite (typecheck + unit + e2e)
pnpm test:all

# Build all packages
pnpm build

# Validate package metadata
pnpm validate

# Clean build artifacts
pnpm clean
```

## Package Dependencies

The dependency graph must be respected when making changes:

```
ir (no internal deps)
  ↑
security (depends on ir)
  ↑
runtime (depends on ir, security)
  ↑
core (depends on ir, security, runtime)
  ↑
llm (depends on core, ir)
  ↑
cli (depends on core, ir, llm, security, runtime)
```

Changes to `@renderify/ir` may affect all packages. Changes to `@renderify/cli` affect nothing downstream.

## Build System

### Turbo

The monorepo uses [Turborepo](https://turbo.build) for task orchestration with caching. Task dependencies are defined in `turbo.json`:

- `build` depends on all packages being valid
- `unit` depends on `typecheck`
- `e2e` depends on `build` (no caching)
- `bench` depends on `typecheck` (no caching)

### Preconstruct

[Preconstruct](https://preconstruct.tools) manages package builds:

- Generates CommonJS and ESM outputs (UMD only for packages that declare `umd:main`)
- Handles TypeScript declaration files
- Validates package.json entry points

```bash
pnpm dev       # Link source files for development
pnpm build     # Production build
pnpm validate  # Check package metadata
```

### TypeScript

TypeScript project references are used for incremental compilation:

- `tsconfig.base.json` — shared compiler options
- `tsconfig.build.json` — references all package tsconfigs
- `tsconfig.tests.json` — test-specific configuration
- Each package has its own `tsconfig.json`

## Code Quality

### Biome

[Biome](https://biomejs.dev) handles both linting and formatting:

```bash
pnpm lint          # Check for lint issues
pnpm format        # Auto-format all files
pnpm format:check  # Check formatting without writing
```

Configuration is in `biome.jsonc`.

### Pre-commit Hooks

Husky runs lint-staged on pre-commit:

```bash
# Automatically runs on commit:
biome check --write --files-ignore-unknown=true --no-errors-on-unmatched
```

### Conventional Commits

The project uses [Conventional Commits](https://www.conventionalcommits.org/) via Commitizen:

```bash
pnpm commit  # Interactive commit message builder
```

Commit types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `ci`, `build`, `style`.

## Testing

### Unit Tests

Tests use Node.js built-in test runner with `tsx`:

```bash
pnpm unit
```

Test files are in `tests/*.test.ts`. Key test areas:

| File | Coverage |
|------|----------|
| `core.test.ts` | RenderifyApp orchestration, streaming, abort |
| `ir.test.ts` | Node types, validation, path utilities, hashing |
| `runtime.test.ts` | Execution, modules, sandboxing, preflight |
| `security.test.ts` | Policy profiles, tag blocking, source analysis |
| `codegen.test.ts` | Plan generation, TSX extraction, streaming |
| `config.test.ts` | Environment variables, defaults |
| `llm.test.ts` | OpenAI, Anthropic, Google providers |
| `ui.test.ts` | HTML rendering, XSS protection |
| `runtime-utils.test.ts` | Budget enforcement, template interpolation |
| `runtime-jspm.test.ts` | Module resolution, compatibility |

### E2E Tests

End-to-end tests use Playwright for browser testing:

```bash
pnpm e2e
```

E2E tests cover:
- CLI commands (render-plan, probe-plan, plan)
- Playground API endpoints
- LLM provider integration (with fake servers)
- Hash deep-link loading in the browser

### Benchmarks

```bash
pnpm bench
```

Benchmarks use [tinybench](https://github.com/tinylibs/tinybench) and measure:
- Code generation throughput
- Plan execution performance
- Compilation speed

Results are output as Markdown tables. In CI, JSON artifacts are uploaded for tracking.

## Release Process

Renderify uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing.

### Adding a Changeset

When your PR changes package behavior or API:

```bash
pnpm changeset
```

This creates a markdown file in `.changeset/` describing the change and affected packages. CI enforces that package changes include a changeset entry.

### Version and Publish

```bash
# Apply version bumps and update changelogs
pnpm version-packages

# Publish to npm
pnpm release
```

Release automation runs on `main` via GitHub Actions. The release workflow either opens a version PR (if changesets are pending) or publishes to npm with provenance.

## CI Pipeline

The CI workflow (`.github/workflows/ci.yml`) runs on every push and PR:

1. **Lint** — code quality checks
2. **Typecheck** — TypeScript validation (Node 22 + 24 matrix)
3. **Unit tests** — all test suites (Node 22 + 24 matrix)
4. **Compatibility tests** — JSPM module resolution
5. **Build** — package validation and build
6. **E2E tests** — full integration tests
7. **Benchmarks** — performance measurement with artifact upload

Concurrency is controlled per-branch to cancel in-progress runs on new pushes.

## Adding a New Package

1. Create the package directory in `packages/`
2. Add `package.json` with proper entry points and dependencies
3. Add `tsconfig.json` referencing `tsconfig.base.json`
4. Add the reference to `tsconfig.build.json`
5. Run `pnpm dev` to link the package
6. Add tests in `tests/`

## Guidelines

- **Keep packages focused** — each package has a single responsibility
- **Test thoroughly** — aim for comprehensive coverage of happy paths and edge cases
- **Validate security** — any code that handles untrusted input must go through security checks
- **Use TypeScript strictly** — enable strict mode, use explicit types for public APIs
- **Follow existing patterns** — look at existing packages for conventions
- **Document public APIs** — exported types and functions should be self-documenting
- **Avoid breaking changes** — use changesets to communicate API changes
