// Author: Liz
import { create } from "zustand";

import type { RuntimeSessionInfo } from "../terminal/terminalStore";
import {
  canSplitPane,
  findLeafPane,
  firstLeafPaneId,
  getActiveTerminalTab,
  getLeafTerminalTabs,
  normalizeWorkspaceTabsPaneIds,
  removePane,
  splitPane,
  updateLeafPane,
  updateSplitRatio,
  updateTerminalTabInRoot,
} from "./workspaceLayout";
import type {
  PaneNode,
  PaneSplitDirection,
  PaneTerminalTab,
  WorkspaceDefinition,
  WorkspaceDefinitionDraft,
  WorkspaceRuntime,
  WorkspaceTab,
} from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaceConstants";

type LeafPane = Extract<PaneNode, { kind: "leaf" }>;

interface WorkspaceStore {
  workspaces: WorkspaceRuntime[];
  workspaceDefinitions: Record<string, WorkspaceDefinition>;
  activeWorkspaceId: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
  cacheWorkspaceDefinition: (workspace: WorkspaceDefinition) => void;
  loadWorkspaceDefinition: (
    workspaceId: string,
    loader: (workspaceId: string) => Promise<WorkspaceDefinition>,
  ) => Promise<WorkspaceDefinition>;
  prefetchWorkspaceDefinitions: (
    workspaceIds: string[],
    loader: (workspaceId: string) => Promise<WorkspaceDefinition>,
  ) => Promise<void>;
  buildActiveWorkspaceDraft: () => WorkspaceDefinitionDraft | null;
  restoreWorkbenchDefinition: (workspace: WorkspaceDefinition) => void;
  clearRuntimeSession: (runtimeSessionId: string) => void;
  getWorkspaceRuntimeSessionIds: (workspaceId: string) => string[];
  removeWorkspace: (workspaceId: string) => void;
  updatePaneTerminalTab: (
    workspaceId: string,
    workspaceTabId: string,
    paneId: string,
    paneTabId: string,
    patch: Partial<PaneTerminalTab>,
  ) => void;
  selectTab: (tabId: string) => void;
  addTab: () => void;
  addPaneTab: (paneId: string) => PaneTerminalTab;
  addPaneTabAfter: (paneId: string, afterPaneTabId: string) => PaneTerminalTab;
  closePaneTab: (paneId: string, paneTabId: string) => void;
  selectPaneTab: (paneId: string, paneTabId: string) => void;
  movePaneTab: (sourcePaneId: string, paneTabId: string, targetPaneId: string, beforePaneTabId: string | null) => void;
  setActivePane: (paneId: string) => void;
  bindRuntimeToPane: (runtime: RuntimeSessionInfo) => void;
  bindRuntimeToPaneTab: (
    workspaceId: string,
    workspaceTabId: string,
    paneId: string,
    paneTabId: string,
    runtime: RuntimeSessionInfo,
  ) => void;
  splitActivePane: (direction: PaneSplitDirection) => void;
  resizeSplitPane: (splitId: string, ratio: number) => void;
  closePane: (paneId: string) => void;
}

let nextPaneCounter = 2;
let nextTabCounter = 2;
let nextPaneTabCounter = 2;
const workspaceDefinitionRequests: Record<string, Promise<WorkspaceDefinition>> = {};

