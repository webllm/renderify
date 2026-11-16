import type {
  JsonValue,
  RuntimeEvent,
  RuntimeExecutionResult,
  RuntimeNode,
} from "@renderify/ir";
import {
  normalizeRuntimeBindPath,
  parseRuntimeEventBinding,
  RUNTIME_BIND_EVENT_TYPE,
} from "@renderify/ir";
import {
  hasRuntimeCssImageSetFunction,
  inspectRuntimeUrlAttribute,
  isRuntimeUrlAttribute,
} from "@renderify/security";

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

export interface DefaultUIRendererOptions {
  loadPreactRenderer?: () => unknown | Promise<unknown>;
}

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

interface SerializedControlBinding {
  bindId: string;
  path: string;
}

interface RenderSerializationContext {
  nextBindingId: number;
  eventBindings: SerializedEventBinding[];
  nextBindId: number;
  controlBindings: SerializedControlBinding[];
}

interface DelegatedListener {
  domTypes: string[];
  listener: (event: Event) => void;
}

interface MountSession {
  html: string;
  planId: string;
  runtimeEvents: Map<string, RuntimeEvent>;
  /** Bind id → state path for form controls with a `bind` prop. */
  controlBindings: Map<string, string>;
  /** Binding event name → its delegated listener and the DOM events it uses. */
  listeners: Map<string, DelegatedListener>;
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
  /** Last rendered value/checked per form control, for controlled updates. */
  private readonly renderedControlState = new WeakMap<
    Element,
    { value: string | null; checked: boolean }
  >();
  private readonly options: DefaultUIRendererOptions;

