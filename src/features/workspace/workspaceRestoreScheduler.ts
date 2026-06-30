// Author: Liz
import { fallbackOnlyErrorMessage } from "../../lib/unknownErrorMessage";
import type { WorkspaceRestoreStrategy } from "../settings/settingsStore";
import type { SavedSession } from "../sessions/types";
import type { RuntimeSessionInfo } from "../terminal/terminalStore";
import { getLeafTerminalTabs, normalizeWorkspaceTabsPaneIds } from "./workspaceLayout";
import type { PaneNode, PaneTerminalTab, WorkspaceDefinition } from "./types";

const MAX_TOTAL_CONCURRENT = 4;
const MAX_SSH_CONCURRENT = 2;
const MAX_LOCAL_CONCURRENT = 4;

interface WorkspaceRestoreTarget {
  workspaceId: string;
  workspaceTabId: string;
  workspaceTabSortOrder: number;
  workspaceTabActive: boolean;
  paneId: string;
  paneOrder: number;
  paneTabId: string;
  paneTabIndex: number;
  paneActive: boolean;
  paneTabActive: boolean;
  visible: boolean;
  terminalTab: PaneTerminalTab;
}

interface WorkspaceRestoreQueueOptions {
  workspace: WorkspaceDefinition;
  sessions: SavedSession[];
  strategy: WorkspaceRestoreStrategy;
  openTerminal: (
    savedSessionId: string,
    paneId: string,
    workingDirectory?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  openDefaultLocalTerminal: (
    paneId: string,
    workingDirectory?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  writeTerminal: (runtimeSessionId: string, data: string) => Promise<unknown>;
  closeTerminal: (runtimeSessionId: string) => Promise<unknown>;
  isCancelled?: () => boolean;
  updatePaneTerminalTab: (
    workspaceId: string,
    workspaceTabId: string,
    paneId: string,
    paneTabId: string,
    patch: Partial<PaneTerminalTab>,
  ) => void;
  metrics?: {
    onFirstVisibleConnected?: () => void;
    onAllVisibleConnected?: () => void;
    onAllScheduledDone?: () => void;
  };
}

export function markWorkspaceRestoreQueued(workspace: WorkspaceDefinition): WorkspaceDefinition {
  return {
    ...workspace,
    tabs: normalizeWorkspaceTabsPaneIds(workspace.tabs).map((tab) => ({
      ...tab,
      root: markPaneRestoreQueued(tab.root),
    })),
  };
}

export function collectWorkspaceRestoreTargets(workspace: WorkspaceDefinition): WorkspaceRestoreTarget[] {
  let paneOrder = 0;
  return [...normalizeWorkspaceTabsPaneIds(workspace.tabs)]
    .sort((left, right) => left.sort_order - right.sort_order)
    .flatMap((tab) => {
      const workspaceTabActive = tab.id === workspace.active_tab_id;
      return collectPaneTargets({
        workspace,
        workspaceTabId: tab.id,
        workspaceTabSortOrder: tab.sort_order,
        workspaceTabActive,
        activePaneId: tab.active_pane_id,
        root: tab.root,
        nextPaneOrder: () => paneOrder++,
      });
    });
}

export function sortWorkspaceRestoreTargets(
  targets: WorkspaceRestoreTarget[],
  _workspace: WorkspaceDefinition,
): WorkspaceRestoreTarget[] {
  return [...targets].sort((left, right) => {
    const priorityDelta = restorePriority(left) - restorePriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    const workspaceTabDelta = left.workspaceTabSortOrder - right.workspaceTabSortOrder;
    if (workspaceTabDelta !== 0) return workspaceTabDelta;
    const paneDelta = left.paneOrder - right.paneOrder;
    if (paneDelta !== 0) return paneDelta;
    return left.paneTabIndex - right.paneTabIndex;
  });
}

export async function runWorkspaceRestoreQueue(options: WorkspaceRestoreQueueOptions): Promise<void> {
  if (options.strategy === "layout_only") {
    options.metrics?.onAllScheduledDone?.();
    return;
  }

  const queue = sortWorkspaceRestoreTargets(collectWorkspaceRestoreTargets(options.workspace), options.workspace);
  const visibleTargetIds = new Set(queue.filter((target) => target.visible).map(targetKey));
  const visibleConnectedIds = new Set<string>();
  let firstVisibleConnected = false;
  let activeTotal = 0;
  let activeSsh = 0;
  let activeLocal = 0;
  const paneLocks = new Set<string>();

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (options.isCancelled?.()) {
        queue.splice(0, queue.length);
        if (activeTotal === 0) {
          options.metrics?.onAllScheduledDone?.();
          resolve();
        }
        return;
      }
      while (activeTotal < MAX_TOTAL_CONCURRENT && queue.length > 0) {
        const nextIndex = queue.findIndex((target) =>
          canStartTarget(target, options.sessions, {
            activeSsh,
            activeLocal,
            paneLocks,
          }),
        );
        if (nextIndex < 0) break;

        const [target] = queue.splice(nextIndex, 1);
        const kind = connectionKindForTarget(target, options.sessions);
        const paneKey = restorePaneKey(target);
        activeTotal += 1;
        if (kind === "ssh") {
          activeSsh += 1;
        } else {
          activeLocal += 1;
        }
        paneLocks.add(paneKey);

        void runSingleTarget(options, target)
          .then((connected) => {
            if (connected && target.visible) {
              visibleConnectedIds.add(targetKey(target));
              if (!firstVisibleConnected) {
                firstVisibleConnected = true;
                options.metrics?.onFirstVisibleConnected?.();
              }
              if (visibleConnectedIds.size === visibleTargetIds.size) {
                options.metrics?.onAllVisibleConnected?.();
              }
            }
          })
          .finally(() => {
            activeTotal -= 1;
            if (kind === "ssh") {
              activeSsh -= 1;
            } else {
              activeLocal -= 1;
            }
            paneLocks.delete(paneKey);
            if (queue.length === 0 && activeTotal === 0) {
              options.metrics?.onAllScheduledDone?.();
              resolve();
              return;
            }
            pump();
          });
      }
      if (queue.length === 0 && activeTotal === 0) {
        options.metrics?.onAllScheduledDone?.();
        resolve();
      }
    };

    pump();
  });
}

