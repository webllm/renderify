export const PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Renderify Runtime Playground</title>
    <style>
      :root {
        --bg-top: #e7f3ff;
        --bg-bottom: #fff9f0;
        --panel: rgba(255, 255, 255, 0.86);
        --line: rgba(17, 24, 39, 0.12);
        --ink: #0f172a;
        --subtle: #475569;
        --brand: #0f766e;
        --brand-2: #0369a1;
        --danger: #b91c1c;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: var(--ink);
        font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 10% 0%, var(--bg-top), var(--bg-bottom));
      }

      .shell {
        min-height: 100vh;
        padding: 20px;
      }

      .title {
        margin: 0 0 8px;
        font-size: 28px;
      }

      .sub {
        margin: 0 0 16px;
        color: var(--subtle);
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        gap: 14px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        backdrop-filter: blur(8px);
      }

      .span-4 {
        grid-column: span 4;
      }

      .span-8 {
        grid-column: span 8;
      }

      .span-12 {
        grid-column: span 12;
      }

      h2 {
        margin: 0 0 10px;
        font-size: 16px;
      }

      textarea {
        width: 100%;
        min-height: 118px;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 11px;
        font: inherit;
        resize: vertical;
        background: #fff;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      button {
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 8px 12px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        background: linear-gradient(160deg, var(--brand), var(--brand-2));
        color: #fff;
      }

      button.secondary {
        background: #fff;
        color: var(--ink);
        border-color: var(--line);
      }

      button.danger {
        background: var(--danger);
      }

      button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .status {
        min-height: 20px;
        margin-top: 10px;
        color: var(--subtle);
        font-size: 13px;
      }

      .render-output {
        min-height: 130px;
        border: 1px dashed rgba(15, 118, 110, 0.35);
        border-radius: 10px;
        padding: 10px;
        background: rgba(255, 255, 255, 0.9);
      }

      pre {
        margin: 0;
        max-height: 360px;
        overflow: auto;
        padding: 10px;
        font-size: 12px;
        border-radius: 10px;
        background: #0f172a;
        color: #dbeafe;
      }

      @media (max-width: 980px) {
        .span-4,
        .span-8 {
          grid-column: span 12;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <h1 class="title">Renderify Playground</h1>
      <p class="sub">Prompt -> RuntimePlan -> Runtime execution -> Browser render</p>

      <div class="grid">
        <section class="card span-4">
          <h2>Prompt</h2>
          <textarea id="prompt">Build an analytics dashboard with a chart and KPI cards</textarea>
          <div class="actions">
            <button id="run-prompt">Render Prompt</button>
            <button id="stream-prompt" class="secondary">Stream Prompt</button>
            <button id="clear" class="danger">Clear</button>
          </div>
          <div class="status" id="status">Ready.</div>
        </section>

        <section class="card span-8">
          <h2>Rendered HTML</h2>
          <div class="render-output" id="html-output"></div>
        </section>

        <section class="card span-6">
          <h2>Plan JSON</h2>
          <textarea id="plan-editor">{}</textarea>
          <div class="actions">
            <button id="run-plan">Render Plan</button>
            <button id="probe-plan" class="secondary">Probe Plan</button>
          </div>
        </section>

        <section class="card span-6">
          <h2>Diagnostics</h2>
          <pre id="diagnostics">{}</pre>
        </section>

        <section class="card span-12">
          <h2>Streaming Feed</h2>
          <pre id="stream-output">[]</pre>
        </section>
      </div>
    </div>

    <script>
      const byId = (id) => document.getElementById(id);
      const statusEl = byId("status");
      const promptEl = byId("prompt");
      const htmlOutputEl = byId("html-output");
      const planEditorEl = byId("plan-editor");
      const diagnosticsEl = byId("diagnostics");
      const streamOutputEl = byId("stream-output");

      const controls = [
        byId("run-prompt"),
        byId("stream-prompt"),
        byId("run-plan"),
        byId("probe-plan"),
        byId("clear"),
      ];

      const setBusy = (busy) => {
        controls.forEach((button) => {
          button.disabled = busy;
        });
      };

      const setStatus = (text) => {
        statusEl.textContent = text;
      };

      const safeJson = (value) => {
        try {
          return JSON.stringify(value ?? {}, null, 2);
        } catch (error) {
          return String(error);
        }
      };

      async function request(path, method, body) {
        const response = await fetch(path, {
          method,
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload && payload.error ? String(payload.error) : "request failed");
        }
        return payload;
      }

      const applyRenderPayload = (payload) => {
        htmlOutputEl.innerHTML = String(payload.html ?? "");
        planEditorEl.value = safeJson(payload.planDetail ?? {});
        diagnosticsEl.textContent = safeJson({
          traceId: payload.traceId,
          state: payload.state ?? {},
          diagnostics: payload.diagnostics ?? [],
        });
      };

      async function runPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Rendering prompt...");
        try {
          const payload = await request("/api/prompt", "POST", { prompt });
          applyRenderPayload(payload);
          streamOutputEl.textContent = "[]";
          setStatus("Prompt rendered.");
        } catch (error) {
          setStatus("Prompt render failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      async function streamPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Streaming prompt...");
        const streamEvents = [];

        try {
          const response = await fetch("/api/prompt-stream", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ prompt }),
          });

          if (!response.ok || !response.body) {
            throw new Error("stream request failed");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) {
                continue;
              }
              const event = JSON.parse(line);
              streamEvents.push({
                type: event.type,
                planId: event.planId ?? null,
                llmTextLength: String(event.llmText ?? "").length,
              });

              if (event.html) {
                htmlOutputEl.innerHTML = String(event.html);
              }
              if (event.type === "final" && event.final) {
                applyRenderPayload(event.final);
              }
            }
          }

          streamOutputEl.textContent = safeJson(streamEvents);
          setStatus("Stream completed.");
        } catch (error) {
          setStatus("Stream failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      async function runPlan() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        setBusy(true);
        setStatus("Rendering plan...");
        try {
          const plan = JSON.parse(raw);
          const payload = await request("/api/plan", "POST", { plan });
          applyRenderPayload(payload);
          setStatus("Plan rendered.");
        } catch (error) {
          setStatus("Plan render failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      async function probePlan() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        setBusy(true);
        setStatus("Probing plan...");
        try {
          const plan = JSON.parse(raw);
          const payload = await request("/api/probe-plan", "POST", { plan });
          diagnosticsEl.textContent = safeJson(payload);
          setStatus("Plan probe completed.");
        } catch (error) {
          setStatus("Plan probe failed.");
          diagnosticsEl.textContent = String(error);
        } finally {
          setBusy(false);
        }
      }

      function clearAll() {
        htmlOutputEl.innerHTML = "";
        diagnosticsEl.textContent = "{}";
        streamOutputEl.textContent = "[]";
        setStatus("Cleared.");
      }

      byId("run-prompt").addEventListener("click", runPrompt);
      byId("stream-prompt").addEventListener("click", streamPrompt);
      byId("run-plan").addEventListener("click", runPlan);
      byId("probe-plan").addEventListener("click", probePlan);
      byId("clear").addEventListener("click", clearAll);
    </script>
  </body>
</html>`;
