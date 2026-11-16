# Renderify MCP server template

An MCP server whose tools return interactive UIs. Hosts that support
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) render the task
board in a sandboxed view; other hosts receive the text summary.

- `show_tasks` returns a declarative RuntimePlan and links it to a UI resource.
- The board's form submits its `title` field to `add_task`, and each row's
  button sends its task id to `complete_task`. The view may call only those
  two tools (`allowedTools`), and both return an updated plan.
- No code runs in the view: plans are validated JSON, and the view rejects
  source, remote modules, network URLs, and timers.

## Run

```bash
pnpm install
pnpm start          # speaks MCP over stdio
```

Inspect it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector pnpm start
```

To use it from a desktop host, add a stdio server that runs
`pnpm --dir /path/to/this/folder start`.

## Copying this template

Inside the Renderify repository the `@renderify/*` dependencies use
`workspace:^`. In your own project, replace them with the published version,
for example `"@renderify/mcp-app": "^0.11.0"`.

## Next steps

- Persist tasks and check the caller's identity in each tool handler.
- Change `buildTaskBoard` in `src/tasks.ts`; the
  [RuntimePlan IR reference](https://github.com/webllm/renderify/blob/main/docs/runtime-plan-ir.md)
  covers lists, conditions, forms, and events.
