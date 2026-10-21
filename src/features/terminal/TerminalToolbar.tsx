// Author: Liz
import { CircleX, LogOut, X } from "lucide-react";

interface TerminalToolbarProps {
  onClosePane: () => void;
  syncChannelMember?: boolean;
  onLeaveSyncChannel?: () => void;
  onCloseSyncChannel?: () => void;
}

export function TerminalToolbar({
  onClosePane,
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
      <button type="button" aria-label="关闭分栏" title="关闭分栏" onClick={onClosePane}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