const now = Date.now();
const initialWorkspace = createDefaultWorkspace(now);

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  workspaces: [initialWorkspace],
  workspaceDefinitions: {},
  activeWorkspaceId: initialWorkspace.id,
  tabs: initialWorkspace.tabs,
  activeTabId: initialWorkspace.activeTabId,
  cacheWorkspaceDefinition: (workspace) =>
    set((state) => ({
      workspaceDefinitions: {
        ...state.workspaceDefinitions,
        [workspace.id]: workspace,
      },
    })),
  loadWorkspaceDefinition: async (workspaceId, loader) => {
    const cached = get().workspaceDefinitions[workspaceId];
    if (cached) return cached;
    const existing = workspaceDefinitionRequests[workspaceId];
    if (existing) return existing;

    const request = loader(workspaceId)
      .then((definition) => {
        get().cacheWorkspaceDefinition(definition);
        return definition;
      })
      .finally(() => {
        delete workspaceDefinitionRequests[workspaceId];
      });
    workspaceDefinitionRequests[workspaceId] = request;
    return request;
  },
  prefetchWorkspaceDefinitions: async (workspaceIds, loader) => {
    await Promise.all(
      workspaceIds.map((workspaceId) =>
        get()
          .loadWorkspaceDefinition(workspaceId, loader)
          .catch(() => undefined),
      ),
    );
  },
  buildActiveWorkspaceDraft: () => {
    const workspace = activeWorkspaceFromState(get());
    if (!workspace) return null;
    return workspaceDraftFromRuntime(workspace);
  },
  restoreWorkbenchDefinition: (workspace) =>
    set((state) => {
      const current = activeWorkspaceFromState(state) ?? createDefaultWorkspace();
      const restored = normalizeWorkspaceRuntime({
        ...current,
        id: DEFAULT_WORKSPACE_ID,
        name: "默认工作区",
        status: "running",
        active_tab_id: workspace.active_tab_id,
        activeTabId: workspace.active_tab_id,
        tabs: workspace.tabs,
        updated_at_ms: Date.now(),
      });
      return {
        workspaces: [restored],
        ...mirrorWorkspace(restored),
      };
    }),
  clearRuntimeSession: (runtimeSessionId) =>
    set((state) =>
      updateActiveWorkspace(state, (workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map((tab) => ({
          ...tab,
          root: clearRuntimeSessionFromRoot(tab.root, runtimeSessionId),
          updated_at_ms: Date.now(),
        })),
        updated_at_ms: Date.now(),
      })),
    ),
  getWorkspaceRuntimeSessionIds: (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    return workspace ? collectRuntimeSessionIds(workspace.tabs) : [];
  },
  removeWorkspace: (workspaceId) =>
    set((state) => {
      const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
      const { [workspaceId]: _removedDefinition, ...workspaceDefinitions } = state.workspaceDefinitions;
      if (state.activeWorkspaceId !== workspaceId) {
        return { workspaces, workspaceDefinitions };
      }

      const nextWorkspaces = workspaces.length > 0 ? workspaces : [createDefaultWorkspace()];
      const nextActive =
        nextWorkspaces.find((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ?? nextWorkspaces[0];
      return {
        workspaces: nextWorkspaces,
        workspaceDefinitions,
        ...mirrorWorkspace(nextActive),
      };
    }),
  updatePaneTerminalTab: (workspaceId, workspaceTabId, paneId, paneTabId, patch) =>
    set((state) => {
      const workspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        return {
          ...workspace,
          tabs: workspace.tabs.map((tab) =>
            tab.id === workspaceTabId
              ? {
                  ...tab,
                  root: updateTerminalTabInRoot(tab.root, paneId, paneTabId, (terminalTab) => ({
                    ...terminalTab,
                    ...patch,
                  })),
                  updated_at_ms: Date.now(),
                }
              : tab,
          ),
          updated_at_ms: Date.now(),
        };
      });
      const active = workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
      return {
        workspaces,
        ...(active ? mirrorWorkspace(active) : {}),
      };
    }),
  selectTab: (tabId) =>
    set((state) => updateActiveWorkspace(state, (workspace) => ({ ...workspace, activeTabId: tabId, active_tab_id: tabId }))),
  addTab: () =>
    set((state) => updateActiveWorkspace(state, (workspace) => {
      const pane = createPane();
      const tab: WorkspaceTab = {
        id: `tab-${nextTabCounter++}`,
        title: pane.title,
        active_pane_id: pane.id,
        root: pane,
        sort_order: workspace.tabs.length,
        created_at_ms: Date.now(),
        updated_at_ms: Date.now(),
      };
      return { ...workspace, tabs: [...workspace.tabs, tab], activeTabId: tab.id, active_tab_id: tab.id };
    })),
  addPaneTab: (paneId) => {
    const paneTab = createAvailablePaneTab(activeWorkspaceFromState(get())?.tabs ?? get().tabs);
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (tab.id !== workspace.activeTabId) return tab;
        return {
          ...tab,
          active_pane_id: paneId,
          root: updateLeafPane(tab.root, paneId, addPaneTabPatch(tab.root, paneId, paneTab)),
          updated_at_ms: Date.now(),
        };
      }),
      updated_at_ms: Date.now(),
    })));
    return paneTab;
  },
  addPaneTabAfter: (paneId, afterPaneTabId) => {
    const paneTab = createAvailablePaneTab(activeWorkspaceFromState(get())?.tabs ?? get().tabs);
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (tab.id !== workspace.activeTabId) return tab;
        return {
          ...tab,
          active_pane_id: paneId,
          root: updateLeafPane(tab.root, paneId, addPaneTabAfterPatch(tab.root, paneId, afterPaneTabId, paneTab)),
          updated_at_ms: Date.now(),
        };
      }),
      updated_at_ms: Date.now(),
    })));
    return paneTab;
  },
  closePaneTab: (paneId, paneTabId) =>
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (tab.id !== workspace.activeTabId) return tab;
        return {
          ...tab,
          active_pane_id: paneId,
          root: closePaneTabInRoot(tab.root, paneId, paneTabId),
          updated_at_ms: Date.now(),
        };
      }),
      updated_at_ms: Date.now(),
    }))),
  selectPaneTab: (paneId, paneTabId) =>
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (tab.id !== workspace.activeTabId) return tab;
        const pane = findLeafPane(tab.root, paneId);
        if (!pane) return tab;
        const selectedPaneTab = getLeafTerminalTabs(pane).find((item) => item.id === paneTabId);
        if (!selectedPaneTab) return tab;
        return {
          ...tab,
          active_pane_id: paneId,
          root: updateLeafPane(tab.root, paneId, {
            active_terminal_tab_id: selectedPaneTab.id,
            runtime_session_id: selectedPaneTab.runtime_session_id,
            saved_session_id: selectedPaneTab.saved_session_id,
            title: selectedPaneTab.title,
          }),
          updated_at_ms: Date.now(),
        };
      }),
      updated_at_ms: Date.now(),
    }))),
  movePaneTab: (sourcePaneId, paneTabId, targetPaneId, beforePaneTabId) =>
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) => {
        if (tab.id !== workspace.activeTabId) return tab;
        const root = movePaneTabInRoot(tab.root, sourcePaneId, paneTabId, targetPaneId, beforePaneTabId);
        return root === tab.root
          ? tab
          : { ...tab, active_pane_id: targetPaneId, root, updated_at_ms: Date.now() };
      }),
      updated_at_ms: Date.now(),
    }))),
  setActivePane: (paneId) =>
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) =>
        tab.id === workspace.activeTabId ? { ...tab, active_pane_id: paneId, updated_at_ms: Date.now() } : tab,
      ),
      updated_at_ms: Date.now(),
    }))),
  bindRuntimeToPane: (runtime) => {
    const state = get();
    const workspace = activeWorkspaceFromState(state);
    const tab = workspace?.tabs.find((item) => item.id === workspace.activeTabId);
    const pane = tab ? findLeafPane(tab.root, runtime.pane_id) : null;
    const paneTab = pane ? getActiveTerminalTab(pane) : null;
    if (!workspace || !tab || !paneTab) return;
    get().bindRuntimeToPaneTab(workspace.id, tab.id, runtime.pane_id, paneTab.id, runtime);
  },
  bindRuntimeToPaneTab: (workspaceId, workspaceTabId, paneId, paneTabId, runtime) =>
    set((state) => {
      const activeMirror = workspaceId === state.activeWorkspaceId ? activeWorkspaceFromState(state) : null;
      const workspaces = state.workspaces.map((workspace) => {
        const sourceWorkspace = activeMirror?.id === workspace.id ? activeMirror : workspace;
        if (sourceWorkspace.id !== workspaceId) return workspace;
        return {
          ...sourceWorkspace,
          tabs: sourceWorkspace.tabs.map((tab) => {
            if (tab.id !== workspaceTabId) return tab;
            const root = numberDuplicateSessionTabs(
              updateTerminalTabInRoot(tab.root, paneId, paneTabId, (terminalTab) => ({
                ...terminalTab,
                runtime_session_id: runtime.runtime_session_id,
                saved_session_id: runtime.saved_session_id,
                title: runtime.title,
                restore_status: "connected",
                restore_error: null,
                visual_snapshot: null,
              })),
              runtime.saved_session_id,
              runtime.title,
            );
            const activeLeaf = findLeafPane(root, paneId);
            return {
              ...tab,
              title: activeLeaf?.title ?? tab.title,
              root,
              updated_at_ms: Date.now(),
            };
          }),
          status: "running" as const,
          updated_at_ms: Date.now(),
        };
      });
      const active = workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
      return {
        workspaces,
        ...(active ? mirrorWorkspace(active) : {}),
      };
    }),
  splitActivePane: (direction) =>
    set((state) => updateActiveWorkspace(state, (workspace) => {
      const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
      if (!activeTab || !canSplitPane(activeTab.root, activeTab.active_pane_id, direction)) return workspace;

      const newPane = createPane(activeTab.root);
      return {
        ...workspace,
        tabs: workspace.tabs.map((tab) =>
          tab.id === activeTab.id
            ? {
                ...tab,
                active_pane_id: newPane.id,
                root: splitPane(tab.root, tab.active_pane_id, direction, newPane),
                updated_at_ms: Date.now(),
              }
            : tab,
        ),
        updated_at_ms: Date.now(),
      };
    })),
  resizeSplitPane: (splitId, ratio) =>
    set((state) => updateActiveWorkspace(state, (workspace) => ({
      ...workspace,
      tabs: workspace.tabs.map((tab) =>
        tab.id === workspace.activeTabId
          ? { ...tab, root: updateSplitRatio(tab.root, splitId, ratio), updated_at_ms: Date.now() }
          : tab,
      ),
      updated_at_ms: Date.now(),
    }))),
  closePane: (paneId) =>
    set((state) => {
      const workspace = activeWorkspaceFromState(state);
      const sourceTabs = workspace?.tabs ?? state.tabs;
      const sourceActiveTabId = workspace?.activeTabId ?? state.activeTabId;
      const tabs = sourceTabs
        .map((tab) => {
          if (tab.id !== sourceActiveTabId) return tab;
          const root = removePane(tab.root, paneId);
          if (!root) return null;
          return {
            ...tab,
            active_pane_id: findLeafPane(root, tab.active_pane_id)
              ? tab.active_pane_id
              : (firstLeafPaneId(root) ?? tab.active_pane_id),
            root,
            updated_at_ms: Date.now(),
          };
        })
        .filter((tab): tab is WorkspaceTab => Boolean(tab));

      const fallbackDefault = createDefaultWorkspace();
      const nextTabs = tabs.length > 0 ? tabs : fallbackDefault.tabs;
      const nextActiveTabId = nextTabs[0]?.id ?? fallbackDefault.activeTabId;
      return updateActiveWorkspace(state, (current) => ({
        ...current,
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
        active_tab_id: nextActiveTabId,
        updated_at_ms: Date.now(),
      }));
    }),
}));

