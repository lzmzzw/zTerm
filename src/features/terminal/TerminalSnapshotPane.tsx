// Author: Liz
import type { PaneTerminalTab } from "../workspace/types";

interface TerminalSnapshotPaneProps {
  title: string;
  text?: string | null;
  restoreStatus?: PaneTerminalTab["restore_status"];
  restoreError?: string | null;
  mode?: "terminal" | "rdp";
}

const ANSI_CONTROL_SEQUENCE_PATTERN = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

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
    const snapshotText = sanitizeSnapshotText(text);
    if (snapshotText.trim()) {
      return snapshotText;
    }
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

function sanitizeSnapshotText(text: string) {
  return text.replace(ANSI_CONTROL_SEQUENCE_PATTERN, "");
}
