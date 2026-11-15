import { highlight } from "fumadocs-core/highlight";
import type { ComponentProps } from "react";
import {
  COUNTER_PLAN_SOURCE,
  METRICS_JSX_SOURCE,
  playgroundHash,
} from "./lane-samples";
import { type Lane, LanesDemo } from "./lanes-demo";

/** Highlights at build time; the theme's own background is dropped. */
function highlightSample(code: string, lang: "json" | "jsx") {
  return highlight(code, {
    components: {
      pre: ({ style: _style, ...props }: ComponentProps<"pre">) => (
        <pre {...props} />
      ),
    },
    lang,
    theme: "tokyo-night",
  });
}

export async function LanesSection() {
  const [planCode, jsxCode] = await Promise.all([
    highlightSample(COUNTER_PLAN_SOURCE, "json"),
    highlightSample(METRICS_JSX_SOURCE, "jsx"),
  ]);

  const lanes: Lane[] = [
    {
      id: "plan",
      label: "RuntimePlan JSON",
      file: "counter.plan.json",
      title: "Declarative lane",
      summary:
        "Validated JSON describes the UI tree, state, and named transitions. Strict and balanced security profiles accept this lane and reject source modules.",
      code: planCode,
      playgroundHref: `/playground/${playgroundHash("plan", COUNTER_PLAN_SOURCE)}`,
    },
    {
      id: "jsx",
      label: "JSX / TSX",
      file: "App.jsx",
      title: "Trusted source lane",
      summary:
        "Reviewed React-compatible JSX is transpiled in the browser and its bare imports are pinned through JSPM. Use it for hooks and richer DOM events.",
      code: jsxCode,
      playgroundHref: `/playground/${playgroundHash("jsx", METRICS_JSX_SOURCE)}`,
    },
  ];

  return (
    <section aria-labelledby="lanes-title" className="home-section">
      <div className="home-container">
        <header className="home-section-header home-reveal">
          <p className="home-eyebrow">Two input lanes</p>
          <h2 id="lanes-title">
            Declarative when you can. Reviewed JSX when you need it.
          </h2>
          <p>
            Pick the lane per render. Both end in the same browser runtime, and
            both samples open in the Playground with one click.
          </p>
        </header>
        <LanesDemo lanes={lanes} />
      </div>
    </section>
  );
}