function updateActiveWorkspace(
  state: WorkspaceStore,
  updater: (workspace: WorkspaceRuntime) => WorkspaceRuntime,
): Partial<WorkspaceStore> {
  const current = normalizeWorkspaceRuntime(activeWorkspaceFromState(state) ?? createDefaultWorkspace());
  const next = normalizeWorkspaceRuntime(updater(current));
  const workspaces = upsertWorkspace(state.workspaces, next);
  return {
    workspaces,
    ...mirrorWorkspace(next),
  };
}

function activeWorkspaceFromState(state: WorkspaceStore): WorkspaceRuntime | null {
  const existing = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId);
  if (!existing) {
    return null;
  }
  if (existing.tabs !== state.tabs || existing.activeTabId !== state.activeTabId) {
    return {
      ...existing,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      active_tab_id: state.activeTabId,
    };
  }
  return existing;
}

function mirrorWorkspace(workspace: WorkspaceRuntime): Partial<WorkspaceStore> {
  return {
    activeWorkspaceId: workspace.id,
    tabs: workspace.tabs,
    activeTabId: workspace.activeTabId,
  };
}

function upsertWorkspace(workspaces: WorkspaceRuntime[], workspace: WorkspaceRuntime): WorkspaceRuntime[] {
  const exists = workspaces.some((item) => item.id === workspace.id);
  return exists ? workspaces.map((item) => (item.id === workspace.id ? workspace : item)) : [...workspaces, workspace];
}

