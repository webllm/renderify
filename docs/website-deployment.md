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

Run the same primary gates used by deployment:

```bash
pnpm install --frozen-lockfile
pnpm website:typecheck
RENDERIFY_SITE_BASE_PATH=renderify pnpm website:build
```

`RENDERIFY_SITE_BASE_PATH` is a build-time value. For the repository project
site at `https://webllm.github.io/renderify/`, it must be `renderify` so static
assets, search, documentation links, and the Playground runtime all resolve
under `/renderify`.

For local root-path preview, omit the variable:

```bash
pnpm website:build
pnpm website:preview
```

## GitHub Pages setup

The repository administrator performs one one-time setting:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.

After that, pushes that change website, documentation, workflow, or relevant
runtime files trigger `.github/workflows/pages.yml`. The workflow builds with
the repository base path, uploads `apps/website/out`, and deploys through the
protected `github-pages` environment.

The workflow requests only the permissions required by GitHub Pages:

- `contents: read`;
- `pages: write`;
- `id-token: write`.

GitHub serializes deployments through the workflow concurrency group so a newer
push can replace an older in-progress site build.

## Verify a deployment

Check these routes after the Pages job completes:

- `/renderify/` — landing page;
- `/renderify/docs/` — documentation tree and static search;
- `/renderify/playground/` — isolated editor and renderer;
- `/renderify/api/search` — static FlexSearch data;
- `/renderify/sitemap.xml` and `/renderify/robots.txt` — crawler metadata.

For the Playground, run both bundled examples and verify more than visible HTML:

1. Material UI elements have computed component styles.
2. Adding, toggling, filtering, and deleting a Todo changes the UI.
3. RuntimePlan counter events update `{{state.count}}`.
4. Browser network logs contain module CDN requests but no model-provider API.

## Custom domain

If the site moves to a root custom domain, build with an empty base path and add
the domain to the Pages configuration. Keep `siteConfig.productionUrl`, sitemap,
Open Graph metadata, and the workflow build variable aligned with that domain.
