import {
  createRenderifyFrame,
  type RenderifyFrame as RenderifyFrameController,
  RenderifyFrameError,
  type RenderifyFrameInput,
  type RenderifyFrameOptions,
  type RenderifyFrameResult,
  type RenderifyFrameStatus,
} from "@renderify/frame";
import {
  type CSSProperties,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export interface RenderifyFrameProps
  extends Omit<
    RenderifyFrameOptions,
    "container" | "onStatusChange" | "theme"
  > {
  /** Model-written JSX/TSX to render. Takes precedence over `plan`. */
  source?: string;
  language?: "js" | "jsx" | "ts" | "tsx";
  runtime?: "preact" | "renderify";
  /** A RuntimePlan to render when there is no `source`. */
  plan?: unknown;
  theme?: RenderifyFrameOptions["theme"];
  className?: string;
  style?: CSSProperties;
  onResult?(result: RenderifyFrameResult): void;
  onError?(error: Error): void;
  onStatusChange?(status: RenderifyFrameStatus): void;
}

/**
 * Renders model-written source (or a plan) in a `@renderify/frame` sandbox:
 * an opaque-origin iframe that cannot reach your page. Only actions listed in
 * `allowedActions` reach `onAction`.
 *
 * Frame options such as `runnerUrl` and `allowedActions` are read when the
 * component mounts; give it a new `key` to apply different ones.
 */
export function RenderifyFrame({
  source,
  language,
  runtime,
  plan,
  theme,
  className,
  style,
  onResult,
  onError,
  onStatusChange,
  onAction,
  onBlockedAction,
  onRuntimeError,
  ...frameOptions
}: RenderifyFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<RenderifyFrameController>();
  const callbacks = useRef({
    onResult,
    onError,
    onStatusChange,
    onAction,
    onBlockedAction,
    onRuntimeError,
  });
  callbacks.current = {
    onResult,
    onError,
    onStatusChange,
    onAction,
    onBlockedAction,
    onRuntimeError,
  };
  const initialOptions = useRef(frameOptions);
  const initialTheme = useRef(theme);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const created = createRenderifyFrame({
      ...initialOptions.current,
      container,
      theme: initialTheme.current,
      onAction: (action) => callbacks.current.onAction?.(action),
      onBlockedAction: (action) => callbacks.current.onBlockedAction?.(action),
      onRuntimeError: (message) => callbacks.current.onRuntimeError?.(message),
      onStatusChange: (status) => callbacks.current.onStatusChange?.(status),
    });
    setFrame(created);
    return () => {
      created.dispose();
      setFrame(undefined);
    };
  }, []);

  const input = useMemo<RenderifyFrameInput | undefined>(() => {
    if (typeof source === "string") {
      return {
        source,
        ...(language ? { language } : {}),
        ...(runtime ? { runtime } : {}),
      };
    }
    return plan === undefined ? undefined : { plan };
  }, [source, language, runtime, plan]);
  const inputKey = useMemo(() => (input ? JSON.stringify(input) : ""), [input]);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const current = inputRef.current;
    if (!frame || !current || inputKey === "") {
      return;
    }
    frame.render(current).then(
      (result) => callbacks.current.onResult?.(result),
      (cause: unknown) => {
        if (
          cause instanceof RenderifyFrameError &&
          (cause.code === "superseded" ||
            cause.code === "disposed" ||
            cause.code === "reset")
        ) {
          return;
        }
        callbacks.current.onError?.(
          cause instanceof Error ? cause : new Error(String(cause)),
        );
      },
    );
  }, [frame, inputKey]);

  const themeKey = theme ? JSON.stringify(theme) : "";
  const themeRef = useRef(theme);
  themeRef.current = theme;
  useEffect(() => {
    if (frame && themeKey !== "" && themeRef.current) {
      frame.setTheme(themeRef.current);
    }
  }, [frame, themeKey]);

  return createElement("div", { className, ref: containerRef, style });
}
