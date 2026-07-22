// Author: Liz
import type { PaneNode, PaneSplitDirection, PaneTerminalTab } from "./types";
import { MIN_PANE_FRACTION } from "./workspaceConstants";

type LeafPane = Extract<PaneNode, { kind: "leaf" }>;

export interface TerminalReference {
  terminal_ref: string;
  runtime_session_id: string;
}

interface PaneGeometry {
  pane: LeafPane;
  left: number;
  top: number;
  width: number;
  height: number;
  order: number;
}

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;

function clampRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

export function findPane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === "leaf") {
    return root.id === paneId ? root : null;
  }

  return findPane(root.first, paneId) ?? findPane(root.second, paneId);
}

export function findLeafPane(root: PaneNode, paneId: string): LeafPane | null {
  const pane = findPane(root, paneId);
  return pane?.kind === "leaf" ? pane : null;
}

export function firstLeafPaneId(root: PaneNode): string | null {
  if (root.kind === "leaf") return root.id;
  return firstLeafPaneId(root.first) ?? firstLeafPaneId(root.second);
}

/** Returns pane ids in visual reading order, not binary-tree implementation order. */
export function getLeafPaneIdsInVisualOrder(root: PaneNode): string[] {
  return collectPaneGeometry(root)
    .sort((left, right) => left.top - right.top || left.left - right.left || left.order - right.order)
    .map((item) => item.pane.id);
}

export function getPaneDisplayLabels(root: PaneNode): Record<string, string> {
  return Object.fromEntries(
    getLeafPaneIdsInVisualOrder(root).map((paneId, index) => [paneId, alphabeticPaneLabel(index)]),
  );
}

export function getTerminalReferences(root: PaneNode): TerminalReference[] {
  const paneLabels = getPaneDisplayLabels(root);
  return getLeafPaneIdsInVisualOrder(root).flatMap((paneId) => {
    const leaf = findLeafPane(root, paneId);
    if (!leaf) return [];
    return getLeafTerminalTabs(leaf)
      .filter(isVisibleTerminalTab)
      .flatMap((terminalTab, index) =>
        terminalTab.runtime_session_id
          ? [{ terminal_ref: `${paneLabels[paneId]}${index + 1}`, runtime_session_id: terminalTab.runtime_session_id }]
          : [],
      );
  });
}

export function isVisibleTerminalTab(terminalTab: PaneTerminalTab): boolean {
  return !(
    terminalTab.title === "新建终端" &&
    !terminalTab.runtime_session_id &&
    !terminalTab.saved_session_id &&
    !terminalTab.restore_status &&
    terminalTab.connection_source !== "missing"
  );
}

/**
 * The default split is 50/50.  Permit it only when both resulting panes retain
 * at least a quarter of the full workspace along the split axis.
 */
export function canSplitPane(root: PaneNode, targetPaneId: string, direction: PaneSplitDirection): boolean {
  const panes = collectPaneGeometry(root);
  const target = panes.find((item) => item.pane.id === targetPaneId);
  if (!target) return false;

  const targetSize = direction === "horizontal" ? target.width : target.height;
  const inheritedSize = direction === "horizontal" ? target.height : target.width;
  return inheritedSize >= MIN_PANE_FRACTION && targetSize * 0.5 >= MIN_PANE_FRACTION;
}

function alphabeticPaneLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function collectPaneGeometry(root: PaneNode): PaneGeometry[] {
  const panes: PaneGeometry[] = [];
  let order = 0;

  function visit(node: PaneNode, left: number, top: number, width: number, height: number) {
    if (node.kind === "leaf") {
      panes.push({ pane: node, left, top, width, height, order: order++ });
      return;
    }
    if (node.direction === "horizontal") {
      const firstWidth = width * node.ratio;
      visit(node.first, left, top, firstWidth, height);
      visit(node.second, left + firstWidth, top, width - firstWidth, height);
      return;
    }
    const firstHeight = height * node.ratio;
    visit(node.first, left, top, width, firstHeight);
    visit(node.second, left, top + firstHeight, width, height - firstHeight);
  }

  visit(root, 0, 0, 1, 1);
  return panes;
}

export function normalizeWorkspaceTabsPaneIds<T extends { active_pane_id: string; root: PaneNode }>(
  tabs: T[],
): T[] {
  return tabs.map((tab) => normalizeWorkspaceTabPaneIds(tab));
}

