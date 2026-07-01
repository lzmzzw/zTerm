// Author: Liz
import { CopyPlus } from "lucide-react";
import { useEffect, useState } from "react";

import { ZtFloatingSurface } from "../../components/ZtUi";
import { WorkspaceLayoutPreview, type WorkspaceLayoutPreviewSession } from "./WorkspaceLayoutPreview";
import { DEFAULT_WORKSPACE_ID } from "./workspaceConstants";
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
  onDeleteWorkspace: (workspaceId: string) => void;
}

type WorkspaceContextMenu =
  | { kind: "root"; x: number; y: number }
  | { kind: "workspace"; workspace: WorkspaceSidebarItem; x: number; y: number };

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
  onDeleteWorkspace,
}: WorkspaceManagerPanelProps) {
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu | null>(null);
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.id !== DEFAULT_WORKSPACE_ID);

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
        setContextMenu({ kind: "root", x: event.clientX, y: event.clientY });
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
        {visibleWorkspaces.map((workspace) => {
          const active = workspace.id === activeWorkspaceId;
          const dotClass = workspace.status;
          const statusText = statusLabel(workspace.status);
          return (
            <li
              key={workspace.id}
              className={active ? "zt-workspace-item active" : "zt-workspace-item"}
              aria-label={`工作区 ${workspace.name}`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ kind: "workspace", workspace, x: event.clientX, y: event.clientY });
              }}
            >
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
              </div>
              <span className={`zt-workspace-dot ${dotClass}`} title={statusText} aria-label={statusText} />
            </li>
          );
        })}
      </ul>

      {visibleWorkspaces.length === 0 ? <div className="zt-empty-line">暂无工作区</div> : null}

      {contextMenu ? (
        <ZtFloatingSurface className="zt-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.kind === "root" ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                onCreateWorkspace();
              }}
            >
              新建工作区
            </button>
          ) : (
            <WorkspaceContextMenuItems
              workspace={contextMenu.workspace}
              onEditWorkspace={onEditWorkspace}
              onRestoreWorkspace={onRestoreWorkspace}
              onCloseWorkspace={onCloseWorkspace}
              onDeleteWorkspace={onDeleteWorkspace}
              onCloseMenu={() => setContextMenu(null)}
            />
          )}
        </ZtFloatingSurface>
      ) : null}
    </section>
  );
}

function WorkspaceContextMenuItems({
  workspace,
  onEditWorkspace,
  onRestoreWorkspace,
  onCloseWorkspace,
  onDeleteWorkspace,
  onCloseMenu,
}: {
  workspace: WorkspaceSidebarItem;
  onEditWorkspace: (workspaceId: string) => void;
  onRestoreWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onCloseMenu: () => void;
}) {
  const restoreDisabled = workspace.status === "running";
  const closeDisabled = workspace.status === "closed";
  const deleteDisabled = workspace.id === DEFAULT_WORKSPACE_ID;

  function run(action: (workspaceId: string) => void) {
    onCloseMenu();
    action(workspace.id);
  }

  return (
    <>
      <button type="button" role="menuitem" aria-label={`编辑工作区 ${workspace.name}`} onClick={() => run(onEditWorkspace)}>
        编辑
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label={`恢复工作区 ${workspace.name}`}
        disabled={restoreDisabled}
        onClick={() => run(onRestoreWorkspace)}
      >
        恢复
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label={`关闭工作区 ${workspace.name}`}
        disabled={closeDisabled}
        onClick={() => run(onCloseWorkspace)}
      >
        关闭
      </button>
      <button
        type="button"
        role="menuitem"
        aria-label={`删除工作区 ${workspace.name}`}
        disabled={deleteDisabled}
        onClick={() => run(onDeleteWorkspace)}
      >
        删除
      </button>
    </>
  );
}

function statusLabel(status: WorkspaceSidebarItem["status"]) {
  return status === "running" ? "运行中" : "已关闭";
}
