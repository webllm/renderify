---
title: Website deployment
description: Build the static Fumadocs website and deploy it to the repository's GitHub Pages environment.
---

# Website deployment

The documentation and renderer-only Playground live in `apps/website`. The app
uses Fumadocs for navigation, MDX rendering, table of contents, and static
FlexSearch. Next.js exports the complete site to `apps/website/out`; there is no
Node.js server in production.

## Local validation

To run the website CI checks locally:

```bash
pnpm install --frozen-lockfile
pnpm website:typecheck
RENDERIFY_SITE_BASE_PATH=renderify pnpm website:build
RENDERIFY_SITE_BASE_PATH=renderify pnpm website:smoke
```

`website:smoke` serves the export under the base path, with GitHub Pages'
`404.html` behavior, and checks the home page, a docs page, the 404 page, and
an interaction inside the sandboxed Playground. It blocks external requests,
so it needs no network. CI runs these three steps on every pull request.

`RENDERIFY_SITE_BASE_PATH` is a build-time value. For the repository project
site at `https://webllm.github.io/renderify/`, it must be `renderify` so static
assets, search, documentation links, and the Playground runtime all resolve
under `/renderify`.

For local root-path preview, omit the variable:

```bash
pnpm website:build
pnpm website:preview
```

## Deploy from your local checkout

From the repository root, with dependencies installed and Git write access to
`origin`, run:

```bash
pnpm run deploy
```

The command type-checks the website, builds the current working tree for
`/renderify/`, and publishes `apps/website/out` to the `gh-pages` branch on
`origin`. Local edits are included in the build. Only the static export is
committed to the publishing branch.

The first run creates `gh-pages`. In **Settings → Pages → Build and deployment**,
choose **Deploy from a branch**, select **gh-pages** and **/(root)**, then save.
Subsequent releases only need `pnpm run deploy`.

## Verify a deployment

Check these routes after the Pages job completes:

- `/renderify/` — landing page;
- `/renderify/docs/` — documentation tree and static search;
- `/renderify/playground/` — isolated editor and renderer;
- `/renderify/api/search` — static FlexSearch data;
- `/renderify/sitemap.xml` and `/renderify/robots.txt` — crawler metadata;
- `/renderify/opengraph-image.jpg` — social card referenced by `og:image`.

For the Playground, run both bundled examples and verify more than visible HTML:

1. Material UI elements have computed component styles.
2. Adding, toggling, filtering, and deleting a Todo changes the UI.
3. RuntimePlan counter events update `{{state.count}}`.
4. Browser network logs contain module CDN requests but no model-provider API.

## Custom domain

If the site moves to a root custom domain, build with an empty base path and add
the domain to the Pages configuration. Keep `siteConfig.productionUrl`, sitemap,
Open Graph metadata, and the base path in the root `deploy` script aligned with
that domain.
