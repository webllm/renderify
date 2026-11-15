/**
 * Landing-page samples for the two input lanes. The previews in
 * lanes-demo.tsx mirror these sources; keep copy, data, and colors in sync.
 * Both samples are deep-linked into the Playground, which renders them with
 * the real runtime.
 */

export const COUNTER_PLAN = {
  specVersion: "runtime-plan/v1",
  id: "home_counter",
  version: 1,
  capabilities: { domWrite: true },
  state: {
    initial: { count: 0 },
    transitions: {
      increment: [{ type: "increment", path: "count", by: 1 }],
      reset: [{ type: "set", path: "count", value: 0 }],
    },
  },
  root: {
    type: "element",
    tag: "main",
    props: {
      style: {
        display: "grid",
        placeItems: "center",
        minHeight: "100vh",
        margin: 0,
        fontFamily: "system-ui, sans-serif",
        background: "#f4f6ff",
      },
    },
    children: [
      {
        type: "element",
        tag: "section",
        props: {
          style: {
            padding: "28px 36px",
            borderRadius: 22,
            background: "#ffffff",
            boxShadow: "0 24px 60px rgba(11, 92, 250, 0.16)",
            textAlign: "center",
          },
        },
        children: [
          {
            type: "element",
            tag: "p",
            props: {
              style: { margin: 0, color: "#0b5cfa", fontWeight: 700 },
            },
            children: [{ type: "text", value: "Clicks" }],
          },
          {
            type: "element",
            tag: "h1",
            props: { style: { margin: "6px 0 18px", fontSize: 56 } },
            children: [{ type: "text", value: "{{state.count}}" }],
          },
          {
            type: "element",
            tag: "button",
            props: {
              onClick: "increment",
              style: {
                marginRight: 8,
                padding: "10px 18px",
                border: 0,
                borderRadius: 10,
                background: "#0b5cfa",
                color: "#ffffff",
                fontWeight: 700,
              },
            },
            children: [{ type: "text", value: "+1" }],
          },
          {
            type: "element",
            tag: "button",
            props: {
              onClick: "reset",
              style: {
                padding: "10px 16px",
                border: "1px solid #d0d5dd",
                borderRadius: 10,
                background: "#ffffff",
              },
            },
            children: [{ type: "text", value: "Reset" }],
          },
        ],
      },
    ],
  },
};

export const COUNTER_PLAN_SOURCE = formatJson(COUNTER_PLAN);

export const METRICS = {
  Revenue: [42, 58, 51, 74, 69, 88],
  Users: [24, 31, 45, 39, 52, 61],
  Latency: [80, 64, 58, 49, 44, 38],
} as const;

export type MetricName = keyof typeof METRICS;

export const METRICS_JSX_SOURCE = `import { useState } from "react";

const DATA = {
  Revenue: [${METRICS.Revenue.join(", ")}],
  Users: [${METRICS.Users.join(", ")}],
  Latency: [${METRICS.Latency.join(", ")}],
};

export default function App() {
  const [metric, setMetric] = useState("Revenue");
  const values = DATA[metric];
  const max = Math.max(...values);

  return (
    <main style={{ padding: 28, fontFamily: "system-ui, sans-serif" }}>
      <h2 style={{ margin: 0 }}>Weekly {metric.toLowerCase()}</h2>
      <div style={{ display: "flex", gap: 8, margin: "16px 0 24px" }}>
        {Object.keys(DATA).map((name) => (
          <button
            key={name}
            onClick={() => setMetric(name)}
            style={{
              padding: "6px 14px",
              border: 0,
              borderRadius: 999,
              background: name === metric ? "#0b5cfa" : "#eef2ff",
              color: name === metric ? "#ffffff" : "#1e293b",
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 150 }}>
        {values.map((value, index) => (
          <div
            key={index}
            style={{
              flex: 1,
              height: \`\${(value / max) * 100}%\`,
              borderRadius: 8,
              background: "linear-gradient(#00d4fb, #0b5cfa 55%, #8a2bf9)",
              transition: "height 300ms ease",
            }}
          />
        ))}
      </div>
    </main>
  );
}
`;

/** Builds a Playground deep link; the Playground decodes the same format. */
export function playgroundHash(mode: "jsx" | "plan", code: string): string {
  return `#${mode}64=${Buffer.from(code, "utf8").toString("base64url")}`;
}

/**
 * JSON.stringify with Prettier-like wrapping: containers that fit within the
 * line width stay on one line, which keeps RuntimePlans readable.
 */
function formatJson(
  value: unknown,
  indent = 0,
  column = indent,
  width = 72,
): string {
  const inline = JSON.stringify(value, null, 1)
    .replace(/\[\n\s*/g, "[")
    .replace(/\{\n\s*/g, "{ ")
    .replace(/\n\s*\]/g, "]")
    .replace(/\n\s*\}/g, " }")
    .replace(/,\n\s*/g, ", ");
  if (
    value === null ||
    typeof value !== "object" ||
    column + inline.length <= width
  ) {
    return inline;
  }

  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  if (Array.isArray(value)) {
    const items = value.map(
      (item) => `${pad}${formatJson(item, indent + 2, indent + 2, width)}`,
    );
    return `[\n${items.join(",\n")}\n${close}]`;
  }
  const entries = Object.entries(value).map(([key, item]) => {
    const prefix = `${pad}${JSON.stringify(key)}: `;
    return `${prefix}${formatJson(item, indent + 2, prefix.length, width)}`;
  });
  return `{\n${entries.join(",\n")}\n${close}}`;
}