function createInitialPane(): PaneNode {
  return {
    kind: "leaf",
    id: "pane-1",
    runtime_session_id: null,
    saved_session_id: null,
    title: "新建终端",
    active_terminal_tab_id: "pane-1-tab-1",
    terminal_tabs: [
      {
        id: "pane-1-tab-1",
        title: "新建终端",
        runtime_session_id: null,
        saved_session_id: null,
      },
    ],
  };
}

function createDefaultWorkspace(timestamp = Date.now()): WorkspaceRuntime {
  const pane = createInitialPane();
  const tab: WorkspaceTab = {
    id: "tab-1",
    title: "新建终端",
    active_pane_id: pane.id,
    root: pane,
    sort_order: 0,
    created_at_ms: timestamp,
    updated_at_ms: timestamp,
  };
  return {
    id: DEFAULT_WORKSPACE_ID,
    name: "默认工作区",
    status: "running",
    active_tab_id: tab.id,
    activeTabId: tab.id,
    tabs: [tab],
    sort_order: 0,
    created_at_ms: timestamp,
    updated_at_ms: timestamp,
  };
}

function normalizeWorkspaceRuntime(workspace: WorkspaceRuntime): WorkspaceRuntime {
  const activeTabId = workspace.activeTabId ?? workspace.active_tab_id;
  return {
    ...workspace,
    active_tab_id: activeTabId,
    activeTabId,
    tabs: normalizeWorkspaceTabsPaneIds(workspace.tabs),
  };
}

