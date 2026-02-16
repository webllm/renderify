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
            <button id="copy-plan-link" class="secondary">Copy Plan Link</button>
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
      const copyPlanLinkEl = byId("copy-plan-link");

      const controls = [
        byId("run-prompt"),
        byId("stream-prompt"),
        byId("run-plan"),
        byId("probe-plan"),
        copyPlanLinkEl,
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

      const isRecord = (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value);

      const DEFAULT_PREACT_VERSION = "10.28.3";
      const ESM_SH_BASE_URL = "https://esm.sh/";
      const BABEL_STANDALONE_URL = "https://unpkg.com/@babel/standalone/babel.min.js";
      const JSSPM_HOSTNAMES = new Set(["ga.jspm.io", "cdn.jspm.io"]);

      let interactiveMountVersion = 0;
      let interactiveBlobModuleUrl = null;
      let babelStandalonePromise;
      let diagnosticsSnapshot = {};

      const resetInteractiveMount = () => {
        interactiveMountVersion += 1;
        if (interactiveBlobModuleUrl) {
          URL.revokeObjectURL(interactiveBlobModuleUrl);
          interactiveBlobModuleUrl = null;
        }
      };

      const writeDiagnostics = (payload) => {
        diagnosticsSnapshot = isRecord(payload) ? payload : {};
        diagnosticsEl.textContent = safeJson(diagnosticsSnapshot);
      };

      const appendInteractiveWarning = (message) => {
        const diagnostics = Array.isArray(diagnosticsSnapshot.diagnostics)
          ? diagnosticsSnapshot.diagnostics.slice()
          : [];
        diagnostics.push({
          level: "warning",
          code: "PLAYGROUND_INTERACTIVE_MOUNT_FAILED",
          message,
        });
        writeDiagnostics({
          traceId: diagnosticsSnapshot.traceId,
          state: diagnosticsSnapshot.state ?? {},
          diagnostics,
        });
      };

      const ensureBabelStandalone = async () => {
        if (window.Babel && typeof window.Babel.transform === "function") {
          return;
        }

        if (!babelStandalonePromise) {
          babelStandalonePromise = new Promise((resolve, reject) => {
            const existing = document.querySelector("script[data-babel-standalone='1']");
            if (existing) {
              existing.addEventListener("load", () => resolve(), { once: true });
              existing.addEventListener(
                "error",
                () => reject(new Error("Failed to load Babel standalone.")),
                { once: true },
              );
              return;
            }

            const script = document.createElement("script");
            script.src = BABEL_STANDALONE_URL;
            script.async = true;
            script.dataset.babelStandalone = "1";
            script.onload = () => resolve();
            script.onerror = () =>
              reject(new Error("Failed to load Babel standalone."));
            document.head.appendChild(script);
          });
        }

        await babelStandalonePromise;

        if (!(window.Babel && typeof window.Babel.transform === "function")) {
          throw new Error("Babel standalone is unavailable in playground.");
        }
      };

      const isBareModuleSpecifier = (specifier) => {
        const normalized = String(specifier ?? "").trim();
        if (!normalized) {
          return false;
        }

        if (
          normalized.startsWith("./") ||
          normalized.startsWith("../") ||
          normalized.startsWith("/") ||
          normalized.startsWith("http://") ||
          normalized.startsWith("https://") ||
          normalized.startsWith("data:") ||
          normalized.startsWith("blob:")
        ) {
          return false;
        }

        const firstColonIndex = normalized.indexOf(":");
        if (firstColonIndex > 0) {
          return false;
        }

        return true;
      };

      const isJspmResolvedUrl = (url) => {
        try {
          const parsed = new URL(String(url));
          return JSSPM_HOSTNAMES.has(parsed.hostname.toLowerCase());
        } catch {
          return false;
        }
      };

      const getManifestResolvedUrl = (planDetail, specifier) => {
        if (!isRecord(planDetail) || !isRecord(planDetail.moduleManifest)) {
          return undefined;
        }
        const descriptor = planDetail.moduleManifest[specifier];
        if (!isRecord(descriptor)) {
          return undefined;
        }
        const resolvedUrl = descriptor.resolvedUrl;
        if (typeof resolvedUrl !== "string" || resolvedUrl.trim().length === 0) {
          return undefined;
        }
        return resolvedUrl.trim();
      };

      const extractPreactVersion = (planDetail) => {
        const candidates = [
          getManifestResolvedUrl(planDetail, "preact"),
          getManifestResolvedUrl(planDetail, "preact/hooks"),
          getManifestResolvedUrl(planDetail, "preact/jsx-runtime"),
        ];

        for (const candidate of candidates) {
          if (!candidate) {
            continue;
          }
          const match = candidate.match(/preact@([^/]+)/);
          if (match && typeof match[1] === "string" && match[1].trim()) {
            return match[1].trim();
          }
        }

        return DEFAULT_PREACT_VERSION;
      };

      const toEsmShUrl = (specifier, planDetail) => {
        const normalized = String(specifier ?? "").trim();
        if (!normalized) {
          return normalized;
        }

        if (!isBareModuleSpecifier(normalized)) {
          return normalized;
        }

        const manifestResolvedUrl = getManifestResolvedUrl(planDetail, normalized);
        if (manifestResolvedUrl && !isJspmResolvedUrl(manifestResolvedUrl)) {
          return manifestResolvedUrl;
        }

        const preactVersion = extractPreactVersion(planDetail);
        if (normalized === "preact") {
          return ESM_SH_BASE_URL + "preact@" + preactVersion;
        }
        if (normalized.startsWith("preact/")) {
          return (
            ESM_SH_BASE_URL +
            "preact@" +
            preactVersion +
            "/" +
            normalized.slice("preact/".length)
          );
        }

        return ESM_SH_BASE_URL + normalized;
      };

      // Playground-only simplification: this regex-based rewrite can match
      // comment/string literals. Production runtime paths must use lexer parsing.
      const rewriteTranspiledImports = (code, planDetail) =>
        String(code ?? "")
          .replace(/\\bfrom\\s+["']([^"']+)["']/g, (full, specifier) =>
            full.replace(specifier, toEsmShUrl(specifier, planDetail)),
          )
          .replace(/\\bimport\\s+["']([^"']+)["']/g, (full, specifier) =>
            full.replace(specifier, toEsmShUrl(specifier, planDetail)),
          )
          .replace(
            /\\bimport\\s*\\(\\s*["']([^"']+)["']\\s*\\)/g,
            (full, specifier) =>
              full.replace(specifier, toEsmShUrl(specifier, planDetail)),
          );

      const shouldMountPreactSource = (planDetail) => {
        if (!isRecord(planDetail) || !isRecord(planDetail.source)) {
          return false;
        }
        const runtime = String(planDetail.source.runtime ?? "")
          .trim()
          .toLowerCase();
        const code = planDetail.source.code;
        return runtime === "preact" && typeof code === "string" && code.trim().length > 0;
      };

      const transpilePreactSource = (source) => {
        const language = String(source.language ?? "jsx")
          .trim()
          .toLowerCase();
        if (
          language !== "js" &&
          language !== "jsx" &&
          language !== "ts" &&
          language !== "tsx"
        ) {
          throw new Error("Unsupported source language for interactive mount: " + language);
        }

        const presets = [];
        if (language === "ts" || language === "tsx") {
          presets.push("typescript");
        }
        if (language === "jsx" || language === "tsx") {
          presets.push([
            "react",
            {
              runtime: "automatic",
              importSource: "preact",
            },
          ]);
        }

        const transformed = window.Babel.transform(String(source.code ?? ""), {
          sourceType: "module",
          presets,
          filename: "renderify-playground-source." + language,
          babelrc: false,
          configFile: false,
          comments: false,
        });

        if (!isRecord(transformed) || typeof transformed.code !== "string") {
          throw new Error("Babel returned empty code for interactive mount.");
        }

        return transformed.code;
      };

      const mountPreactSourceInteractively = async (
        planDetail,
        runtimeState,
        mountVersion,
      ) => {
        if (!shouldMountPreactSource(planDetail)) {
          return;
        }

        await ensureBabelStandalone();
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        const source = planDetail.source;
        const transpiled = transpilePreactSource(source);
        const rewritten = rewriteTranspiledImports(transpiled, planDetail);
        const preactImportUrl = toEsmShUrl("preact", planDetail);
        const exportNameRaw =
          typeof source.exportName === "string" && source.exportName.trim().length > 0
            ? source.exportName.trim()
            : "default";

        if (interactiveBlobModuleUrl) {
          URL.revokeObjectURL(interactiveBlobModuleUrl);
          interactiveBlobModuleUrl = null;
        }

        interactiveBlobModuleUrl = URL.createObjectURL(
          new Blob([rewritten], { type: "text/javascript" }),
        );

        const sourceNamespace = await import(interactiveBlobModuleUrl);
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        let component = sourceNamespace[exportNameRaw];
        if (
          component === undefined &&
          exportNameRaw !== "default" &&
          typeof sourceNamespace.default === "function"
        ) {
          component = sourceNamespace.default;
        }
        if (typeof component !== "function") {
          throw new Error(
            "Source export '" + exportNameRaw + "' is not a component function.",
          );
        }

        const preactNamespace = await import(preactImportUrl);
        if (mountVersion !== interactiveMountVersion) {
          return;
        }

        if (
          !isRecord(preactNamespace) ||
          typeof preactNamespace.h !== "function" ||
          typeof preactNamespace.render !== "function"
        ) {
          throw new Error("Failed to load Preact runtime for interactive mount.");
        }

        const runtimeInput = {
          context: {},
          state: isRecord(runtimeState) ? runtimeState : {},
          event: null,
        };
        htmlOutputEl.innerHTML = "";
        preactNamespace.render(
          preactNamespace.h(component, runtimeInput),
          htmlOutputEl,
        );
      };

      const HASH_SOURCE_LANGUAGE_KEYS = {
        js64: "js",
        jsx64: "jsx",
        ts64: "ts",
        tsx64: "tsx",
      };

      const toBase64Bytes = (input) => {
        const normalized = String(input ?? "")
          .trim()
          .replace(/[\\r\\n\\t ]+/g, "")
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        if (!normalized) {
          throw new Error("Base64 payload is empty.");
        }
        const remainder = normalized.length % 4;
        const padded =
          remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
        return atob(padded);
      };

      const decodeBase64Text = (input) => {
        const binary = toBase64Bytes(input);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new TextDecoder().decode(bytes);
      };

      const encodeBase64Url = (input) => {
        const text = String(input ?? "");
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return btoa(binary)
          .replace(/\\+/g, "-")
          .replace(/\\//g, "_")
          .replace(/=+$/g, "");
      };

      const getHashSearchParams = () => {
        const rawHash = window.location.hash.startsWith("#")
          ? window.location.hash.slice(1)
          : window.location.hash;
        return new URLSearchParams(rawHash);
      };

      const parseJsonFromBase64 = (input, label) => {
        try {
          const decoded = decodeBase64Text(input);
          return JSON.parse(decoded);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error("Failed to decode " + label + ": " + message);
        }
      };

      const resolveSourceHashPayload = (params) => {
        const sourceEntry = Object.entries(HASH_SOURCE_LANGUAGE_KEYS).find(
          ([key]) => params.has(key),
        );
        if (!sourceEntry && !params.has("source64")) {
          return null;
        }

        const explicitLanguage = String(params.get("language") || "")
          .trim()
          .toLowerCase();
        const language =
          (sourceEntry ? sourceEntry[1] : undefined) ||
          (explicitLanguage === "js" ||
          explicitLanguage === "jsx" ||
          explicitLanguage === "ts" ||
          explicitLanguage === "tsx"
            ? explicitLanguage
            : "jsx");
        const sourceRaw = sourceEntry ? params.get(sourceEntry[0]) : params.get("source64");
        if (!sourceRaw) {
          throw new Error("Source hash payload is empty.");
        }

        const code = decodeBase64Text(sourceRaw);
        const runtimeRaw = String(params.get("runtime") || "").trim().toLowerCase();
        const runtime =
          runtimeRaw === "renderify" || runtimeRaw === "preact"
            ? runtimeRaw
            : language === "jsx" || language === "tsx"
              ? "preact"
              : "renderify";
        const exportName = String(params.get("exportName") || "default").trim() || "default";
        const manifestPayload = params.get("manifest64");
        const moduleManifest = manifestPayload
          ? parseJsonFromBase64(manifestPayload, "manifest64")
          : undefined;
        const planId =
          String(params.get("id") || "").trim() ||
          "hash_source_" + Date.now().toString(36);

        return {
          specVersion: "runtime-plan/v1",
          id: planId,
          version: 1,
          root: {
            type: "element",
            tag: "div",
            children: [{ type: "text", value: "Renderify source root" }],
          },
          capabilities: {},
          ...(moduleManifest &&
          typeof moduleManifest === "object" &&
          !Array.isArray(moduleManifest)
            ? { moduleManifest }
            : {}),
          source: {
            code,
            language,
            exportName,
            runtime,
          },
          metadata: {
            tags: ["hash-deeplink", "source"],
          },
        };
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

      const applyRenderPayload = async (payload) => {
        resetInteractiveMount();
        htmlOutputEl.innerHTML = String(payload.html ?? "");
        planEditorEl.value = safeJson(payload.planDetail ?? {});
        writeDiagnostics({
          traceId: payload.traceId,
          state: payload.state ?? {},
          diagnostics: payload.diagnostics ?? [],
        });

        const mountVersion = interactiveMountVersion;
        try {
          await mountPreactSourceInteractively(
            payload.planDetail,
            payload.state ?? {},
            mountVersion,
          );
        } catch (error) {
          if (mountVersion !== interactiveMountVersion) {
            return;
          }
          htmlOutputEl.innerHTML = String(payload.html ?? "");
          const message = error instanceof Error ? error.message : String(error);
          appendInteractiveWarning(message);
        }
      };

      const resetRenderPanels = () => {
        resetInteractiveMount();
        htmlOutputEl.innerHTML = "";
        planEditorEl.value = "{}";
        writeDiagnostics({});
      };

      async function renderPlanObject(plan, statusText) {
        setBusy(true);
        setStatus(statusText || "Rendering plan...");
        try {
          const payload = await request("/api/plan", "POST", { plan });
          await applyRenderPayload(payload);
          setStatus("Plan rendered.");
          return payload;
        } catch (error) {
          setStatus("Plan render failed.");
          diagnosticsEl.textContent = String(error);
          throw error;
        } finally {
          setBusy(false);
        }
      }

      async function runPrompt() {
        const prompt = promptEl.value.trim();
        if (!prompt) {
          setStatus("Prompt is required.");
          return;
        }

        setBusy(true);
        setStatus("Rendering prompt...");
        resetRenderPanels();
        streamOutputEl.textContent = "[]";
        try {
          const payload = await request("/api/prompt", "POST", { prompt });
          await applyRenderPayload(payload);
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
        resetRenderPanels();
        const streamEvents = [];
        let streamErrorMessage;
        let streamCompleted = false;

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

              if (event.type === "error") {
                const message =
                  event.error && typeof event.error.message === "string"
                    ? event.error.message
                    : event.error
                      ? String(event.error)
                      : "Stream request failed";
                streamErrorMessage = message;
                continue;
              }

              if (event.html) {
                htmlOutputEl.innerHTML = String(event.html);
              }
              if (event.type === "final" && event.final) {
                await applyRenderPayload(event.final);
                streamCompleted = true;
              }
            }
          }

          streamOutputEl.textContent = safeJson(streamEvents);
          if (streamErrorMessage) {
            throw new Error(streamErrorMessage);
          }

          setStatus(streamCompleted ? "Stream completed." : "Stream finished without final result.");
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

        try {
          const plan = JSON.parse(raw);
          await renderPlanObject(plan, "Rendering plan...");
        } catch (error) {
          setStatus("Plan render failed.");
          diagnosticsEl.textContent = String(error);
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
        resetInteractiveMount();
        htmlOutputEl.innerHTML = "";
        writeDiagnostics({});
        streamOutputEl.textContent = "[]";
        setStatus("Cleared.");
      }

      async function copyPlanLink() {
        const raw = planEditorEl.value.trim();
        if (!raw) {
          setStatus("Plan JSON is required.");
          return;
        }

        try {
          const parsed = JSON.parse(raw);
          const encoded = encodeBase64Url(JSON.stringify(parsed));
          const shareUrl =
            window.location.origin +
            window.location.pathname +
            "#plan64=" +
            encoded;

          if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(shareUrl);
            setStatus("Plan share link copied.");
            diagnosticsEl.textContent = safeJson({
              shareUrl,
            });
            return;
          }

          diagnosticsEl.textContent = shareUrl;
          setStatus("Clipboard unavailable; share URL written to diagnostics.");
        } catch (error) {
          setStatus("Failed to create share link.");
          diagnosticsEl.textContent = String(error);
        }
      }

      async function renderFromHashPayload() {
        const params = getHashSearchParams();
        if (Array.from(params.keys()).length === 0) {
          return;
        }

        try {
          const plan64 = params.get("plan64");
          const plan = plan64
            ? parseJsonFromBase64(plan64, "plan64")
            : resolveSourceHashPayload(params);

          if (!plan) {
            return;
          }

          planEditorEl.value = safeJson(plan);
          await renderPlanObject(plan, "Rendering hash payload...");
          setStatus("Hash payload rendered.");
        } catch (error) {
          setStatus("Hash payload render failed.");
          diagnosticsEl.textContent = String(error);
        }
      }

      byId("run-prompt").addEventListener("click", runPrompt);
      byId("stream-prompt").addEventListener("click", streamPrompt);
      byId("run-plan").addEventListener("click", runPlan);
      byId("probe-plan").addEventListener("click", probePlan);
      copyPlanLinkEl.addEventListener("click", () => {
        void copyPlanLink();
      });
      byId("clear").addEventListener("click", clearAll);

      void renderFromHashPayload();
      window.addEventListener("hashchange", () => {
        void renderFromHashPayload();
      });
    </script>
  </body>
</html>`;
