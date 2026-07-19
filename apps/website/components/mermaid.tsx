"use client";

import { useTheme } from "next-themes";
import { useEffect, useId, useRef, useState } from "react";

const renderCache = new Map<string, Promise<MermaidRenderResult>>();

interface MermaidRenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

export function Mermaid({ chart }: { chart: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="mermaid-placeholder">Loading diagram…</div>;
  }

  return <MermaidContent chart={chart} />;
}

function MermaidContent({ chart }: { chart: string }) {
  const id = useId().replaceAll(":", "");
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const cacheKey = `${resolvedTheme ?? "light"}:${chart}`;
  const [result, setResult] = useState<MermaidRenderResult | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const pending = getCachedRender(cacheKey, async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        fontFamily: "inherit",
        securityLevel: "strict",
        startOnLoad: false,
        theme: resolvedTheme === "dark" ? "dark" : "default",
      });
      return mermaid.render(`renderify-${id}`, chart.replaceAll("\\n", "\n"));
    });
    void pending.then(
      (rendered) => {
        if (active) {
          setResult(rendered);
          setError(undefined);
        }
      },
      (reason: unknown) => {
        if (active) {
          setResult(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [cacheKey, chart, id, resolvedTheme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !result) {
      return;
    }

    const parsed = new DOMParser().parseFromString(result.svg, "image/svg+xml");
    if (parsed.querySelector("parsererror")) {
      container.textContent = "Unable to render this diagram.";
      return;
    }

    for (const unsafeElement of parsed.querySelectorAll(
      "script, foreignObject",
    )) {
      unsafeElement.remove();
    }
    for (const element of parsed.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on") || value.startsWith("javascript:")) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    container.replaceChildren(
      document.importNode(parsed.documentElement, true),
    );
    result.bindFunctions?.(container);
    return () => container.replaceChildren();
  }, [result]);

  if (error) {
    return (
      <div className="mermaid-error" role="alert">
        Unable to render this diagram: {error}
      </div>
    );
  }

  if (!result) {
    return <div className="mermaid-placeholder">Rendering diagram…</div>;
  }

  return <div className="mermaid-diagram" ref={containerRef} />;
}

function getCachedRender(
  key: string,
  render: () => Promise<MermaidRenderResult>,
): Promise<MermaidRenderResult> {
  const cached = renderCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = render();
  renderCache.set(key, pending);
  void pending.catch(() => {
    if (renderCache.get(key) === pending) {
      renderCache.delete(key);
    }
  });
  return pending;
}
