// Author: Liz
import { fallbackOnlyErrorMessage } from "../../lib/unknownErrorMessage";
type TerminalLayoutRestoreStrategy = "visible_first" | "connect_all" | "layout_only";
import type { SavedSession } from "../sessions/types";
import type { RuntimeSessionInfo } from "../terminal/terminalStore";
import { getLeafTerminalTabs, normalizeTerminalLayoutTabsPaneIds } from "./terminalLayoutLayout";
import type { PaneNode, PaneTerminalTab, TerminalLayoutDefinition } from "./types";

const MAX_TOTAL_CONCURRENT = 4;
const MAX_SSH_CONCURRENT = 2;
const MAX_LOCAL_CONCURRENT = 4;

interface TerminalLayoutRestoreTarget {
  terminalLayoutId: string;
  terminalLayoutTabId: string;
  terminalLayoutTabSortOrder: number;
  terminalLayoutTabActive: boolean;
  paneId: string;
  paneOrder: number;
  paneTabId: string;
  paneTabIndex: number;
  paneActive: boolean;
  paneTabActive: boolean;
  visible: boolean;
  terminalTab: PaneTerminalTab;
}

interface TerminalLayoutRestoreQueueOptions {
  terminalLayout: TerminalLayoutDefinition;
  sessions: SavedSession[];
  strategy: TerminalLayoutRestoreStrategy;
  openTerminal: (
    savedSessionId: string,
    paneId: string,
    workingDirectory?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  openDefaultLocalTerminal: (
    paneId: string,
    workingDirectory?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  openSshContainerTerminal: (
    savedSessionId: string,
    paneId: string,
    containerId: string,
    containerName?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  writeTerminal: (runtimeSessionId: string, data: string) => Promise<unknown>;
  closeTerminal: (runtimeSessionId: string) => Promise<unknown>;
  isCancelled?: () => boolean;
  isTargetAvailable?: (terminalLayoutId: string, terminalLayoutTabId: string, paneId: string, paneTabId: string) => boolean;
  updatePaneTerminalTab: (
    terminalLayoutId: string,
    terminalLayoutTabId: string,
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

export function markTerminalLayoutRestoreQueued(terminalLayout: TerminalLayoutDefinition): TerminalLayoutDefinition {
  return {
    ...terminalLayout,
    tabs: normalizeTerminalLayoutTabsPaneIds(terminalLayout.tabs).map((tab) => ({
      ...tab,
      root: markPaneRestoreQueued(tab.root),
    })),
  };
}

export function collectTerminalLayoutRestoreTargets(terminalLayout: TerminalLayoutDefinition): TerminalLayoutRestoreTarget[] {
  let paneOrder = 0;
  return [...normalizeTerminalLayoutTabsPaneIds(terminalLayout.tabs)]
    .sort((left, right) => left.sort_order - right.sort_order)
    .flatMap((tab) => {
      const terminalLayoutTabActive = tab.id === terminalLayout.active_tab_id;
      return collectPaneTargets({
        terminalLayout,
        terminalLayoutTabId: tab.id,
        terminalLayoutTabSortOrder: tab.sort_order,
        terminalLayoutTabActive,
        activePaneId: tab.active_pane_id,
        root: tab.root,
        nextPaneOrder: () => paneOrder++,
      });
    });
}

export function sortTerminalLayoutRestoreTargets(
  targets: TerminalLayoutRestoreTarget[],
  _terminalLayout: TerminalLayoutDefinition,
): TerminalLayoutRestoreTarget[] {
  return [...targets].sort((left, right) => {
    const priorityDelta = restorePriority(left) - restorePriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    const terminalLayoutTabDelta = left.terminalLayoutTabSortOrder - right.terminalLayoutTabSortOrder;
    if (terminalLayoutTabDelta !== 0) return terminalLayoutTabDelta;
    const paneDelta = left.paneOrder - right.paneOrder;
    if (paneDelta !== 0) return paneDelta;
    return left.paneTabIndex - right.paneTabIndex;
  });
}

export async function runTerminalLayoutRestoreQueue(options: TerminalLayoutRestoreQueueOptions): Promise<void> {
  if (options.strategy === "layout_only") {
    options.metrics?.onAllScheduledDone?.();
    return;
  }

  const queue = sortTerminalLayoutRestoreTargets(collectTerminalLayoutRestoreTargets(options.terminalLayout), options.terminalLayout);
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
    restore_status: tab.connection_source === "empty" ? null : "queued" as const,
    restore_token: crypto.randomUUID(),
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
  terminalLayout,
  terminalLayoutTabId,
  terminalLayoutTabSortOrder,
  terminalLayoutTabActive,
  activePaneId,
  root,
  nextPaneOrder,
}: {
  terminalLayout: TerminalLayoutDefinition;
  terminalLayoutTabId: string;
  terminalLayoutTabSortOrder: number;
  terminalLayoutTabActive: boolean;
  activePaneId: string;
  root: PaneNode;
  nextPaneOrder: () => number;
}): TerminalLayoutRestoreTarget[] {
  if (root.kind === "split") {
    return [
      ...collectPaneTargets({
        terminalLayout,
        terminalLayoutTabId,
        terminalLayoutTabSortOrder,
        terminalLayoutTabActive,
        activePaneId,
        root: root.first,
        nextPaneOrder,
      }),
      ...collectPaneTargets({
        terminalLayout,
        terminalLayoutTabId,
        terminalLayoutTabSortOrder,
        terminalLayoutTabActive,
        activePaneId,
        root: root.second,
        nextPaneOrder,
      }),
    ];
  }

  const paneOrder = nextPaneOrder();
  const terminalTabs = getLeafTerminalTabs(root);
  const activeTerminalTabId = root.active_terminal_tab_id ?? terminalTabs[0]?.id ?? "";
  return terminalTabs.filter(tab => tab.connection_source !== "empty").map((terminalTab, paneTabIndex) => ({
    terminalLayoutId: terminalLayout.id,
    terminalLayoutTabId,
    terminalLayoutTabSortOrder,
    terminalLayoutTabActive,
    paneId: root.id,
    paneOrder,
    paneTabId: terminalTab.id,
    paneTabIndex,
    paneActive: terminalLayoutTabActive && root.id === activePaneId,
    paneTabActive: terminalTab.id === activeTerminalTabId,
    visible: terminalLayoutTabActive && terminalTab.id === activeTerminalTabId,
    terminalTab,
  }));
}

function restorePriority(target: TerminalLayoutRestoreTarget): number {
  if (target.terminalLayoutTabActive && target.paneActive && target.paneTabActive) return 0;
  if (target.visible) return 1;
  if (target.terminalLayoutTabActive) return 2;
  if (target.paneTabActive) return 3;
  return 4;
}

function canStartTarget(
  target: TerminalLayoutRestoreTarget,
  sessions: SavedSession[],
  state: { activeSsh: number; activeLocal: number; paneLocks: Set<string> },
) {
  if (state.paneLocks.has(restorePaneKey(target))) return false;
  const kind = connectionKindForTarget(target, sessions);
  if (kind === "ssh") return state.activeSsh < MAX_SSH_CONCURRENT;
  return state.activeLocal < MAX_LOCAL_CONCURRENT;
}

async function runSingleTarget(
  options: TerminalLayoutRestoreQueueOptions,
  target: TerminalLayoutRestoreTarget,
): Promise<boolean> {
  let runtime: RuntimeSessionInfo | null = null;
  if (restoreTargetUnavailable(options, target)) return false;
  options.updatePaneTerminalTab(target.terminalLayoutId, target.terminalLayoutTabId, target.paneId, target.paneTabId, {
    restore_status: "pending",
    restore_token: target.terminalTab.restore_token,
    restore_error: null,
  });

  try {
    if (restoreTargetUnavailable(options, target)) return false;
    runtime = await openTerminalLayoutTerminal(
      target,
      options.sessions,
      options.openTerminal,
      options.openDefaultLocalTerminal,
      options.openSshContainerTerminal,
    );
    if (restoreTargetUnavailable(options, target)) {
      await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
      return false;
    }

    const startupCommand = normalizedStartupCommand(target.terminalTab.startup_command);
    if (startupCommand && runtime.kind !== "rdp_placeholder") {
      await options.writeTerminal(runtime.runtime_session_id, startupCommand);
    }
    if (restoreTargetUnavailable(options, target)) {
      await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
      return false;
    }

    options.updatePaneTerminalTab(target.terminalLayoutId, target.terminalLayoutTabId, target.paneId, target.paneTabId, {
      title: runtime.title,
      runtime_session_id: runtime.runtime_session_id,
      saved_session_id: runtime.saved_session_id,
      restore_status: "connected",
      restore_error: null,
    });
    return true;
  } catch (error) {
    if (restoreTargetUnavailable(options, target)) {
      if (runtime) {
        await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
      }
      return false;
    }
    options.updatePaneTerminalTab(target.terminalLayoutId, target.terminalLayoutTabId, target.paneId, target.paneTabId, {
      restore_status: "failed",
      restore_error: fallbackOnlyErrorMessage(error, "恢复标签失败"),
    });
    if (runtime) {
      await options.closeTerminal(runtime.runtime_session_id).catch(() => undefined);
    }
    return false;
  }
}

function restoreTargetUnavailable(options: TerminalLayoutRestoreQueueOptions, target: TerminalLayoutRestoreTarget) {
  return Boolean(
    options.isCancelled?.() ||
      (options.isTargetAvailable &&
        !options.isTargetAvailable(target.terminalLayoutId, target.terminalLayoutTabId, target.paneId, target.paneTabId)),
  );
}

async function openTerminalLayoutTerminal(
  target: TerminalLayoutRestoreTarget,
  sessions: SavedSession[],
  openTerminal: (savedSessionId: string, paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>,
  openDefaultLocalTerminal: (paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>,
  openSshContainerTerminal: (
    savedSessionId: string,
    paneId: string,
    containerId: string,
    containerName?: string | null,
  ) => Promise<RuntimeSessionInfo>,
): Promise<RuntimeSessionInfo> {
  const source =
    target.terminalTab.connection_source ?? (target.terminalTab.saved_session_id ? "saved_session" : "default_local");
  const path = normalizedTerminalLayoutPath(target.terminalTab.path);

  if (source === "missing") {
    throw new Error("连接已缺失");
  }
  if (source === "default_local") {
    return openDefaultLocalTerminal(target.paneId, path);
  }

  if (!target.terminalTab.saved_session_id) {
    throw new Error(source === "ssh_container" ? "保存会话不存在" : "连接已缺失");
  }

  const session = sessions.find((candidate) => candidate.id === target.terminalTab.saved_session_id);
  if (!session) {
    throw new Error("保存会话不存在");
  }
  if (source === "ssh_container") {
    const containerId = target.terminalTab.container_target?.id?.trim();
    if (!containerId) {
      throw new Error("容器目标缺失");
    }
    return openSshContainerTerminal(session.id, target.paneId, containerId, target.terminalTab.container_target?.name ?? null);
  }
  return openTerminal(session.id, target.paneId, path);
}

function connectionKindForTarget(target: TerminalLayoutRestoreTarget, sessions: SavedSession[]): "ssh" | "local" {
  const source =
    target.terminalTab.connection_source ?? (target.terminalTab.saved_session_id ? "saved_session" : "default_local");
  if ((source !== "saved_session" && source !== "ssh_container") || !target.terminalTab.saved_session_id) return "local";
  const session = sessions.find((candidate) => candidate.id === target.terminalTab.saved_session_id);
  return session?.type === "ssh" ? "ssh" : "local";
}

function normalizedTerminalLayoutPath(path: string | null | undefined): string | null {
  const value = path?.trim();
  return value ? value : null;
}

function normalizedStartupCommand(command: string | null | undefined): string | null {
  const value = command?.trimEnd();
  if (!value || !value.trim()) return null;
  return /[\r\n]$/.test(value) ? value : `${value}\r`;
}

function restorePaneKey(target: TerminalLayoutRestoreTarget): string {
  return `${target.terminalLayoutTabId}/${target.paneId}`;
}

function targetKey(target: TerminalLayoutRestoreTarget): string {
  return `${target.terminalLayoutTabId}/${target.paneId}/${target.paneTabId}`;
}
