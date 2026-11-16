import type { RuntimePlan } from "@renderify/ir";
import {
  type CSSProperties,
  createElement,
  Fragment,
  type ReactNode,
} from "react";
import {
  type UseRenderifySessionOptions,
  useRenderifySession,
} from "./use-renderify-session";

export interface RenderifyViewProps extends UseRenderifySessionOptions {
  /** The RuntimePlan to render, for example a tool result from a model. */
  plan: RuntimePlan | null | undefined;
  className?: string;
  style?: CSSProperties;
  /** Shown instead of the plan when it is rejected or fails to render. */
  renderError?(error: Error): ReactNode;
}

/**
 * Renders a declarative RuntimePlan. The plan is checked against the security
 * profile first, then renders into a `<div>` that Renderify owns; its events
 * run the plan's transitions locally.
 *
 * @example
 * <RenderifyView plan={part.output.plan} onEvent={(event) => log(event)} />
 */
export function RenderifyView({
  plan,
  className,
  style,
  renderError,
  ...options
}: RenderifyViewProps) {
  const { ref, status, error } = useRenderifySession(plan, options);
  // Renderify owns the div's children; React only sets its attributes.
  return createElement(
    Fragment,
    null,
    createElement("div", {
      className,
      "data-renderify-status": status,
      ref,
      style,
    }),
    status === "error" && error && renderError ? renderError(error) : null,
  );
}
