// Author: Liz
import type { CSSProperties } from "react";

import { getActiveTerminalTab, getLeafTerminalTabs } from "./workspaceLayout";
import type { PaneNode, PaneTerminalTab } from "./types";

export interface WorkspaceLayoutPreviewSession {
  id: string;
  name: string;
}

interface WorkspaceLayoutPreviewProps {
  root: PaneNode;
  sessions: WorkspaceLayoutPreviewSession[];
  variant?: "detail" | "thumbnail";
  selectedPaneId?: string | null;
  compact?: boolean;
  interactive?: boolean;
  onSelectPane?: (paneId: string) => void;
}

export function WorkspaceLayoutPreview({
  root,
  sessions,
  variant = "detail",
  selectedPaneId,
  compact = false,
  interactive = true,
  onSelectPane,
}: WorkspaceLayoutPreviewProps) {
  if (variant === "thumbnail") {
    return (
      <div className="zt-workspace-layout-preview thumbnail" aria-hidden="true">
        <ThumbnailNode node={root} />
      </div>
    );
  }

  return (
    <div className={compact ? "zt-workspace-layout-preview compact" : "zt-workspace-layout-preview"}>
      <PreviewNode
        node={root}
        sessions={sessions}
        selectedPaneId={selectedPaneId}
        compact={compact}
        interactive={interactive}
        onSelectPane={onSelectPane}
      />
    </div>
  );
}

function ThumbnailNode({ node }: { node: PaneNode }) {
  if (node.kind === "split") {
    return (
      <div
        className={`zt-workspace-layout-thumbnail-split zt-workspace-layout-thumbnail-split-${node.direction}`}
        data-thumbnail-split-id={node.id}
      >
        <ThumbnailNode node={node.first} />
        <div className="zt-workspace-layout-thumbnail-divider" />
        <ThumbnailNode node={node.second} />
      </div>
    );
  }

  return <div className="zt-workspace-layout-thumbnail-leaf" />;
}

function PreviewNode({
  node,
  sessions,
  selectedPaneId,
  compact,
  interactive,
  onSelectPane,
}: {
  node: PaneNode;
  sessions: WorkspaceLayoutPreviewSession[];
  selectedPaneId?: string | null;
  compact: boolean;
  interactive: boolean;
  onSelectPane?: (paneId: string) => void;
}) {
  if (node.kind === "split") {
    return (
      <div
        className={`zt-workspace-layout-split zt-workspace-layout-split-${node.direction}`}
        data-split-id={node.id}
        style={{ "--zt-workspace-preview-ratio": formatRatio(node.ratio) } as CSSProperties}
      >
        <PreviewNode
          node={node.first}
          sessions={sessions}
          selectedPaneId={selectedPaneId}
          compact={compact}
          interactive={interactive}
          onSelectPane={onSelectPane}
        />
        <div className="zt-workspace-layout-divider" aria-hidden="true" />
        <PreviewNode
          node={node.second}
          sessions={sessions}
          selectedPaneId={selectedPaneId}
          compact={compact}
          interactive={interactive}
          onSelectPane={onSelectPane}
        />
      </div>
    );
  }

  const activeTerminalTab = getActiveTerminalTab(node);
  const terminalTabs = getLeafTerminalTabs(node);
  const selected = node.id === selectedPaneId;
  const connectionLabel = connectionName(activeTerminalTab, sessions);
  const paneContent = (
    <>
      <div className="zt-workspace-layout-pane-title">
        <span>{activeTerminalTab.title || node.title}</span>
        <code>{node.id}</code>
      </div>
      <div className="zt-workspace-layout-pane-body">
        <div className="zt-workspace-layout-pane-tabs">
          {terminalTabs.slice(0, compact ? 3 : 5).map((terminalTab) => (
            <span
              key={terminalTab.id}
              className={terminalTab.id === activeTerminalTab.id ? "active" : ""}
              title={terminalTab.title}
            >
              {terminalTab.title}
            </span>
          ))}
          {terminalTabs.length > (compact ? 3 : 5) ? <span>+{terminalTabs.length - (compact ? 3 : 5)}</span> : null}
        </div>
        {compact ? null : (
          <>
            <span className="zt-workspace-layout-connection">{connectionLabel}</span>
            {activeTerminalTab.path ? <span className="zt-workspace-layout-path">{activeTerminalTab.path}</span> : null}
            {activeTerminalTab.restore_status === "failed" ? (
              <span className="zt-workspace-layout-error">{activeTerminalTab.restore_error ?? "恢复失败"}</span>
            ) : (
              <span className="zt-workspace-layout-prompt">$ ▌</span>
            )}
          </>
        )}
      </div>
    </>
  );

  const className = selected ? "zt-workspace-layout-pane selected" : "zt-workspace-layout-pane";
  if (!interactive) {
    return (
      <div className={className} data-pane-id={node.id}>
        {paneContent}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={className}
      data-pane-id={node.id}
      aria-pressed={selected}
      onClick={() => onSelectPane?.(node.id)}
    >
      {paneContent}
    </button>
  );
}

function connectionName(terminalTab: PaneTerminalTab, sessions: WorkspaceLayoutPreviewSession[]) {
  if (terminalTab.connection_source === "missing") return "缺失连接";
  if (terminalTab.saved_session_id) {
    return sessions.find((session) => session.id === terminalTab.saved_session_id)?.name ?? "保存会话";
  }
  return "默认本地终端";
}

function formatRatio(ratio: number) {
  return `${Number((ratio * 100).toFixed(2))}%`;
}
