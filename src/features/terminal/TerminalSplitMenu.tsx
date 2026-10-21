// Author: Liz
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { ZtContextMenu } from "../../components/ZtUi";
import type { PaneSplitDirection } from "../terminal-layout/types";

export function TerminalSplitMenu({
  x, y, availability, onSplit, onClose,
}: {
  x: number;
  y: number;
  availability: Record<PaneSplitDirection, boolean>;
  onSplit: (direction: PaneSplitDirection) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, x, y]);

  return createPortal(
    <div ref={menuRef} onClick={(event) => event.stopPropagation()}>
      <ZtContextMenu
        className="zt-context-menu"
        role="menu"
        aria-label="终端分屏"
        x={x}
        y={y}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          if (items.length === 0) return;
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }}
      >
        {([
          ["horizontal", "左右分屏", "继续分屏会使宽度小于页面的 1/4"],
          ["vertical", "上下分屏", "继续分屏会使高度小于页面的 1/4"],
        ] as const).map(([direction, label, limit]) => (
          <button
            key={direction}
            type="button"
            role="menuitem"
            disabled={!availability[direction]}
            title={availability[direction] ? undefined : limit}
            onClick={() => {
              onClose();
              onSplit(direction);
            }}
          >
            {label}
          </button>
        ))}
      </ZtContextMenu>
    </div>,
    document.body,
  );
}
