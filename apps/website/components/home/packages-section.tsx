import { ArrowUpRight } from "lucide-react";

const PACKAGES = [
  {
    name: "renderify",
    role: "SDK",
    body: "The recommended entry point: an app factory, one-shot helpers, and re-exports of the core, runtime, and provider APIs.",
    featured: true,
  },
  {
    name: "@renderify/react",
    role: "React",
    body: "RenderifyView for validated plans, RenderifyFrame for sandboxed model-written JSX, and the useRenderifySession hook.",
  },
  {
    name: "@renderify/ir",
    role: "Contracts",
    body: "The RuntimePlan schema, node, state, and action types, guards, and shared constants.",
  },
  {
    name: "@renderify/runtime",
    role: "Execution",
    body: "Executes plans and source modules, resolves JSPM imports, and renders to HTML or browser targets.",
  },
  {
    name: "@renderify/frame",
    role: "Sandbox",
    body: "An opaque-origin iframe for model-written JSX/TSX with a strict CSP, an action allowlist, loop guards, and a watchdog.",
  },
  {
    name: "@renderify/security",
    role: "Policy",
    body: "Validates plans, capabilities, module sources, and runtime source before anything executes.",
  },
  {
    name: "@renderify/core",
    role: "Orchestration",
    body: "Wires config, LLM, code generation, policy, runtime, and UI rendering together through RenderifyApp.",
  },
  {
    name: "@renderify/llm",
    role: "Providers",
    body: "OpenAI, OpenAI Codex, Anthropic, Google, Ollama, and LM Studio interpreters, plus a provider registry.",
  },
  {
    name: "@renderify/cli",
    role: "Tooling",
    body: "Run prompts, inspect RuntimePlan JSON, probe dependencies, execute plan files, and open the playground.",
  },
  {
    name: "@renderify/mcp-app",
    role: "Integration",
    body: "An offline, declarative RuntimePlan adapter that serves a self-contained ui:// resource for MCP Apps.",
  },
];

export function PackagesSection() {
  return (
    <section aria-labelledby="packages-title" className="home-section">
      <div className="home-container">
        <header className="home-section-header home-reveal">
          <p className="home-eyebrow">Packages</p>
          <h2 id="packages-title">Composable by design</h2>
          <p>
            Start with the SDK, or assemble only the layers you need. Every
            package is published to npm under the MIT license.
          </p>
        </header>

        <ul className="packages-grid">
          {PACKAGES.map((pkg) => (
            <li className="home-reveal" key={pkg.name}>
              <a
                className="package-card"
                data-featured={pkg.featured ? "true" : undefined}
                href={`https://www.npmjs.com/package/${pkg.name}`}
                rel="noreferrer"
                target="_blank"
              >
                <span className="package-role">{pkg.role}</span>
                <span className="package-name">
                  {pkg.name}
                  <ArrowUpRight aria-hidden="true" size={15} />
                </span>
                <span className="package-body">{pkg.body}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
