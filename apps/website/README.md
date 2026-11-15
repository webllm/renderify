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

## Landing page

`app/(home)/page.tsx` composes the sections in `components/home/`:

- the hero, whose interactive 3D logo is a dependency-free WebGL point cloud
  sampled from the logo bitmap (`particle-logo-engine.ts`). Without WebGL the
  static logo stays in place, and reduced-motion users get a still logo;
- an exploded CSS 3D view of the render pipeline;
- the two-lane demo, whose samples (`lane-samples.ts`) deep-link into the
  Playground with the same `#plan64=` / `#jsx64=` hash it already accepts;
- the feature grid, package overview, and call to action, which uses the
  extruded `components/brand/logo-3d.tsx`.

Autoplay and ambient animation stop under `prefers-reduced-motion`; only
pointer-driven effects remain.

## Brand assets

The repository-level `logo.png` is the source of truth. The theme palette in
`styles/theme.css` is sampled from it, and the derived images are committed:

| Output | Used for |
| --- | --- |
| `assets/brand/renderify-logo.webp` | Hero, 3D logo, particle sampling |
| `assets/brand/renderify-mark.webp` | Navigation and footer mark |
| `app/icon.png`, `app/apple-icon.png` | Favicon and Apple touch icon |
| `app/opengraph-image.jpg` | Open Graph and Twitter card |

Regenerate them after changing the logo. The script renders in Chromium
through Playwright; pass `--chromium` when Playwright's bundled browser is not
installed:

```bash
pnpm --filter @renderify/website brand:assets
pnpm --filter @renderify/website brand:assets -- --chromium /path/to/chrome
```

See [`docs/website-playground.md`](../../docs/website-playground.md) for the
runtime boundary and [`docs/website-deployment.md`](../../docs/website-deployment.md)
for the Pages workflow.
