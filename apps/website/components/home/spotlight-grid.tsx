"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Tracks the pointer across a grid and exposes its position to every
 * `[data-spotlight]` child as --spot-x / --spot-y, so neighboring cards light
 * up together. Updates are batched to one per animation frame.
 */
export function SpotlightGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) {
      return;
    }
    let frame = 0;
    let pointer: { x: number; y: number } | undefined;

    const update = () => {
      frame = 0;
      if (!pointer) {
        return;
      }
      for (const card of grid.querySelectorAll<HTMLElement>(
        "[data-spotlight]",
      )) {
        const bounds = card.getBoundingClientRect();
        card.style.setProperty("--spot-x", `${pointer.x - bounds.left}px`);
        card.style.setProperty("--spot-y", `${pointer.y - bounds.top}px`);
      }
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

    grid.addEventListener("pointermove", move, { passive: true });
    return () => {
      grid.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className={className} ref={gridRef}>
      {children}
    </div>
  );
}
