// Author: Liz
import { getLeafTerminalTabs } from "./workspaceLayout";
import type {
  PaneNode,
  PaneTerminalTab,
  WorkspaceDefinition,
  WorkspaceRuntime,
  WorkspaceSummary,
  WorkspaceStatus,
} from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaceConstants";

export interface WorkspaceSidebarItem {
  id: string;
  name: string;
  status: WorkspaceStatus;
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
  runtimes: WorkspaceRuntime[],
  previewDefinitions: Record<string, WorkspaceDefinition>,
): WorkspaceSidebarItem[] {
  const items = new Map<string, WorkspaceSidebarItem>();
  for (const summary of summaries) {
    if (summary.id === DEFAULT_WORKSPACE_ID) continue;
    const previewDefinition = previewDefinitions[summary.id];
    items.set(summary.id, {
      ...summary,
      preview_root: previewDefinition ? activeWorkspaceDefinitionRoot(previewDefinition) : null,
    });
  }

  for (const runtime of runtimes) {
    if (runtime.id === DEFAULT_WORKSPACE_ID) continue;
    const existing = items.get(runtime.id);
    items.set(runtime.id, {
      id: runtime.id,
      name: runtime.name,
      status: runtime.status,
      active_tab_id: runtime.activeTabId ?? runtime.active_tab_id ?? existing?.active_tab_id ?? "",
      tab_count: hasRuntimeTabs(runtime)
        ? runtime.tabs.length
        : existing?.tab_count ?? (runtime as WorkspaceRuntime & { tab_count?: number }).tab_count ?? 0,
      sort_order: runtime.sort_order ?? existing?.sort_order ?? 0,
      created_at_ms: runtime.created_at_ms ?? existing?.created_at_ms ?? 0,
      updated_at_ms: runtime.updated_at_ms ?? existing?.updated_at_ms ?? 0,
      preview_root: existing?.preview_root ?? null,
    });
  }

  return [...items.values()].sort(compareWorkspaceSidebarItems);
}

export function hasRuntimeTabs(workspace: WorkspaceRuntime): workspace is WorkspaceRuntime & { tabs: WorkspaceRuntime["tabs"] } {
  return Array.isArray((workspace as WorkspaceRuntime & { tabs?: unknown }).tabs);
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
    tabs: workspace.tabs,
    sort_order: workspace.sort_order,
    created_at_ms: workspace.created_at_ms,
    updated_at_ms: workspace.updated_at_ms,
  };
}

export function materializePaneVisualSnapshots(
  root: PaneNode,
  visualOutputTail: Record<string, string>,
  capturedAtMs: number,
): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: materializePaneVisualSnapshots(root.first, visualOutputTail, capturedAtMs),
      second: materializePaneVisualSnapshots(root.second, visualOutputTail, capturedAtMs),
    };
  }

  const terminalTabs = getLeafTerminalTabs(root).map((terminalTab) => {
    const runtimeSessionId = terminalTab.runtime_session_id;
    return {
      ...terminalTab,
      visual_snapshot: {
        kind: runtimeSessionId ? "terminal_tail" as const : "placeholder" as const,
        text: runtimeSessionId ? (visualOutputTail[runtimeSessionId] ?? terminalTab.visual_snapshot?.text ?? "") : "",
        captured_at_ms: capturedAtMs,
        runtime_session_id: runtimeSessionId,
      },
    };
  });
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === root.active_terminal_tab_id) ?? terminalTabs[0];

  return {
    ...root,
    runtime_session_id: activeTerminalTab?.runtime_session_id ?? root.runtime_session_id,
    saved_session_id: activeTerminalTab?.saved_session_id ?? root.saved_session_id,
    title: activeTerminalTab?.title ?? root.title,
    active_terminal_tab_id: activeTerminalTab?.id ?? root.active_terminal_tab_id,
    terminal_tabs: terminalTabs,
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

function activeWorkspaceDefinitionRoot(workspace: WorkspaceDefinition) {
  const activeTab =
    workspace.tabs.find((tab) => tab.id === workspace.active_tab_id) ??
    workspace.tabs[0] ??
    null;
  return activeTab?.root ?? null;
}

function compareWorkspaceSidebarItems(left: WorkspaceSidebarItem, right: WorkspaceSidebarItem): number {
  return (
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }) ||
    left.sort_order - right.sort_order ||
    right.updated_at_ms - left.updated_at_ms ||
    left.id.localeCompare(right.id)
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
