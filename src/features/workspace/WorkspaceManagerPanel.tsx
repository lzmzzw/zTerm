// Author: Liz
import { CopyPlus, Save } from "lucide-react";
import { useEffect, useState } from "react";

import { ZtFloatingSurface } from "../../components/ZtUi";
import { WorkspaceLayoutPreview, type WorkspaceLayoutPreviewSession } from "./WorkspaceLayoutPreview";
import { DEFAULT_WORKSPACE_ID } from "./workspaceConstants";
import type { WorkspaceSidebarItem } from "./workspaceShellModel";

interface WorkspaceManagerPanelProps {
  workspaces: WorkspaceSidebarItem[];
  sessions?: WorkspaceLayoutPreviewSession[];
  selectedWorkspaceId: string | null;
  error?: string | null;
  onCreateWorkspace: () => void;
  onSaveWorkspace: (workspaceId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onClearWorkspaceSelection: () => void;
  onEditWorkspace: (workspaceId: string) => void;
  onRestoreWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
}

type WorkspaceContextMenu =
  { workspace: WorkspaceSidebarItem; x: number; y: number };

export function WorkspaceManagerPanel({
  workspaces,
  sessions = [],
  selectedWorkspaceId,
  error,
  onCreateWorkspace,
  onSaveWorkspace,
  onSelectWorkspace,
  onClearWorkspaceSelection,
  onEditWorkspace,
  onRestoreWorkspace,
  onDeleteWorkspace,
}: WorkspaceManagerPanelProps) {
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu | null>(null);
  const visibleWorkspaces = workspaces.filter((workspace) => workspace.id !== DEFAULT_WORKSPACE_ID);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!selectedWorkspaceId) return undefined;
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClearWorkspaceSelection();
    };
    window.addEventListener("keydown", clearOnEscape);
    return () => window.removeEventListener("keydown", clearOnEscape);
  }, [onClearWorkspaceSelection, selectedWorkspaceId]);

  return (
    <section
      className="zt-workspace-panel"
      aria-label="工作区管理"
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <div className="zt-panel-header">
        <span>Workspace</span>
        <div className="zt-panel-header-action">
          {selectedWorkspaceId ? (
            <button
              type="button"
              aria-label="保存工作区"
              title="保存工作区"
              onClick={() => onSaveWorkspace(selectedWorkspaceId)}
            >
              <Save size={14} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" aria-label="新建工作区" title="新建工作区" onClick={onCreateWorkspace}>
              <CopyPlus size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div
        className="zt-workspace-panel-body"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClearWorkspaceSelection();
        }}
      >
        <div className="zt-workspace-panel-error">{error ? <div className="zt-empty-line">{error}</div> : null}</div>
        <ul
          className="zt-workspace-list"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClearWorkspaceSelection();
          }}
        >
        {visibleWorkspaces.map((workspace) => {
          const active = workspace.id === selectedWorkspaceId;
          return (
            <li
              key={workspace.id}
              className={active ? "zt-workspace-item active" : "zt-workspace-item"}
              aria-label={`工作区 ${workspace.name}`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!active) onSelectWorkspace(workspace.id);
                setContextMenu({ workspace, x: event.clientX, y: event.clientY });
              }}
            >
              <button
                type="button"
                className="zt-workspace-main"
                aria-label={`选择工作区 ${workspace.name}`}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  if (!active) onSelectWorkspace(workspace.id);
                }}
                onDoubleClick={() => onRestoreWorkspace(workspace.id)}
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
            </li>
          );
        })}
        {visibleWorkspaces.length === 0 ? <li className="zt-empty-line">暂无工作区</li> : null}
        </ul>

      </div>

      {contextMenu ? (
        <ZtFloatingSurface className="zt-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <WorkspaceContextMenuItems
            workspace={contextMenu.workspace}
            onEditWorkspace={onEditWorkspace}
            onRestoreWorkspace={onRestoreWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            onCloseMenu={() => setContextMenu(null)}
          />
        </ZtFloatingSurface>
      ) : null}
    </section>
  );
}

function WorkspaceContextMenuItems({
  workspace,
  onEditWorkspace,
  onRestoreWorkspace,
  onDeleteWorkspace,
  onCloseMenu,
}: {
  workspace: WorkspaceSidebarItem;
  onEditWorkspace: (workspaceId: string) => void;
  onRestoreWorkspace: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onCloseMenu: () => void;
}) {
  const deleteDisabled = workspace.id === DEFAULT_WORKSPACE_ID;

  function run(action: (workspaceId: string) => void) {
    onCloseMenu();
    action(workspace.id);
  }

  return (
    <>
      <button
        type="button"
        role="menuitem"
        aria-label={`恢复工作区 ${workspace.name}`}
        onClick={() => run(onRestoreWorkspace)}
      >
        恢复
      </button>
      <button type="button" role="menuitem" aria-label={`编辑工作区 ${workspace.name}`} onClick={() => run(onEditWorkspace)}>
        编辑
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
