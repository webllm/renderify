import {
  AppWindow,
  ArrowRight,
  Package,
  Plug,
  Radio,
  ShieldCheck,
  Workflow,
  Zap,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { SpotlightGrid } from "./spotlight-grid";

const HOOKS = [
  "beforeLLM",
  "afterLLM",
  "beforeCodeGen",
  "afterCodeGen",
  "beforePolicyCheck",
  "afterPolicyCheck",
  "beforeRuntime",
  "afterRuntime",
  "beforeRender",
  "afterRender",
];

// The marquee renders the list twice so the loop is seamless.
const HOOK_MARQUEE = [
  ...HOOKS.map((hook) => ({ hook, key: hook })),
  ...HOOKS.map((hook) => ({ hook, key: `${hook}-repeat` })),
];

const AGENT_STACKS = [
  "Vercel AI SDK",
  "CopilotKit",
  "assistant-ui",
  "AG-UI",
  "MCP Apps",
];

interface Feature {
  title: string;
  body: string;
  href: string;
  icon: ReactNode;
  visual: ReactNode;
  size?: "wide" | "wide-lg";
}

const FEATURES: Feature[] = [
  {
    title: "Zero-build rendering",
    body: "Generated JSX/TSX is transpiled in the browser with @babel/standalone and its imports resolve through JSPM. No backend compiler, no deploy step, no server round-trip.",
    href: "/docs/runtime-execution",
    icon: <Zap size={18} />,
    size: "wide",
    visual: (
      <pre className="feature-code">
        <i>import</i> {"{ renderPlanInBrowser }"} <i>from</i> <b>"renderify"</b>
        ;{"\n\n"}
        <i>await</i> renderPlanInBrowser(plan, {"{ target: "}
        <b>"#mount"</b>
        {" });"}
      </pre>
    ),
  },
  {
    title: "Security-first execution",
    body: "Every plan passes a policy check before any code runs: blocked tags, module allowlists, tree depth limits, and execution budgets.",
    href: "/docs/security",
    icon: <ShieldCheck size={18} />,
    visual: (
      <div className="feature-pills">
        <span>strict</span>
        <span data-active="true">balanced · default</span>
        <span>trusted</span>
        <span>relaxed</span>
      </div>
    ),
  },
  {
    title: "JSPM packages, pinned",
    body: "Bare imports resolve through JSPM and are pinned into the moduleManifest before execution, under an explicit tiered compatibility contract.",
    href: "/docs/runtime-execution#module-loading",
    icon: <Package size={18} />,
    visual: (
      <div className="feature-manifest">
        <code>"date-fns/format"</code>
        <ArrowRight aria-hidden="true" size={14} />
        <code>ga.jspm.io/npm:date-fns@4.1.0/format.js</code>
      </div>
    ),
  },
  {
    title: "Streaming-first",
    body: "renderPromptStream emits llm-delta, preview, and final chunks, so chat interfaces can render progressively as a model responds.",
    href: "/docs/llm-integration#3-streaming-generation",
    icon: <Radio size={18} />,
    visual: (
      <div className="feature-stream">
        <span>llm-delta</span>
        <span>preview</span>
        <span>final</span>
      </div>
    ),
  },
  {
    title: "Fits your agent stack",
    body: "Render plans returned by Vercel AI SDK, CopilotKit, assistant-ui, AG-UI, or MCP tools, or by your own code. The renderer never requires an LLM.",
    href: "/docs/integrations",
    icon: <Workflow size={18} />,
    visual: (
      <div className="feature-pills feature-pills-compact">
        {AGENT_STACKS.map((stack) => (
          <span key={stack}>{stack}</span>
        ))}
        <span data-active="true">or your code</span>
      </div>
    ),
  },
  {
    title: "Pluggable at every stage",
    body: "Ten hook points let you inject custom logic across the pipeline without forking the core.",
    href: "/docs/plugin-system",
    icon: <Plug size={18} />,
    visual: (
      <div className="feature-marquee">
        <div>
          {HOOK_MARQUEE.map(({ hook, key }) => (
            <code key={key}>{hook}</code>
          ))}
        </div>
      </div>
    ),
  },
  {
    title: "MCP Apps adapter",
    body: "@renderify/mcp-app serves a self-contained ui:// resource for offline declarative RuntimePlans, with official protocol lifecycle handling and a strict no-source, no-network boundary.",
    href: "/docs/architecture/mcp-app-runtime-modules",
    icon: <AppWindow size={18} />,
    size: "wide-lg",
    visual: (
      <div className="feature-mcp">
        <span>MCP host</span>
        <i aria-hidden="true" />
        <span>
          ui:// resource
          <small>structuredContent.renderify.plan</small>
        </span>
        <div>
          <em>no source</em>
          <em>no network</em>
        </div>
      </div>
    ),
  },
];

export function FeatureGrid() {
  return (
    <section aria-labelledby="features-title" className="home-section">
      <div className="home-container">
        <header className="home-section-header home-reveal">
          <p className="home-eyebrow">Why Renderify</p>
          <h2 id="features-title">
            Everything between generated code and interactive UI
          </h2>
          <p>
            A small, security-governed runtime with explicit contracts at every
            boundary, from module resolution to the trust lane a plan runs in.
          </p>
        </header>

        <SpotlightGrid className="feature-grid">
          {FEATURES.map((feature) => (
            <Link
              className="feature-card home-reveal"
              data-size={feature.size}
              data-spotlight=""
              href={feature.href}
              key={feature.title}
            >
              <span aria-hidden="true" className="feature-icon">
                {feature.icon}
              </span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <div aria-hidden="true" className="feature-visual">
                {feature.visual}
              </div>
              <span className="feature-more">
                Learn more
                <ArrowRight aria-hidden="true" size={15} />
              </span>
            </Link>
          ))}
        </SpotlightGrid>
      </div>
    </section>
  );
}
