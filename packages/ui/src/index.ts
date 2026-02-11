import type {
  JsonValue,
  RuntimeEvent,
  RuntimeExecutionResult,
  RuntimeNode,
} from "@renderify/ir";

export interface RuntimeEventDispatchRequest {
  planId: string;
  event: RuntimeEvent;
}

export interface InteractiveRenderTarget {
  element: string | HTMLElement;
  onRuntimeEvent?: (
    request: RuntimeEventDispatchRequest,
  ) => void | Promise<void>;
}

export type RenderTarget = string | HTMLElement | InteractiveRenderTarget;

export interface UIRenderer {
  render(
    result: RuntimeExecutionResult,
    target?: RenderTarget,
  ): Promise<string>;
  renderNode(node: RuntimeNode): string;
}

interface SerializedEventBinding {
  domEvent: string;
  bindingId: string;
  runtimeEvent: RuntimeEvent;
}

interface RenderSerializationContext {
  nextBindingId: number;
  eventBindings: SerializedEventBinding[];
}

interface MountSession {
  html: string;
  planId: string;
  runtimeEvents: Map<string, RuntimeEvent>;
  listeners: Map<string, (event: Event) => void>;
  onRuntimeEvent?: (
    request: RuntimeEventDispatchRequest,
  ) => void | Promise<void>;
}

interface ResolvedRenderTarget {
  mountPoint: HTMLElement;
  onRuntimeEvent?: (
    request: RuntimeEventDispatchRequest,
  ) => void | Promise<void>;
}

export class DefaultUIRenderer implements UIRenderer {
  private readonly mountSessions = new WeakMap<HTMLElement, MountSession>();

  async render(
    result: RuntimeExecutionResult,
    target?: RenderTarget,
  ): Promise<string> {
    if (result.renderArtifact?.mode === "preact-vnode") {
      return this.renderPreactArtifact(result.renderArtifact.payload, target);
    }

    const serialized = this.renderNodeWithBindings(result.root);

    if (typeof document === "undefined") {
      return serialized.html;
    }

    if (!target) {
      return serialized.html;
    }

    const resolvedTarget = this.resolveRenderTarget(target);
    if (!resolvedTarget) {
      throw new Error(
        `Render target not found: ${this.stringifyTarget(target)}`,
      );
    }

    const { mountPoint, onRuntimeEvent } = resolvedTarget;
    this.patchMountPoint(mountPoint, serialized.html);
    this.syncMountSession(
      mountPoint,
      result.planId,
      serialized.eventBindings,
      onRuntimeEvent,
    );

    return mountPoint.innerHTML;
  }

  private async renderPreactArtifact(
    payload: unknown,
    target?: RenderTarget,
  ): Promise<string> {
    if (typeof document !== "undefined" && target) {
      const resolvedTarget = this.resolveRenderTarget(target);
      if (!resolvedTarget) {
        throw new Error(
          `Render target not found: ${this.stringifyTarget(target)}`,
        );
      }

      const preact = await this.loadPreactRenderer();
      preact.render(payload, resolvedTarget.mountPoint);
      return resolvedTarget.mountPoint.innerHTML;
    }

    const renderToString = await this.loadPreactRenderToString();
    return renderToString(payload);
  }

  renderNode(node: RuntimeNode): string {
    return this.renderNodeWithBindings(node).html;
  }

  private renderNodeWithBindings(node: RuntimeNode): {
    html: string;
    eventBindings: SerializedEventBinding[];
  } {
    const context: RenderSerializationContext = {
      nextBindingId: 0,
      eventBindings: [],
    };

    return {
      html: this.renderNodeInternal(node, context),
      eventBindings: context.eventBindings,
    };
  }

  private renderNodeInternal(
    node: RuntimeNode,
    context: RenderSerializationContext,
  ): string {
    if (node.type === "text") {
      return escapeHtml(node.value);
    }

    if (node.type === "component") {
      return `<div data-renderify-unresolved-component="${escapeHtml(node.module)}"></div>`;
    }

    const attributes = serializeProps(node.props, context);
    const children = (node.children ?? [])
      .map((child) => this.renderNodeInternal(child, context))
      .join("");

    return `<${node.tag}${attributes}>${children}</${node.tag}>`;
  }

  private resolveRenderTarget(
    target: RenderTarget,
  ): ResolvedRenderTarget | null {
    if (isInteractiveRenderTarget(target)) {
      const mountPoint = this.resolveTargetElement(target.element);
      if (!mountPoint) {
        return null;
      }

      return {
        mountPoint,
        onRuntimeEvent: target.onRuntimeEvent,
      };
    }

    const mountPoint = this.resolveTargetElement(target);
    if (!mountPoint) {
      return null;
    }

    return {
      mountPoint,
    };
  }

  private resolveTargetElement(
    target: string | HTMLElement,
  ): HTMLElement | null {
    if (typeof target !== "string") {
      return target;
    }

    return document.querySelector<HTMLElement>(target);
  }

