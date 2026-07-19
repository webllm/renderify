# Renderify website

The Fumadocs website and renderer-only Playground are statically exported for
GitHub Pages. No LLM provider or API key is used by this application.

Documentation is sourced from the repository-level `docs/` directory. The
Playground runner is generated into `public/playground-runtime.js` by the
`predev` and `prebuild` scripts; that generated bundle is intentionally ignored.

```bash
pnpm website:dev
pnpm website:typecheck
pnpm website:build
```

Use `RENDERIFY_SITE_BASE_PATH=renderify` when building the project-site layout
used by GitHub Pages.

See [`docs/website-playground.md`](../../docs/website-playground.md) for the
runtime boundary and [`docs/website-deployment.md`](../../docs/website-deployment.md)
for the Pages workflow.