function normalizeWorkspaceTabPaneIds<T extends { active_pane_id: string; root: PaneNode }>(tab: T): T {
  const reservedPaneIds = new Set<string>();
  collectPaneIds(tab.root, reservedPaneIds);
  const seenPaneIds = new Set<string>();
  const normalizedRoot = normalizePaneIds(tab.root, seenPaneIds, reservedPaneIds);
  const activePaneId = findLeafPane(normalizedRoot, tab.active_pane_id)
    ? tab.active_pane_id
    : firstLeafPaneId(normalizedRoot) ?? tab.active_pane_id;
  return { ...tab, active_pane_id: activePaneId, root: normalizedRoot };
}

function normalizePaneIds(root: PaneNode, seenPaneIds: Set<string>, reservedPaneIds: Set<string>): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: normalizePaneIds(root.first, seenPaneIds, reservedPaneIds),
      second: normalizePaneIds(root.second, seenPaneIds, reservedPaneIds),
    };
  }

  const originalId = root.id;
  if (!seenPaneIds.has(originalId)) {
    seenPaneIds.add(originalId);
    return normalizeLeafTerminalTabIds(root);
  }

  const id = nextAvailablePaneId(reservedPaneIds);
  seenPaneIds.add(id);
  const terminalTabs = getLeafTerminalTabs(root).map((terminalTab) =>
    renamePaneTerminalTabId(terminalTab, originalId, id),
  );
  const activeTerminalTabId = renamePaneTerminalTabIdValue(root.active_terminal_tab_id, originalId, id);

  return normalizeLeafTerminalTabIds({
    ...root,
    id,
    active_terminal_tab_id: activeTerminalTabId,
    terminal_tabs: terminalTabs,
  });
}

function normalizeLeafTerminalTabIds(root: LeafPane): LeafPane {
  const terminalTabs = getLeafTerminalTabs(root);
  const reservedIds = new Set(terminalTabs.map((terminalTab) => terminalTab.id));
  const seenIds = new Set<string>();
  let changed = false;
  const normalizedTabs = terminalTabs.map((terminalTab) => {
    if (!seenIds.has(terminalTab.id)) {
      seenIds.add(terminalTab.id);
      return terminalTab;
    }
    changed = true;
    const id = nextAvailableTerminalTabId(root.id, reservedIds);
    seenIds.add(id);
    return { ...terminalTab, id };
  });
  return changed ? { ...root, terminal_tabs: normalizedTabs } : root;
}

function nextAvailableTerminalTabId(paneId: string, reservedIds: Set<string>): string {
  let counter = 1;
  let id = `${paneId}-tab-${counter}`;
  while (reservedIds.has(id)) {
    counter += 1;
    id = `${paneId}-tab-${counter}`;
  }
  reservedIds.add(id);
  return id;
}

function collectPaneIds(root: PaneNode, paneIds: Set<string>) {
  if (root.kind === "leaf") {
    paneIds.add(root.id);
    return;
  }

  collectPaneIds(root.first, paneIds);
  collectPaneIds(root.second, paneIds);
}

function nextAvailablePaneId(reservedPaneIds: Set<string>): string {
  let counter = 1;
  let id = `pane-${counter}`;
  while (reservedPaneIds.has(id)) {
    counter += 1;
    id = `pane-${counter}`;
  }
  reservedPaneIds.add(id);
  return id;
}

function renamePaneTerminalTabId(
  terminalTab: PaneTerminalTab,
  oldPaneId: string,
  newPaneId: string,
): PaneTerminalTab {
  const id = renamePaneTerminalTabIdValue(terminalTab.id, oldPaneId, newPaneId) ?? terminalTab.id;
  return id === terminalTab.id ? terminalTab : { ...terminalTab, id };
}

function renamePaneTerminalTabIdValue(
  value: string | undefined,
  oldPaneId: string,
  newPaneId: string,
): string | undefined {
  const oldPrefix = `${oldPaneId}-tab-`;
  return value?.startsWith(oldPrefix) ? `${newPaneId}-tab-${value.slice(oldPrefix.length)}` : value;
}

export function getLeafTerminalTabs(leaf: LeafPane): PaneTerminalTab[] {
  if (leaf.terminal_tabs) {
    return leaf.terminal_tabs;
  }

  return [
    {
      id: `${leaf.id}-tab-1`,
      title: leaf.title,
      runtime_session_id: leaf.runtime_session_id,
      saved_session_id: leaf.saved_session_id,
    },
  ];
}

export function getActiveTerminalTab(
  leaf: Extract<PaneNode, { kind: "leaf" }>,
): PaneTerminalTab {
  const terminalTabs = getLeafTerminalTabs(leaf);
  return terminalTabs.find((tab) => tab.id === leaf.active_terminal_tab_id) ?? terminalTabs[0] ?? {
    id: `${leaf.id}-empty`,
    title: "新建终端",
    runtime_session_id: null,
    saved_session_id: null,
  };
}

