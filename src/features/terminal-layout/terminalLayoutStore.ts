// Author: Liz
import { create } from "zustand";

import type { RuntimeSessionInfo } from "../terminal/terminalStore";
import {
  canSplitPane,
  findLeafPane,
  firstLeafPaneId,
  getActiveTerminalTab,
  getLeafTerminalTabs,
  normalizeTerminalLayoutTabsPaneIds,
  removePane,
  splitPane,
  updateLeafPane,
  updateSplitRatio,
  updateTerminalTabInRoot,
} from "./terminalLayoutLayout";
import type {
  PaneNode,
  PaneSplitDirection,
  PaneTerminalTab,
  TerminalLayoutDefinition,
  TerminalLayoutDefinitionDraft,
  TerminalLayoutRuntime,
  TerminalLayoutTab,
} from "./types";
import { DEFAULT_TERMINAL_LAYOUT_ID } from "./terminalLayoutConstants";

type LeafPane = Extract<PaneNode, { kind: "leaf" }>;

interface TerminalLayoutStore {
  runtime: TerminalLayoutRuntime;
  activeTerminalLayoutId: string;
  tabs: TerminalLayoutTab[];
  activeTabId: string;
  buildActiveTerminalLayoutDraft: () => TerminalLayoutDefinitionDraft | null;
  restoreWorkbenchDefinition: (terminalLayout: TerminalLayoutDefinition) => void;
  clearRuntimeSession: (runtimeSessionId: string) => void;
  markRuntimeExited: (runtimeSessionId: string, message: string, snapshotText?: string | null) => void;
  hasPaneTerminalTab: (
    terminalLayoutId: string,
    terminalLayoutTabId: string,
    paneId: string,
    paneTabId: string,
  ) => boolean;
  updatePaneTerminalTab: (
    terminalLayoutId: string,
    terminalLayoutTabId: string,
    paneId: string,
    paneTabId: string,
    patch: Partial<PaneTerminalTab>,
  ) => void;
  addPaneTab: (paneId: string) => PaneTerminalTab;
  addPaneTabAfter: (paneId: string, afterPaneTabId: string) => PaneTerminalTab;
  closePaneTab: (paneId: string, paneTabId: string) => void;
  selectPaneTab: (paneId: string, paneTabId: string) => void;
  movePaneTab: (sourcePaneId: string, paneTabId: string, targetPaneId: string, beforePaneTabId: string | null) => void;
  setActivePane: (paneId: string) => void;
  bindRuntimeToPane: (runtime: RuntimeSessionInfo) => void;
  bindRuntimeToPaneTab: (
    terminalLayoutId: string,
    terminalLayoutTabId: string,
    paneId: string,
    paneTabId: string,
    runtime: RuntimeSessionInfo,
  ) => void;
  splitActivePane: (direction: PaneSplitDirection) => void;
  resizeSplitPane: (splitId: string, ratio: number) => void;
  closePane: (paneId: string) => void;
}

let nextPaneCounter = 2;
let nextPaneTabCounter = 2;

const now = Date.now();
const initialTerminalLayout = createDefaultTerminalLayout(now);

