export type PlaygroundMode = "jsx" | "plan";

export interface PlaygroundSample {
  id: string;
  label: string;
  mode: PlaygroundMode;
  code: string;
}

export const MUI_TODO_SOURCE = `import { useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Container,
  CssBaseline,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

const FILTERS = ["全部", "未完成", "已完成"];

export default function App() {
  const [todos, setTodos] = useState([
    { id: 1, text: "验证 Material UI 样式", done: true },
    { id: 2, text: "测试 Todo 交互", done: false },
  ]);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState("全部");

  const visibleTodos = useMemo(() => {
    if (filter === "未完成") return todos.filter((todo) => !todo.done);
    if (filter === "已完成") return todos.filter((todo) => todo.done);
    return todos;
  }, [filter, todos]);

  const addTodo = () => {
    const text = input.trim();
    if (!text) return;
    setTodos((current) => [
      { id: Date.now(), text, done: false },
      ...current,
    ]);
    setInput("");
  };

  const toggleTodo = (id) => {
    setTodos((current) =>
      current.map((todo) =>
        todo.id === id ? { ...todo, done: !todo.done } : todo,
      ),
    );
  };

  const removeTodo = (id) => {
    setTodos((current) => current.filter((todo) => todo.id !== id));
  };

  const completed = todos.filter((todo) => todo.done).length;

  return (
    <>
      <CssBaseline />
      <Box sx={{ minHeight: "100vh", bgcolor: "#f3f5fb", py: 5 }}>
        <Container maxWidth="sm">
          <Card elevation={8} sx={{ borderRadius: 4 }}>
            <CardContent sx={{ p: { xs: 2.5, sm: 4 } }}>
              <Typography component="h1" variant="h4" fontWeight={800}>
                Todo List
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2.5 }}>
                React-compatible JSX · Material UI · Renderify
              </Typography>

              <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                {FILTERS.map((item) => (
                  <Chip
                    key={item}
                    label={item}
                    color={filter === item ? "primary" : "default"}
                    onClick={() => setFilter(item)}
                    variant={filter === item ? "filled" : "outlined"}
                  />
                ))}
              </Stack>

              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25}>
                <TextField
                  fullWidth
                  label="添加任务"
                  value={input}
                  onChange={(event) => setInput(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addTodo();
                  }}
                />
                <Button variant="contained" onClick={addTodo}>
                  添加
                </Button>
              </Stack>

              <Divider sx={{ my: 2.5 }} />

              {visibleTodos.length === 0 ? (
                <Alert severity="info">当前筛选下暂无任务</Alert>
              ) : (
                <List disablePadding>
                  {visibleTodos.map((todo) => (
                    <ListItem
                      key={todo.id}
                      disableGutters
                      secondaryAction={
                        <Button
                          color="error"
                          size="small"
                          onClick={() => removeTodo(todo.id)}
                        >
                          删除
                        </Button>
                      }
                    >
                      <ListItemIcon sx={{ minWidth: 42 }}>
                        <Checkbox
                          checked={todo.done}
                          onChange={() => toggleTodo(todo.id)}
                        />
                      </ListItemIcon>
                      <ListItemText
                        primary={todo.text}
                        sx={{
                          pr: 7,
                          textDecoration: todo.done ? "line-through" : "none",
                          color: todo.done ? "text.disabled" : "text.primary",
                        }}
                      />
                    </ListItem>
                  ))}
                </List>
              )}

              <Typography color="text.secondary" variant="body2" sx={{ mt: 2 }}>
                总计 {todos.length} · 未完成 {todos.length - completed} · 已完成 {completed}
              </Typography>
            </CardContent>
          </Card>
        </Container>
      </Box>
    </>
  );
}`;