function markPaneRestoreQueued(root: PaneNode): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: markPaneRestoreQueued(root.first),
      second: markPaneRestoreQueued(root.second),
    };
  }

  const terminalTabs = getLeafTerminalTabs(root).map((tab) => ({
    ...tab,
    runtime_session_id: null,
    restore_status: "queued" as const,
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

function collectPaneTargets({
  workspace,
  workspaceTabId,
  workspaceTabSortOrder,
  workspaceTabActive,
  activePaneId,
  root,
  nextPaneOrder,
}: {
  workspace: WorkspaceDefinition;
  workspaceTabId: string;
  workspaceTabSortOrder: number;
  workspaceTabActive: boolean;
  activePaneId: string;
  root: PaneNode;
  nextPaneOrder: () => number;
}): WorkspaceRestoreTarget[] {
  if (root.kind === "split") {
    return [
      ...collectPaneTargets({
        workspace,
        workspaceTabId,
        workspaceTabSortOrder,
        workspaceTabActive,
        activePaneId,
        root: root.first,
        nextPaneOrder,
      }),
      ...collectPaneTargets({
        workspace,
        workspaceTabId,
        workspaceTabSortOrder,
        workspaceTabActive,
        activePaneId,
        root: root.second,
        nextPaneOrder,
      }),
    ];
  }

  const paneOrder = nextPaneOrder();
  const terminalTabs = getLeafTerminalTabs(root);
  const activeTerminalTabId = root.active_terminal_tab_id ?? terminalTabs[0]?.id ?? "";
  return terminalTabs.map((terminalTab, paneTabIndex) => ({
    workspaceId: workspace.id,
    workspaceTabId,
    workspaceTabSortOrder,
    workspaceTabActive,
    paneId: root.id,
    paneOrder,
    paneTabId: terminalTab.id,
    paneTabIndex,
    paneActive: workspaceTabActive && root.id === activePaneId,
    paneTabActive: terminalTab.id === activeTerminalTabId,
    visible: workspaceTabActive && terminalTab.id === activeTerminalTabId,
    terminalTab,
  }));
}

function restorePriority(target: WorkspaceRestoreTarget): number {
  if (target.workspaceTabActive && target.paneActive && target.paneTabActive) return 0;
  if (target.visible) return 1;
  if (target.workspaceTabActive) return 2;
  if (target.paneTabActive) return 3;
  return 4;
}

function canStartTarget(
  target: WorkspaceRestoreTarget,
  sessions: SavedSession[],
  state: { activeSsh: number; activeLocal: number; paneLocks: Set<string> },
) {
  if (state.paneLocks.has(restorePaneKey(target))) return false;
  const kind = connectionKindForTarget(target, sessions);
  if (kind === "ssh") return state.activeSsh < MAX_SSH_CONCURRENT;
  return state.activeLocal < MAX_LOCAL_CONCURRENT;
}

async function runSingleTarget(
  options: WorkspaceRestoreQueueOptions,
  target: WorkspaceRestoreTarget,
): Promise<boolean> {
  let runtime: RuntimeSessionInfo | null = null;
  if (options.isCancelled?.()) return false;
  options.updatePaneTerminalTab(target.workspaceId, target.workspaceTabId, target.paneId, target.paneTabId, {
    restore_status: "pending",
    restore_error: null,
  });

  try {
    if (options.isCancelled?.()) return false;
    runtime = await openWorkspaceTerminal(target, options.sessions, options.openTerminal, options.openDefaultLocalTerminal);
    if (options.isCancelled?.()) {
      await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
      return false;
    }

    const startupCommand = normalizedStartupCommand(target.terminalTab.startup_command);
    if (startupCommand && runtime.kind !== "rdp_placeholder") {
      await options.writeTerminal(runtime.runtime_session_id, startupCommand);
    }
    if (options.isCancelled?.()) {
      await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
      return false;
    }

    options.updatePaneTerminalTab(target.workspaceId, target.workspaceTabId, target.paneId, target.paneTabId, {
      title: runtime.title,
      runtime_session_id: runtime.runtime_session_id,
      saved_session_id: runtime.saved_session_id,
      restore_status: "connected",
      restore_error: null,
    });
    return true;
  } catch (error) {
    if (options.isCancelled?.()) {
      if (runtime) {
        await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
      }
      return false;
    }
    options.updatePaneTerminalTab(target.workspaceId, target.workspaceTabId, target.paneId, target.paneTabId, {
      restore_status: "failed",
      restore_error: fallbackOnlyErrorMessage(error, "恢复标签失败"),
    });
    if (runtime) {
      await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
    }
    return false;
  }
}

async function openWorkspaceTerminal(
  target: WorkspaceRestoreTarget,
  sessions: SavedSession[],
  openTerminal: (savedSessionId: string, paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>,
  openDefaultLocalTerminal: (paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>,
): Promise<RuntimeSessionInfo> {
  const source =
    target.terminalTab.connection_source ?? (target.terminalTab.saved_session_id ? "saved_session" : "default_local");
  const path = normalizedWorkspacePath(target.terminalTab.path);

  if (source === "missing") {
    throw new Error("连接已缺失");
  }
  if (source === "default_local" || !target.terminalTab.saved_session_id) {
    return openDefaultLocalTerminal(target.paneId, path);
  }

  const session = sessions.find((candidate) => candidate.id === target.terminalTab.saved_session_id);
  if (!session) {
    throw new Error("保存会话不存在");
  }
  return openTerminal(session.id, target.paneId, path);
}

function connectionKindForTarget(target: WorkspaceRestoreTarget, sessions: SavedSession[]): "ssh" | "local" {
  const source =
    target.terminalTab.connection_source ?? (target.terminalTab.saved_session_id ? "saved_session" : "default_local");
  if (source !== "saved_session" || !target.terminalTab.saved_session_id) return "local";
  const session = sessions.find((candidate) => candidate.id === target.terminalTab.saved_session_id);
  return session?.type === "ssh" ? "ssh" : "local";
}

function normalizedWorkspacePath(path: string | null | undefined): string | null {
  const value = path?.trim();
  return value ? value : null;
}

function normalizedStartupCommand(command: string | null | undefined): string | null {
  const value = command?.trimEnd();
  if (!value || !value.trim()) return null;
  return /[\r\n]$/.test(value) ? value : `${value}\r`;
}

function restorePaneKey(target: WorkspaceRestoreTarget): string {
  return `${target.workspaceTabId}/${target.paneId}`;
}

function targetKey(target: WorkspaceRestoreTarget): string {
  return `${target.workspaceTabId}/${target.paneId}/${target.paneTabId}`;
}
