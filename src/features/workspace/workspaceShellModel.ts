// Author: Liz
import { getLeafTerminalTabs } from "./workspaceLayout";
import type {
  PaneNode,
  PaneTerminalTab,
  WorkspaceDefinition,
  WorkspaceRuntime,
  WorkspaceSummary,
} from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaceConstants";

export interface WorkspaceSidebarItem {
  id: string;
  name: string;
  active_tab_id: string;
  tab_count: number;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
  preview_root?: PaneNode | null;
}

interface WorkspaceTerminalRestoreTarget {
  workspaceTabId: string;
  paneId: string;
  terminalTab: PaneTerminalTab;
}

export function mergeWorkspaceSidebarItems(
  summaries: WorkspaceSummary[],
  previewDefinitions: Record<string, WorkspaceDefinition>,
): WorkspaceSidebarItem[] {
  const items = new Map<string, WorkspaceSidebarItem>();
  for (const summary of summaries) {
    if (summary.id === DEFAULT_WORKSPACE_ID) continue;
    const previewDefinition = previewDefinitions[summary.id];
    const { status: _status, ...sidebarSummary } = summary;
    items.set(summary.id, {
      ...sidebarSummary,
      preview_root: previewDefinition ? activeWorkspaceDefinitionRoot(previewDefinition) : null,
    });
  }

  return [...items.values()].sort(compareWorkspaceSidebarItems);
}

export function nextWorkspaceSortOrder(workspaces: Array<Pick<WorkspaceSidebarItem, "sort_order">>): number {
  return workspaces.reduce((maxSortOrder, workspace) => Math.max(maxSortOrder, workspace.sort_order), -1) + 1;
}

export function definitionFromRuntime(workspace: WorkspaceRuntime): WorkspaceDefinition {
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status,
    active_tab_id: workspace.activeTabId ?? workspace.active_tab_id,
    tabs: workspace.tabs.map((tab) => ({
      ...tab,
      root: removeTransientConnections(tab.root),
    })),
    sort_order: workspace.sort_order,
    created_at_ms: workspace.created_at_ms,
    updated_at_ms: workspace.updated_at_ms,
  };
}

export function collectWorkspaceTerminalTargets(workspace: WorkspaceDefinition): WorkspaceTerminalRestoreTarget[] {
  return [...workspace.tabs]
    .sort((left, right) => left.sort_order - right.sort_order)
    .flatMap((tab) => collectPaneTerminalTargets(tab.id, tab.root));
}

export function isReusableConnectionTab(tab: PaneTerminalTab): boolean {
  return !tab.runtime_session_id && !tab.saved_session_id && tab.connection_source !== "missing";
}

function removeTransientConnections(root: PaneNode): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: removeTransientConnections(root.first),
      second: removeTransientConnections(root.second),
    };
  }

  const retainedTabs = getLeafTerminalTabs(root).filter((tab) => !isTransientConnection(tab));
  const terminalTabs = retainedTabs.length > 0 ? retainedTabs : [emptyTerminalTab(root.id)];
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === root.active_terminal_tab_id) ?? terminalTabs[0];
  return {
    ...root,
    runtime_session_id: activeTerminalTab?.runtime_session_id ?? null,
    saved_session_id: activeTerminalTab?.saved_session_id ?? null,
    title: activeTerminalTab?.title ?? root.title,
    active_terminal_tab_id: activeTerminalTab?.id,
    terminal_tabs: terminalTabs,
  };
}

function isTransientConnection(tab: PaneTerminalTab): boolean {
  return tab.connection_source === "external_ssh" || tab.saved_session_id?.startsWith("external:") === true;
}

function emptyTerminalTab(paneId: string): PaneTerminalTab {
  return {
    id: `${paneId}-tab-1`,
    title: "新建终端",
    runtime_session_id: null,
    saved_session_id: null,
    connection_source: "default_local",
    restore_status: null,
    restore_error: null,
  };
}

function activeWorkspaceDefinitionRoot(workspace: WorkspaceDefinition) {
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.active_tab_id) ??
    workspace.tabs[0] ??
    null;
  return activeTab?.root ?? null;
}

function compareWorkspaceSidebarItems(left: WorkspaceSidebarItem, right: WorkspaceSidebarItem): number {
  return (
    left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }) ||
    left.sort_order - right.sort_order ||
    right.updated_at_ms - left.updated_at_ms ||
    left.id.localeCompare(right.id, "zh-CN")
  );
}

function collectPaneTerminalTargets(workspaceTabId: string, root: PaneNode): WorkspaceTerminalRestoreTarget[] {
  if (root.kind === "split") {
    return [
      ...collectPaneTerminalTargets(workspaceTabId, root.first),
      ...collectPaneTerminalTargets(workspaceTabId, root.second),
    ];
  }

  return getLeafTerminalTabs(root).map((terminalTab) => ({
    workspaceTabId,
    paneId: root.id,
    terminalTab,
  }));
}