const PREACT_CARD_SOURCE = `import { useState } from "preact/hooks";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <main style={{
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      fontFamily: "Inter, system-ui, sans-serif",
      background: "linear-gradient(145deg, #f5f3ff, #eef2ff)",
    }}>
      <section style={{
        width: "min(420px, calc(100% - 32px))",
        padding: 32,
        borderRadius: 24,
        background: "white",
        boxShadow: "0 24px 70px rgba(76, 61, 150, 0.18)",
        textAlign: "center",
      }}>
        <p style={{ color: "#6d5dfc", fontWeight: 700 }}>PREACT JSX</p>
        <h1 style={{ margin: "8px 0 12px", fontSize: 34 }}>Interactive card</h1>
        <p style={{ color: "#667085" }}>Edit the source and render it instantly.</p>
        <button
          type="button"
          onClick={() => setCount((value) => value + 1)}
          style={{
            marginTop: 20,
            border: 0,
            borderRadius: 12,
            padding: "12px 18px",
            background: "#6d5dfc",
            color: "white",
            fontSize: 16,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Clicked {count} times
        </button>
      </section>
    </main>
  );
}`;

const COUNTER_PLAN = JSON.stringify(
  {
    specVersion: "runtime-plan/v1",
    id: "website_playground_counter",
    version: 1,
    root: {
      type: "element",
      tag: "main",
      props: {
        style: {
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 24,
          fontFamily: "Inter, system-ui, sans-serif",
          background: "linear-gradient(145deg, #f8fafc, #ede9fe)",
        },
      },
      children: [
        {
          type: "element",
          tag: "section",
          props: {
            style: {
              width: "min(420px, 100%)",
              padding: 32,
              borderRadius: 24,
              background: "#ffffff",
              boxShadow: "0 24px 70px rgba(76, 61, 150, 0.16)",
              textAlign: "center",
            },
          },
          children: [
            {
              type: "element",
              tag: "p",
              props: { style: { color: "#6d5dfc", fontWeight: 700 } },
              children: [{ type: "text", value: "RUNTIMEPLAN STATE" }],
            },
            {
              type: "element",
              tag: "h1",
              props: { style: { margin: "10px 0", fontSize: 54 } },
              children: [{ type: "text", value: "{{state.count}}" }],
            },
            {
              type: "element",
              tag: "p",
              props: { style: { color: "#667085", marginBottom: 22 } },
              children: [
                {
                  type: "text",
                  value: "Events dispatch declarative transitions.",
                },
              ],
            },
            {
              type: "element",
              tag: "div",
              props: {
                style: {
                  display: "flex",
                  justifyContent: "center",
                  gap: 10,
                },
              },
              children: [
                {
                  type: "element",
                  tag: "button",
                  props: {
                    onClick: "decrement",
                    style: {
                      padding: "10px 16px",
                      border: "1px solid #d0d5dd",
                      borderRadius: 10,
                      background: "white",
                      cursor: "pointer",
                    },
                  },
                  children: [{ type: "text", value: "−1" }],
                },
                {
                  type: "element",
                  tag: "button",
                  props: {
                    onClick: "increment",
                    style: {
                      padding: "10px 18px",
                      border: 0,
                      borderRadius: 10,
                      background: "#6d5dfc",
                      color: "white",
                      fontWeight: 700,
                      cursor: "pointer",
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
                      background: "white",
                      cursor: "pointer",
                    },
                  },
                  children: [{ type: "text", value: "Reset" }],
                },
              ],
            },
          ],
        },
      ],
    },
    imports: [],
    capabilities: {
      domWrite: true,
      allowedModules: [],
    },
    state: {
      initial: { count: 0 },
      transitions: {
        increment: [{ type: "increment", path: "count", by: 1 }],
        decrement: [{ type: "increment", path: "count", by: -1 }],
        reset: [{ type: "set", path: "count", value: 0 }],
      },
    },
  },
  null,
  2,
);

export const PLAYGROUND_SAMPLES: PlaygroundSample[] = [
  {
    id: "mui-todo",
    label: "React + Material UI Todo",
    mode: "jsx",
    code: MUI_TODO_SOURCE,
  },
  {
    id: "preact-card",
    label: "Preact interactive card",
    mode: "jsx",
    code: PREACT_CARD_SOURCE,
  },
  {
    id: "runtime-counter",
    label: "RuntimePlan counter",
    mode: "plan",
    code: COUNTER_PLAN,
  },
];

export function firstSampleForMode(mode: PlaygroundMode): PlaygroundSample {
  const sample = PLAYGROUND_SAMPLES.find(
    (candidate) => candidate.mode === mode,
  );
  if (!sample) {
    throw new Error(`Missing Playground sample for mode: ${mode}`);
  }
  return sample;
}