  private patchMountPoint(mountPoint: HTMLElement, nextHtml: string): void {
    const session = this.mountSessions.get(mountPoint);
    if (!session) {
      mountPoint.innerHTML = nextHtml;
      return;
    }

    if (session.html === nextHtml) {
      return;
    }

    const template = document.createElement("template");
    template.innerHTML = nextHtml;
    this.reconcileChildren(mountPoint, template.content);
  }

  private reconcileChildren(
    currentParent: ParentNode,
    nextParent: ParentNode,
  ): void {
    const currentChildren = Array.from(currentParent.childNodes);
    const nextChildren = Array.from(nextParent.childNodes);
    const commonLength = Math.min(currentChildren.length, nextChildren.length);

    for (let i = 0; i < commonLength; i += 1) {
      this.reconcileNode(currentChildren[i], nextChildren[i]);
    }

    for (let i = currentChildren.length - 1; i >= nextChildren.length; i -= 1) {
      currentChildren[i].remove();
    }

    for (let i = commonLength; i < nextChildren.length; i += 1) {
      currentParent.appendChild(nextChildren[i].cloneNode(true));
    }
  }

  private reconcileNode(currentNode: ChildNode, nextNode: ChildNode): void {
    if (currentNode.nodeType !== nextNode.nodeType) {
      currentNode.replaceWith(nextNode.cloneNode(true));
      return;
    }

    if (currentNode.nodeType === Node.TEXT_NODE) {
      if (currentNode.textContent !== nextNode.textContent) {
        currentNode.textContent = nextNode.textContent;
      }
      return;
    }

    if (!(currentNode instanceof Element) || !(nextNode instanceof Element)) {
      if (currentNode.textContent !== nextNode.textContent) {
        currentNode.textContent = nextNode.textContent;
      }
      return;
    }

    if (currentNode.tagName !== nextNode.tagName) {
      currentNode.replaceWith(nextNode.cloneNode(true));
      return;
    }

    this.reconcileAttributes(currentNode, nextNode);
    this.reconcileChildren(currentNode, nextNode);
  }

  private reconcileAttributes(
    currentElement: Element,
    nextElement: Element,
  ): void {
    for (const attribute of Array.from(currentElement.attributes)) {
      if (!nextElement.hasAttribute(attribute.name)) {
        currentElement.removeAttribute(attribute.name);
      }
    }

    for (const attribute of Array.from(nextElement.attributes)) {
      if (currentElement.getAttribute(attribute.name) !== attribute.value) {
        currentElement.setAttribute(attribute.name, attribute.value);
      }
    }
  }

  private syncMountSession(
    mountPoint: HTMLElement,
    planId: string,
    eventBindings: SerializedEventBinding[],
    onRuntimeEvent?: (
      request: RuntimeEventDispatchRequest,
    ) => void | Promise<void>,
  ): void {
    const existing = this.mountSessions.get(mountPoint);

    const runtimeEvents = new Map<string, RuntimeEvent>();
    const delegatedEventTypes = new Set<string>();

    for (const binding of eventBindings) {
      runtimeEvents.set(binding.bindingId, binding.runtimeEvent);
      delegatedEventTypes.add(binding.domEvent);
    }

    const session: MountSession = existing ?? {
      html: "",
      planId,
      runtimeEvents,
      listeners: new Map(),
      onRuntimeEvent,
    };

    session.html = mountPoint.innerHTML;
    session.planId = planId;
    session.runtimeEvents = runtimeEvents;
    session.onRuntimeEvent = onRuntimeEvent;

    this.syncDelegatedListeners(mountPoint, session, delegatedEventTypes);
    this.mountSessions.set(mountPoint, session);
  }

  private syncDelegatedListeners(
    mountPoint: HTMLElement,
    session: MountSession,
    delegatedEventTypes: Set<string>,
  ): void {
    for (const [eventType, listener] of session.listeners.entries()) {
      if (!delegatedEventTypes.has(eventType)) {
        mountPoint.removeEventListener(eventType, listener);
        session.listeners.delete(eventType);
      }
    }

    for (const eventType of delegatedEventTypes) {
      if (session.listeners.has(eventType)) {
        continue;
      }

      const listener = (event: Event) => {
        this.handleDelegatedRuntimeEvent(mountPoint, session, eventType, event);
      };

      mountPoint.addEventListener(eventType, listener);
      session.listeners.set(eventType, listener);
    }
  }

  private handleDelegatedRuntimeEvent(
    mountPoint: HTMLElement,
    session: MountSession,
    domEvent: string,
    event: Event,
  ): void {
    const eventTarget = event.target;
    if (!eventTarget || !(eventTarget instanceof Element)) {
      return;
    }

    const bindingAttribute = getBindingAttributeName(domEvent);
    const matched = eventTarget.closest(`[${bindingAttribute}]`);

    if (
      !matched ||
      !(matched instanceof Element) ||
      !mountPoint.contains(matched)
    ) {
      return;
    }

    const bindingId = matched.getAttribute(bindingAttribute);
    if (!bindingId) {
      return;
    }

    const runtimeEvent = session.runtimeEvents.get(bindingId);
    if (!runtimeEvent) {
      return;
    }

    const dispatchRequest: RuntimeEventDispatchRequest = {
      planId: session.planId,
      event: runtimeEvent,
    };

    if (typeof CustomEvent === "function") {
      mountPoint.dispatchEvent(
        new CustomEvent<RuntimeEventDispatchRequest>(
          "renderify:runtime-event",
          {
            bubbles: true,
            composed: true,
            detail: dispatchRequest,
          },
        ),
      );
    }

    if (session.onRuntimeEvent) {
      void Promise.resolve(session.onRuntimeEvent(dispatchRequest)).catch(
        () => {
          // Host callback errors should not break UI interaction.
        },
      );
    }
  }

