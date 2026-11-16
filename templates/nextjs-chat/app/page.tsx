"use client";

import { useChat } from "@ai-sdk/react";
import { RenderifyView } from "@renderify/react";
import { type FormEvent, useState } from "react";
import type { RenderUiOutput } from "./api/chat/route";

export default function ChatPage() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = input.trim();
    if (text && !busy) {
      void sendMessage({ text });
      setInput("");
    }
  };

  return (
    <main className="chat">
      <h1>Renderify chat</h1>
      {messages.length === 0 ? (
        <p className="hint">
          Try “Plan a weekly budget with editable categories” or “Make a packing
          checklist for a beach trip”.
        </p>
      ) : null}
      {messages.map((message) => (
        <article className={`message ${message.role}`} key={message.id}>
          {message.parts.map((part, index) => {
            const key = `${message.id}:${index}`;
            if (part.type === "text") {
              return <p key={key}>{part.text}</p>;
            }
            if (part.type === "tool-render_ui") {
              if (part.state === "output-available") {
                const output = part.output as RenderUiOutput;
                return "plan" in output ? (
                  <RenderifyView
                    className="plan"
                    key={key}
                    plan={output.plan}
                    renderError={(error) => (
                      <p className="error">
                        This UI could not be shown: {error.message}
                      </p>
                    )}
                  />
                ) : (
                  <p className="error" key={key}>
                    The model's UI was invalid; it will try again.
                  </p>
                );
              }
              if (part.state === "output-error") {
                return (
                  <p className="error" key={key}>
                    {part.errorText}
                  </p>
                );
              }
              return (
                <p className="hint" key={key}>
                  Building an interactive answer…
                </p>
              );
            }
            return null;
          })}
        </article>
      ))}
      <form className="composer" onSubmit={submit}>
        <input
          aria-label="Message"
          onChange={(event) => setInput(event.target.value)}
          placeholder="Ask for something interactive"
          value={input}
        />
        <button disabled={busy || input.trim() === ""} type="submit">
          Send
        </button>
      </form>
    </main>
  );
}
