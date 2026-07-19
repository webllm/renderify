"use client";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import CodeMirror from "@uiw/react-codemirror";
import {
  AlertTriangle,
  Check,
  Copy,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  firstSampleForMode,
  PLAYGROUND_SAMPLES,
  type PlaygroundMode,
} from "./samples";

interface PlaygroundDiagnostic {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

interface PlaygroundResult {
  durationMs: number;
  diagnostics: PlaygroundDiagnostic[];
  framework: "react" | "preact" | "runtime-plan";
  planId: string;
  state?: Record<string, unknown>;
}

type RunStatus = "booting" | "idle" | "running" | "success" | "error";

interface RunnerMessage {
  type?: unknown;
  runId?: unknown;
  durationMs?: unknown;
  diagnostics?: unknown;
  framework?: unknown;
  planId?: unknown;
  state?: unknown;
  message?: unknown;
}

const SITE_BASE_PATH = process.env.NEXT_PUBLIC_RENDERIFY_BASE_PATH ?? "";
const RENDER_TIMEOUT_MS = 45_000;

export function Playground() {
  const initialJsx = firstSampleForMode("jsx");
  const initialPlan = firstSampleForMode("plan");
  const [mode, setMode] = useState<PlaygroundMode>("jsx");
  const [codeByMode, setCodeByMode] = useState<Record<PlaygroundMode, string>>({
    jsx: initialJsx.code,
    plan: initialPlan.code,
  });
  const [selectedSample, setSelectedSample] = useState(initialJsx.id);
  const [autoRun, setAutoRun] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const [runnerReady, setRunnerReady] = useState(false);
  const [status, setStatus] = useState<RunStatus>("booting");
  const [result, setResult] = useState<PlaygroundResult>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const runIdRef = useRef(0);

  const code = codeByMode[mode];

  const editorExtensions = useMemo(
    () => [mode === "jsx" ? javascript({ jsx: true }) : json()],
    [mode],
  );
  const iframeDocument = createIframeDocument();

  const clearRunTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  const run = useCallback(() => {
    const port = portRef.current;
    if (!runnerReady || !port) {
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    clearRunTimeout();
    setStatus("running");
    setErrorMessage(undefined);
    port.postMessage({
      type: "render",
      runId,
      mode,
      code,
    });
    timeoutRef.current = setTimeout(() => {
      if (runIdRef.current !== runId) {
        return;
      }
      setStatus("error");
      setErrorMessage(
        "Render timed out. Reset the sandbox to terminate the current document, then review loops and remote imports.",
      );
    }, RENDER_TIMEOUT_MS);
  }, [clearRunTimeout, code, mode, runnerReady]);

  const handleRunnerMessage = useCallback(
    (event: MessageEvent<unknown>) => {
      const message = event.data as RunnerMessage;
      if (message.type === "ready") {
        setRunnerReady(true);
        setStatus("idle");
        return;
      }

      if (
        typeof message.runId !== "number" ||
        message.runId !== runIdRef.current
      ) {
        return;
      }

      clearRunTimeout();
      if (message.type === "error") {
        setStatus("error");
        setErrorMessage(
          typeof message.message === "string"
            ? message.message
            : "Unknown renderer error",
        );
        return;
      }

      if (
        message.type === "result" &&
        typeof message.durationMs === "number" &&
        typeof message.framework === "string" &&
        typeof message.planId === "string"
      ) {
        setResult({
          durationMs: message.durationMs,
          diagnostics: isDiagnostics(message.diagnostics)
            ? message.diagnostics
            : [],
          framework: message.framework as PlaygroundResult["framework"],
          planId: message.planId,
          ...(isRecord(message.state) ? { state: message.state } : {}),
        });
        setStatus("success");
      }
    },
    [clearRunTimeout],
  );

  const connectRunner = useCallback(() => {
    const contentWindow = iframeRef.current?.contentWindow;
    if (!contentWindow) {
      return;
    }

    portRef.current?.close();
    const channel = new MessageChannel();
    channel.port1.onmessage = handleRunnerMessage;
    channel.port1.start();
    portRef.current = channel.port1;
    contentWindow.postMessage({ type: "renderify-playground-connect" }, "*", [
      channel.port2,
    ]);
  }, [handleRunnerMessage]);

  useEffect(() => {
    const decoded = decodeLocationHash(window.location.hash);
    if (!decoded) {
      return;
    }
    setMode(decoded.mode);
    setSelectedSample("");
    setCodeByMode((current) => ({
      ...current,
      [decoded.mode]: decoded.code,
    }));
  }, []);

  useEffect(() => {
    if (!autoRun || !runnerReady) {
      return;
    }
    const timer = setTimeout(run, 700);
    return () => clearTimeout(timer);
  }, [autoRun, run, runnerReady]);

  useEffect(
    () => () => {
      clearRunTimeout();
      portRef.current?.close();
    },
    [clearRunTimeout],
  );

  const selectMode = (nextMode: PlaygroundMode) => {
    if (nextMode === mode) {
      return;
    }
    setMode(nextMode);
    setSelectedSample(firstSampleForMode(nextMode).id);
    setResult(undefined);
    setErrorMessage(undefined);
    setStatus(runnerReady ? "idle" : "booting");
  };

  const chooseSample = (sampleId: string) => {
    const sample = PLAYGROUND_SAMPLES.find(
      (candidate) => candidate.id === sampleId,
    );
    if (!sample) {
      return;
    }
    setMode(sample.mode);
    setSelectedSample(sample.id);
    setCodeByMode((current) => ({ ...current, [sample.mode]: sample.code }));
  };

  const updateCode = (nextCode: string) => {
    setSelectedSample("");
    setCodeByMode((current) => ({ ...current, [mode]: nextCode }));
  };

  const resetCode = () => {
    const sample = firstSampleForMode(mode);
    setSelectedSample(sample.id);
    setCodeByMode((current) => ({ ...current, [mode]: sample.code }));
  };

  const resetSandbox = () => {
    clearRunTimeout();
    portRef.current?.close();
    portRef.current = undefined;
    setRunnerReady(false);
    setStatus("booting");
    setErrorMessage(undefined);
    setResult(undefined);
    setFrameVersion((value) => value + 1);
  };

  const share = async () => {
    const hash = encodeLocationHash(mode, code);
    window.history.replaceState(null, "", hash);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="playground-shell">
      <div className="playground-toolbar">
        <div
          className="playground-mode-switch"
          aria-label="Editor mode"
          role="tablist"
        >
          <button
            aria-selected={mode === "jsx"}
            className={mode === "jsx" ? "is-active" : undefined}
            onClick={() => selectMode("jsx")}
            role="tab"
            type="button"
          >
            JSX / TSX
          </button>
          <button
            aria-selected={mode === "plan"}
            className={mode === "plan" ? "is-active" : undefined}
            onClick={() => selectMode("plan")}
            role="tab"
            type="button"
          >
            RuntimePlan JSON
          </button>
        </div>

        <label className="playground-sample-select">
          <span className="sr-only">Sample</span>
          <select
            value={selectedSample}
            onChange={(event) => chooseSample(event.target.value)}
          >
            <option value="" disabled>
              Modified code
            </option>
            {PLAYGROUND_SAMPLES.filter((sample) => sample.mode === mode).map(
              (sample) => (
                <option key={sample.id} value={sample.id}>
                  {sample.label}
                </option>
              ),
            )}
          </select>
        </label>

        <label className="playground-auto-run">
          <input
            checked={autoRun}
            onChange={(event) => setAutoRun(event.target.checked)}
            type="checkbox"
          />
          Auto-run
        </label>

        <div className="playground-toolbar-actions">
          <button onClick={resetCode} type="button">
            <RotateCcw aria-hidden="true" size={15} />
            Reset code
          </button>
          <button onClick={() => void share()} type="button">
            {copied ? (
              <Check aria-hidden="true" size={15} />
            ) : (
              <Copy aria-hidden="true" size={15} />
            )}
            {copied ? "Copied" : "Share"}
          </button>
          <button
            className="playground-run-button"
            disabled={!runnerReady || status === "running"}
            onClick={run}
            type="button"
          >
            {status === "running" ? (
              <LoaderCircle
                aria-hidden="true"
                className="animate-spin"
                size={16}
              />
            ) : (
              <Play aria-hidden="true" fill="currentColor" size={15} />
            )}
            {status === "running" ? "Rendering" : "Run"}
          </button>
        </div>
      </div>

      <div className="playground-grid">
        <section className="playground-pane" aria-label="Code editor">
          <div className="playground-pane-heading">
            <span>{mode === "jsx" ? "App.jsx" : "plan.json"}</span>
            <span>
              {new TextEncoder().encode(code).byteLength.toLocaleString()} bytes
            </span>
          </div>
          <CodeMirror
            aria-label={
              mode === "jsx" ? "JSX source editor" : "RuntimePlan JSON editor"
            }
            basicSetup={{
              bracketMatching: true,
              closeBrackets: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              lineNumbers: true,
            }}
            extensions={editorExtensions}
            height="640px"
            onChange={updateCode}
            theme="dark"
            value={code}
          />
        </section>

        <section className="playground-pane" aria-label="Rendered preview">
          <div className="playground-pane-heading">
            <StatusLabel result={result} status={status} />
            <button
              className="playground-icon-button"
              onClick={resetSandbox}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={14} />
              Reset sandbox
            </button>
          </div>
          <div className="playground-preview-wrap">
            {status === "booting" ? (
              <div className="playground-preview-overlay">
                <LoaderCircle
                  aria-hidden="true"
                  className="animate-spin"
                  size={20}
                />
                Starting isolated renderer…
              </div>
            ) : null}
            <iframe
              key={frameVersion}
              className="playground-preview"
              onLoad={connectRunner}
              ref={iframeRef}
              sandbox="allow-scripts"
              srcDoc={iframeDocument}
              title="Renderify isolated preview"
            />
          </div>
        </section>
      </div>

      <div className="playground-footer-grid">
        <section className="playground-safety-note">
          <ShieldCheck aria-hidden="true" size={18} />
          <div>
            <strong>Renderer-only and isolated</strong>
            <p>
              No prompt or code is sent to an LLM. Source runs in a sandboxed,
              opaque-origin iframe and can load reviewed browser ESM
              dependencies.
            </p>
          </div>
        </section>

        <section className="playground-diagnostics" aria-live="polite">
          <h2>Diagnostics</h2>
          {errorMessage ? (
            <div className="playground-error">
              <AlertTriangle aria-hidden="true" size={17} />
              <span>{errorMessage}</span>
            </div>
          ) : result ? (
            <>
              <dl>
                <div>
                  <dt>Plan</dt>
                  <dd>{result.planId}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>{result.framework}</dd>
                </div>
                <div>
                  <dt>First render</dt>
                  <dd>{result.durationMs.toLocaleString()} ms</dd>
                </div>
              </dl>
              {result.diagnostics.length > 0 ? (
                <ul>
                  {result.diagnostics.map((diagnostic) => (
                    <li key={`${diagnostic.code}:${diagnostic.message}`}>
                      <strong>{diagnostic.code}</strong> {diagnostic.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No runtime diagnostics.</p>
              )}
            </>
          ) : (
            <p>Run the editor to inspect timing and runtime diagnostics.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusLabel({
  result,
  status,
}: {
  result: PlaygroundResult | undefined;
  status: RunStatus;
}) {
  if (status === "success" && result) {
    return (
      <span className="playground-status is-success">
        <span aria-hidden="true" /> Rendered in{" "}
        {result.durationMs.toLocaleString()} ms
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="playground-status is-error">
        <span aria-hidden="true" /> Render failed
      </span>
    );
  }
  if (status === "running") {
    return <span className="playground-status">Rendering…</span>;
  }
  if (status === "booting") {
    return <span className="playground-status">Starting sandbox…</span>;
  }
  return <span className="playground-status">Preview ready</span>;
}

function createIframeDocument(): string {
  const runtimeUrl = `${SITE_BASE_PATH}/playground-runtime.js`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: http: https:; connect-src blob: https://ga.jspm.io https://cdn.jspm.io https://esm.sh; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data: https:;">
    <style>
      html, body, #renderify-root { min-height: 100%; margin: 0; }
      body { color: #101828; background: #fff; }
      * { box-sizing: border-box; }
    </style>
  </head>
  <body>
    <div id="renderify-root"></div>
    <script src="${escapeHtmlAttribute(runtimeUrl)}"></script>
  </body>
</html>`;
}

function encodeLocationHash(mode: PlaygroundMode, code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
  return `#${mode}64=${encoded}`;
}

function decodeLocationHash(
  hash: string,
): { mode: PlaygroundMode; code: string } | undefined {
  const match = /^#(jsx|plan)64=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) {
    return undefined;
  }
  try {
    const encoded = match[2].replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return {
      mode: match[1] as PlaygroundMode,
      code: new TextDecoder().decode(bytes),
    };
  } catch {
    return undefined;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiagnostics(value: unknown): value is PlaygroundDiagnostic[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        (entry.level === "info" ||
          entry.level === "warning" ||
          entry.level === "error") &&
        typeof entry.code === "string" &&
        typeof entry.message === "string",
    )
  );
}
