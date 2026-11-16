"use client";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import {
  createRenderifyFrame,
  type RenderifyFrame,
  RenderifyFrameError,
  type RenderifyFrameInput,
  type RenderifyFrameResult,
} from "@renderify/frame";
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

type RunStatus = "booting" | "idle" | "running" | "success" | "error";

const SITE_BASE_PATH = process.env.NEXT_PUBLIC_RENDERIFY_BASE_PATH ?? "";
const RUNNER_URL = `${SITE_BASE_PATH}/renderify-frame-runner.js`;
const RENDER_TIMEOUT_MS = 45_000;
const MAX_SOURCE_BYTES = 120_000;

export function Playground() {
  const initialJsx = firstSampleForMode("jsx");
  const initialPlan = firstSampleForMode("plan");
  const [mode, setMode] = useState<PlaygroundMode>("jsx");
  const [codeByMode, setCodeByMode] = useState<Record<PlaygroundMode, string>>({
    jsx: initialJsx.code,
    plan: initialPlan.code,
  });
  const [selectedSample, setSelectedSample] = useState(initialJsx.id);
  const [autoRun, setAutoRun] = useState(true);
  const [runnerReady, setRunnerReady] = useState(false);
  const [status, setStatus] = useState<RunStatus>("booting");
  const [result, setResult] = useState<RenderifyFrameResult>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [copied, setCopied] = useState(false);
  const previewHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<RenderifyFrame | undefined>(undefined);
  const runIdRef = useRef(0);

  const code = codeByMode[mode];

  const editorExtensions = useMemo(
    () => [mode === "jsx" ? javascript({ jsx: true }) : json()],
    [mode],
  );

  // The SDK owns the sandboxed iframe: boot, handshake, watchdog, and reset.
  useEffect(() => {
    const container = previewHostRef.current;
    if (!container) {
      return;
    }
    const frame = createRenderifyFrame({
      container,
      runnerUrl: RUNNER_URL,
      autoResize: false,
      timeoutMs: RENDER_TIMEOUT_MS,
      maxInputBytes: MAX_SOURCE_BYTES,
      title: "Renderify isolated preview",
      onStatusChange: (next) => {
        if (next === "booting") {
          setRunnerReady(false);
          setStatus("booting");
        } else if (next === "ready") {
          setRunnerReady(true);
          setStatus((current) => (current === "booting" ? "idle" : current));
        }
      },
    });
    frameRef.current = frame;
    return () => {
      frame.dispose();
      frameRef.current = undefined;
    };
  }, []);

  const run = useCallback(async () => {
    const frame = frameRef.current;
    if (!runnerReady || !frame) {
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setStatus("running");
    setErrorMessage(undefined);

    let input: RenderifyFrameInput;
    if (mode === "plan") {
      try {
        input = { plan: JSON.parse(code) as unknown };
      } catch (error) {
        setStatus("error");
        setErrorMessage(
          `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    } else {
      input = { source: code, language: "jsx" };
    }

    try {
      const rendered = await frame.render(input);
      if (runIdRef.current === runId) {
        setResult(rendered);
        setStatus("success");
      }
    } catch (error) {
      if (
        runIdRef.current !== runId ||
        (error instanceof RenderifyFrameError &&
          (error.code === "superseded" || error.code === "reset"))
      ) {
        return;
      }
      setStatus("error");
      setErrorMessage(
        error instanceof RenderifyFrameError && error.code === "timeout"
          ? "Render timed out, so the sandbox was reset. Review loops and remote imports, then run again."
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }, [code, mode, runnerReady]);

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
    const timer = setTimeout(() => void run(), 700);
    return () => clearTimeout(timer);
  }, [autoRun, run, runnerReady]);

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
    runIdRef.current += 1;
    setErrorMessage(undefined);
    setResult(undefined);
    void frameRef.current?.reset().catch(() => {});
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
            onClick={() => void run()}
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
            <div className="playground-preview" ref={previewHostRef} />
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
  result: RenderifyFrameResult | undefined;
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