function updateActiveTerminalTab(
  leaf: LeafPane,
  patch: Partial<PaneTerminalTab>,
): LeafPane {
  const activeTerminalTab = getActiveTerminalTab(leaf);
  const terminalTabs = getLeafTerminalTabs(leaf).map((tab) =>
    tab.id === activeTerminalTab.id ? { ...tab, ...patch, id: tab.id } : tab,
  );
  if (terminalTabs.length === 0) {
    return {
      ...leaf,
      title: "新建终端",
      runtime_session_id: null,
      saved_session_id: null,
      active_terminal_tab_id: undefined,
      terminal_tabs: terminalTabs,
    };
  }
  const nextActiveTerminalTab = terminalTabs.find((tab) => tab.id === activeTerminalTab.id) ?? terminalTabs[0];

  return {
    ...leaf,
    title: nextActiveTerminalTab.title,
    runtime_session_id: nextActiveTerminalTab.runtime_session_id,
    saved_session_id: nextActiveTerminalTab.saved_session_id,
    active_terminal_tab_id: nextActiveTerminalTab.id,
    terminal_tabs: terminalTabs,
  };
}

export function updateLeafPane(
  root: PaneNode,
  paneId: string,
  patch: Partial<LeafPane>,
): PaneNode {
  if (root.kind === "leaf") {
    if (root.id !== paneId) return root;
    const nextLeaf = { ...root, ...patch, id: root.id, kind: "leaf" } as LeafPane;
    if ("title" in patch || "runtime_session_id" in patch || "saved_session_id" in patch) {
      return updateActiveTerminalTab(nextLeaf, {
        title: nextLeaf.title,
        runtime_session_id: nextLeaf.runtime_session_id,
        saved_session_id: nextLeaf.saved_session_id,
      });
    }
    return nextLeaf;
  }

  return {
    ...root,
    first: updateLeafPane(root.first, paneId, patch),
    second: updateLeafPane(root.second, paneId, patch),
  };
}

export function updateTerminalTabInRoot(
  root: PaneNode,
  paneId: string,
  terminalTabId: string,
  updater: (terminalTab: PaneTerminalTab) => PaneTerminalTab,
): PaneNode {
  if (root.kind === "leaf") {
    if (root.id !== paneId) return root;
    let updated = false;
    const terminalTabs = getLeafTerminalTabs(root).map((terminalTab) => {
      if (terminalTab.id !== terminalTabId) return terminalTab;
      updated = true;
      return { ...updater(terminalTab), id: terminalTab.id };
    });
    if (!updated) return root;

    const activeTerminalTab = terminalTabs.find((terminalTab) => terminalTab.id === root.active_terminal_tab_id) ?? terminalTabs[0];
    return {
      ...root,
      title: activeTerminalTab?.title ?? root.title,
      runtime_session_id: activeTerminalTab?.runtime_session_id ?? root.runtime_session_id,
      saved_session_id: activeTerminalTab?.saved_session_id ?? root.saved_session_id,
      active_terminal_tab_id: activeTerminalTab?.id ?? root.active_terminal_tab_id,
      terminal_tabs: terminalTabs,
    };
  }

  const first = updateTerminalTabInRoot(root.first, paneId, terminalTabId, updater);
  const second = updateTerminalTabInRoot(root.second, paneId, terminalTabId, updater);
  if (first === root.first && second === root.second) return root;

  return {
    ...root,
    first,
    second,
  };
}

export function splitPane(
  root: PaneNode,
  targetPaneId: string,
  direction: PaneSplitDirection,
  newPane: PaneNode,
  ratio = 0.5,
): PaneNode {
  if (root.kind === "leaf") {
    if (root.id !== targetPaneId) return root;
    return {
      kind: "split",
      id: `split-${targetPaneId}-${newPane.id}`,
      direction,
      ratio: clampRatio(ratio),
      first: root,
      second: newPane,
    };
  }

  return {
    ...root,
    first: splitPane(root.first, targetPaneId, direction, newPane, ratio),
    second: splitPane(root.second, targetPaneId, direction, newPane, ratio),
  };
}

export function updateSplitRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  if (root.kind === "leaf") return root;

  return {
    ...root,
    ratio: root.id === splitId ? clampRatio(ratio) : root.ratio,
    first: updateSplitRatio(root.first, splitId, ratio),
    second: updateSplitRatio(root.second, splitId, ratio),
  };
}

export function removePane(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === "leaf") {
    return root.id === paneId ? null : root;
  }

  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);

  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;

  return {
    ...root,
    first,
    second,
  };
}
