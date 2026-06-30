// Author: Liz
import type { CSSProperties } from "react";

import { getActiveTerminalTab, getLeafTerminalTabs } from "./workspaceLayout";
import type { PaneNode } from "./types";

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
  selectedPaneId,
  compact,
  interactive,
  onSelectPane,
}: {
  node: PaneNode;
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
          selectedPaneId={selectedPaneId}
          compact={compact}
          interactive={interactive}
          onSelectPane={onSelectPane}
        />
        <div className="zt-workspace-layout-divider" aria-hidden="true" />
        <PreviewNode
          node={node.second}
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
  const paneContent = (
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
    </div>
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

function formatRatio(ratio: number) {
  return `${Number((ratio * 100).toFixed(2))}%`;
}
