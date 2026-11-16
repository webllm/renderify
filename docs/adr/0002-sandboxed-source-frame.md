---
title: ADR-0002 Sandboxed source frame
description: Run model-written source in an opaque-origin iframe owned by the SDK, including, when an MCP App opts in, inside its view.
---

# ADR-0002: Sandboxed source frame

## Context

Declarative RuntimePlans cover forms, lists, and conditions, but open-ended
requests ("a chart with this npm library", "a kanban board with drag and drop")
need model-written JSX or TSX. Until now the only way to run that source
interactively was the `trusted` profile, which executes it in the host page
with the host's privileges. Static source scanning is not an isolation
boundary.

The website Playground already ran source in a `sandbox="allow-scripts"`
iframe with a restrictive CSP and a MessagePort protocol. Hosts asked for the
same isolation without copying the Playground's code. Two weaknesses had to be
fixed on the way: the Playground runner accepted a connection from any window
that could post to it, and a synchronous infinite loop could freeze the host,
because many browsers run an opaque-origin iframe on the embedding page's
thread, where no watchdog timer can fire.

## Decision

Ship `@renderify/frame` as the supported way to run untrusted source and plans
in a browser. A frame MUST:

- be an `<iframe sandbox="allow-scripts">` without `allow-same-origin` or any
  other sandbox token, so content has an opaque origin and cannot read the host
  DOM, cookies, or storage, submit forms, open popups, or navigate the top
  window;
- load its document from `srcdoc` with a CSP of `default-src 'none'`, scripts
  only from the runner's origin, the configured module CDNs, and `blob:`,
  network access only to those CDNs, and no frames, workers, `<base>`, or form
  submission;
- load the runner script pinned by version with Subresource Integrity by
  default, and allow hosts to self-host it;
- connect over one transferred `MessagePort`; the runner accepts the connect
  message only from `window.parent` and only once, and the host never listens
  to `window` message events;
- validate every message in both directions with bounded sizes, and deliver a
  rendered action to the host only when its type is on an allowlist;
- add a time check to every synchronous loop at transpile time, and destroy
  and recreate the iframe when a render exceeds the host's watchdog; and
- accept theme changes only as CSS custom properties and a color scheme.

## Options considered

### Trusted in-page source

Kept for reviewed code and demos, rejected for model output. Code runs with
the host page's origin and can read anything the page can.

### Web Worker sandbox

Kept for computation (`sandbox-worker`), rejected for interactive UI. Workers
have no DOM, so React or Preact components cannot mount there.

### Dedicated sandbox origin

Stronger: an iframe `src` on a separate site gets its own process in browsers
with site isolation, so even a loop the guard misses cannot block the host.
Deferred because it requires every host to operate an extra origin. The
protocol does not depend on `srcdoc`, so this can be added as an option later.

### Opaque-origin `srcdoc` frame

Accepted. It needs no extra infrastructure, and with loop guards and the
watchdog it recovers from the failure modes generated code commonly hits.

## MCP source mode

`@renderify/mcp-app` renders model-written source only for apps registered with
`sourceMode: true`. It is off by default, and apps that do not opt in keep the
offline declarative contract of ADR-0001 unchanged (see its amendment).

- Source never runs in the view's own window. There it could post JSON-RPC to
  the host as the view, bypassing the tool allowlist; that design stays
  rejected.
- The view renders source in a nested `@renderify/frame`. The host bridge
  accepts messages only from the view's window and the view's bridge only from
  the host, so content in the nested frame can address neither. Its only way
  out is `window.renderify.action("tool:<name>", args)`, which the view maps to
  `callServerTool` when `<name>` is in `allowedTools`.
- The view must not fetch scripts, so the runner (about 2.6 MB) travels inside
  the resource as a non-executing `<script type="text/plain">` block. The view
  copies it into the frame document, and the view's CSP allows exactly that
  script by SHA-256 hash.
- A `srcdoc` frame inherits the view's CSP, so source mode widens the view's
  CSP only by what the frame needs: the runner's hash, `blob:` for transpiled
  modules, and the module CDNs for scripts, styles, and connections, plus
  `blob:` images. There is still no `unsafe-eval` and no script
  `unsafe-inline`, and frames and workers stay `'none'`. The CDNs are declared
  in `_meta.ui.csp` (`connectDomains` and `resourceDomains`), so a host sees
  the wider surface before it renders anything and can refuse it.
- Source payloads are `{ source: { code, language, runtime } }`, 256 KiB by
  default. Servers refuse to return them from apps without source mode, and
  views without it reject them.
- A source view's state stays in the frame. The model context only records
  that a source view is showing, which replaces the previous plan's state;
  tools called through allowlisted actions carry what the server needs.

Verification: browser tests drive the view with the official `AppBridge`
under both the shell's CSP and the CSP the ext-apps reference host
(`examples/basic-host`) sends, which includes `frame-src 'none'`. Chromium does
not apply `frame-src` to the `srcdoc` frame, the runner boots from the inlined
copy, spoofed JSON-RPC from the frame reaches neither the host nor the view,
and only allowlisted actions call tools. Source mode has not yet been verified
on production hosts. A host whose CSP omits `blob:` from `script-src`, blocks
`srcdoc` frames, or caps resource size below the runner will not render source
views; the view then shows an error, and plans keep working.

## Consequences

- Hosts get a small host API and a self-hostable runner (about 2.6 MB with
  Babel and the runtime). The first render of an npm-heavy component depends
  on module CDN latency.
- Rendered code can still mislead users inside its rectangle, and it can leak
  data it was given through module CDN request URLs. Hosts must not pass
  secrets into a frame.
- Work that blocks without a loop, such as one enormous synchronous call, is
  not interrupted by the loop guard; in browsers that share the host's thread
  with the frame, the watchdog cannot fire until it returns.

## Follow-up

- Add a dedicated sandbox origin option.
- Verify MCP source mode on production hosts and record per-host results,
  including resource size limits.
- Provide framework bindings (for example a React `<RenderifyFrame>`).

## Supersedes / Superseded by

None. Complements ADR-0001.
