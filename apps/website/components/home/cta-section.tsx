import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Logo3D } from "@/components/brand/logo-3d";

export function CtaSection() {
  return (
    <section
      aria-labelledby="cta-title"
      className="home-section home-cta-section"
    >
      <div className="home-container">
        <div className="home-cta home-reveal">
          <div aria-hidden="true" className="home-cta-floor" />
          <div className="home-cta-copy">
            <p className="home-eyebrow">Get started</p>
            <h2 id="cta-title">Start rendering in minutes</h2>
            <p>
              Install @renderify/react, hand it a RuntimePlan from your model,
              and render interactive UI in your app. No build server required.
            </p>
            <div className="home-hero-actions">
              <Link
                className="home-button home-button-primary"
                href="/docs/getting-started"
              >
                Get started
                <ArrowRight aria-hidden="true" size={17} />
              </Link>
              <Link
                className="home-button home-cta-secondary"
                href="/playground"
              >
                Open Playground
              </Link>
            </div>
          </div>
          <div className="home-cta-visual">
            <Logo3D />
          </div>
        </div>
      </div>
    </section>
  );
}
