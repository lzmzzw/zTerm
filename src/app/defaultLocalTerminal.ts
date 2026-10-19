// Author: Liz
import { useTerminalLayoutStore } from "../features/terminal-layout/terminalLayoutStore";
import { findPane, getActiveTerminalTab, getLeafTerminalTabs } from "../features/terminal-layout/terminalLayoutLayout";
import type { PaneNode } from "../features/terminal-layout/types";
import type { RuntimeSessionInfo } from "../features/terminal/terminalStore";

function hasConnection(root: PaneNode): boolean {
  if (root.kind === "split") return hasConnection(root.first) || hasConnection(root.second);
  return getLeafTerminalTabs(root).some(tab => Boolean(tab.runtime_session_id)
    || tab.restore_status === "pending" || tab.restore_status === "queued");
}

// Mark the target synchronously before opening the PTY so concurrent callers share it.
export async function ensureDefaultLocalTerminal(
  open: (paneId: string, workingDirectory?: string | null) => Promise<RuntimeSessionInfo>,
  close: (runtimeId: string) => Promise<void>,
): Promise<void> {
  const state = useTerminalLayoutStore.getState();
  if (state.tabs.some(tab => hasConnection(tab.root))) return;
  const layoutTab = state.tabs.find(tab => tab.id === state.activeTabId) ?? state.tabs[0];
  const pane = layoutTab ? findPane(layoutTab.root, layoutTab.active_pane_id) : null;
  if (!layoutTab || pane?.kind !== "leaf") return;
  const current = getActiveTerminalTab(pane);
  const target = current.runtime_session_id || current.saved_session_id || current.connection_source === "default_local"
    ? state.addPaneTab(pane.id) : current;
  const layoutId = state.activeTerminalLayoutId;
  state.updatePaneTerminalTab(layoutId, layoutTab.id, pane.id, target.id, {
    connection_source: "default_local", restore_status: "pending", restore_error: null,
  });
  try {
    const runtime = await open(pane.id);
    const latest = useTerminalLayoutStore.getState();
    if (!latest.hasPaneTerminalTab(layoutId, layoutTab.id, pane.id, target.id)) {
      await close(runtime.runtime_session_id);
      return;
    }
    latest.bindRuntimeToPaneTab(layoutId, layoutTab.id, pane.id, target.id, runtime);
  } catch (error) {
    useTerminalLayoutStore.getState().updatePaneTerminalTab(layoutId, layoutTab.id, pane.id, target.id, {
      restore_status: "failed", restore_error: "打开默认本地终端失败",
    });
    throw error;
  }
}
