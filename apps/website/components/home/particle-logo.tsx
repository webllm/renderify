"use client";

import { MousePointer2, RefreshCw } from "lucide-react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import logo from "@/assets/brand/renderify-logo.webp";
import { ParticleLogoEngine, type ParticleTheme } from "./particle-logo-engine";

/**
 * Interactive 3D particle rendering of the Renderify logo. The static logo is
 * server-rendered underneath and stays visible when WebGL is unavailable.
 */
export function ParticleLogo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ParticleLogoEngine | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [canBurst, setCanBurst] = useState(false);
  const { resolvedTheme } = useTheme();
  const theme: ParticleTheme = resolvedTheme === "dark" ? "dark" : "light";

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }

    let disposed = false;
    let engine: ParticleLogoEngine | undefined;
    const cleanups: Array<() => void> = [];
    const image = new window.Image();
    image.decoding = "async";
    image.src = logo.src;

    void image
      .decode()
      .then(() => {
        if (disposed) {
          return;
        }
        const rect = container.getBoundingClientRect();
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        engine = ParticleLogoEngine.create({
          canvas,
          image,
          particleCount: rect.width < 480 ? 7000 : 12500,
          reducedMotion,
          theme: document.documentElement.classList.contains("dark")
            ? "dark"
            : "light",
        });
        if (!engine) {
          return;
        }
        const activeEngine = engine;
        engineRef.current = activeEngine;

        const resize = () => {
          const bounds = container.getBoundingClientRect();
          activeEngine.setSize(
            bounds.width,
            bounds.height,
            window.devicePixelRatio || 1,
          );
        };
        resize();
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        cleanups.push(() => resizeObserver.disconnect());

        const intersectionObserver = new IntersectionObserver(([entry]) => {
          activeEngine.setVisible(Boolean(entry?.isIntersecting));
        });
        intersectionObserver.observe(container);
        cleanups.push(() => intersectionObserver.disconnect());

        const toDevice = (event: PointerEvent) => {
          const bounds = container.getBoundingClientRect();
          const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
          const y = 1 - ((event.clientY - bounds.top) / bounds.height) * 2;
          return { inside: Math.abs(x) <= 1 && Math.abs(y) <= 1, x, y };
        };
        const handleMove = (event: PointerEvent) => {
          const point = toDevice(event);
          activeEngine.setPointer(point.x, point.y, point.inside);
        };
        const handleRelease = (event: PointerEvent) => {
          if (event.pointerType !== "mouse") {
            activeEngine.releasePointer();
          }
        };
        const handleOut = (event: PointerEvent) => {
          if (!event.relatedTarget) {
            activeEngine.releasePointer();
          }
        };
        const handleDown = (event: PointerEvent) => {
          const point = toDevice(event);
          activeEngine.burst(point.x, point.y);
        };
        window.addEventListener("pointermove", handleMove, { passive: true });
        window.addEventListener("pointerup", handleRelease, { passive: true });
        window.addEventListener("pointercancel", handleRelease, {
          passive: true,
        });
        window.addEventListener("pointerout", handleOut, { passive: true });
        canvas.addEventListener("pointerdown", handleDown);
        cleanups.push(() => {
          window.removeEventListener("pointermove", handleMove);
          window.removeEventListener("pointerup", handleRelease);
          window.removeEventListener("pointercancel", handleRelease);
          window.removeEventListener("pointerout", handleOut);
          canvas.removeEventListener("pointerdown", handleDown);
        });

        activeEngine.start();
        setReady(true);
        setCanBurst(!reducedMotion);
      })
      .catch(() => {
        // Keep the static logo when the image cannot be decoded.
      });

    return () => {
      disposed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
      engine?.dispose();
      engineRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <figure className="particle-logo" data-ready={ready}>
      <div className="particle-logo-stage" ref={containerRef}>
        <div aria-hidden="true" className="particle-logo-floor" />
        <div aria-hidden="true" className="particle-logo-halo" />
        <Image
          alt="Renderify logo"
          className="particle-logo-fallback"
          preload
          sizes="(min-width: 1024px) 340px, 60vw"
          src={logo}
        />
        <div aria-hidden="true" className="particle-logo-layer">
          <canvas className="particle-logo-canvas" ref={canvasRef} />
        </div>
      </div>
      <figcaption className="particle-logo-caption">
        <span>
          <MousePointer2 aria-hidden="true" size={13} />
          Move through the logo
        </span>
        {canBurst ? (
          <button onClick={() => engineRef.current?.burst()} type="button">
            <RefreshCw aria-hidden="true" size={13} />
            Re-render
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}
