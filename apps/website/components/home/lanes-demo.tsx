"use client";

import { ArrowUpRight, FileCode2, FileJson } from "lucide-react";
import Link from "next/link";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { METRICS, type MetricName } from "./lane-samples";

export interface Lane {
  id: "plan" | "jsx";
  label: string;
  file: string;
  title: string;
  summary: string;
  code: ReactNode;
  playgroundHref: string;
}

export function LanesDemo({ lanes }: { lanes: Lane[] }) {
  const [activeId, setActiveId] = useState<Lane["id"]>(lanes[0]?.id ?? "plan");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectByOffset = (event: KeyboardEvent, index: number) => {
    const offset =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!offset) {
      return;
    }
    event.preventDefault();
    const next = (index + offset + lanes.length) % lanes.length;
    setActiveId(lanes[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="lanes">
      <div aria-label="Input lane" className="lanes-tabs" role="tablist">
        {lanes.map((lane, index) => {
          const selected = lane.id === activeId;
          return (
            <button
              aria-controls={`lane-panel-${lane.id}`}
              aria-selected={selected}
              className="lanes-tab"
              id={`lane-tab-${lane.id}`}
              key={lane.id}
              onClick={() => setActiveId(lane.id)}
              onKeyDown={(event) => selectByOffset(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              {lane.id === "plan" ? (
                <FileJson aria-hidden="true" size={16} />
              ) : (
                <FileCode2 aria-hidden="true" size={16} />
              )}
              {lane.label}
            </button>
          );
        })}
      </div>

      {lanes.map((lane) => (
        <div
          aria-labelledby={`lane-tab-${lane.id}`}
          className="lanes-panel"
          hidden={lane.id !== activeId}
          id={`lane-panel-${lane.id}`}
          key={lane.id}
          role="tabpanel"
        >
          <div className="lanes-code">
            <div className="lanes-code-header">
              <span aria-hidden="true" className="lanes-dots">
                <span />
                <span />
                <span />
              </span>
              <span>{lane.file}</span>
            </div>
            <div className="lanes-code-body not-fumadocs-codeblock">
              {lane.code}
            </div>
          </div>

          <div className="lanes-side">
            <TiltFrame>
              <div className="lanes-browser">
                <div className="lanes-browser-bar">
                  <span aria-hidden="true" className="lanes-dots">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="lanes-browser-url">preview</span>
                </div>
                <div className="lanes-browser-body">
                  {lane.id === "plan" ? <CounterPreview /> : <MetricsPreview />}
                </div>
              </div>
            </TiltFrame>
            <div className="lanes-copy">
              <h3>{lane.title}</h3>
              <p>{lane.summary}</p>
              <Link className="lanes-link" href={lane.playgroundHref}>
                Render this sample in the Playground
                <ArrowUpRight aria-hidden="true" size={16} />
              </Link>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Tilts its child toward the pointer in 3D. */
function TiltFrame({ children }: { children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (
      !frame ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      const bounds = frame.getBoundingClientRect();
      const x = (event.clientX - bounds.left) / bounds.width - 0.5;
      const y = (event.clientY - bounds.top) / bounds.height - 0.5;
      frame.style.setProperty("--lanes-tilt-x", `${(-y * 9).toFixed(2)}deg`);
      frame.style.setProperty("--lanes-tilt-y", `${(x * 11).toFixed(2)}deg`);
      frame.style.setProperty(
        "--lanes-glare-x",
        `${((x + 0.5) * 100).toFixed(1)}%`,
      );
      frame.style.setProperty(
        "--lanes-glare-y",
        `${((y + 0.5) * 100).toFixed(1)}%`,
      );
    };
    const reset = () => {
      for (const property of [
        "--lanes-tilt-x",
        "--lanes-tilt-y",
        "--lanes-glare-x",
        "--lanes-glare-y",
      ]) {
        frame.style.removeProperty(property);
      }
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerleave", reset);
    return () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerleave", reset);
    };
  }, []);

  return (
    <div className="lanes-tilt" ref={frameRef}>
      {children}
    </div>
  );
}

/** Mirrors COUNTER_PLAN: state.count with increment and reset transitions. */
function CounterPreview() {
  const [count, setCount] = useState(0);
  return (
    <div className="preview-counter">
      <section>
        <p>Clicks</p>
        <strong aria-live="polite">{count}</strong>
        <div>
          <button
            className="preview-primary"
            onClick={() => setCount((value) => value + 1)}
            type="button"
          >
            +1
          </button>
          <button onClick={() => setCount(0)} type="button">
            Reset
          </button>
        </div>
      </section>
      <code className="preview-state">
        <span>state</span> {JSON.stringify({ count })}
      </code>
    </div>
  );
}

/** Mirrors METRICS_JSX_SOURCE: a metric toggle driving a bar chart. */
function MetricsPreview() {
  const [metric, setMetric] = useState<MetricName>("Revenue");
  const values = METRICS[metric];
  const max = Math.max(...values);
  const names = Object.keys(METRICS) as MetricName[];

  return (
    <div className="preview-metrics">
      <h4>Weekly {metric.toLowerCase()}</h4>
      <div className="preview-metrics-tabs">
        {names.map((name) => (
          <button
            aria-pressed={name === metric}
            key={name}
            onClick={() => setMetric(name)}
            type="button"
          >
            {name}
          </button>
        ))}
      </div>
      <div aria-hidden="true" className="preview-metrics-bars">
        {values.map((value, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length series.
            key={index}
            style={{ height: `${(value / max) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}
