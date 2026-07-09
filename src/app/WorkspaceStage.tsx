// Author: Liz
import { useShallow } from "zustand/react/shallow";

import { SplitPaneView } from "../features/workspace/SplitPaneView";
import type { PaneSplitDirection, WorkspaceRuntime } from "../features/workspace/types";
import { useWorkspaceStore } from "../features/workspace/workspaceStore";

interface WorkspaceStageProps {
  activeWorkspaceId: string;
  onActivatePane: (paneId: string) => void;
  onAddPaneTab: (paneId: string) => void;
  onSelectPaneTab: (paneId: string, paneTabId: string) => void;
  onClosePaneTab: (paneId: string, paneTabId: string) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onResizeSplit?: (splitId: string, ratio: number) => void;
  onClosePane: () => void;
  onDisconnectTerminal?: (paneId: string, paneTabId: string, runtimeSessionId: string) => void;
  onReconnectTerminal?: (paneId: string, paneTabId: string, savedSessionId: string, runtimeSessionId: string) => void;
}

export function WorkspaceStage({
  activeWorkspaceId,
  onActivatePane,
  onAddPaneTab,
  onSelectPaneTab,
  onClosePaneTab,
  onSplitPane,
  onResizeSplit,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
}: WorkspaceStageProps) {
  const runningWorkspaceIds = useWorkspaceStore(
    useShallow((state) =>
      (state.workspaces as WorkspaceRuntime[])
        .filter(
          (workspace) =>
            workspace.status === "running" && Array.isArray(workspace.tabs) && workspace.tabs.length > 0,
        )
        .map((workspace) => workspace.id),
    ),
  );

  return (
    <div className="zt-workspace-stage" aria-label="工作区舞台">
      {runningWorkspaceIds.map((workspaceId) => (
        <WorkspaceStageLayer
          key={workspaceId}
          workspaceId={workspaceId}
          activeWorkspaceId={activeWorkspaceId}
          onActivatePane={onActivatePane}
          onAddPaneTab={onAddPaneTab}
          onSelectPaneTab={onSelectPaneTab}
          onClosePaneTab={onClosePaneTab}
          onSplitPane={onSplitPane}
          onResizeSplit={onResizeSplit}
          onClosePane={onClosePane}
          onDisconnectTerminal={onDisconnectTerminal}
          onReconnectTerminal={onReconnectTerminal}
        />
      ))}
    </div>
  );
}

function WorkspaceStageLayer({
  workspaceId,
  activeWorkspaceId,
  onActivatePane,
  onAddPaneTab,
  onSelectPaneTab,
  onClosePaneTab,
  onSplitPane,
  onResizeSplit,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
}: WorkspaceStageProps & { workspaceId: string }) {
  const workspace = useWorkspaceStore((state) =>
    (state.workspaces as WorkspaceRuntime[]).find((candidate) => candidate.id === workspaceId),
  );
  if (!workspace || workspace.status !== "running" || !Array.isArray(workspace.tabs) || workspace.tabs.length === 0) {
    return null;
  }

  const active = workspace.id === activeWorkspaceId;
  const activeWorkspaceTabId = workspace.activeTabId ?? workspace.active_tab_id;
  const activeTab = workspace.tabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspace.tabs[0];
  if (!activeTab) return null;

  return (
    <section
      className={`zt-workspace-stage-layer ${active ? "active" : ""}`}
      aria-hidden={!active}
      aria-label={`工作区视图 ${workspace.name}`}
      data-active={String(active)}
      data-workspace-id={workspace.id}
    >
      <SplitPaneView
        root={activeTab.root}
        activePaneId={activeTab.active_pane_id}
        onActivatePane={onActivatePane}
        onAddPaneTab={onAddPaneTab}
        onSelectPaneTab={onSelectPaneTab}
        onClosePaneTab={onClosePaneTab}
        onSplitPane={onSplitPane}
        onResizeSplit={onResizeSplit}
        onClosePane={onClosePane}
        onDisconnectTerminal={onDisconnectTerminal}
        onReconnectTerminal={onReconnectTerminal}
        workspaceActive={active}
      />
    </section>
  );
}
