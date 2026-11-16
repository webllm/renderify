import type {
  RuntimeEvent,
  RuntimeExecutionContext,
  RuntimePlan,
  RuntimeStateSnapshot,
} from "@renderify/ir";
import {
  createInteractiveSession,
  DefaultUIRenderer,
  type RuntimeInteractiveSession,
} from "@renderify/runtime";
import type { RuntimeSecurityProfile } from "@renderify/security";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type RenderifySessionStatus = "idle" | "rendering" | "ready" | "error";

export interface UseRenderifySessionOptions {
  /**
   * Security profile used to check the plan before it renders. `balanced`
   * renders declarative plans and rejects source modules.
   * @defaultValue "balanced"
   */
  securityProfile?: RuntimeSecurityProfile;
  /** Values readable as `{{context.*}}` and `{{vars.*}}`; read when the plan mounts. */
  context?: RuntimeExecutionContext;
  /** Called after each event's transitions run, with the new state. */
  onEvent?(event: RuntimeEvent, state: RuntimeStateSnapshot | undefined): void;
  /** Called when the plan is rejected by policy or fails to render. */
  onError?(error: Error): void;
}

export interface RenderifySession {
  /** Attach to the element Renderify should render into. */
  ref: (element: HTMLElement | null) => void;
  status: RenderifySessionStatus;
  error?: Error;
  /** Current plan state; updates after every event. */
  state?: RuntimeStateSnapshot;
  /** The live session, for `dispatch`, `setState`, and `getState`. */
  session?: RuntimeInteractiveSession;
}

/**
 * Renders a RuntimePlan into an element and keeps it interactive. The session
 * is recreated only when the plan's content or the security profile changes,
 * so re-renders that pass an equal plan object keep state and DOM intact.
 */
export function useRenderifySession(
  plan: RuntimePlan | null | undefined,
  options: UseRenderifySessionOptions = {},
): RenderifySession {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState<RenderifySessionStatus>("idle");
  const [error, setError] = useState<Error>();
  const [state, setState] = useState<RuntimeStateSnapshot>();
  const [session, setSession] = useState<RuntimeInteractiveSession>();
  const ui = useMemo(() => new DefaultUIRenderer(), []);

  const latest = useRef(options);
  latest.current = options;

  // Content key: chat UIs often recreate equal plan objects on every render.
  const planKey = useMemo(() => (plan ? JSON.stringify(plan) : ""), [plan]);
  const planRef = useRef(plan);
  planRef.current = plan;
  const profile = options.securityProfile ?? "balanced";

  useEffect(() => {
    const currentPlan = planRef.current;
    if (!element || !currentPlan || planKey === "") {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let active: RuntimeInteractiveSession | undefined;
    setStatus("rendering");
    setError(undefined);

    createInteractiveSession(currentPlan, {
      ui,
      context: latest.current.context,
      securityInitialization: { profile },
      runtimeOptions: { enableDependencyPreflight: false },
      target: {
        element,
        onRuntimeEvent: ({ event }) => {
          if (cancelled || !active) {
            return;
          }
          const nextState = active.getState();
          setState(nextState);
          latest.current.onEvent?.(event, nextState);
        },
      },
    }).then(
      (created) => {
        if (cancelled) {
          void created.terminate();
          ui.disposeTarget(element);
          return;
        }
        active = created;
        setSession(created);
        setState(created.getState());
        setStatus("ready");
      },
      (cause: unknown) => {
        if (cancelled) {
          return;
        }
        const failure =
          cause instanceof Error ? cause : new Error(String(cause));
        setError(failure);
        setStatus("error");
        element.replaceChildren();
        latest.current.onError?.(failure);
      },
    );

    return () => {
      cancelled = true;
      setSession(undefined);
      void active?.terminate();
      ui.disposeTarget(element);
      element.replaceChildren();
    };
  }, [element, planKey, profile, ui]);

  const ref = useCallback((node: HTMLElement | null) => setElement(node), []);
  return { ref, status, error, state, session };
}
