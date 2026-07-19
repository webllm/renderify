# Renderify website

The Fumadocs website and renderer-only Playground are statically exported for
GitHub Pages. No LLM provider or API key is used by this application.

```bash
pnpm website:dev
pnpm website:typecheck
pnpm website:build
```

Use `RENDERIFY_SITE_BASE_PATH=renderify` when building the project-site layout
used by GitHub Pages.
