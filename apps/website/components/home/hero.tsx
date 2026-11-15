import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { InstallCommand } from "./install-command";
import { ParticleLogo } from "./particle-logo";

const STATS = [
  { value: "0", label: "build or deploy steps in the render path" },
  { value: "4", label: "security profiles enforced before execution" },
  { value: "10", label: "plugin hooks from prompt to render" },
  { value: "6", label: "built-in LLM providers, all optional" },
];

export function Hero() {
  return (
    <section aria-labelledby="home-hero-title" className="home-hero">
      <div aria-hidden="true" className="home-hero-backdrop" />

      <div className="home-container home-hero-layout">
        <div className="home-hero-copy">
          <Link className="home-badge" href="/docs">
            <span className="home-badge-pill">Open source</span>
            <span>
              Runtime-first
              <span className="home-badge-optional"> · Browser-native</span> ·
              LLM optional
            </span>
            <ArrowRight aria-hidden="true" size={14} />
          </Link>
          <h1 id="home-hero-title">
            Render plans and JSX{" "}
            <span className="renderify-gradient-text">
              at the moment you need them.
            </span>
          </h1>
          <p className="home-hero-lede">
            Renderify turns validated RuntimePlans or reviewed JSX/TSX modules
            into interactive browser UI—without adding an application build or
            deploy step to the render path.
          </p>
          <div className="home-hero-actions">
            <Link
              className="home-button home-button-primary"
              href="/playground"
            >
              Open Playground
              <ArrowRight aria-hidden="true" size={17} />
            </Link>
            <Link className="home-button home-button-secondary" href="/docs">
              Read the docs
            </Link>
          </div>
          <InstallCommand />
        </div>

        <div className="home-hero-visual">
          <ParticleLogo />
        </div>
      </div>

      <dl className="home-container home-stats">
        {STATS.map((stat) => (
          <div key={stat.label}>
            <dt>{stat.label}</dt>
            <dd className="renderify-gradient-text">{stat.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
