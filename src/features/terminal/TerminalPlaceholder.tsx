// Author: Liz
import { Power, RefreshCw } from "lucide-react";

interface TerminalPlaceholderProps {
  mode?: "terminal" | "rdp";
  message?: string;
  title?: string;
  onDisconnect?: () => void;
  onReconnect?: () => void;
}

export function TerminalPlaceholder({
  mode = "terminal",
  message,
  title = "终端",
  onDisconnect,
  onReconnect,
}: TerminalPlaceholderProps) {
  return (
    <div className="zt-terminal-surface">
      {mode === "rdp" ? (
        <div className="zt-terminal-placeholder">
          <strong>RDP 已在外部窗口中打开</strong>
          <span>{message ?? "当前 RDP 会话使用系统远程桌面客户端。"}</span>
          <PlaceholderActions title={title} onDisconnect={onDisconnect} onReconnect={onReconnect} />
        </div>
      ) : message ? (
        <div className="zt-terminal-placeholder">
          <strong>{message}</strong>
          <span>连接建立后终端会自动显示。</span>
          <PlaceholderActions title={title} onDisconnect={onDisconnect} onReconnect={onReconnect} />
        </div>
      ) : (
        <div className="zt-terminal-empty" aria-label="空终端分栏" />
      )}
    </div>
  );
}

function PlaceholderActions({
  title,
  onDisconnect,
  onReconnect,
}: Pick<TerminalPlaceholderProps, "title" | "onDisconnect" | "onReconnect">) {
  if (!onDisconnect && !onReconnect) return null;
  return (
    <div className="zt-terminal-placeholder-actions">
      {onReconnect ? (
        <button type="button" aria-label={`重新连接 ${title}`} title="重新连接" onClick={onReconnect}>
          <RefreshCw size={14} aria-hidden="true" />
          重新连接
        </button>
      ) : null}
      {onDisconnect ? (
        <button type="button" aria-label={`断开连接 ${title}`} title="断开连接" onClick={onDisconnect}>
          <Power size={14} aria-hidden="true" />
          断开连接
        </button>
      ) : null}
    </div>
  );
}