function workspaceDraftFromRuntime(workspace: WorkspaceRuntime): WorkspaceDefinitionDraft {
  const tabs = normalizeWorkspaceTabsPaneIds(workspace.tabs);
  return {
    id: workspace.id,
    name: workspace.name,
    status: "closed",
    active_tab_id: workspace.activeTabId,
    sort_order: workspace.sort_order,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      active_pane_id: tab.active_pane_id,
      root: stripRuntimeState(tab.root),
      sort_order: tab.sort_order,
    })),
  };
}

function stripRuntimeState(root: PaneNode): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: stripRuntimeState(root.first),
      second: stripRuntimeState(root.second),
    };
  }

  const retainedTabs = getLeafTerminalTabs(root).filter((tab) => !isTransientConnectionTab(tab));
  const sourceTabs = retainedTabs.length > 0 ? retainedTabs : [emptyPersistedTerminalTab(root.id)];
  const terminalTabs = sourceTabs.map((tab) => ({
    ...stripTerminalVisualSnapshot(tab),
    runtime_session_id: null,
    connection_source: tab.connection_source ?? (tab.saved_session_id ? "saved_session" : "default_local"),
    restore_status: null,
    restore_error: null,
  }));
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === root.active_terminal_tab_id) ?? terminalTabs[0];
  return {
    ...root,
    runtime_session_id: null,
    saved_session_id: activeTerminalTab?.saved_session_id ?? root.saved_session_id,
    title: activeTerminalTab?.title ?? root.title,
    active_terminal_tab_id: activeTerminalTab?.id ?? root.active_terminal_tab_id,
    terminal_tabs: terminalTabs,
  };
}

