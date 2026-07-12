import type { RuntimePlan } from "@renderify/ir";

export interface DashboardPlanInput {
  title: string;
  activeUsers: number;
}

export function buildDashboardPlan(input: DashboardPlanInput): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id: "mcp_dashboard",
    version: 1,
    capabilities: { domWrite: true },
    state: {
      initial: { refreshes: 0 },
      transitions: {
        refresh: [{ type: "increment", path: "refreshes", by: 1 }],
      },
    },
    root: {
      type: "element",
      tag: "section",
      props: {
        style:
          "display:grid;gap:12px;padding:16px;border:1px solid #d0d5dd;border-radius:12px",
      },
      children: [
        {
          type: "element",
          tag: "h2",
          props: { style: "margin:0" },
          children: [{ type: "text", value: input.title }],
        },
        {
          type: "element",
          tag: "p",
          children: [
            { type: "text", value: `Active users: ${input.activeUsers}` },
          ],
        },
        {
          type: "element",
          tag: "p",
          children: [
            { type: "text", value: "Local refreshes: {{state.refreshes}}" },
          ],
        },
        {
          type: "element",
          tag: "button",
          props: {
            type: "button",
            onClick: "refresh",
            style:
              "width:max-content;padding:8px 12px;border:1px solid #98a2b3;border-radius:8px",
          },
          children: [{ type: "text", value: "Refresh locally" }],
        },
      ],
    },
  };
}
