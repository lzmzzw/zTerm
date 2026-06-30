// Author: Liz
import { CopyPlus, Pencil, Play, Power } from "lucide-react";
import { useEffect, useState } from "react";

import { WorkspaceLayoutPreview, type WorkspaceLayoutPreviewSession } from "./WorkspaceLayoutPreview";
import type { WorkspaceSidebarItem } from "./workspaceShellModel";

interface WorkspaceManagerPanelProps {
  workspaces: WorkspaceSidebarItem[];
  sessions?: WorkspaceLayoutPreviewSession[];
  activeWorkspaceId: string | null;
  error?: string | null;
  onCreateWorkspace: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onEditWorkspace: (workspaceId: string) => void;
  onRestoreWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
}

export function WorkspaceManagerPanel({
  workspaces,
  sessions = [],
  activeWorkspaceId,
  error,
  onCreateWorkspace,
  onSelectWorkspace,
  onEditWorkspace,
  onRestoreWorkspace,
  onCloseWorkspace,
}: WorkspaceManagerPanelProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  return (
    <section
      className="zt-workspace-panel"
      aria-label="工作区管理"
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="zt-panel-header">
        <span>Workspace</span>
        <div className="zt-panel-header-action">
          <button type="button" aria-label="新建工作区" title="新建工作区" onClick={onCreateWorkspace}>
            <CopyPlus size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {error ? <div className="zt-empty-line">{error}</div> : null}

      <ul className="zt-workspace-list">
        {workspaces.map((workspace) => {
          const active = workspace.id === activeWorkspaceId;
          const dotClass = workspace.status;
          const statusText = statusLabel(workspace.status);
          return (
            <li key={workspace.id} className={active ? "zt-workspace-item active" : "zt-workspace-item"}>
              <button
                type="button"
                className="zt-workspace-main"
                aria-label={`切换工作区 ${workspace.name}`}
                aria-current={active ? "true" : undefined}
                onClick={() => onSelectWorkspace(workspace.id)}
              >
                <span>{workspace.name}</span>
              </button>
              <div className="zt-workspace-preview-col">
                <div
                  className={
                    workspace.preview_root ? "zt-workspace-thumbnail" : "zt-workspace-thumbnail placeholder"
                  }
                  aria-label={`工作区 ${workspace.name} 布局缩略图`}
                >
                  {workspace.preview_root ? (
                    <WorkspaceLayoutPreview
                      root={workspace.preview_root}
                      sessions={sessions}
                      variant="thumbnail"
                      selectedPaneId={null}
                      interactive={false}
                    />
                  ) : (
                    <span className="zt-workspace-thumbnail-empty" aria-hidden="true" />
                  )}
                </div>
                <div className="zt-workspace-actions">
                  <button
                    type="button"
                    aria-label={`编辑工作区 ${workspace.name}`}
                    title="编辑"
                    onClick={() => onEditWorkspace(workspace.id)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`恢复工作区 ${workspace.name}`}
                    title="恢复"
                    onClick={() => onRestoreWorkspace(workspace.id)}
                  >
                    <Play size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭工作区 ${workspace.name}`}
                    title="关闭工作区"
                    onClick={() => onCloseWorkspace(workspace.id)}
                  >
                    <Power size={14} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <span className={`zt-workspace-dot ${dotClass}`} title={statusText} aria-label={statusText} />
            </li>
          );
        })}
      </ul>

      {workspaces.length === 0 ? <div className="zt-empty-line">暂无工作区</div> : null}

      {contextMenu ? (
        <div className="zt-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" role="menuitem" onClick={onCreateWorkspace}>
            新建工作区
          </button>
        </div>
      ) : null}
    </section>
  );
}

function statusLabel(status: WorkspaceSidebarItem["status"]) {
  return status === "running" ? "运行中" : "已关闭";
}