function isTransientConnectionTab(tab: PaneTerminalTab): boolean {
  return tab.connection_source === "external_ssh" || tab.saved_session_id?.startsWith("external:") === true;
}

function emptyPersistedTerminalTab(paneId: string): PaneTerminalTab {
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

function clearRuntimeSessionFromRoot(root: PaneNode, runtimeSessionId: string): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: clearRuntimeSessionFromRoot(root.first, runtimeSessionId),
      second: clearRuntimeSessionFromRoot(root.second, runtimeSessionId),
    };
  }

  const terminalTabs = getLeafTerminalTabs(root).map((tab) =>
    tab.runtime_session_id === runtimeSessionId
      ? {
          ...stripTerminalVisualSnapshot(tab),
          runtime_session_id: null,
          restore_status: null,
          restore_error: null,
        }
      : tab,
  );
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === root.active_terminal_tab_id) ?? terminalTabs[0];
  return {
    ...root,
    runtime_session_id: activeTerminalTab?.runtime_session_id ?? null,
    saved_session_id: activeTerminalTab?.saved_session_id ?? root.saved_session_id,
    title: activeTerminalTab?.title ?? root.title,
    terminal_tabs: terminalTabs,
  };
}

function collectRuntimeSessionIds(tabs: WorkspaceTab[]): string[] {
  const ids = new Set<string>();
  for (const tab of tabs) {
    collectRuntimeSessionIdsFromRoot(tab.root, ids);
  }
  return [...ids];
}

function collectRuntimeSessionIdsFromRoot(root: PaneNode, ids: Set<string>) {
  if (root.kind === "split") {
    collectRuntimeSessionIdsFromRoot(root.first, ids);
    collectRuntimeSessionIdsFromRoot(root.second, ids);
    return;
  }

  if (root.runtime_session_id) ids.add(root.runtime_session_id);
  for (const terminalTab of getLeafTerminalTabs(root)) {
    if (terminalTab.runtime_session_id) ids.add(terminalTab.runtime_session_id);
  }
}

function createPane(existingRoot?: PaneNode): LeafPane {
  const id = nextPaneId(existingRoot);
  const paneTab = createPaneTab(`${id}-tab-1`);
  return {
    kind: "leaf",
    id,
    runtime_session_id: paneTab.runtime_session_id,
    saved_session_id: paneTab.saved_session_id,
    title: paneTab.title,
    active_terminal_tab_id: paneTab.id,
    terminal_tabs: [paneTab],
  };
}

function nextPaneId(existingRoot?: PaneNode): string {
  const existingPaneIds = new Set<string>();
  if (existingRoot) collectLeafPaneIds(existingRoot, existingPaneIds);

  let id = `pane-${nextPaneCounter}`;
  while (existingPaneIds.has(id)) {
    nextPaneCounter += 1;
    id = `pane-${nextPaneCounter}`;
  }
  nextPaneCounter += 1;
  return id;
}

function collectLeafPaneIds(root: PaneNode, paneIds: Set<string>) {
  if (root.kind === "leaf") {
    paneIds.add(root.id);
    return;
  }

  collectLeafPaneIds(root.first, paneIds);
  collectLeafPaneIds(root.second, paneIds);
}

function createPaneTab(id = `pane-tab-${nextPaneTabCounter++}`): PaneTerminalTab {
  return {
    id,
    title: "新建终端",
    runtime_session_id: null,
    saved_session_id: null,
  };
}

function createAvailablePaneTab(tabs: WorkspaceTab[]): PaneTerminalTab {
  const reservedIds = new Set<string>();
  tabs.forEach((tab) => collectPaneTerminalTabIds(tab.root, reservedIds));
  let counter = 1;
  let id = `pane-tab-${counter}`;
  while (reservedIds.has(id)) {
    counter += 1;
    id = `pane-tab-${counter}`;
  }
  return createPaneTab(id);
}

