// Author: Liz
import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

const FLIP_DURATION_MS = 140;

export function useFlipLayout(containerRef: RefObject<HTMLElement | null>, dependency: unknown) {
  const previousRectsRef = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const items = Array.from(container.querySelectorAll<HTMLElement>("[data-flip-id]"));
    const nextRects = new Map(items.map((item) => [item.dataset.flipId ?? "", item.getBoundingClientRect()]));
    const animatedItems: HTMLElement[] = [];

    for (const item of items) {
      const id = item.dataset.flipId ?? "";
      const previous = previousRectsRef.current.get(id);
      const next = nextRects.get(id);
      if (!previous || !next) continue;
      const deltaX = previous.left - next.left;
      const deltaY = previous.top - next.top;
      if (deltaX === 0 && deltaY === 0) continue;
      item.style.transition = "none";
      item.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      animatedItems.push(item);
    }

    previousRectsRef.current = nextRects;
    if (animatedItems.length === 0) return undefined;

    const frame = window.requestAnimationFrame(() => {
      for (const item of animatedItems) {
        item.style.transition = `transform ${FLIP_DURATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
        item.style.transform = "translate3d(0, 0, 0)";
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [containerRef, dependency]);
}

