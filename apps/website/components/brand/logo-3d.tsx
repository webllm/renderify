"use client";

import Image from "next/image";
import { type CSSProperties, useEffect, useRef } from "react";
import logo from "@/assets/brand/renderify-logo.webp";

// Identical silhouettes stacked along Z read as a solid extrusion when the
// object turns; back layers are darkened in CSS to form the side walls.
const LAYERS = Array.from({ length: 14 }, (_, index) => ({
  id: `layer-${index}`,
  index,
}));

const MAX_TURN_Y = 32;
const MAX_TURN_X = 22;

/**
 * The Renderify logo extruded into a 3D solid. It turns toward the pointer
 * anywhere on the page and floats gently while idle. Decorative only.
 */
export function Logo3D({ className }: { className?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (
      !root ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    let frame = 0;
    let pointer: { x: number; y: number } | undefined;

    const update = () => {
      frame = 0;
      if (!pointer) {
        return;
      }
      const bounds = root.getBoundingClientRect();
      const x =
        (pointer.x - (bounds.left + bounds.width / 2)) / window.innerWidth;
      const y =
        (pointer.y - (bounds.top + bounds.height / 2)) / window.innerHeight;
      const turnY = clamp(x * 80, -MAX_TURN_Y, MAX_TURN_Y);
      const turnX = clamp(-y * 60, -MAX_TURN_X, MAX_TURN_X);
      root.style.setProperty("--logo-3d-ry", `${turnY.toFixed(2)}deg`);
      root.style.setProperty("--logo-3d-rx", `${turnX.toFixed(2)}deg`);
      root.style.setProperty(
        "--logo-3d-shine",
        `${(50 - (turnY / MAX_TURN_Y) * 45).toFixed(1)}%`,
      );
      root.dataset.tracking = "true";
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      if (!frame) {
        frame = requestAnimationFrame(update);
      }
    };
    const leave = (event: PointerEvent) => {
      if (event.relatedTarget) {
        return;
      }
      pointer = undefined;
      delete root.dataset.tracking;
      for (const property of [
        "--logo-3d-rx",
        "--logo-3d-ry",
        "--logo-3d-shine",
      ]) {
        root.style.removeProperty(property);
      }
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerout", leave, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      cancelAnimationFrame(frame);
    };
  }, []);

  const mask = `url(${logo.src})`;

  return (
    <div
      aria-hidden="true"
      className={className ? `logo-3d ${className}` : "logo-3d"}
      ref={rootRef}
    >
      <div className="logo-3d-float">
        <div className="logo-3d-object">
          {LAYERS.map((layer) => (
            <Image
              alt=""
              className="logo-3d-layer"
              draggable={false}
              key={layer.id}
              sizes="(min-width: 1024px) 18rem, 14rem"
              src={logo}
              style={{ "--logo-3d-layer": layer.index } as CSSProperties}
            />
          ))}
          <span
            className="logo-3d-shine"
            style={{ maskImage: mask, WebkitMaskImage: mask }}
          />
        </div>
      </div>
      <span className="logo-3d-shadow" />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