function collectPaneTerminalTabIds(root: PaneNode, terminalTabIds: Set<string>) {
  if (root.kind === "leaf") {
    getLeafTerminalTabs(root).forEach((terminalTab) => terminalTabIds.add(terminalTab.id));
    return;
  }
  collectPaneTerminalTabIds(root.first, terminalTabIds);
  collectPaneTerminalTabIds(root.second, terminalTabIds);
}

function stripTerminalVisualSnapshot(tab: PaneTerminalTab): PaneTerminalTab {
  const { visual_snapshot: _visualSnapshot, ...rest } = tab;
  return rest;
}

function addPaneTabPatch(root: PaneNode, paneId: string, paneTab: PaneTerminalTab): Partial<LeafPane> {
  const pane = findLeafPane(root, paneId);
  const terminalTabs = pane ? getLeafTerminalTabs(pane) : [];
  return {
    active_terminal_tab_id: paneTab.id,
    terminal_tabs: [...terminalTabs, paneTab],
    runtime_session_id: paneTab.runtime_session_id,
    saved_session_id: paneTab.saved_session_id,
    title: paneTab.title,
  };
}

function addPaneTabAfterPatch(
  root: PaneNode,
  paneId: string,
  afterPaneTabId: string,
  paneTab: PaneTerminalTab,
): Partial<LeafPane> {
  const pane = findLeafPane(root, paneId);
  const terminalTabs = pane ? getLeafTerminalTabs(pane) : [];
  const afterIndex = terminalTabs.findIndex((tab) => tab.id === afterPaneTabId);
  const nextTerminalTabs =
    afterIndex >= 0
      ? [
          ...terminalTabs.slice(0, afterIndex + 1),
          paneTab,
          ...terminalTabs.slice(afterIndex + 1),
        ]
      : [...terminalTabs, paneTab];
  return {
    active_terminal_tab_id: paneTab.id,
    terminal_tabs: nextTerminalTabs,
    runtime_session_id: paneTab.runtime_session_id,
    saved_session_id: paneTab.saved_session_id,
    title: paneTab.title,
  };
}

function closePaneTabInRoot(root: PaneNode, paneId: string, paneTabId: string): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: closePaneTabInRoot(root.first, paneId, paneTabId),
      second: closePaneTabInRoot(root.second, paneId, paneTabId),
    };
  }

  if (root.id !== paneId) return root;

  const terminalTabs = getLeafTerminalTabs(root);
  const closedIndex = terminalTabs.findIndex((tab) => tab.id === paneTabId);
  if (closedIndex < 0) return root;

  const remainingTabs = terminalTabs.filter((tab) => tab.id !== paneTabId);
  const nextTerminalTabs = remainingTabs.length > 0 ? remainingTabs : [createPaneTab(`${paneId}-tab-${nextPaneTabCounter++}`)];
  const currentActiveTabId = getActiveTerminalTab(root).id;
  const nextActiveTerminalTab =
    nextTerminalTabs.find((tab) => tab.id === currentActiveTabId) ??
    nextTerminalTabs[Math.max(0, closedIndex - 1)] ??
    nextTerminalTabs[0];

  return {
    ...root,
    title: nextActiveTerminalTab.title,
    runtime_session_id: nextActiveTerminalTab.runtime_session_id,
    saved_session_id: nextActiveTerminalTab.saved_session_id,
    active_terminal_tab_id: nextActiveTerminalTab.id,
    terminal_tabs: nextTerminalTabs,
  };
}

