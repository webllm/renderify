import type { RuntimePlan } from "@renderify/ir";

/**
 * A purely declarative KPI dashboard RuntimePlan — no source, no imports.
 *
 * This is the "Tier A" generative payload: it renders fully offline inside the
 * MCP Apps sandboxed iframe under a strict CSP. In a real server the model would
 * emit this (or a richer TSX source plan); here we synthesize it deterministically
 * so the demo runs with no network and no API key.
 */
export interface DashboardInput {
  title?: string;
  kpis?: Array<{ label: string; value: string; delta?: string }>;
}

const DEFAULT_KPIS = [
  { label: "Revenue", value: "$48.2k", delta: "+12%" },
  { label: "Active users", value: "3,914", delta: "+4%" },
  { label: "Churn", value: "1.8%", delta: "-0.3%" },
];

function card(kpi: { label: string; value: string; delta?: string }) {
  return {
    type: "element" as const,
    tag: "div",
    props: {
      style:
        "flex:1;min-width:140px;padding:14px;border:1px solid #d8e1ec;border-radius:12px;background:#fff",
    },
    children: [
      {
        type: "element" as const,
        tag: "div",
        props: { style: "font-size:12px;color:#5d6f86" },
        children: [{ type: "text" as const, value: kpi.label }],
      },
      {
        type: "element" as const,
        tag: "div",
        props: { style: "font-size:24px;font-weight:700;color:#152339" },
        children: [{ type: "text" as const, value: kpi.value }],
      },
      ...(kpi.delta
        ? [
            {
              type: "element" as const,
              tag: "div",
              props: {
                style: `font-size:12px;color:${
                  kpi.delta.startsWith("-") ? "#b00020" : "#0f766e"
                }`,
              },
              children: [{ type: "text" as const, value: kpi.delta }],
            },
          ]
        : []),
    ],
  };
}

export function buildDashboardPlan(input: DashboardInput = {}): RuntimePlan {
  const kpis = input.kpis ?? DEFAULT_KPIS;
  const title = input.title ?? "Analytics overview";
  return {
    specVersion: "runtime-plan/v1",
    id: "renderify-mcp-dashboard",
    version: 1,
    capabilities: { domWrite: true },
    root: {
      type: "element",
      tag: "div",
      props: {
        style:
          "font-family:system-ui,sans-serif;color:#152339;display:flex;flex-direction:column;gap:12px",
      },
      children: [
        {
          type: "element",
          tag: "h2",
          props: { style: "margin:0;font-size:18px" },
          children: [{ type: "text", value: title }],
        },
        {
          type: "element",
          tag: "div",
          props: { style: "display:flex;gap:12px;flex-wrap:wrap" },
          children: kpis.map(card),
        },
      ],
    },
  };
}
