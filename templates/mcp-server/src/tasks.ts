import type { RuntimePlan } from "@renderify/ir";

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

/**
 * The task board as a declarative RuntimePlan. The form submits its named
 * `title` field to the `add_task` tool; each row's button sends its task id to
 * `complete_task`. Both tools return a new plan, which the view renders.
 */
export function buildTaskBoard(tasks: readonly Task[]): RuntimePlan {
  return {
    specVersion: "runtime-plan/v1",
    id: "renderify_task_board",
    version: 1,
    capabilities: { domWrite: true },
    state: {
      initial: { tasks: tasks.map((task) => ({ ...task })) },
    },
    root: {
      type: "element",
      tag: "section",
      props: {
        style:
          "font-family: system-ui, sans-serif; padding: 16px; max-width: 520px",
      },
      children: [
        {
          type: "element",
          tag: "h2",
          props: { style: "margin: 0 0 12px" },
          children: [{ type: "text", value: "Tasks" }],
        },
        {
          type: "element",
          tag: "form",
          props: {
            onSubmit: "tool:add_task",
            style: "display: flex; gap: 8px; margin-bottom: 12px",
          },
          children: [
            {
              type: "element",
              tag: "input",
              props: {
                name: "title",
                placeholder: "Add a task",
                "aria-label": "New task",
                style: "flex: 1; padding: 6px 8px",
              },
            },
            {
              type: "element",
              tag: "button",
              children: [{ type: "text", value: "Add" }],
            },
          ],
        },
        {
          type: "if",
          when: "state.tasks",
          not: true,
          children: [
            {
              type: "element",
              tag: "p",
              children: [{ type: "text", value: "Nothing left to do." }],
            },
          ],
        },
        {
          type: "element",
          tag: "ul",
          props: { style: "list-style: none; padding: 0; margin: 0" },
          children: [
            {
              type: "each",
              items: "state.tasks",
              as: "task",
              key: "id",
              children: [
                {
                  type: "element",
                  tag: "li",
                  props: {
                    style:
                      "display: flex; justify-content: space-between; padding: 6px 0",
                  },
                  children: [
                    {
                      type: "element",
                      tag: "span",
                      children: [{ type: "text", value: "{{task.title}}" }],
                    },
                    {
                      type: "if",
                      when: "task.done",
                      children: [{ type: "text", value: "Done" }],
                    },
                    {
                      type: "if",
                      when: "task.done",
                      not: true,
                      children: [
                        {
                          type: "element",
                          tag: "button",
                          props: {
                            type: "button",
                            onClick: {
                              type: "tool:complete_task",
                              payload: { id: "{{task.id}}" },
                            },
                          },
                          children: [{ type: "text", value: "Complete" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
