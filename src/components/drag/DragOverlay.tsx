// Author: Liz
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const SNAP_DURATION_MS = 140;

export interface DragOverlayHandle {
  moveTo: (x: number, y: number) => void;
  animateTo: (rect: Pick<DOMRect, "left" | "top" | "width" | "height">) => Promise<void>;
}

interface DragOverlayProps {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  variant: "tab" | "session";
}

export const DragOverlay = forwardRef<DragOverlayHandle, DragOverlayProps>(function DragOverlay(
  { label, x, y, width, height, variant },
  ref,
) {
  const overlayRef = useRef<HTMLDivElement>(null);

  function setPosition(left: number, top: number) {
    if (overlayRef.current) {
      overlayRef.current.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }
  }

  useLayoutEffect(() => setPosition(x, y), [x, y]);

  useImperativeHandle(ref, () => ({
    moveTo: setPosition,
    animateTo: (rect) =>
      new Promise<void>((resolve) => {
        const overlay = overlayRef.current;
        if (!overlay) {
          resolve();
          return;
        }
        overlay.classList.add("snapping");
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
        setPosition(rect.left, rect.top);
        window.setTimeout(resolve, SNAP_DURATION_MS);
      }),
  }));

  return createPortal(
    <div
      ref={overlayRef}
      className={`zt-drag-overlay zt-drag-overlay-${variant}`}
      style={{ width, height }}
      aria-hidden="true"
    >
      <span>{label}</span>
    </div>,
    document.body,
  );
});