  private async loadPreactRenderer(): Promise<PreactRendererLike> {
    const loaded = (await import(getPreactSpecifier())) as unknown;
    if (!isPreactRendererLike(loaded)) {
      throw new Error("Failed to load preact renderer from `preact` package");
    }

    return loaded;
  }

  private async loadPreactRenderToString(): Promise<
    (payload: unknown) => string
  > {
    const loaded = (await import(
      getPreactRenderToStringSpecifier()
    )) as unknown;
    if (!isPreactRenderToStringLike(loaded)) {
      throw new Error(
        "Failed to load preact-render-to-string from `preact-render-to-string` package",
      );
    }

    if (typeof loaded === "function") {
      return loaded;
    }

    if (typeof loaded.default === "function") {
      return loaded.default;
    }

    return loaded.render;
  }

  private stringifyTarget(target: RenderTarget): string {
    if (typeof target === "string") {
      return target;
    }

    if (isInteractiveRenderTarget(target)) {
      if (typeof target.element === "string") {
        return target.element;
      }
      return "[interactive-target-element]";
    }

    return "[target-element]";
  }
}

interface PreactRendererLike {
  render(vnode: unknown, parent: Element): void;
}

type PreactRenderToStringLike =
  | ((payload: unknown) => string)
  | {
      default?: (payload: unknown) => string;
      render: (payload: unknown) => string;
    };

function isPreactRendererLike(value: unknown): value is PreactRendererLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { render?: unknown };
  return typeof candidate.render === "function";
}

function isPreactRenderToStringLike(
  value: unknown,
): value is PreactRenderToStringLike {
  if (typeof value === "function") {
    return true;
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { default?: unknown; render?: unknown };
  return (
    typeof candidate.default === "function" ||
    typeof candidate.render === "function"
  );
}

function isInteractiveRenderTarget(
  value: RenderTarget,
): value is InteractiveRenderTarget {
  if (typeof value === "string") {
    return false;
  }

  if (typeof HTMLElement !== "undefined" && value instanceof HTMLElement) {
    return false;
  }

  return (
    typeof value === "object" &&
    value !== null &&
    "element" in value &&
    (typeof (value as { element?: unknown }).element === "string" ||
      (typeof HTMLElement !== "undefined" &&
        (value as { element?: unknown }).element instanceof HTMLElement))
  );
}

function getPreactSpecifier(): string {
  return "preact";
}

function getPreactRenderToStringSpecifier(): string {
  return "preact-render-to-string";
}

function getBindingAttributeName(domEvent: string): string {
  return `data-renderify-event-${domEvent}`;
}

function serializeProps(
  props: Record<string, JsonValue> | undefined,
  context: RenderSerializationContext,
): string {
  if (!props) {
    return "";
  }

  const attributes: string[] = [];

  for (const [key, rawValue] of Object.entries(props)) {
    const eventSpec = parseRuntimeEventProp(key, rawValue);
    if (eventSpec) {
      const bindingId = `evt_${String(++context.nextBindingId)}`;
      context.eventBindings.push({
        bindingId,
        domEvent: eventSpec.domEvent,
        runtimeEvent: eventSpec.runtimeEvent,
      });
      attributes.push(
        ` ${getBindingAttributeName(eventSpec.domEvent)}="${escapeHtml(bindingId)}"`,
      );
      continue;
    }

    if (key.startsWith("on")) {
      continue;
    }

    if (typeof rawValue === "boolean") {
      if (rawValue) {
        attributes.push(` ${key}`);
      }
      continue;
    }

    if (rawValue === null || typeof rawValue === "object") {
      attributes.push(` ${key}='${escapeHtml(JSON.stringify(rawValue))}'`);
      continue;
    }

    attributes.push(` ${key}="${escapeHtml(String(rawValue))}"`);
  }

  return attributes.join("");
}

function parseRuntimeEventProp(
  propName: string,
  value: JsonValue,
): { domEvent: string; runtimeEvent: RuntimeEvent } | undefined {
  if (!/^on[A-Z]/.test(propName)) {
    return undefined;
  }

  const domEvent = propName.slice(2).toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(domEvent)) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return {
      domEvent,
      runtimeEvent: {
        type: value.trim(),
      },
    };
  }

  if (!isJsonObject(value)) {
    return undefined;
  }

  const eventType = value.type;
  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return undefined;
  }

  const payload = value.payload;
  const runtimeEvent: RuntimeEvent = {
    type: eventType.trim(),
  };

  if (isJsonObject(payload)) {
    runtimeEvent.payload = payload;
  }

  return {
    domEvent,
    runtimeEvent,
  };
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
