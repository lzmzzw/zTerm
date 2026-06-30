// Author: Liz
import type { PaneTerminalTab } from "../workspace/types";

interface TerminalSnapshotPaneProps {
  title: string;
  text?: string | null;
  restoreStatus?: PaneTerminalTab["restore_status"];
  restoreError?: string | null;
  mode?: "terminal" | "rdp";
}

export function TerminalSnapshotPane({
  title,
  text,
  restoreStatus,
  restoreError,
  mode = "terminal",
}: TerminalSnapshotPaneProps) {
  const content = snapshotContent(title, text, restoreStatus, restoreError, mode);
  return (
    <div className="zt-terminal-surface zt-terminal-snapshot-pane" aria-label={`终端快照 ${title}`}>
      <pre>{content}</pre>
    </div>
  );
}

function snapshotContent(
  title: string,
  text: string | null | undefined,
  restoreStatus: PaneTerminalTab["restore_status"],
  restoreError: string | null | undefined,
  mode: "terminal" | "rdp",
) {
  if (mode === "rdp") {
    return title || "RDP 连接占位";
  }
  if (text) {
    return text;
  }
  if (restoreStatus === "failed") {
    return restoreError ?? "连接失败";
  }
  if (restoreStatus === "pending") {
    return `正在连接 ${title}`;
  }
  if (restoreStatus === "queued") {
    return `等待连接 ${title}`;
  }
  return title ? `正在准备 ${title}` : "";
}
