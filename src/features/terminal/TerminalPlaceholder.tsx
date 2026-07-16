// Author: Liz
interface TerminalPlaceholderProps {
  mode?: "terminal" | "rdp";
  message?: string;
}

export function TerminalPlaceholder({ mode = "terminal", message }: TerminalPlaceholderProps) {
  return (
    <div className="zt-terminal-surface">
      {mode === "rdp" ? (
        <div className="zt-terminal-placeholder">
          <strong>RDP 已在外部窗口中打开</strong>
          <span>{message ?? "当前 RDP 会话使用系统远程桌面客户端。"}</span>
        </div>
      ) : message ? (
        <div className="zt-terminal-placeholder">
          <strong>{message}</strong>
          <span>连接建立后终端会自动显示。</span>
        </div>
      ) : (
        <div className="zt-terminal-empty" aria-label="空终端分栏" />
      )}
    </div>
  );
}
