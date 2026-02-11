import type {
  JsonValue,
  RuntimeExecutionResult,
  RuntimeNode,
} from "@renderify/ir";

export type RenderTarget = string | HTMLElement;

export interface UIRenderer {
  render(
    result: RuntimeExecutionResult,
    target?: RenderTarget,
  ): Promise<string>;
  renderNode(node: RuntimeNode): string;
}

export class DefaultUIRenderer implements UIRenderer {
  async render(
    result: RuntimeExecutionResult,
    target?: RenderTarget,
  ): Promise<string> {
    if (result.renderArtifact?.mode === "preact-vnode") {
      return this.renderPreactArtifact(result.renderArtifact.payload, target);
    }

    const html = this.renderNode(result.root);

    if (typeof document === "undefined") {
      return html;
    }

    if (!target) {
      return html;
    }

    const mountPoint = this.resolveTarget(target);
    if (!mountPoint) {
      throw new Error(`Render target not found: ${String(target)}`);
    }

    mountPoint.innerHTML = html;
    return html;
  }

  private async renderPreactArtifact(
    payload: unknown,
    target?: RenderTarget,
  ): Promise<string> {
    if (typeof document !== "undefined" && target) {
      const mountPoint = this.resolveTarget(target);
      if (!mountPoint) {
        throw new Error(`Render target not found: ${String(target)}`);
      }

      const preact = await this.loadPreactRenderer();
      preact.render(payload, mountPoint);
      return mountPoint.innerHTML;
    }

    const renderToString = await this.loadPreactRenderToString();
    return renderToString(payload);
  }

  renderNode(node: RuntimeNode): string {
    if (node.type === "text") {
      return escapeHtml(node.value);
    }

    if (node.type === "component") {
      return `<div data-renderify-unresolved-component="${escapeHtml(node.module)}"></div>`;
    }

    const attributes = serializeProps(node.props);
    const children = (node.children ?? [])
      .map((child) => this.renderNode(child))
      .join("");
    return `<${node.tag}${attributes}>${children}</${node.tag}>`;
  }

  private resolveTarget(target: RenderTarget): HTMLElement | null {
    if (typeof target !== "string") {
      return target;
    }

    return document.querySelector<HTMLElement>(target);
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

function getPreactSpecifier(): string {
  return "preact";
}

function getPreactRenderToStringSpecifier(): string {
  return "preact-render-to-string";
}

function serializeProps(props?: Record<string, JsonValue>): string {
  if (!props) {
    return "";
  }

  const attributes: string[] = [];

  for (const [key, rawValue] of Object.entries(props)) {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
