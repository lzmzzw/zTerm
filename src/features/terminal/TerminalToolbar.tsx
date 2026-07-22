// Author: Liz
import { CircleX, LogOut, SquareSplitHorizontal, SquareSplitVertical, X } from "lucide-react";

import type { PaneSplitDirection } from "../workspace/types";

interface TerminalToolbarProps {
  onSplitPane: (direction: PaneSplitDirection) => void;
  onClosePane: () => void;
  canSplitHorizontal?: boolean;
  canSplitVertical?: boolean;
  syncChannelMember?: boolean;
  onLeaveSyncChannel?: () => void;
  onCloseSyncChannel?: () => void;
}

export function TerminalToolbar({
  onSplitPane,
  onClosePane,
  canSplitHorizontal = true,
  canSplitVertical = true,
  syncChannelMember = false,
  onLeaveSyncChannel,
  onCloseSyncChannel,
}: TerminalToolbarProps) {
  return (
    <div className="zt-terminal-toolbar" aria-label="终端分栏操作">
      {syncChannelMember ? (
        <>
          <button type="button" aria-label="离开同步频道" title="离开同步频道" onClick={onLeaveSyncChannel}>
            <LogOut size={14} aria-hidden="true" />
          </button>
          <button type="button" aria-label="关闭同步频道" title="关闭同步频道" onClick={onCloseSyncChannel}>
            <CircleX size={14} aria-hidden="true" />
          </button>
          <span className="zt-terminal-toolbar-separator" aria-hidden="true" />
        </>
      ) : null}
      <button
        type="button"
        aria-label="横向分栏"
        title={canSplitHorizontal ? "横向分栏" : "继续分栏会使宽度小于页面的 1/4"}
        disabled={!canSplitHorizontal}
        onClick={() => onSplitPane("horizontal")}
      >
        <SquareSplitHorizontal size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="纵向分栏"
        title={canSplitVertical ? "纵向分栏" : "继续分栏会使高度小于页面的 1/4"}
        disabled={!canSplitVertical}
        onClick={() => onSplitPane("vertical")}
      >
        <SquareSplitVertical size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="关闭分栏" onClick={onClosePane}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
