// Author: Liz
import type { RuntimeSessionInfo } from "../features/terminal/terminalStore";
import type { PaneTerminalTab, WorkspaceTab } from "../features/workspace/types";
import type { SavedSession } from "../features/sessions/types";
import { fallbackOnlyErrorMessage } from "../lib/unknownErrorMessage";

interface TerminalActionDependencies {
  workbenchId: string;
  workbenchTabId: string | null;
  activePaneTab: PaneTerminalTab | null;
  activeTab: WorkspaceTab | null | undefined;
  setTerminalError: (message: string | null) => void;
  addPaneTab: (paneId: string) => PaneTerminalTab;
  bindRuntimeToPaneTab: (
    workspaceId: string,
    workspaceTabId: string,
    paneId: string,
    paneTabId: string,
    runtime: RuntimeSessionInfo,
  ) => void;
  updatePaneTerminalTab: (
    workspaceId: string,
    workspaceTabId: string,
    paneId: string,
    paneTabId: string,
    patch: Partial<PaneTerminalTab>,
  ) => void;
  openTerminal: (savedSessionId: string, paneId: string) => Promise<RuntimeSessionInfo>;
  openSshContainerTerminal: (
    savedSessionId: string,
    paneId: string,
    containerId: string,
    containerName?: string | null,
  ) => Promise<RuntimeSessionInfo>;
  closeTerminal: (runtimeSessionId: string, options?: { releaseExternalSession?: boolean }) => Promise<void>;
  writeTerminal: (runtimeSessionId: string, data: string) => Promise<void>;
  activeRuntimeSessionId: string | null;
}

export function createTerminalActions({
  workbenchId,
  workbenchTabId,
  activePaneTab,
  activeTab,
  setTerminalError,
  addPaneTab,
  bindRuntimeToPaneTab,
  updatePaneTerminalTab,
  openTerminal,
  openSshContainerTerminal,
  closeTerminal,
  writeTerminal,
  activeRuntimeSessionId,
}: TerminalActionDependencies) {
  async function openSession(session: SavedSession) {
    if (!activeTab || !activePaneTab) return;
    const targetWorkbenchId = workbenchId;
    const targetWorkspaceTabId = activeTab.id;
    const targetPaneId = activeTab.active_pane_id;
    const targetPaneTab = activePaneTab.runtime_session_id ? addPaneTab(targetPaneId) : activePaneTab;
    setTerminalError(null);
    try {
      const runtime = await openTerminal(session.id, targetPaneId);
      bindRuntimeToPaneTab(targetWorkbenchId, targetWorkspaceTabId, targetPaneId, targetPaneTab.id, runtime);
    } catch (openError) {
      setTerminalError(fallbackOnlyErrorMessage(openError, "打开终端失败"));
    }
  }

  async function disconnectTerminal(paneId: string, paneTabId: string, runtimeSessionId: string) {
    if (!workbenchTabId) return;
    setTerminalError(null);
    try {
      await closeTerminal(runtimeSessionId);
      updatePaneTerminalTab(workbenchId, workbenchTabId, paneId, paneTabId, {
        runtime_session_id: null,
        restore_status: "failed",
        restore_error: "已断开连接",
      });
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "断开连接失败"));
    }
  }

  async function reconnectTerminal(
    paneId: string,
    paneTabId: string,
    savedSessionId: string,
    runtimeSessionId: string | null,
  ) {
    if (!workbenchTabId) return;
    setTerminalError(null);
    try {
      if (runtimeSessionId) {
        await closeTerminal(runtimeSessionId, { releaseExternalSession: !isExternalSessionId(savedSessionId) });
      }
      updatePaneTerminalTab(workbenchId, workbenchTabId, paneId, paneTabId, {
        runtime_session_id: null,
        restore_status: "pending",
        restore_error: null,
      });
      const runtime =
        activePaneTab?.connection_source === "ssh_container" && activePaneTab.container_target?.id
          ? await openSshContainerTerminal(
              savedSessionId,
              paneId,
              activePaneTab.container_target.id,
              activePaneTab.container_target.name ?? null,
            )
          : await openTerminal(savedSessionId, paneId);
      updatePaneTerminalTab(workbenchId, workbenchTabId, paneId, paneTabId, {
        runtime_session_id: runtime.runtime_session_id,
        saved_session_id: runtime.saved_session_id,
        title: runtime.title,
        restore_status: "connected",
        restore_error: null,
      });
    } catch (error) {
      const message = fallbackOnlyErrorMessage(error, "重新连接失败");
      updatePaneTerminalTab(workbenchId, workbenchTabId, paneId, paneTabId, {
        restore_status: "failed",
        restore_error: message,
      });
      setTerminalError(message);
    }
  }

  async function sendCommand(command: string) {
    if (!activeRuntimeSessionId) {
      setTerminalError("当前没有活动终端");
      return;
    }
    const value = command.trim();
    if (!value) return;
    setTerminalError(null);
    try {
      await writeTerminal(activeRuntimeSessionId, `${value}\r`);
    } catch (sendError) {
      setTerminalError(fallbackOnlyErrorMessage(sendError, "发送命令失败"));
    }
  }

  return {
    openSession,
    disconnectTerminal,
    reconnectTerminal,
    sendCommand,
  };
}

function isExternalSessionId(value: string | null | undefined) {
  return typeof value === "string" && value.startsWith("external:");
}