function movePaneTabInRoot(
  root: PaneNode,
  sourcePaneId: string,
  paneTabId: string,
  targetPaneId: string,
  beforePaneTabId: string | null,
): PaneNode {
  const sourcePane = findLeafPane(root, sourcePaneId);
  const targetPane = findLeafPane(root, targetPaneId);
  if (!sourcePane || !targetPane) return root;

  const sourceTabs = getLeafTerminalTabs(sourcePane);
  const movedTab = sourceTabs.find((tab) => tab.id === paneTabId);
  if (!movedTab) return root;

  if (sourcePaneId === targetPaneId) {
    if (beforePaneTabId === paneTabId) return root;
    const remainingTabs = sourceTabs.filter((tab) => tab.id !== paneTabId);
    const beforeIndex = beforePaneTabId ? remainingTabs.findIndex((tab) => tab.id === beforePaneTabId) : -1;
    const terminalTabs = beforeIndex >= 0
      ? [...remainingTabs.slice(0, beforeIndex), movedTab, ...remainingTabs.slice(beforeIndex)]
      : [...remainingTabs, movedTab];
    return updateLeafPane(root, sourcePaneId, leafPatchForActiveTab(terminalTabs, movedTab.id));
  }

  const remainingSourceTabs = sourceTabs.filter((tab) => tab.id !== paneTabId);
  const nextSourceTabs = remainingSourceTabs;
  const sourceActiveTabId = getActiveTerminalTab(sourcePane).id;
  const sourceNextActiveTab = nextSourceTabs.find((tab) => tab.id === sourceActiveTabId) ?? nextSourceTabs[0] ?? null;

  const targetTabs = getLeafTerminalTabs(targetPane);
  const beforeIndex = beforePaneTabId ? targetTabs.findIndex((tab) => tab.id === beforePaneTabId) : -1;
  const nextTargetTabs = beforeIndex >= 0
    ? [...targetTabs.slice(0, beforeIndex), movedTab, ...targetTabs.slice(beforeIndex)]
    : [...targetTabs, movedTab];

  return updateLeafPane(
    updateLeafPane(root, sourcePaneId, leafPatchForActiveTab(nextSourceTabs, sourceNextActiveTab?.id ?? null)),
    targetPaneId,
    leafPatchForActiveTab(nextTargetTabs, movedTab.id),
  );
}

function leafPatchForActiveTab(terminalTabs: PaneTerminalTab[], activePaneTabId: string | null): Partial<LeafPane> {
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === activePaneTabId) ?? terminalTabs[0] ?? null;
  return {
    terminal_tabs: terminalTabs,
    active_terminal_tab_id: activeTerminalTab?.id,
    title: activeTerminalTab?.title ?? "新建终端",
    runtime_session_id: activeTerminalTab?.runtime_session_id ?? null,
    saved_session_id: activeTerminalTab?.saved_session_id ?? null,
  };
}

function numberDuplicateSessionTabs(root: PaneNode, savedSessionId: string | null, title: string): PaneNode {
  if (!savedSessionId || countNumberedSessionTabs(root, savedSessionId) <= 1) return root;

  let index = 0;
  const baseTitle = title.replace(/\s\(\d+\)$/, "");

  function visit(node: PaneNode): PaneNode {
    if (node.kind === "split") {
      return {
        ...node,
        first: visit(node.first),
        second: visit(node.second),
      };
    }

    const terminalTabs = getLeafTerminalTabs(node).map((tab) => {
      if (tab.saved_session_id !== savedSessionId || tab.connection_source === "ssh_container") return tab;
      index += 1;
      return { ...tab, title: `${baseTitle} (${index})` };
    });
    const activeTerminalTab = terminalTabs.find((tab) => tab.id === node.active_terminal_tab_id) ?? terminalTabs[0];

    return {
      ...node,
      title: activeTerminalTab.title,
      runtime_session_id: activeTerminalTab.runtime_session_id,
      saved_session_id: activeTerminalTab.saved_session_id,
      active_terminal_tab_id: activeTerminalTab.id,
      terminal_tabs: terminalTabs,
    };
  }

  return visit(root);
}

function countNumberedSessionTabs(root: PaneNode, savedSessionId: string): number {
  if (root.kind === "split") {
    return countNumberedSessionTabs(root.first, savedSessionId) + countNumberedSessionTabs(root.second, savedSessionId);
  }

  return getLeafTerminalTabs(root).filter(
    (tab) => tab.saved_session_id === savedSessionId && tab.connection_source !== "ssh_container",
  ).length;
}