export const useTerminalLayoutStore = create<TerminalLayoutStore>((set, get) => ({
  runtime: initialTerminalLayout,
  activeTerminalLayoutId: initialTerminalLayout.id,
  tabs: initialTerminalLayout.tabs,
  activeTabId: initialTerminalLayout.activeTabId,
  buildActiveTerminalLayoutDraft: () => {
    const terminalLayout = activeTerminalLayoutFromState(get());
    if (!terminalLayout) return null;
    return terminalLayoutDraftFromRuntime(terminalLayout);
  },
  restoreWorkbenchDefinition: (terminalLayout) =>
    set((state) => {
      const current = activeTerminalLayoutFromState(state) ?? createDefaultTerminalLayout();
      const restored = normalizeTerminalLayoutRuntime({
        ...current,
        id: DEFAULT_TERMINAL_LAYOUT_ID,
        name: "终端布局",
        status: "running",
        active_tab_id: terminalLayout.active_tab_id,
        activeTabId: terminalLayout.active_tab_id,
        tabs: terminalLayout.tabs,
        updated_at_ms: Date.now(),
      });
      return {
        runtime: restored,
        ...mirrorTerminalLayout(restored),
      };
    }),
  clearRuntimeSession: (runtimeSessionId) =>
    set((state) =>
      updateActiveTerminalLayout(state, (terminalLayout) => ({
        ...terminalLayout,
        tabs: terminalLayout.tabs.map((tab) => ({
          ...tab,
          root: clearRuntimeSessionFromRoot(tab.root, runtimeSessionId),
          updated_at_ms: Date.now(),
        })),
        updated_at_ms: Date.now(),
      })),
    ),
  markRuntimeExited: (runtimeSessionId, message, snapshotText) =>
    set((state) =>
      updateActiveTerminalLayout(state, (terminalLayout) => ({
        ...terminalLayout,
        tabs: terminalLayout.tabs.map((tab) => ({
          ...tab,
          root: markRuntimeExitedInRoot(tab.root, runtimeSessionId, message, snapshotText),
          updated_at_ms: Date.now(),
        })),
        updated_at_ms: Date.now(),
      })),
    ),
  hasPaneTerminalTab: (terminalLayoutId, terminalLayoutTabId, paneId, paneTabId) => {
    const state = get();
    const terminalLayout = (state.runtime.id === terminalLayoutId ? state.runtime : null);
    const terminalLayoutTab = terminalLayout?.tabs.find((item) => item.id === terminalLayoutTabId);
    const pane = terminalLayoutTab ? findLeafPane(terminalLayoutTab.root, paneId) : null;
    return Boolean(pane && getLeafTerminalTabs(pane).some((item) => item.id === paneTabId));
  },
  updatePaneTerminalTab: (terminalLayoutId, terminalLayoutTabId, paneId, paneTabId, patch) =>
    set((state) => {
      const next = ((terminalLayout: TerminalLayoutRuntime) => {
        if (terminalLayout.id !== terminalLayoutId) return terminalLayout;
        return {
          ...terminalLayout,
          tabs: terminalLayout.tabs.map((tab) =>
            tab.id === terminalLayoutTabId
              ? {
                  ...tab,
                  root: updateTerminalTabInRoot(tab.root, paneId, paneTabId, (terminalTab) => ({
                    ...terminalTab,
                    ...patch,
                    ...(patch.restore_status === "pending" && !("restore_token" in patch) ? { restore_token: null } : {}),
                  })),
                  updated_at_ms: Date.now(),
                }
              : tab,
          ),
          updated_at_ms: Date.now(),
        };
      })(state.runtime);
      return { runtime: next, ...mirrorTerminalLayout(next) };
    }),
  addPaneTab: (paneId) => {
    const paneTab = createAvailablePaneTab(activeTerminalLayoutFromState(get())?.tabs ?? get().tabs);
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) => {
        if (tab.id !== terminalLayout.activeTabId) return tab;
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
    const paneTab = createAvailablePaneTab(activeTerminalLayoutFromState(get())?.tabs ?? get().tabs);
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) => {
        if (tab.id !== terminalLayout.activeTabId) return tab;
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
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) => {
        if (tab.id !== terminalLayout.activeTabId) return tab;
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
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) => {
        if (tab.id !== terminalLayout.activeTabId) return tab;
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
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) => {
        if (tab.id !== terminalLayout.activeTabId) return tab;
        const root = movePaneTabInRoot(tab.root, sourcePaneId, paneTabId, targetPaneId, beforePaneTabId);
        return root === tab.root
          ? tab
          : { ...tab, active_pane_id: targetPaneId, root, updated_at_ms: Date.now() };
      }),
      updated_at_ms: Date.now(),
    }))),
  setActivePane: (paneId) =>
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) =>
        tab.id === terminalLayout.activeTabId ? { ...tab, active_pane_id: paneId, updated_at_ms: Date.now() } : tab,
      ),
      updated_at_ms: Date.now(),
    }))),
  bindRuntimeToPane: (runtime) => {
    const state = get();
    const terminalLayout = activeTerminalLayoutFromState(state);
    const tab = terminalLayout?.tabs.find((item) => item.id === terminalLayout.activeTabId);
    const pane = tab ? findLeafPane(tab.root, runtime.pane_id) : null;
    const paneTab = pane ? getActiveTerminalTab(pane) : null;
    if (!terminalLayout || !tab || !paneTab) return;
    get().bindRuntimeToPaneTab(terminalLayout.id, tab.id, runtime.pane_id, paneTab.id, runtime);
  },
  bindRuntimeToPaneTab: (terminalLayoutId, terminalLayoutTabId, paneId, paneTabId, runtime) =>
    set((state) => {
      const activeMirror = terminalLayoutId === state.activeTerminalLayoutId ? activeTerminalLayoutFromState(state) : null;
      const next = ((terminalLayout: TerminalLayoutRuntime) => {
        const sourceTerminalLayout = activeMirror?.id === terminalLayout.id ? activeMirror : terminalLayout;
        if (sourceTerminalLayout.id !== terminalLayoutId) return terminalLayout;
        return {
          ...sourceTerminalLayout,
          tabs: sourceTerminalLayout.tabs.map((tab) => {
            if (tab.id !== terminalLayoutTabId) return tab;
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
      })(state.runtime);
      return { runtime: next, ...mirrorTerminalLayout(next) };
    }),
  splitActivePane: (direction) =>
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => {
      const activeTab = terminalLayout.tabs.find((tab) => tab.id === terminalLayout.activeTabId);
      if (!activeTab || !canSplitPane(activeTab.root, activeTab.active_pane_id, direction)) return terminalLayout;

      const newPane = createPane(activeTab.root);
      return {
        ...terminalLayout,
        tabs: terminalLayout.tabs.map((tab) =>
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
    set((state) => updateActiveTerminalLayout(state, (terminalLayout) => ({
      ...terminalLayout,
      tabs: terminalLayout.tabs.map((tab) =>
        tab.id === terminalLayout.activeTabId
          ? { ...tab, root: updateSplitRatio(tab.root, splitId, ratio), updated_at_ms: Date.now() }
          : tab,
      ),
      updated_at_ms: Date.now(),
    }))),
  closePane: (paneId) =>
    set((state) => {
      const terminalLayout = activeTerminalLayoutFromState(state);
      const sourceTabs = terminalLayout?.tabs ?? state.tabs;
      const sourceActiveTabId = terminalLayout?.activeTabId ?? state.activeTabId;
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
        .filter((tab): tab is TerminalLayoutTab => Boolean(tab));

      const fallbackDefault = createDefaultTerminalLayout(Date.now(), true);
      const nextTabs = tabs.length > 0 ? tabs : fallbackDefault.tabs;
      const nextActiveTabId = nextTabs[0]?.id ?? fallbackDefault.activeTabId;
      return updateActiveTerminalLayout(state, (current) => ({
        ...current,
        tabs: nextTabs,
        activeTabId: nextActiveTabId,
        active_tab_id: nextActiveTabId,
        updated_at_ms: Date.now(),
      }));
    }),
}));

function updateActiveTerminalLayout(
  state: TerminalLayoutStore,
  updater: (terminalLayout: TerminalLayoutRuntime) => TerminalLayoutRuntime,
): Partial<TerminalLayoutStore> {
  const current = normalizeTerminalLayoutRuntime(activeTerminalLayoutFromState(state) ?? createDefaultTerminalLayout());
  const next = normalizeTerminalLayoutRuntime(updater(current));

  return {
    runtime: next,
    ...mirrorTerminalLayout(next),
  };
}

function activeTerminalLayoutFromState(state: TerminalLayoutStore): TerminalLayoutRuntime | null {
  const existing = state.runtime;
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

function mirrorTerminalLayout(terminalLayout: TerminalLayoutRuntime): Partial<TerminalLayoutStore> {
  return {
    activeTerminalLayoutId: terminalLayout.id,
    tabs: terminalLayout.tabs,
    activeTabId: terminalLayout.activeTabId,
  };
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

function createDefaultTerminalLayout(timestamp = Date.now(), freshPane = false): TerminalLayoutRuntime {
  const pane = createInitialPane();
  if (freshPane && pane.kind === "leaf") {
    const suffix = crypto.randomUUID();
    pane.id = `pane-${suffix}`;
    pane.active_terminal_tab_id = `pane-tab-${suffix}`;
    pane.terminal_tabs = [{ id: pane.active_terminal_tab_id, title: pane.title, runtime_session_id: null, saved_session_id: null }];
  }
  const tab: TerminalLayoutTab = {
    id: "tab-1",
    title: "新建终端",
    active_pane_id: pane.id,
    root: pane,
    sort_order: 0,
    created_at_ms: timestamp,
    updated_at_ms: timestamp,
  };
  return {
    id: DEFAULT_TERMINAL_LAYOUT_ID,
    name: "终端布局",
    status: "running",
    active_tab_id: tab.id,
    activeTabId: tab.id,
    tabs: [tab],
    sort_order: 0,
    created_at_ms: timestamp,
    updated_at_ms: timestamp,
  };
}

function normalizeTerminalLayoutRuntime(terminalLayout: TerminalLayoutRuntime): TerminalLayoutRuntime {
  const activeTabId = terminalLayout.activeTabId ?? terminalLayout.active_tab_id;
  return {
    ...terminalLayout,
    active_tab_id: activeTabId,
    activeTabId,
    tabs: normalizeTerminalLayoutTabsPaneIds(terminalLayout.tabs),
  };
}

function terminalLayoutDraftFromRuntime(terminalLayout: TerminalLayoutRuntime): TerminalLayoutDefinitionDraft {
  const tabs = normalizeTerminalLayoutTabsPaneIds(terminalLayout.tabs);
  return {
    id: terminalLayout.id,
    name: terminalLayout.name,
    status: "closed",
    active_tab_id: terminalLayout.activeTabId,
    sort_order: terminalLayout.sort_order,
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
    connection_source: tab.connection_source ?? (tab.saved_session_id ? "saved_session" : tab.runtime_session_id ? "default_local" : "empty"),
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
  return tab.connection_source === "external_ssh" || tab.connection_source === "external_local" || tab.saved_session_id?.startsWith("external:") === true;
}

function emptyPersistedTerminalTab(paneId: string): PaneTerminalTab {
  return {
    id: `${paneId}-tab-1`,
    title: "新建终端",
    runtime_session_id: null,
    saved_session_id: null,
    connection_source: "empty",
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

function markRuntimeExitedInRoot(
  root: PaneNode,
  runtimeSessionId: string,
  message: string,
  snapshotText?: string | null,
): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: markRuntimeExitedInRoot(root.first, runtimeSessionId, message, snapshotText),
      second: markRuntimeExitedInRoot(root.second, runtimeSessionId, message, snapshotText),
    };
  }

  const terminalTabs = getLeafTerminalTabs(root).map((tab) =>
    tab.runtime_session_id === runtimeSessionId
      ? {
          ...stripTerminalVisualSnapshot(tab),
          runtime_session_id: null,
          restore_status: "failed" as const,
          restore_error: message,
          visual_snapshot: snapshotText
            ? {
                kind: "terminal_tail" as const,
                text: snapshotText,
                captured_at_ms: Date.now(),
                runtime_session_id: null,
              }
            : null,
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

function createAvailablePaneTab(tabs: TerminalLayoutTab[]): PaneTerminalTab {
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
  const nextTerminalTabs = remainingTabs.length > 0 ? remainingTabs : [createPaneTab(`${paneId}-tab-${crypto.randomUUID()}`)];
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
