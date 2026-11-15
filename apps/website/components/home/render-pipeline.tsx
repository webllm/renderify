"use client";

import {
  Check,
  Code2,
  PenLine,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

const STEP_MS = 3600;

const STEPS = [
  {
    id: "produce",
    title: "Produce",
    chip: "LLM optional",
    body: "Authored code, your backend, or an optional LLM provider emits a RuntimePlan or a JSX/TSX module.",
  },
  {
    id: "validate",
    title: "Validate",
    chip: "runtime-plan/v1",
    body: "The RuntimePlan IR is normalized and checked: spec version, node tree, state transitions, and capabilities.",
  },
  {
    id: "enforce",
    title: "Enforce",
    chip: "security policy",
    body: "Policy runs before any code executes: blocked tags, module allowlists, tree depth limits, and execution budgets.",
  },
  {
    id: "execute",
    title: "Execute",
    chip: "Babel · JSPM",
    body: "Reviewed source is transpiled in the browser, and bare imports resolve through JSPM and are pinned into the moduleManifest.",
  },
  {
    id: "render",
    title: "Render",
    chip: "renderPlanInBrowser()",
    body: "Interactive UI mounts into your target element, and events dispatch declarative state transitions.",
  },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export function RenderPipeline() {
  const sectionRef = useRef<HTMLElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [inView, setInView] = useState(false);
  const [paused, setPaused] = useState(false);
  const [autoplay, setAutoplay] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      { threshold: 0.3 },
    );
    observer.observe(section);

    const pause = () => setPaused(true);
    const resume = () => setPaused(false);
    const resumeOnFocusOut = (event: FocusEvent) => {
      if (!section.contains(event.relatedTarget as Node | null)) {
        setPaused(false);
      }
    };
    section.addEventListener("pointerenter", pause);
    section.addEventListener("pointerleave", resume);
    section.addEventListener("focusin", pause);
    section.addEventListener("focusout", resumeOnFocusOut);
    setAutoplay(!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    return () => {
      observer.disconnect();
      section.removeEventListener("pointerenter", pause);
      section.removeEventListener("pointerleave", resume);
      section.removeEventListener("focusin", pause);
      section.removeEventListener("focusout", resumeOnFocusOut);
    };
  }, []);

  useEffect(() => {
    if (!autoplay || !inView || paused) {
      return;
    }
    const timer = setInterval(
      () => setActive((index) => (index + 1) % STEPS.length),
      STEP_MS,
    );
    return () => clearInterval(timer);
  }, [autoplay, inView, paused]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    const tilt = (event: PointerEvent) => {
      const bounds = scene.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      scene.style.setProperty(
        "--pipeline-tilt-x",
        `${(-y * 12).toFixed(2)}deg`,
      );
      scene.style.setProperty("--pipeline-tilt-z", `${(x * 16).toFixed(2)}deg`);
    };
    const reset = () => {
      scene.style.removeProperty("--pipeline-tilt-x");
      scene.style.removeProperty("--pipeline-tilt-z");
    };
    scene.addEventListener("pointermove", tilt);
    scene.addEventListener("pointerleave", reset);
    return () => {
      scene.removeEventListener("pointermove", tilt);
      scene.removeEventListener("pointerleave", reset);
    };
  }, []);

  return (
    <section
      aria-labelledby="pipeline-title"
      className="home-section"
      ref={sectionRef}
    >
      <div className="home-container">
        <header className="home-section-header home-reveal">
          <p className="home-eyebrow">How it works</p>
          <h2 id="pipeline-title">From plan to pixels in one runtime pass</h2>
          <p>
            Every render takes the same governed path. Policy runs before any
            code does, and nothing in the loop needs a build server or a deploy.
          </p>
        </header>

        <div className="pipeline">
          <ol className="pipeline-steps">
            {STEPS.map((step, index) => {
              const isActive = index === active;
              return (
                <li key={step.id}>
                  <button
                    aria-pressed={isActive}
                    className="pipeline-step"
                    data-active={isActive}
                    onClick={() => setActive(index)}
                    type="button"
                  >
                    <span className="pipeline-step-index">0{index + 1}</span>
                    <span className="pipeline-step-text">
                      <span className="pipeline-step-title">
                        {step.title}
                        <span className="pipeline-step-chip">{step.chip}</span>
                      </span>
                      <span className="pipeline-step-body">
                        <span>{step.body}</span>
                      </span>
                    </span>
                    {isActive && autoplay ? (
                      <span
                        className="pipeline-step-progress"
                        data-paused={paused || !inView}
                        key={active}
                        style={{ animationDuration: `${STEP_MS}ms` }}
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>

          <div
            aria-hidden="true"
            className="pipeline-scene"
            data-inview={inView}
            ref={sceneRef}
          >
            <div className="pipeline-stack">
              {STEPS.map((step, index) => (
                <div
                  className="pipeline-layer"
                  data-active={index === active}
                  key={step.id}
                  style={{ "--pipeline-index": index } as CSSProperties}
                >
                  <span className="pipeline-layer-label">
                    0{index + 1} · {step.title}
                  </span>
                  <LayerArt id={step.id} />
                </div>
              ))}
              <span className="pipeline-packet" />
              <span className="pipeline-packet" />
              <span className="pipeline-packet" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LayerArt({ id }: { id: StepId }) {
  switch (id) {
    case "produce":
      return (
        <div className="pipeline-art pipeline-art-produce">
          <span>
            <Sparkles size={13} /> LLM
          </span>
          <span>
            <Server size={13} /> Backend
          </span>
          <span>
            <PenLine size={13} /> Authored
          </span>
        </div>
      );
    case "validate":
      return (
        <pre className="pipeline-art pipeline-art-code">
          <span>{"{"}</span>
          {"\n  "}
          <b>"specVersion"</b>: <i>"runtime-plan/v1"</i>,{"\n  "}
          <b>"root"</b>: {"{ "}
          <b>"type"</b>: <i>"element"</i>
          {" },\n  "}
          <b>"state"</b>: {"{ "}
          <b>"initial"</b>: {"{ … } }\n"}
          <span>{"}"}</span>
        </pre>
      );
    case "enforce":
      return (
        <div className="pipeline-art pipeline-art-enforce">
          <ShieldCheck size={30} strokeWidth={1.6} />
          <div>
            {["strict", "balanced", "trusted", "relaxed"].map((profile) => (
              <span key={profile}>{profile}</span>
            ))}
          </div>
        </div>
      );
    case "execute":
      return (
        <div className="pipeline-art pipeline-art-execute">
          <span>
            <Code2 size={12} /> Babel
          </span>
          <i />
          <span>JSPM</span>
          <i />
          <span>manifest</span>
        </div>
      );
    case "render":
      return (
        <div className="pipeline-art pipeline-art-render">
          <div className="pipeline-art-window">
            <span />
            <span />
            <span />
          </div>
          <strong>3</strong>
          <div className="pipeline-art-buttons">
            <span>−1</span>
            <span>+1</span>
            <span>
              <Check size={11} />
            </span>
          </div>
        </div>
      );
  }
}