  constructor(options: DefaultUIRendererOptions = {}) {
    this.options = options;
  }

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
      serialized.controlBindings,
      onRuntimeEvent,
    );
    this.syncControlledFormValues(mountPoint);

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

  disposeTarget(target: RenderTarget): void {
    if (typeof document === "undefined") {
      return;
    }

    const resolvedTarget = this.resolveRenderTarget(target);
    if (!resolvedTarget) {
      return;
    }

    const { mountPoint } = resolvedTarget;
    const session = this.mountSessions.get(mountPoint);
    if (!session) {
      return;
    }

    for (const { domTypes, listener } of session.listeners.values()) {
      for (const domType of domTypes) {
        mountPoint.removeEventListener(domType, listener);
      }
    }
    session.listeners.clear();
    this.mountSessions.delete(mountPoint);
  }

  private renderNodeWithBindings(node: RuntimeNode): {
    html: string;
    eventBindings: SerializedEventBinding[];
    controlBindings: SerializedControlBinding[];
  } {
    const context: RenderSerializationContext = {
      nextBindingId: 0,
      eventBindings: [],
      nextBindId: 0,
      controlBindings: [],
    };

    return {
      html: this.renderNodeInternal(node, context),
      eventBindings: context.eventBindings,
      controlBindings: context.controlBindings,
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

    if (node.type === "each" || node.type === "if") {
      // Control nodes are expanded by the runtime before rendering; an
      // unexecuted plan has no state to evaluate them against.
      return `<div data-renderify-unresolved-control="${node.type}"></div>`;
    }

    const children = (node.children ?? [])
      .map((child) => this.renderNodeInternal(child, context))
      .join("");
    const normalizedTag = normalizeTagName(node.tag);
    if (!normalizedTag) {
      return `<div data-renderify-sanitized-tag="${escapeHtml(node.tag)}">${children}</div>`;
    }
    if (normalizedTag === "form") {
      // A real form could navigate the host or post its fields elsewhere, so
      // forms render as inert containers and the runtime emulates submit.
      const attributes = serializeProps(
        withoutFormSubmissionProps(node.props),
        context,
        "div",
      );
      return `<div data-renderify-form${attributes}>${children}</div>`;
    }
    if (BLOCKED_TAG_NAMES.has(normalizedTag)) {
      return `<div data-renderify-sanitized-tag="${escapeHtml(node.tag)}"></div>`;
    }

    const attributes = serializeProps(node.props, context, normalizedTag);

    return `<${normalizedTag}${attributes}>${children}</${normalizedTag}>`;
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
    const sanitizedHtml = this.sanitizeHtmlForMount(nextHtml);
    const session = this.mountSessions.get(mountPoint);
    if (!session) {
      mountPoint.innerHTML = sanitizedHtml;
      return;
    }

    if (session.html === sanitizedHtml) {
      return;
    }

    const scrollTop = mountPoint.scrollTop;
    const scrollLeft = mountPoint.scrollLeft;

    const template = document.createElement("template");
    template.innerHTML = sanitizedHtml;
    this.reconcileChildren(mountPoint, template.content);
    mountPoint.scrollTop = scrollTop;
    mountPoint.scrollLeft = scrollLeft;
  }

  private sanitizeHtmlForMount(html: string): string {
    const template = document.createElement("template");
    template.innerHTML = html;
    sanitizeRenderedFragment(template.content);
    return template.innerHTML;
  }

  private reconcileChildren(
    currentParent: ParentNode,
    nextParent: ParentNode,
  ): void {
    const currentChildren = Array.from(currentParent.childNodes);
    const nextChildren = Array.from(nextParent.childNodes);

    if (this.shouldUseKeyedReconcile(currentChildren, nextChildren)) {
      this.reconcileKeyedChildren(currentParent, currentChildren, nextChildren);
      return;
    }

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

  private shouldUseKeyedReconcile(
    currentChildren: ChildNode[],
    nextChildren: ChildNode[],
  ): boolean {
    return (
      currentChildren.some((node) => this.getNodeKey(node) !== null) ||
      nextChildren.some((node) => this.getNodeKey(node) !== null)
    );
  }

  private reconcileKeyedChildren(
    currentParent: ParentNode,
    currentChildren: ChildNode[],
    nextChildren: ChildNode[],
  ): void {
    const currentByKey = new Map<string, ChildNode>();
    for (const node of currentChildren) {
      const key = this.getNodeKey(node);
      if (!key || currentByKey.has(key)) {
        continue;
      }
      currentByKey.set(key, node);
    }

    const consumed = new Set<ChildNode>();
    const desiredNodes: ChildNode[] = [];

    for (let index = 0; index < nextChildren.length; index += 1) {
      const nextChild = nextChildren[index];
      const nextKey = this.getNodeKey(nextChild);

      let candidate: ChildNode | undefined;
      if (nextKey) {
        const keyed = currentByKey.get(nextKey);
        if (
          keyed &&
          !consumed.has(keyed) &&
          this.areNodesCompatible(keyed, nextChild)
        ) {
          candidate = keyed;
        }
      } else {
        const positional = currentChildren[index];
        if (
          positional &&
          !consumed.has(positional) &&
          this.getNodeKey(positional) === null &&
          this.areNodesCompatible(positional, nextChild)
        ) {
          candidate = positional;
        }
      }

      if (candidate) {
        this.reconcileNode(candidate, nextChild);
        consumed.add(candidate);
        desiredNodes.push(candidate);
        continue;
      }

      desiredNodes.push(nextChild.cloneNode(true) as ChildNode);
    }

    this.applyDesiredChildren(currentParent, desiredNodes);
  }

  private applyDesiredChildren(
    currentParent: ParentNode,
    desiredNodes: ChildNode[],
  ): void {
    const desiredSet = new Set(desiredNodes);
    for (const child of Array.from(currentParent.childNodes)) {
      if (!desiredSet.has(child)) {
        child.remove();
      }
    }

    for (let index = 0; index < desiredNodes.length; index += 1) {
      const desiredNode = desiredNodes[index];
      const nodeAtIndex = currentParent.childNodes[index] ?? null;

      if (desiredNode.parentNode !== currentParent) {
        currentParent.insertBefore(desiredNode, nodeAtIndex);
        continue;
      }

      if (nodeAtIndex !== desiredNode) {
        currentParent.insertBefore(desiredNode, nodeAtIndex);
      }
    }
  }

  private getNodeKey(node: ChildNode): string | null {
    if (typeof Element === "undefined" || !(node instanceof Element)) {
      return null;
    }

    const key =
      node.getAttribute("data-renderify-key") ?? node.getAttribute("key");
    if (!key || key.trim().length === 0) {
      return null;
    }

    return key;
  }

  private areNodesCompatible(
    currentNode: ChildNode,
    nextNode: ChildNode,
  ): boolean {
    if (currentNode.nodeType !== nextNode.nodeType) {
      return false;
    }

    if (
      typeof Element === "undefined" ||
      !(currentNode instanceof Element) ||
      !(nextNode instanceof Element)
    ) {
      return true;
    }

    return currentNode.tagName === nextNode.tagName;
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

  /**
   * Applies rendered `value`/`checked` to form control properties when the
   * render changed them, so state updates (such as clearing a bound input
   * after "Add") reach controls the user has already edited. Controls whose
   * rendered value did not change keep whatever the user entered, and a
   * focused control is only updated when it is being cleared, so in-flight
   * renders never overwrite text the user is typing.
   */
  private syncControlledFormValues(mountPoint: HTMLElement): void {
    const activeElement =
      typeof document !== "undefined" ? document.activeElement : null;
    for (const element of Array.from(
      mountPoint.querySelectorAll("input, textarea, select"),
    )) {
      const control = element as HTMLInputElement;
      const tag = element.tagName.toLowerCase();
      const type =
        tag === "input" ? (control.type || "text").toLowerCase() : tag;
      const previous = this.renderedControlState.get(element);

      if (type === "checkbox" || type === "radio") {
        const rendered = element.hasAttribute("checked");
        if (
          previous === undefined
            ? control.checked !== rendered
            : previous.checked !== rendered
        ) {
          control.checked = rendered;
        }
        this.renderedControlState.set(element, {
          value: null,
          checked: rendered,
        });
        continue;
      }

      const rendered = element.getAttribute("value");
      const changed = previous === undefined || previous.value !== rendered;
      this.renderedControlState.set(element, {
        value: rendered,
        checked: false,
      });
      if (
        rendered === null ||
        !changed ||
        type === "file" ||
        (tag === "select" && (element as HTMLSelectElement).multiple) ||
        (element === activeElement && rendered !== "")
      ) {
        continue;
      }
      if (control.value !== rendered) {
        control.value = rendered;
      }
    }
  }

  private syncMountSession(
    mountPoint: HTMLElement,
    planId: string,
    eventBindings: SerializedEventBinding[],
    controlBindings: SerializedControlBinding[],
    onRuntimeEvent?: (
      request: RuntimeEventDispatchRequest,
    ) => void | Promise<void>,
  ): void {
    const existing = this.mountSessions.get(mountPoint);

    const runtimeEvents = new Map<string, RuntimeEvent>();
    const boundControls = new Map<string, string>();
    const delegatedEventTypes = new Set<string>();

    for (const binding of eventBindings) {
      runtimeEvents.set(binding.bindingId, binding.runtimeEvent);
      delegatedEventTypes.add(binding.domEvent);
    }
    for (const binding of controlBindings) {
      boundControls.set(binding.bindId, binding.path);
    }
    if (boundControls.size > 0) {
      delegatedEventTypes.add("input");
      delegatedEventTypes.add("change");
    }

    const session: MountSession = existing ?? {
      html: "",
      planId,
      runtimeEvents,
      controlBindings: boundControls,
      listeners: new Map(),
      onRuntimeEvent,
    };

    session.html = mountPoint.innerHTML;
    session.planId = planId;
    session.runtimeEvents = runtimeEvents;
    session.controlBindings = boundControls;
    session.onRuntimeEvent = onRuntimeEvent;

    this.syncDelegatedListeners(mountPoint, session, delegatedEventTypes);
    this.mountSessions.set(mountPoint, session);
  }

  private syncDelegatedListeners(
    mountPoint: HTMLElement,
    session: MountSession,
    delegatedEventTypes: Set<string>,
  ): void {
    for (const [eventType, entry] of session.listeners.entries()) {
      if (!delegatedEventTypes.has(eventType)) {
        for (const domType of entry.domTypes) {
          mountPoint.removeEventListener(domType, entry.listener);
        }
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

      const domTypes = toDomListenerTypes(eventType);
      for (const domType of domTypes) {
        mountPoint.addEventListener(domType, listener);
      }
      session.listeners.set(eventType, { domTypes, listener });
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

    if (domEvent === "input" || domEvent === "change") {
      this.dispatchControlBinding(mountPoint, session, domEvent, eventTarget);
    }

    if (domEvent === "submit") {
      this.dispatchFormSubmit(mountPoint, session, event, eventTarget);
      return;
    }

    if (domEvent === "enter" && !isPlainEnterKey(event)) {
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

    if (domEvent === "enter") {
      // Enter triggers the bound action instead of inserting a newline.
      event.preventDefault();
    }

    // Events from form controls carry the control's live value, so plans can
    // copy it with {"$from":"event.payload.value"}. Declared payload keys win.
    const captured = captureControlValues(eventTarget, matched);
    this.dispatchRuntimeEvent(
      mountPoint,
      session,
      captured
        ? {
            ...runtimeEvent,
            payload: { ...captured, ...(runtimeEvent.payload ?? {}) },
          }
        : runtimeEvent,
    );
  }

  /**
   * Emulates form submission for `form` nodes, which render as inert
   * containers: a click on a submit button or Enter in a text field inside a
   * container with an `onSubmit` binding dispatches it, with the container's
   * named fields in the payload.
   */
  private dispatchFormSubmit(
    mountPoint: HTMLElement,
    session: MountSession,
    event: Event,
    target: Element,
  ): void {
    const bindingAttribute = getBindingAttributeName("submit");
    const form = target.closest(`[${bindingAttribute}]`);
    if (!form || !mountPoint.contains(form)) {
      return;
    }
    if (event.type === "click") {
      const submitter = target.closest("button, input");
      if (
        !submitter ||
        !form.contains(submitter) ||
        !isSubmitControl(submitter)
      ) {
        return;
      }
    } else if (
      event.type !== "keydown" ||
      !isPlainEnterKey(event) ||
      !isImplicitSubmitField(target)
    ) {
      return;
    }
    event.preventDefault();

    const bindingId = form.getAttribute(bindingAttribute);
    const runtimeEvent = bindingId
      ? session.runtimeEvents.get(bindingId)
      : undefined;
    if (!runtimeEvent) {
      return;
    }
    this.dispatchRuntimeEvent(mountPoint, session, {
      ...runtimeEvent,
      payload: { ...collectFormFields(form), ...(runtimeEvent.payload ?? {}) },
    });
  }

  private dispatchControlBinding(
    mountPoint: HTMLElement,
    session: MountSession,
    domEvent: "input" | "change",
    target: Element,
  ): void {
    const bindId = target.getAttribute(CONTROL_BIND_ATTRIBUTE);
    const path = bindId ? session.controlBindings.get(bindId) : undefined;
    if (!path || getControlBindDomEvent(target) !== domEvent) {
      return;
    }
    if (
      readControlType(target) === "radio" &&
      !(target as HTMLInputElement).checked
    ) {
      return;
    }
    const value = readControlValue(target);
    if (value === undefined) {
      return;
    }
    this.dispatchRuntimeEvent(mountPoint, session, {
      type: RUNTIME_BIND_EVENT_TYPE,
      payload: { path, value },
    });
  }

  private dispatchRuntimeEvent(
    mountPoint: HTMLElement,
    session: MountSession,
    runtimeEvent: RuntimeEvent,
  ): void {
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
    const loaded = this.options.loadPreactRenderer
      ? await this.options.loadPreactRenderer()
      : ((await import(
          /* webpackIgnore: true */ getPreactSpecifier()
        )) as unknown);
    if (!isPreactRendererLike(loaded)) {
      throw new Error("Failed to load preact renderer from `preact` package");
    }

    return loaded;
  }

  private async loadPreactRenderToString(): Promise<
    (payload: unknown) => string
  > {
    const loaded = (await import(
      /* webpackIgnore: true */ getPreactRenderToStringSpecifier()
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

const CONTROL_BIND_ATTRIBUTE = "data-renderify-bind";
const BINDABLE_TAG_NAMES = new Set(["input", "textarea", "select"]);
const UNCAPTURED_INPUT_TYPES = new Set([
  "password",
  "file",
  "button",
  "submit",
  "reset",
  "image",
]);

/**
 * DOM events a binding listens to: `onEnter` is a keydown filtered to Enter,
 * and `onSubmit` on a form container is emulated from submit-button clicks
 * and Enter in its text fields.
 */
function toDomListenerTypes(domEvent: string): string[] {
  if (domEvent === "enter") {
    return ["keydown"];
  }
  if (domEvent === "submit") {
    return ["click", "keydown"];
  }
  return [domEvent];
}

const FORM_SUBMISSION_PROPS = new Set([
  "action",
  "method",
  "target",
  "enctype",
  "novalidate",
  "accept-charset",
  "acceptcharset",
]);

function withoutFormSubmissionProps(
  props: Record<string, JsonValue> | undefined,
): Record<string, JsonValue> | undefined {
  if (!props) {
    return props;
  }
  return Object.fromEntries(
    Object.entries(props).filter(
      ([key]) => !FORM_SUBMISSION_PROPS.has(key.toLowerCase()),
    ),
  );
}

function isSubmitControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  const type = ((element as HTMLButtonElement).type || "").toLowerCase();
  return (
    (tag === "button" && type === "submit") ||
    (tag === "input" && (type === "submit" || type === "image"))
  );
}

const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "file",
  "button",
  "submit",
  "reset",
  "image",
  "range",
  "color",
  "hidden",
]);

function isImplicitSubmitField(element: Element): boolean {
  return (
    element.tagName.toLowerCase() === "input" &&
    !NON_TEXT_INPUT_TYPES.has(
      ((element as HTMLInputElement).type || "text").toLowerCase(),
    )
  );
}

const FORM_FIELD_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const UNSAFE_FIELD_NAMES = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Reads named fields inside a form container, like FormData but as JSON:
 * a lone checkbox is a boolean, a group of same-named checkboxes is the
 * array of checked values, a radio group is the checked value or null.
 * Password, file, and disabled fields are skipped.
 */
function collectFormFields(form: Element): Record<string, JsonValue> {
  const fields: Record<string, JsonValue> = {};
  const controls = Array.from(
    form.querySelectorAll("input[name], select[name], textarea[name]"),
  );
  const checkboxCounts = new Map<string, number>();
  for (const control of controls) {
    if (readControlType(control) === "checkbox") {
      const name = control.getAttribute("name") ?? "";
      checkboxCounts.set(name, (checkboxCounts.get(name) ?? 0) + 1);
    }
  }

  for (const control of controls) {
    const name = control.getAttribute("name") ?? "";
    const type = readControlType(control);
    if (
      !FORM_FIELD_NAME_PATTERN.test(name) ||
      UNSAFE_FIELD_NAMES.has(name) ||
      type === undefined ||
      (control as HTMLInputElement).disabled
    ) {
      continue;
    }
    if (type === "radio") {
      const input = control as HTMLInputElement;
      if (input.checked) {
        fields[name] = input.value;
      } else if (!Object.hasOwn(fields, name)) {
        fields[name] = null;
      }
      continue;
    }
    if (type === "checkbox" && (checkboxCounts.get(name) ?? 0) > 1) {
      const input = control as HTMLInputElement;
      const checked = Array.isArray(fields[name])
        ? (fields[name] as JsonValue[])
        : [];
      fields[name] = input.checked ? [...checked, input.value] : checked;
      continue;
    }
    const value = readControlValue(control);
    if (value !== undefined) {
      fields[name] = value;
    }
  }
  return fields;
}

function isPlainEnterKey(event: Event): boolean {
  const keyboard = event as KeyboardEvent;
  return (
    keyboard.key === "Enter" &&
    !keyboard.isComposing &&
    !keyboard.shiftKey &&
    !keyboard.altKey &&
    !keyboard.ctrlKey &&
    !keyboard.metaKey
  );
}

function readControlType(element: Element): string | undefined {
  const tag = element.tagName.toLowerCase();
  if (!BINDABLE_TAG_NAMES.has(tag)) {
    return undefined;
  }
  return tag === "input"
    ? ((element as HTMLInputElement).type || "text").toLowerCase()
    : tag;
}

/** Checkboxes, radios, and selects commit on change; text-like controls on input. */
function getControlBindDomEvent(element: Element): "input" | "change" {
  const type = readControlType(element);
  return type === "checkbox" || type === "radio" || type === "select"
    ? "change"
    : "input";
}

/**
 * Reads a form control's current value as JSON: booleans for checkboxes,
 * numbers for number and range inputs, an array for multi-selects, and
 * strings otherwise. Password and file inputs are never read.
 */
function readControlValue(element: Element): JsonValue | undefined {
  const type = readControlType(element);
  if (type === undefined || UNCAPTURED_INPUT_TYPES.has(type)) {
    return undefined;
  }
  if (type === "checkbox") {
    return (element as HTMLInputElement).checked;
  }
  if (type === "number" || type === "range") {
    const input = element as HTMLInputElement;
    return Number.isFinite(input.valueAsNumber)
      ? input.valueAsNumber
      : input.value;
  }
  if (type === "select" && (element as HTMLSelectElement).multiple) {
    return Array.from((element as HTMLSelectElement).selectedOptions).map(
      (option) => option.value,
    );
  }
  return (element as HTMLInputElement).value;
}

function captureControlValues(
  target: Element,
  matched: Element,
): Record<string, JsonValue> | undefined {
  const control =
    readControlType(target) !== undefined
      ? target
      : readControlType(matched) !== undefined
        ? matched
        : undefined;
  if (!control) {
    return undefined;
  }
  const value = readControlValue(control);
  if (value === undefined) {
    return undefined;
  }
  const type = readControlType(control);
  return type === "checkbox" || type === "radio"
    ? { value, checked: (control as HTMLInputElement).checked }
    : { value };
}

const BLOCKED_TAG_NAMES = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "animate",
  "set",
]);

const BLOCKED_ATTRIBUTE_NAMES = new Set([
  "srcdoc",
  "innerhtml",
  "dangerouslysetinnerhtml",
]);

const UNSAFE_STYLE_PATTERNS = [
  /\bexpression\s*\(/i,
  /\burl\s*\(/i,
  /\bjavascript\s*:/i,
  /\bdata\s*:/i,
  /@import/i,
  /\bbehavior\s*:/i,
  /-moz-binding/i,
] as const;

const UNITLESS_CSS_NUMBER_PROPERTIES = new Set([
  "animation-iteration-count",
  "aspect-ratio",
  "border-image-outset",
  "border-image-slice",
  "border-image-width",
  "box-flex",
  "box-flex-group",
  "box-ordinal-group",
  "column-count",
  "columns",
  "fill-opacity",
  "flex",
  "flex-grow",
  "flex-negative",
  "flex-order",
  "flex-positive",
  "flex-shrink",
  "flood-opacity",
  "font-size-adjust",
  "font-weight",
  "grid-area",
  "grid-column",
  "grid-column-end",
  "grid-column-span",
  "grid-column-start",
  "grid-row",
  "grid-row-end",
  "grid-row-span",
  "grid-row-start",
  "line-clamp",
  "line-height",
  "opacity",
  "order",
  "orphans",
  "scale",
  "shape-image-threshold",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "widows",
  "z-index",
  "zoom",
]);

function sanitizeTagName(tag: string): string | undefined {
  const normalized = normalizeTagName(tag);
  if (!normalized) {
    return undefined;
  }

  if (BLOCKED_TAG_NAMES.has(normalized)) {
    return undefined;
  }

  return normalized;
}

function normalizeTagName(tag: string): string | undefined {
  const normalized = tag.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    return undefined;
  }

  return normalized;
}

function isSafeAttributeName(attributeName: string): boolean {
  return /^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(attributeName);
}

function serializeProps(
  props: Record<string, JsonValue> | undefined,
  context: RenderSerializationContext,
  tagName: string,
): string {
  if (!props) {
    return "";
  }

  const attributes: string[] = [];
  let targetIsBlank = false;
  let relProvided = false;
  const hasCanonicalClass = Object.hasOwn(props, "class");
  const hasCanonicalFor = Object.hasOwn(props, "for");

  for (const [key, rawValue] of Object.entries(props)) {
    if (
      (key === "className" && hasCanonicalClass) ||
      (key === "htmlFor" && hasCanonicalFor)
    ) {
      continue;
    }
    const attributeName =
      key === "className" ? "class" : key === "htmlFor" ? "for" : key;
    if (!isSafeAttributeName(attributeName)) {
      continue;
    }

    const normalizedKey = attributeName.toLowerCase();
    if (BLOCKED_ATTRIBUTE_NAMES.has(normalizedKey)) {
      continue;
    }

    if (key === "key") {
      if (typeof rawValue === "string" || typeof rawValue === "number") {
        attributes.push(
          ` data-renderify-key="${escapeHtml(String(rawValue))}"`,
        );
      }
      continue;
    }

    if (key === "bind") {
      const path = normalizeRuntimeBindPath(rawValue);
      const inputType =
        typeof props.type === "string"
          ? props.type.trim().toLowerCase()
          : "text";
      if (
        path &&
        BINDABLE_TAG_NAMES.has(tagName) &&
        !(tagName === "input" && UNCAPTURED_INPUT_TYPES.has(inputType))
      ) {
        const bindId = `bind_${String(++context.nextBindId)}`;
        context.controlBindings.push({ bindId, path });
        attributes.push(` ${CONTROL_BIND_ATTRIBUTE}="${escapeHtml(bindId)}"`);
      }
      continue;
    }

    const eventSpec = parseRuntimeEventBinding(key, rawValue);
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

    if (isRuntimeUrlAttribute(normalizedKey)) {
      if (typeof rawValue !== "string") {
        continue;
      }
      const inspection = inspectRuntimeUrlAttribute(normalizedKey, rawValue);
      if (!inspection.safe || inspection.remoteUrls.length > 0) {
        continue;
      }
    }

    if (normalizedKey === "style") {
      const sanitizedStyle = normalizeInlineStyleValue(rawValue);
      if (!sanitizedStyle) {
        continue;
      }

      attributes.push(` style="${escapeHtml(sanitizedStyle)}"`);
      continue;
    }

    if (normalizedKey.startsWith("on")) {
      continue;
    }

    if (normalizedKey === "target" && String(rawValue).trim() === "_blank") {
      targetIsBlank = true;
    }

    if (normalizedKey === "rel") {
      relProvided = true;
    }

    if (typeof rawValue === "boolean") {
      if (rawValue) {
        attributes.push(` ${attributeName}`);
      }
      continue;
    }

    if (rawValue === null || typeof rawValue === "object") {
      attributes.push(
        ` ${attributeName}='${escapeHtml(JSON.stringify(rawValue))}'`,
      );
      continue;
    }

    attributes.push(` ${attributeName}="${escapeHtml(String(rawValue))}"`);
  }

  if (targetIsBlank && !relProvided) {
    attributes.push(' rel="noopener noreferrer"');
  }

  return attributes.join("");
}

function normalizeInlineStyleValue(style: JsonValue): string | undefined {
  if (typeof style === "string") {
    return sanitizeInlineStyle(style);
  }
  if (style === null || Array.isArray(style) || typeof style !== "object") {
    return undefined;
  }

  const declarations: string[] = [];
  for (const [rawProperty, rawValue] of Object.entries(style)) {
    const property = normalizeCssPropertyName(rawProperty);
    if (
      !property ||
      (typeof rawValue !== "string" && typeof rawValue !== "number")
    ) {
      continue;
    }

    const value = normalizeCssPropertyValue(property, rawValue);
    if (!value) {
      continue;
    }
    declarations.push(`${property}:${value};`);
  }

  return declarations.length > 0
    ? sanitizeInlineStyle(declarations.join(""))
    : undefined;
}

function normalizeCssPropertyValue(
  property: string,
  value: string | number,
): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const normalized = String(value);
  if (
    value === 0 ||
    property.startsWith("--") ||
    isUnitlessCssNumberProperty(property)
  ) {
    return normalized;
  }
  return `${normalized}px`;
}

function isUnitlessCssNumberProperty(property: string): boolean {
  const unprefixed = property.replace(/^-(?:webkit|moz|ms|o)-/, "");
  return UNITLESS_CSS_NUMBER_PROPERTIES.has(unprefixed);
}

function normalizeCssPropertyName(property: string): string | undefined {
  const trimmed = property.trim().replace(/^WebKit/, "Webkit");
  if (/^--[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  if (/^-(?:webkit|moz|ms|o)-[A-Za-z][A-Za-z0-9-]*$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(trimmed)) {
    return undefined;
  }

  const normalized = trimmed
    .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
    .toLowerCase();
  return /^(?:webkit|moz|ms|o)-/.test(normalized)
    ? `-${normalized}`
    : normalized;
}

function sanitizeInlineStyle(style: string): string | undefined {
  const normalized = style.trim();
  if (normalized.length === 0 || hasRuntimeCssImageSetFunction(normalized)) {
    return undefined;
  }

  const inspected = normalizeStyleForSecurityInspection(normalized);
  if (inspected.length === 0) {
    return undefined;
  }

  for (const pattern of UNSAFE_STYLE_PATTERNS) {
    if (pattern.test(inspected)) {
      return undefined;
    }
  }

  return normalized;
}

function normalizeStyleForSecurityInspection(style: string): string {
  const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
  const decodedEscapes = decodeCssEscapes(withoutComments).replace(/\0/g, "");
  return decodedEscapes.replace(/\s+/g, " ").trim().toLowerCase();
}

function decodeCssEscapes(input: string): string {
  return input.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|(.))/g,
    (_match, hexCodePoint: string | undefined, escapedChar: string) => {
      if (hexCodePoint) {
        const parsed = Number.parseInt(hexCodePoint, 16);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0x10ffff) {
          return "";
        }
        return String.fromCodePoint(parsed);
      }

      return escapedChar;
    },
  );
}

function sanitizeRenderedFragment(fragment: DocumentFragment): void {
  sanitizeRenderedSubtree(fragment);
}

function sanitizeRenderedSubtree(root: ParentNode): void {
  const elements = Array.from(root.querySelectorAll("*"));

  for (const element of elements) {
    if (!element.isConnected) {
      continue;
    }

    const tagName = element.tagName.toLowerCase();
    if (!sanitizeTagName(tagName)) {
      replaceBlockedElement(element, tagName);
      continue;
    }

    sanitizeElementAttributes(element);

    const shadowRoot = (element as Element & { shadowRoot?: ShadowRoot | null })
      .shadowRoot;
    if (shadowRoot) {
      sanitizeRenderedSubtree(shadowRoot);
    }
  }
}

function replaceBlockedElement(element: Element, tagName: string): void {
  const replacement = element.ownerDocument.createElement("div");
  replacement.setAttribute("data-renderify-sanitized-tag", tagName);
  element.replaceWith(replacement);
}

function sanitizeElementAttributes(element: Element): void {
  let targetIsBlank = false;
  let relProvided = false;

  for (const attribute of Array.from(element.attributes)) {
    const key = attribute.name;
    const value = attribute.value;
    const normalizedKey = key.toLowerCase();

    if (
      !isSafeAttributeName(key) ||
      BLOCKED_ATTRIBUTE_NAMES.has(normalizedKey)
    ) {
      element.removeAttribute(key);
      continue;
    }

    if (normalizedKey.startsWith("on")) {
      element.removeAttribute(key);
      continue;
    }

    if (isRuntimeUrlAttribute(normalizedKey)) {
      const inspection = inspectRuntimeUrlAttribute(normalizedKey, value);
      if (!inspection.safe || inspection.remoteUrls.length > 0) {
        element.removeAttribute(key);
        continue;
      }
    }

    if (normalizedKey === "style") {
      const sanitizedStyle = sanitizeInlineStyle(value);
      if (!sanitizedStyle) {
        element.removeAttribute(key);
        continue;
      }
      if (sanitizedStyle !== value) {
        element.setAttribute(key, sanitizedStyle);
      }
    }

    if (normalizedKey === "target" && value.trim() === "_blank") {
      targetIsBlank = true;
    }

    if (normalizedKey === "rel") {
      relProvided = true;
    }
  }

  if (targetIsBlank && !relProvided) {
    element.setAttribute("rel", "noopener noreferrer");
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
