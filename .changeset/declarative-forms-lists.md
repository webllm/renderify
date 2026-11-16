---
"@renderify/ir": minor
"@renderify/runtime": minor
"@renderify/security": minor
"@renderify/core": minor
"@renderify/llm": minor
"@renderify/mcp-app": minor
---

Declarative plans can now build real forms and lists without source code.

- New `each` and `if` RuntimeNodes repeat or conditionally render children, with loop variables (`{{todo.title}}`, `{{index}}`), item keys, and a 10,000-node expansion cap.
- `bind` keeps an input, textarea, or select in sync with a state path; events from form controls carry their live value in `event.payload.value`; `onEnter` fires on Enter in a field.
- `form` nodes render as inert containers with emulated submit: `onSubmit` receives the form's named fields. Password and file inputs are never captured.
- New `remove` action, array-aware paths (`todos.2.done`), whole-segment path templates (`todos.{{event.payload.index}}.done`), and `{"$from"}` references at any depth in action values and event payloads, resolved when the event is handled.
- MCP Apps pass those resolved payloads as tool arguments and debounce model-context updates from bound inputs.
- The shared LLM schema, repair diagnostics, and system prompts teach models the new vocabulary.
