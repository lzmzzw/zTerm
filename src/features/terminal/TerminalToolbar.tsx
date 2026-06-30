// Author: Liz
import { SquareSplitHorizontal, SquareSplitVertical, X } from "lucide-react";

import type { PaneSplitDirection } from "../workspace/types";

interface TerminalToolbarProps {
  onSplitPane: (direction: PaneSplitDirection) => void;
  onClosePane: () => void;
}

export function TerminalToolbar({ onSplitPane, onClosePane }: TerminalToolbarProps) {
  return (
    <div className="zt-terminal-toolbar" aria-label="终端分栏操作">
      <button type="button" aria-label="横向分栏" onClick={() => onSplitPane("horizontal")}>
        <SquareSplitHorizontal size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="纵向分栏" onClick={() => onSplitPane("vertical")}>
        <SquareSplitVertical size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="关闭分栏" onClick={onClosePane}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
