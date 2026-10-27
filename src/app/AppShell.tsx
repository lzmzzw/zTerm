// Author: Liz
import { ArrowLeftRight, Settings, MessageSquareMore, Terminal } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  AppTextInputDialog,
  AppTransferConflictDialog,
  ConnectionPickerDialog,
  SyncChannelDialog,
  type ConnectionChoice,
} from "./AppShellDialogs";
import { ExternalSshTunnelEditorDialog, SshTunnelEditorDialog } from "./SshTunnelDialogs";
import { RightToolsPanel } from "./RightToolsPanel";
import { PanelHeader, ToolButton } from "./ShellControls";
import { TitleBar } from "./TitleBar";
import { TerminalTools } from "./TerminalTools";
import { loadTerminalLayout, saveTerminalLayout } from "../features/terminal-layout/terminalLayoutPersistence";
import { markTerminalLayoutRestoreQueued, runTerminalLayoutRestoreQueue } from "../features/terminal-layout/terminalLayoutRestoreScheduler";
import { TerminalLayoutStage } from "./TerminalLayoutStage";
import { createRemoteFileActions } from "./remoteFileActions";
import { createTerminalActions } from "./terminalActions";
import { closeTerminalRuntimes } from "./terminalLifecycle";
import { ensureDefaultLocalTerminal } from "./defaultLocalTerminal";
import { openSavedSessionTarget } from "./savedSessionActions";
import { visibleRightTools, type ActiveConnectionKind, type RightTool } from "./rightTools";
import { useAppShortcutKeys } from "./useAppShortcutKeys";
import { useAppTextInputDialog } from "./useAppTextInputDialog";
import {
  DEFAULT_EXTERNAL_SSH_OPTIONS,
  EMPTY_CONTAINER_PANEL_STATE,
  EMPTY_FILE_PANEL_STATE,
  EMPTY_HISTORY_PANEL_STATE,
  EMPTY_MCP_PANEL_STATE,
  EMPTY_TRANSFER_PANEL_STATE,
  readString,
  rightToolFromValue,
  savedSessionDraftWithSshOptions,
  waitForUiTurn,
  type ActiveSshTunnelTarget,
  type ConnectionDialogTarget,
  type LeftTool,
  type PendingSshTunnelDelete,
  type SshTunnelEditorState,
  type TransferConflictDialogState,
  type ZtermToolActionEvent,
} from "./appShellModel";
import { ZtCenteredPageLayout, ZtConfirmDialog, ZtInlineError } from "../components/ZtUi";
import {
  closeAgentCodex,
  openAgentCodex,
  type AgentCodexSession,
} from "../features/ai/agentCodexApi";
import { useActiveAgentTerminalSync } from "../features/ai/useActiveAgentTerminalSync";
import { setMcpAffectedDomainsHandler, useMcpStore } from "../features/ai/mcpStore";
import { FileTransferDialog } from "../features/files/FileTransferDialog";
import { useFileTransferStore } from "../features/files/fileTransferStore";
import { useFileStore } from "../features/files/fileStore";
import type { TransferConflict, TransferConflictPolicy } from "../features/files/fileTypes";
import type { CommandHistoryView } from "../features/history/CommandHistoryPanel";
import { resolveHistoryScope } from "../features/history/historyScopeModel";
import { useHistoryStore } from "../features/history/historyStore";
import { LOCAL_SERVER_INFO_TARGET_ID } from "../features/monitor/serverInfoApi";
import { SessionTree } from "../features/sessions/SessionTree";
import { emptySshTunnel } from "../features/sessions/sshSessionModel";
import { useSessionStore } from "../features/sessions/sessionStore";
import type { SavedSession, SshOptions, SshTunnel } from "../features/sessions/types";
import { SettingsPage } from "../features/settings/SettingsPage";
import { applyAppSettings } from "../features/settings/applyAppSettings";
import { useDomI18n } from "../features/settings/domI18n";
import { t } from "../features/settings/i18n";
import { useSettingsStore } from "../features/settings/settingsStore";
import { listSshContainers, startSshContainer, type SshContainerInfo } from "../features/terminal/sshContainerApi";
import {
  externalSshChannelPolicy,
  externalSshHostServiceTarget,
  getExternalSshOptions,
  isExternalSessionId,
  takePendingExternalLaunches,
  takePendingExternalLocalLaunches,
  updateExternalSshOptions,
  type ExternalSshLaunchEvent,
} from "../features/terminal/externalLaunchApi";
import { useTerminalStore, type RuntimeSessionInfo } from "../features/terminal/terminalStore";
import { collectSyncChannelCandidates, useSyncInputStore } from "../features/terminal/syncInputStore";
import {
  findPane,
  getActiveTerminalTab,
  getLeafTerminalTabs,
} from "../features/terminal-layout/terminalLayoutLayout";
import { isReusableConnectionTab } from "../features/terminal-layout/terminalLayoutShellModel";
import { useTerminalLayoutStore } from "../features/terminal-layout/terminalLayoutStore";
import type { PaneNode, TerminalLayoutTab } from "../features/terminal-layout/types";
import { listenTauri } from "../lib/tauriClient";
import { fallbackOnlyErrorMessage, unknownErrorMessage } from "../lib/unknownErrorMessage";

async function stopAgentCodexSession(session: AgentCodexSession) {
  await closeAgentCodex(session);
}

function agentConnectionKey(
  savedSessionId: string | null,
  runtimeSessionId: string | null,
  isContainerConnection = false,
) {
  if (savedSessionId && !isContainerConnection) return `connection:${savedSessionId}`;
  return runtimeSessionId ? `runtime:${runtimeSessionId}` : null;
}

function collectLiveAgentConnectionKeys(tabs: TerminalLayoutTab[]) {
  const keys = new Set<string>();
  const visit = (node: PaneNode) => {
    if (node.kind === "split") {
      visit(node.first);
      visit(node.second);
      return;
    }
    for (const terminalTab of getLeafTerminalTabs(node)) {
      const key = agentConnectionKey(
        terminalTab.saved_session_id,
        terminalTab.runtime_session_id,
        terminalTab.connection_source === "ssh_container",
      );
      if (key) keys.add(key);
    }
  };
  tabs.forEach((tab) => visit(tab.root));
  return keys;
}

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export function AppShell() {
  const {
    groups,
    sessions,
    sessionError,
    loadSessions,
    saveGroup,
    saveSession,
    exportCsv,
    testSession,
    deleteGroup,
    deleteSession,
  } = useSessionStore(
    useShallow((state) => ({
      groups: state.groups,
      sessions: state.sessions,
      sessionError: state.error,
      loadSessions: state.loadSessions,
      saveGroup: state.saveGroup,
      saveSession: state.saveSession,
      exportCsv: state.exportCsv,
      testSession: state.testSession,
      deleteGroup: state.deleteGroup,
      deleteSession: state.deleteSession,
    })),
  );
  const {
    appSettings,
    terminalProfiles,
    shortcutDefinitions,
    mcpStatus,
    settingsLoading,
    settingsError,
    loadSettings,
    saveAppSettings,
    resetAppSettingsSection,
    saveCredential,
    readCredentialSecret,
    detectTerminalProfiles,
    setDefaultTerminalProfile,
    setMcpEnabled,
    rotateMcpToken,
  } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      terminalProfiles: state.terminalProfiles,
      shortcutDefinitions: state.shortcutDefinitions,
      mcpStatus: state.mcpStatus,
      settingsLoading: state.loading,
      settingsError: state.error,
      loadSettings: state.loadSettings,
      saveAppSettings: state.saveAppSettings,
      resetAppSettingsSection: state.resetAppSettingsSection,
      saveCredential: state.saveCredential,
      readCredentialSecret: state.readCredentialSecret,
      detectTerminalProfiles: state.detectTerminalProfiles,
      setDefaultTerminalProfile: state.setDefaultTerminalProfile,
      setMcpEnabled: state.setMcpEnabled,
      rotateMcpToken: state.rotateMcpToken,
    })),
  );
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [fileTransferDialogOpen, setFileTransferDialogOpen] = useState(false);
  const [syncChannelDialogOpen, setSyncChannelDialogOpen] = useState(false);
  const initialLayoutTabsRef = useRef(useTerminalLayoutStore.getState().tabs);
  const [layoutReady, setLayoutReady] = useState(false);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [viewMode, setViewMode] = useState<"workbench" | "settings">("workbench");
  const [activeLeftTool, setActiveLeftTool] = useState<LeftTool | null>(null);
  const [activeTool, setActiveTool] = useState<RightTool | null>(null);
  const [agentSessionsByConnectionKey, setAgentSessionsByConnectionKey] = useState<Record<string, AgentCodexSession>>({});
  const agentSessionsRef = useRef<Record<string, AgentCodexSession>>({});
  const agentOpenPromisesRef = useRef<Map<string, Promise<AgentCodexSession | null>>>(new Map());
  const agentStoppingSessionIdsRef = useRef<Set<string>>(new Set());
  const [agentOpeningConnectionKeys, setAgentOpeningConnectionKeys] = useState<Record<string, true>>({});
  const [agentOpenError, setAgentOpenError] = useState<string | null>(null);
  const previousAgentConnectionKeyRef = useRef<string | null>(null);
  const [containerPanelState, setContainerPanelState] = useState(EMPTY_CONTAINER_PANEL_STATE);
  const [externalSshSessions, setExternalSshSessions] = useState<Record<string, ExternalSshLaunchEvent>>({});
  const { textInputDialog, requestTextInput, resolveTextInputDialog } = useAppTextInputDialog();
  const [transferConflictDialog, setTransferConflictDialog] = useState<TransferConflictDialogState | null>(null);
  const [connectionDialogTarget, setConnectionDialogTarget] = useState<ConnectionDialogTarget | null>(null);
  const [connectionDialogError, setConnectionDialogError] = useState<string | null>(null);
  const [connectionOpening, setConnectionOpening] = useState(false);
  const [externalSshOptionsById, setExternalSshOptionsById] = useState<Record<string, SshOptions>>({});
  const [externalSshTunnelEditor, setExternalSshTunnelEditor] = useState<string | null>(null);
  const [sshTunnelEditor, setSshTunnelEditor] = useState<SshTunnelEditorState | null>(null);
  const [pendingSshTunnelDelete, setPendingSshTunnelDelete] = useState<PendingSshTunnelDelete | null>(null);
  const [sshTunnelNeedsReconnectBySessionId, setSshTunnelNeedsReconnectBySessionId] = useState<Record<string, boolean>>({});
  const syncChannel = useSyncInputStore((state) => state.channel);
  const createSyncChannel = useSyncInputStore((state) => state.createChannel);
  const retainSyncChannelMembers = useSyncInputStore((state) => state.retainMembers);
  const processedExternalLaunchIdsRef = useRef<Set<string>>(new Set());
  const [historyView, setHistoryView] = useState<CommandHistoryView>("history");
  const [deduplicateHistory, setDeduplicateHistory] = useState(true);
  const [historyQuery, setHistoryQuery] = useState("");
  const {
    loadPendingInvocations,
    bindApprovalModeToSession,
    setApprovalMode,
    confirmTool,
  } = useMcpStore(
    useShallow((state) => ({
      loadPendingInvocations: state.loadPendingInvocations,
      bindApprovalModeToSession: state.bindApprovalModeToSession,
      setApprovalMode: state.setApprovalMode,
      confirmTool: state.confirmTool,
    })),
  );
  const {
    mcpApprovalMode,
    mcpPendingInvocations,
    agentError,
  } = useMcpStore(
    useShallow((state) =>
      activeTool === "agent"
        ? {
            mcpApprovalMode: state.approvalMode,
            mcpPendingInvocations: state.pendingInvocations,
            agentError: state.error,
          }
        : EMPTY_MCP_PANEL_STATE,
    ),
  );
  const {
    setPath: setFilePath,
    selectPath,
    selectPaths,
    clearFiles,
    listFiles,
    mkdir,
    upload,
    download,
    deletePath,
    renamePath,
    classifyLocalPaths,
    checkTransferConflicts,
    bindTransferEvents,
    loadTransfers,
    retryTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    deleteTransfer,
  } = useFileStore(
    useShallow((state) => ({
      setPath: state.setPath,
      selectPath: state.selectPath,
      selectPaths: state.selectPaths,
      clearFiles: state.clearFiles,
      listFiles: state.listFiles,
      mkdir: state.mkdir,
      upload: state.upload,
      download: state.download,
      deletePath: state.deletePath,
      renamePath: state.renamePath,
      classifyLocalPaths: state.classifyLocalPaths,
      checkTransferConflicts: state.checkTransferConflicts,
      bindTransferEvents: state.bindTransferEvents,
      loadTransfers: state.loadTransfers,
      retryTransfer: state.retryTransfer,
      pauseTransfer: state.pauseTransfer,
      resumeTransfer: state.resumeTransfer,
      cancelTransfer: state.cancelTransfer,
      deleteTransfer: state.deleteTransfer,
    })),
  );
  const {
    fileEntries,
    filePath,
    selectedPaths,
    filesLoading,
    fileError,
  } = useFileStore(
    useShallow((state) =>
      activeTool === "files"
        ? {
            fileEntries: state.entries,
            filePath: state.path,
            selectedPaths: state.selectedPaths,
            filesLoading: state.loading,
            fileError: state.error,
          }
        : EMPTY_FILE_PANEL_STATE,
    ),
  );
  const { transfers } = useFileStore(
    useShallow((state) => (activeTool === "files" ? { transfers: state.transfers } : EMPTY_TRANSFER_PANEL_STATE)),
  );
  const {
    searchHistory,
    clearHistory,
    deleteHistoryEntries,
    loadCommandGroups,
    saveCommandGroup,
    deleteCommandGroup,
  } = useHistoryStore(
    useShallow((state) => ({
      searchHistory: state.searchHistory,
      clearHistory: state.clearHistory,
      deleteHistoryEntries: state.deleteHistoryEntries,
      loadCommandGroups: state.loadCommandGroups,
      saveCommandGroup: state.saveCommandGroup,
      deleteCommandGroup: state.deleteCommandGroup,
    })),
  );
  const {
    historyEntries,
    commandGroups,
    historyLoading,
    historyError,
    historyGroupLoading,
    historyGroupError,
  } = useHistoryStore(
    useShallow((state) =>
      activeTool === "history"
        ? {
            historyEntries: state.entries,
            commandGroups: state.commandGroups,
            historyLoading: state.loading,
            historyError: state.error,
            historyGroupLoading: state.groupLoading,
            historyGroupError: state.groupError,
          }
        : EMPTY_HISTORY_PANEL_STATE,
    ),
  );
  const {
    activeTerminalLayoutId,
    tabs,
    activeTabId,
  } = useTerminalLayoutStore(
    useShallow((state) => ({
      activeTerminalLayoutId: state.activeTerminalLayoutId,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    })),
  );
  const {
    clearRuntimeSession,
    updatePaneTerminalTab,
    addPaneTab,
    addPaneTabAfter,
    closePaneTab,
    selectPaneTab,
    movePaneTab,
    setActivePane,
    bindRuntimeToPaneTab,
    splitActivePane,
    resizeSplitPane,
    closePane,
  } = useTerminalLayoutStore(
    useShallow((state) => ({
      clearRuntimeSession: state.clearRuntimeSession,
      updatePaneTerminalTab: state.updatePaneTerminalTab,
      addPaneTab: state.addPaneTab,
      addPaneTabAfter: state.addPaneTabAfter,
      closePaneTab: state.closePaneTab,
      selectPaneTab: state.selectPaneTab,
      movePaneTab: state.movePaneTab,
      setActivePane: state.setActivePane,
      bindRuntimeToPaneTab: state.bindRuntimeToPaneTab,
      splitActivePane: state.splitActivePane,
      resizeSplitPane: state.resizeSplitPane,
      closePane: state.closePane,
    })),
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activePane = activeTab ? findPane(activeTab.root, activeTab.active_pane_id) : null;
  const activeLeaf = activePane?.kind === "leaf" ? activePane : null;
  const activePaneTab = activeLeaf ? getActiveTerminalTab(activeLeaf) : null;
  const activeSavedSessionId = activePaneTab?.saved_session_id ?? null;
  const activeSavedSession = activeSavedSessionId ? sessions.find((session) => session.id === activeSavedSessionId) ?? null : null;
  const mcpApprovalSessionId = activeSavedSession?.type === "ssh" ? activeSavedSession.id : null;
  const activeExternalSshSession =
    activeSavedSessionId && isExternalSessionId(activeSavedSessionId) ? (externalSshSessions[activeSavedSessionId] ?? null) : null;
  const activeExternalSshOptions = activeExternalSshSession
    ? (externalSshOptionsById[activeExternalSshSession.id] ?? DEFAULT_EXTERNAL_SSH_OPTIONS)
    : null;
  const activeExternalSshChannelPolicy = activeExternalSshSession
    ? externalSshChannelPolicy(activeExternalSshSession)
    : null;
  const activeExternalSshMultiChannel = activeExternalSshChannelPolicy === "multi_channel";
  const activeSshSessionId = activeSavedSession?.type === "ssh" ? activeSavedSession.id : activeExternalSshSession?.id ?? null;
  const activeSshTunnels =
    activeSavedSession?.type === "ssh"
      ? (activeSavedSession.ssh_options?.tunnels ?? [])
      : (activeExternalSshOptions?.tunnels ?? []);
  const activeSshContainersEnabled =
    activeSavedSession?.type === "ssh"
      ? activeSavedSession.ssh_options?.container?.enabled === true
      : activeExternalSshOptions?.container?.enabled === true && activeExternalSshMultiChannel;
  const activeRuntimeSessionId = activePaneTab?.runtime_session_id ?? null;
  const containerTargetKey = `${activeSshSessionId ?? ""}:${activeRuntimeSessionId ?? ""}:${activePaneTab?.id ?? ""}:${activeExternalSshOptions?.container?.runtime ?? activeSavedSession?.ssh_options?.container?.runtime ?? ""}`;
  const containerTargetKeyRef = useLatestRef(containerTargetKey);
  const containerStartPendingRef = useRef(false);
  const activeAgentConnectionKey = agentConnectionKey(
    activeSavedSessionId,
    activeRuntimeSessionId,
    activePaneTab?.connection_source === "ssh_container",
  );
  const activeAgentSession = activeAgentConnectionKey
    ? (agentSessionsByConnectionKey[activeAgentConnectionKey] ?? null)
    : null;
  const activeAgentConnectionKeyRef = useLatestRef(activeAgentConnectionKey);
  const syncChannelCandidates = collectSyncChannelCandidates(
    tabs,
    useTerminalStore.getState().runtimes,
    (savedSessionId, runtime) => {
      const savedSession = savedSessionId ? sessions.find((session) => session.id === savedSessionId) : null;
      if (savedSession?.type === "ssh") return savedSession.host.trim();
      if (savedSessionId && isExternalSessionId(savedSessionId)) {
        return externalSshSessions[savedSessionId]?.host.trim() ?? runtime.title;
      }
      return runtime.title;
    },
  );
  const bindTerminalEvents = useTerminalStore((state) => state.bindTerminalEvents);
  const openTerminal = useTerminalStore((state) => state.openTerminal);
  const openSshContainerTerminal = useTerminalStore((state) => state.openSshContainerTerminal);
  const enterSshContainerRuntime = useTerminalStore((state) => state.enterSshContainerRuntime);
  const openDefaultLocalTerminal = useTerminalStore((state) => state.openDefaultLocalTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const forgetTerminalRuntime = useTerminalStore((state) => state.forgetTerminalRuntime);
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const terminalRuntimes = useTerminalStore((state) => state.runtimes);
  const activeRuntimeInfo = useTerminalStore((state) =>
    activeRuntimeSessionId ? (state.runtimes[activeRuntimeSessionId] ?? null) : null,
  );
  const terminalSessionLabels = useMemo(() => Object.fromEntries([
    ...sessions.filter((session) => session.type === "ssh").map((session) => [session.id, session.host.trim() || session.name]),
    ...Object.values(externalSshSessions).map((session) => [session.id, session.host.trim() || session.name]),
  ]), [sessions, externalSshSessions]);
  const activeAgentRuntimeSessionId =
    activeRuntimeSessionId &&
    (activeRuntimeInfo?.kind === "local" ||
      activeSavedSession?.type === "local" ||
      activePaneTab?.connection_source === "default_local" ||
      activePaneTab?.connection_source === "external_local" ||
      activePaneTab?.connection_source === "ssh_container" ||
      activePaneTab?.connection_source === "external_ssh" ||
      activeSavedSession?.type === "ssh" ||
      activeRuntimeInfo?.kind === "ssh" ||
      activeRuntimeInfo?.kind === "ssh_container")
      ? activeRuntimeSessionId
      : null;
  const activeAgentTargetLabel = activeAgentRuntimeSessionId
    ? activeSavedSession?.name?.trim()
      || activeExternalSshSession?.name?.trim()
      || activeRuntimeInfo?.title?.trim()
      || activePaneTab?.title?.trim()
      || null
    : null;
  const activeConnectionKind: ActiveConnectionKind = (() => {
    if (!activeRuntimeSessionId || activePaneTab?.connection_source === "ssh_container") return "none";
    if (activeExternalSshSession) {
      return activeExternalSshMultiChannel ? "ssh_transient_multi" : "ssh_transient_restricted";
    }
    if (activeSavedSession?.type === "ssh" || activeRuntimeInfo?.kind === "ssh") return "ssh";
    if (
      activeSavedSession?.type === "local" ||
      activePaneTab?.connection_source === "default_local" ||
      activeRuntimeInfo?.kind === "local"
    ) {
      return "local";
    }
    return "none";
  })();

  const bindOpenedTerminalRuntime = useCallback(
    async (
      terminalLayoutId: string,
      terminalLayoutTabId: string,
      paneId: string,
      paneTabId: string,
      runtime: RuntimeSessionInfo,
    ) => {
      if (!useTerminalLayoutStore.getState().hasPaneTerminalTab(terminalLayoutId, terminalLayoutTabId, paneId, paneTabId)) {
        await closeTerminal(runtime.runtime_session_id);
        return false;
      }
      bindRuntimeToPaneTab(terminalLayoutId, terminalLayoutTabId, paneId, paneTabId, runtime);
      return true;
    },
    [bindRuntimeToPaneTab, closeTerminal],
  );
  const activeRuntimeInputSerial = useTerminalStore((state) =>
    activeTool === "history" && activeRuntimeSessionId
      ? (state.inputSerialByRuntime[activeRuntimeSessionId] ?? 0)
      : 0,
  );
  const activeHistoryScope = resolveHistoryScope({
    runtimeScopeKind: activeRuntimeInfo?.history_scope_kind,
    runtimeScopeId: activeRuntimeInfo?.history_scope_id,
    savedSessionId: activeSavedSessionId,
    savedSessionType:
      activeSavedSession?.type === "ssh" || activeSavedSession?.type === "local"
        ? activeSavedSession.type
        : undefined,
    savedSessionLocalProfileId: activeSavedSession?.local_options?.profile_id,
    defaultLocalProfileId: terminalProfiles.find((profile) => profile.is_default)?.id,
  });
  const activeHistoryScopeKind = activeHistoryScope.scopeKind;
  const activeHistoryScopeId = activeHistoryScope.scopeId;
  const language = appSettings?.language ?? "zhCN";
  useDomI18n(language);

  useEffect(() => {
    void bindApprovalModeToSession(mcpApprovalSessionId);
  }, [mcpApprovalSessionId, bindApprovalModeToSession]);

  useActiveAgentTerminalSync(
    activeRuntimeInfo?.kind === "local" || activeSavedSession?.type === "local" ||
      activePaneTab?.connection_source === "default_local" || activePaneTab?.connection_source === "external_local"
      ? null : activeAgentRuntimeSessionId,
  );

  useEffect(() => {
    if (previousAgentConnectionKeyRef.current === activeAgentConnectionKey) return;
    previousAgentConnectionKeyRef.current = activeAgentConnectionKey;
    setAgentOpenError(null);
    setActiveTool((current) => {
      if (activeAgentConnectionKey && agentSessionsByConnectionKey[activeAgentConnectionKey]) return "agent";
      return current === "agent" ? null : current;
    });
  }, [activeAgentConnectionKey, agentSessionsByConnectionKey]);

  useEffect(() => {
    const liveConnectionKeys = collectLiveAgentConnectionKeys(tabs);
    const removed = Object.entries(agentSessionsByConnectionKey).filter(([connectionKey]) => !liveConnectionKeys.has(connectionKey));
    if (removed.length === 0) return;
    for (const [, session] of removed) {
      void stopAgentCodexSessionAndForgetRuntime(session).catch(() => undefined);
    }
    const next = Object.fromEntries(Object.entries(agentSessionsRef.current).filter(([connectionKey]) => liveConnectionKeys.has(connectionKey)));
    agentSessionsRef.current = next;
    setAgentSessionsByConnectionKey(next);
  }, [agentSessionsByConnectionKey, tabs]);

  useEffect(() => {
    const exited = Object.entries(agentSessionsByConnectionKey).filter(([, session]) =>
      !terminalRuntimes[session.runtime.runtime_session_id] &&
      !agentStoppingSessionIdsRef.current.has(session.agent_session_id),
    );
    if (exited.length === 0) return;
    for (const [connectionKey, session] of exited) {
      removeAgentCodexSession(connectionKey, session);
      void stopAgentCodexSessionAndForgetRuntime(session).catch(() => undefined);
    }
  }, [agentSessionsByConnectionKey, terminalRuntimes]);

  const syncChannelCandidateKey = syncChannelCandidates
    .map((candidate) => `${candidate.id}:${candidate.runtimeSessionId}:${candidate.host}`)
    .join("|");
  useEffect(() => {
    retainSyncChannelMembers(syncChannelCandidates);
  }, [retainSyncChannelMembers, syncChannelCandidateKey]);

  useEffect(() => {
    void loadSessions().finally(() => setSessionsReady(true));
    void loadSettings();
    void loadPendingInvocations();
  }, [loadPendingInvocations, loadSessions, loadSettings]);

  useEffect(() => {
    if (!sessionsReady) return;
    let disposed = false;
    const initialTabs = initialLayoutTabsRef.current;
    void loadTerminalLayout().then(async (saved) => {
      if (disposed || !saved || useTerminalLayoutStore.getState().tabs !== initialTabs) return;
      const queued = markTerminalLayoutRestoreQueued(saved);
      useTerminalLayoutStore.getState().restoreWorkbenchDefinition(queued);
      await runTerminalLayoutRestoreQueue({ terminalLayout: queued, sessions, strategy: "visible_first",
        openTerminal, openDefaultLocalTerminal, openSshContainerTerminal, writeTerminal, closeTerminal,
        updatePaneTerminalTab, isCancelled: () => disposed,
        isTargetAvailable: (layoutId, tabId, paneId, paneTabId) => {
          const state = useTerminalLayoutStore.getState();
          if (!state.hasPaneTerminalTab(layoutId, tabId, paneId, paneTabId)) return false;
          const tab = state.tabs.find(item => item.id === tabId);
          const leaf = tab ? findPane(tab.root, paneId) : null;
          const target = leaf?.kind === "leaf" ? getLeafTerminalTabs(leaf).find(item => item.id === paneTabId) : null;
          const originalTab = queued.tabs.find(item => item.id === tabId);
          const originalLeaf = originalTab ? findPane(originalTab.root, paneId) : null;
          const originalTarget = originalLeaf?.kind === "leaf" ? getLeafTerminalTabs(originalLeaf).find(item => item.id === paneTabId) : null;
          return Boolean(target && target.restore_token === originalTarget?.restore_token && !target.runtime_session_id && (target.restore_status === "queued" || target.restore_status === "pending"));
        } });
    }).catch(error => { if (!disposed) setTerminalError(fallbackOnlyErrorMessage(error, "恢复终端布局失败")); })
      .finally(() => { if (!disposed) setLayoutReady(true); });
    return () => { disposed = true; };
  }, [sessionsReady]);

  useEffect(() => {
    if (!layoutReady) return;
    const timer = window.setTimeout(() => {
      const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft();
      if (draft) void saveTerminalLayout(draft).catch(error => setTerminalError(fallbackOnlyErrorMessage(error, "保存终端布局失败")));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [layoutReady, tabs, activeTabId]);

  useEffect(() => {
    if (!layoutReady || !("__TAURI_INTERNALS__" in globalThis)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.onCloseRequested(async event => {
      event.preventDefault();
      try {
        const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft();
        if (draft) await saveTerminalLayout(draft);
        unlisten?.();
        await appWindow.close();
      } catch (error) {
        setTerminalError(fallbackOnlyErrorMessage(error, "保存终端布局失败"));
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [layoutReady]);

  useEffect(() => {
    if (!appSettings) return;
    applyAppSettings(appSettings);
  }, [appSettings]);


  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;
    void bindTerminalEvents().then((unlisten) => {
      if (mounted) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    });
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [bindTerminalEvents]);

  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;
    void bindTransferEvents().then((unlisten) => {
      if (mounted) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    });
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [bindTransferEvents]);

  useEffect(() => {
    if (activeTool === "files" && activeSshSessionId) {
      void listFiles(activeSshSessionId, filePath);
      return;
    }
    if (activeTool === "files") {
      clearFiles();
    }
  }, [activeSshSessionId, activeTool, clearFiles, filePath, listFiles]);

  useEffect(() => {
    if (!activeExternalSshSession) return undefined;
    let cancelled = false;
    void getExternalSshOptions(activeExternalSshSession.id)
      .then((options) => {
        if (cancelled) return;
        setExternalSshOptionsById((current) => ({ ...current, [activeExternalSshSession.id]: options }));
      })
      .catch((error) => {
        if (!cancelled) {
          setTerminalError(fallbackOnlyErrorMessage(error, "读取临时 SSH 配置失败"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeExternalSshSession]);

  useEffect(() => {
    if (activeTool && !visibleRightTools(activeConnectionKind).includes(activeTool)) {
      setActiveTool(null);
    }
  }, [activeConnectionKind, activeTool]);

  useEffect(() => {
    if (activeTool !== "containers") return undefined;
    if (!activeSshContainersEnabled || !activeSshSessionId) {
      setContainerPanelState(EMPTY_CONTAINER_PANEL_STATE);
      return undefined;
    }

    let cancelled = false;
    void loadSshContainers(
      activeSshSessionId,
      isExternalSessionId(activeSshSessionId) ? activeRuntimeSessionId : null,
      () => cancelled,
    );
    return () => {
      cancelled = true;
    };
  }, [activeRuntimeSessionId, activeSshContainersEnabled, activeSshSessionId, activeTool]);

  useEffect(() => {
    if (activeTool !== "history") {
      return;
    }
    if (historyView !== "groups") {
      void searchHistory({
        query: historyQuery,
        scopeKind: activeHistoryScopeKind,
        scopeId: activeHistoryScopeId,
        deduplicate: deduplicateHistory,
      });
    }
    void loadCommandGroups(activeHistoryScopeKind, activeHistoryScopeId);
  }, [
    activeTool,
    activeHistoryScopeId,
    activeHistoryScopeKind,
    activeRuntimeInputSerial,
    deduplicateHistory,
    historyQuery,
    historyView,
    loadCommandGroups,
    searchHistory,
  ]);

  useEffect(() => {
    if (activeTool === "files") {
      void loadTransfers(activeSshSessionId);
    }
  }, [activeSshSessionId, activeTool, loadTransfers]);

  useAppShortcutKeys(
    appSettings?.shortcuts ?? [],
    {
      activePaneId: activeLeaf?.id ?? null,
      activePaneTabId: activePaneTab?.id ?? null,
      newTabPaneId: activeTab?.active_pane_id ?? null,
    },
    {
      onOpenSettings: () => setViewMode("settings"),
      onOpenSyncChannel: () => setSyncChannelDialogOpen(true),
      onAddTerminalTab: addPaneTab,
      onCloseTerminalTab: (paneId, paneTabId) => void handleClosePaneTab(paneId, paneTabId),
      onSplitPane: splitActivePane,
      onToggleRightTool: toggleRightTool,
    },
  );

  const refreshAffectedDomainsRef = useLatestRef(refreshAffectedDomains);
  const handleZtermToolActionRef = useLatestRef(handleZtermToolAction);
  const openSavedSessionRef = useLatestRef(openSavedSession);

  useEffect(() => {
    setMcpAffectedDomainsHandler((domains) => {
      void refreshAffectedDomainsRef.current(domains);
    });
    return () => setMcpAffectedDomainsHandler(null);
  }, [refreshAffectedDomainsRef]);

  const handleExternalSshLaunch = useCallback(
    async (launch: ExternalSshLaunchEvent) => {
      if (!launch.id || processedExternalLaunchIdsRef.current.has(launch.id)) return;
      processedExternalLaunchIdsRef.current.add(launch.id);
      if (launch.file_transfer_protocol === "ftp" || launch.file_transfer_protocol === "sftp") {
        setTerminalError(null);
        try {
          await useFileTransferStore.getState().prepareForSession(launch.id, launch.remote_path || "/");
          setViewMode("workbench");
          setFileTransferDialogOpen(true);
        } catch (error) {
          setTerminalError(fallbackOnlyErrorMessage(error, "打开外部文件传输连接失败"));
        }
        return;
      }
      setExternalSshSessions((current) => ({ ...current, [launch.id]: launch }));
      setExternalSshOptionsById((current) => ({ ...current, [launch.id]: current[launch.id] ?? DEFAULT_EXTERNAL_SSH_OPTIONS }));
      setActiveTool(null);

      const terminalLayoutState = useTerminalLayoutStore.getState();
      const targetTerminalLayoutId = terminalLayoutState.activeTerminalLayoutId;
      const targetTerminalLayoutTab = terminalLayoutState.tabs.find((tab) => tab.id === terminalLayoutState.activeTabId) ?? terminalLayoutState.tabs[0];
      const targetPane = targetTerminalLayoutTab ? findPane(targetTerminalLayoutTab.root, targetTerminalLayoutTab.active_pane_id) : null;
      const targetLeaf = targetPane?.kind === "leaf" ? targetPane : null;
      const activeTargetPaneTab = targetLeaf ? getActiveTerminalTab(targetLeaf) : null;
      if (!targetTerminalLayoutTab || !targetLeaf || !activeTargetPaneTab) {
        setTerminalError("外部 SSH 连接无法定位目标分栏");
        return;
      }

      const targetPaneId = targetTerminalLayoutTab.active_pane_id;
      const targetPaneTab = isReusableConnectionTab(activeTargetPaneTab) ? activeTargetPaneTab : addPaneTab(targetPaneId);
      updatePaneTerminalTab(targetTerminalLayoutId, targetTerminalLayoutTab.id, targetPaneId, targetPaneTab.id, {
        title: launch.name,
        saved_session_id: launch.id,
        connection_source: "external_ssh",
        restore_status: "pending",
        restore_error: null,
      });

      setTerminalError(null);
      try {
        const runtime = await openTerminal(launch.id, targetPaneId);
        await bindOpenedTerminalRuntime(
          targetTerminalLayoutId,
          targetTerminalLayoutTab.id,
          targetPaneId,
          targetPaneTab.id,
          runtime,
        );
      } catch (error) {
        const message = fallbackOnlyErrorMessage(error, "打开外部 SSH 连接失败");
        updatePaneTerminalTab(targetTerminalLayoutId, targetTerminalLayoutTab.id, targetPaneId, targetPaneTab.id, {
          restore_status: "failed",
          restore_error: message,
        });
        setTerminalError(message);
      }
    },
    [addPaneTab, bindOpenedTerminalRuntime, openTerminal, updatePaneTerminalTab],
  );

  const drainPendingExternalLaunches = useCallback(async () => {
    const localLaunches = await takePendingExternalLocalLaunches();
    for (const launch of localLaunches) {
      if (processedExternalLaunchIdsRef.current.has(launch.id)) continue;
      processedExternalLaunchIdsRef.current.add(launch.id);
      const state = useTerminalLayoutStore.getState();
      const tab = state.tabs.find(item => item.id === state.activeTabId) ?? state.tabs[0];
      const pane = tab ? findPane(tab.root, tab.active_pane_id) : null;
      if (!tab || pane?.kind !== "leaf") continue;
      const current = getActiveTerminalTab(pane);
      const target = isReusableConnectionTab(current) ? current : state.addPaneTab(pane.id);
      state.updatePaneTerminalTab(state.activeTerminalLayoutId, tab.id, pane.id, target.id, {
        connection_source: "external_local", path: launch.working_directory,
        restore_status: "pending", restore_error: null,
      });
      try {
        const runtime = await openDefaultLocalTerminal(pane.id, launch.working_directory);
        await bindOpenedTerminalRuntime(state.activeTerminalLayoutId, tab.id, pane.id, target.id, runtime);
        useTerminalLayoutStore.getState().updatePaneTerminalTab(state.activeTerminalLayoutId, tab.id, pane.id, target.id, {
          connection_source: "external_local",
        });
      } catch (error) {
        state.updatePaneTerminalTab(state.activeTerminalLayoutId, tab.id, pane.id, target.id, {
          restore_status: "failed", restore_error: fallbackOnlyErrorMessage(error, "打开本地目录失败"),
        });
        setTerminalError(fallbackOnlyErrorMessage(error, "打开本地目录失败"));
      }
    }
    const launches = await takePendingExternalLaunches();
    for (const launch of launches) {
      await handleExternalSshLaunch(launch);
    }
  }, [handleExternalSshLaunch, openDefaultLocalTerminal, bindOpenedTerminalRuntime]);

  useEffect(() => {
    if (!layoutReady) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    let cleanupLocal: (() => void) | null = null;
    const drain = () =>
      drainPendingExternalLaunches().catch((error) => {
        if (!disposed) setTerminalError(fallbackOnlyErrorMessage(error, "读取外部启动请求失败"));
      });
    const localListener = listenTauri("zterm:external-local-launch", () => { void drain(); }).then(unlisten => {
      if (disposed) unlisten();
      else cleanupLocal = unlisten;
    });
    const sshListener = listenTauri("zterm:external-ssh-launch", () => {
      void drain();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup = unlisten;
    });
    void Promise.all([localListener, sshListener])
      .catch(error => {
        if (!disposed) setTerminalError(fallbackOnlyErrorMessage(error, "监听外部启动请求失败"));
      })
      .then(async () => {
        if (disposed) return;
        await drain();
        if (!disposed) await ensureDefaultLocalTerminal(openDefaultLocalTerminal, closeTerminal);
      })
      .catch(error => {
        if (!disposed) setTerminalError(fallbackOnlyErrorMessage(error, "打开默认本地终端失败"));
      });
    return () => {
      disposed = true;
      cleanup?.();
      cleanupLocal?.();
    };
  }, [layoutReady, drainPendingExternalLaunches, openDefaultLocalTerminal, closeTerminal]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void listenTauri<ZtermToolActionEvent>("zterm:tool-action", (event) => {
      void handleZtermToolActionRef.current(event.payload);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [handleZtermToolActionRef]);

  async function refreshAffectedDomains(domains: string[]) {
    const domainSet = new Set(domains);
    if (domainSet.has("sessions")) {
      await loadSessions();
    }
    if (domainSet.has("settings") || domainSet.has("terminal")) {
      await loadSettings();
    }
    if (domainSet.has("transfer")) {
      await loadTransfers(activeSshSessionId);
    }
    if (domainSet.has("history") && activeHistoryScopeKind && activeHistoryScopeId) {
      await searchHistory({
        query: historyQuery,
        scopeKind: activeHistoryScopeKind,
        scopeId: activeHistoryScopeId,
        deduplicate: deduplicateHistory,
      });
    }
  }

  async function handleZtermToolAction(event: ZtermToolActionEvent) {
    const args = event.arguments ?? {};
    switch (event.action) {
      case "tool.open": {
        const tool = rightToolFromValue(readString(args, "tool") ?? readString(args, "right_tool"));
        if (tool) setActiveTool(tool);
        break;
      }
      case "terminal.split": {
        const direction = readString(args, "direction") === "vertical" ? "vertical" : "horizontal";
        handleSplitPane(direction);
        break;
      }
      case "terminal.focus": {
        const paneId = readString(args, "pane_id");
        const paneTabId = readString(args, "pane_tab_id");
        if (paneId) setActivePane(paneId);
        if (paneId && paneTabId) selectPaneTab(paneId, paneTabId);
        break;
      }
      case "terminal.open":
      case "sessions.open": {
        const savedSessionId = readString(args, "saved_session_id") ?? readString(args, "id");
        if (!savedSessionId) break;
        const session = sessions.find((item) => item.id === savedSessionId);
        if (session) {
          const placement = readString(args, "placement") ?? "tab";
          if (placement === "split_horizontal" || placement === "split_vertical") {
            handleSplitPane(placement === "split_vertical" ? "vertical" : "horizontal");
            await waitForUiTurn();
          }
          await openSavedSessionRef.current(session);
        }
        break;
      }
      case "terminal.close": {
        const runtimeSessionId = readString(args, "runtime_session_id");
        if (runtimeSessionId) {
          await closeTerminal(runtimeSessionId);
          clearRuntimeSession(runtimeSessionId);
        }
        break;
      }
      case "sftp.list":
      case "sftp.mkdir":
      case "sftp.upload":
      case "sftp.download":
      case "sftp.delete":
      case "sftp.rename": {
        setActiveTool("files");
        if (activeSshSessionId) {
          await listFiles(activeSshSessionId, filePath);
        }
        break;
      }
      case "server_info.snapshot":
        setActiveTool("monitor");
        break;
      case "ssh_container.list":
        setActiveTool("containers");
        await refreshActiveSshContainers();
        break;
      default:
        break;
    }
    if (event.affected_domains?.length) {
      await refreshAffectedDomains(event.affected_domains);
    }
  }

  function handleRequestPaneConnection(paneId: string) {
    if (!activeTab) return;
    setActivePane(paneId);
    setConnectionDialogTarget({
      terminalLayoutId: activeTerminalLayoutId,
      terminalLayoutTabId: activeTab.id,
      paneId,
    });
    setConnectionDialogError(null);
  }

  async function handleDuplicatePaneConnection(paneId: string, paneTabId: string) {
    if (!activeTab) return;
    const sourcePane = findPane(activeTab.root, paneId);
    const sourceTab = sourcePane?.kind === "leaf"
      ? getLeafTerminalTabs(sourcePane).find((tab) => tab.id === paneTabId)
      : null;
    const source = sourceTab?.connection_source ?? (sourceTab?.saved_session_id ? "saved_session" : null);
    if (!sourceTab || !source || source === "missing" || (source !== "default_local" && source !== "external_local" && !sourceTab.saved_session_id)) return;

    const targetTerminalLayoutId = activeTerminalLayoutId;
    const targetTerminalLayoutTabId = activeTab.id;
    const targetPaneTab = addPaneTabAfter(paneId, paneTabId);
    updatePaneTerminalTab(targetTerminalLayoutId, targetTerminalLayoutTabId, paneId, targetPaneTab.id, {
      title: sourceTab.title,
      saved_session_id: sourceTab.saved_session_id,
      connection_source: source,
      container_target: sourceTab.container_target ?? null,
      path: sourceTab.path ?? null,
      restore_status: "pending",
      restore_error: null,
    });
    setTerminalError(null);

    try {
      const workingDirectory = sourceTab.path?.trim() || null;
      const runtime = source === "default_local" || source === "external_local"
        ? await openDefaultLocalTerminal(paneId, workingDirectory)
        : source === "ssh_container" && sourceTab.container_target?.id
          ? await openSshContainerTerminal(
              sourceTab.saved_session_id!,
              paneId,
              sourceTab.container_target.id,
              sourceTab.container_target.name ?? null,
            )
          : await openTerminal(sourceTab.saved_session_id!, paneId, workingDirectory);
      await bindOpenedTerminalRuntime(targetTerminalLayoutId, targetTerminalLayoutTabId, paneId, targetPaneTab.id, runtime);
    } catch (error) {
      const message = fallbackOnlyErrorMessage(error, "复制当前连接失败");
      updatePaneTerminalTab(targetTerminalLayoutId, targetTerminalLayoutTabId, paneId, targetPaneTab.id, {
        restore_status: "failed",
        restore_error: message,
      });
      setTerminalError(message);
    }
  }

  async function handleCreatePaneConnection(choice: ConnectionChoice) {
    if (!connectionDialogTarget || connectionOpening) return;
    const target = connectionDialogTarget;
    const state = useTerminalLayoutStore.getState();
    const targetTab =
      state.activeTerminalLayoutId === target.terminalLayoutId
        ? state.tabs.find((tab) => tab.id === target.terminalLayoutTabId)
        : undefined;
    const targetPane = targetTab ? findPane(targetTab.root, target.paneId) : null;
    const activeTargetPaneTab = targetPane?.kind === "leaf" ? getActiveTerminalTab(targetPane) : null;
    if (!targetTab || !activeTargetPaneTab) {
      setConnectionDialogError("目标分栏不存在");
      return;
    }

    setConnectionOpening(true);
    setConnectionDialogError(null);
    setTerminalError(null);
    try {
      const targetPaneTab = isReusableConnectionTab(activeTargetPaneTab)
        ? activeTargetPaneTab
        : addPaneTab(target.paneId);
      const runtime = await openTerminal(choice.session.id, target.paneId);
      const bound = await bindOpenedTerminalRuntime(
        target.terminalLayoutId,
        target.terminalLayoutTabId,
        target.paneId,
        targetPaneTab.id,
        runtime,
      );
      if (bound) setConnectionDialogTarget(null);
    } catch (openError) {
      const message = fallbackOnlyErrorMessage(openError, "打开终端失败");
      setConnectionDialogError(message);
      setTerminalError(message);
    } finally {
      setConnectionOpening(false);
    }
  }

  async function handleClosePaneTab(paneId: string, paneTabId: string) {
    const terminalLayoutState = useTerminalLayoutStore.getState();
    const targetTab = terminalLayoutState.tabs.find((tab) => tab.id === terminalLayoutState.activeTabId);
    const targetPane = targetTab ? findPane(targetTab.root, paneId) : null;
    const terminalTab = targetPane?.kind === "leaf"
      ? getLeafTerminalTabs(targetPane).find((tab) => tab.id === paneTabId)
      : null;
    if (!terminalTab) return;

    setTerminalError(null);
    try {
      if (terminalTab.runtime_session_id) {
        await closeTerminal(terminalTab.runtime_session_id);
      }
      closePaneTab(paneId, paneTabId);
      await ensureDefaultLocalTerminal(openDefaultLocalTerminal, closeTerminal);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "关闭终端标签失败"));
    }
  }

  async function handleClosePane(paneId: string) {
    const terminalLayoutState = useTerminalLayoutStore.getState();
    const targetTab = terminalLayoutState.tabs.find((tab) => tab.id === terminalLayoutState.activeTabId);
    const targetPane = targetTab ? findPane(targetTab.root, paneId) : null;
    if (targetPane?.kind !== "leaf") return;

    const runtimeSessionIds = getLeafTerminalTabs(targetPane)
      .map((tab) => tab.runtime_session_id)
      .filter((runtimeSessionId): runtimeSessionId is string => Boolean(runtimeSessionId));
    setTerminalError(null);
    const { closedRuntimeSessionIds, failedReason } = await closeTerminalRuntimes(runtimeSessionIds, closeTerminal);
    closedRuntimeSessionIds.forEach((runtimeSessionId) => clearRuntimeSession(runtimeSessionId));
    if (failedReason !== null) {
      setTerminalError(fallbackOnlyErrorMessage(failedReason, "关闭分栏失败"));
      return;
    }
    closePane(paneId);
    try {
      await ensureDefaultLocalTerminal(openDefaultLocalTerminal, closeTerminal);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "打开默认本地终端失败"));
    }
  }

  function handleSplitPane(direction: "horizontal" | "vertical") {
    splitActivePane(direction);
  }

  function toggleRightTool(tool: RightTool) {
    if (tool !== "agent") {
      setActiveTool((current) => (current === tool ? null : tool));
      return;
    }
    if (activeTool === "agent") {
      setActiveTool(null);
      return;
    }
    setAgentOpenError(null);
    setActiveTool("agent");
    void ensureActiveAgentCodex();
  }

  function removeAgentCodexSession(connectionKey: string, expectedSession?: AgentCodexSession) {
    if (expectedSession && agentSessionsRef.current[connectionKey] !== expectedSession) return;
    const next = Object.fromEntries(
      Object.entries(agentSessionsRef.current).filter(([currentConnectionKey]) => currentConnectionKey !== connectionKey),
    );
    agentSessionsRef.current = next;
    setAgentSessionsByConnectionKey(next);
  }

  async function stopAgentCodexSessionAndForgetRuntime(session: AgentCodexSession) {
    agentStoppingSessionIdsRef.current.add(session.agent_session_id);
    let stopped = false;
    try {
      await stopAgentCodexSession(session);
      stopped = true;
    } finally {
      if (stopped) forgetTerminalRuntime(session.runtime.runtime_session_id);
      agentStoppingSessionIdsRef.current.delete(session.agent_session_id);
    }
  }

  function setAgentConnectionOpening(connectionKey: string, opening: boolean) {
    setAgentOpeningConnectionKeys((current) => {
      if (opening) return current[connectionKey] ? current : { ...current, [connectionKey]: true };
      if (!current[connectionKey]) return current;
      const { [connectionKey]: _removed, ...next } = current;
      return next;
    });
  }

  function setAgentOpenErrorForConnection(connectionKey: string, error: string | null) {
    if (activeAgentConnectionKeyRef.current === connectionKey) setAgentOpenError(error);
  }

  function isAgentConnectionLive(connectionKey: string) {
    return collectLiveAgentConnectionKeys(useTerminalLayoutStore.getState().tabs).has(connectionKey);
  }

  function openAgentCodexForConnection(
    connectionKey: string,
    request: {
      tabId: string;
      targetRuntimeSessionId: string;
      targetSavedSessionId: string | null;
      targetLabel: string;
    },
  ) {
    const existing = agentSessionsRef.current[connectionKey];
    if (existing) return Promise.resolve(existing);
    const opening = agentOpenPromisesRef.current.get(connectionKey);
    if (opening) return opening;

    setAgentConnectionOpening(connectionKey, true);
    let operation: Promise<AgentCodexSession | null>;
    operation = openAgentCodex(request)
      .then(async (session) => {
        if (!isAgentConnectionLive(connectionKey)) {
          await stopAgentCodexSessionAndForgetRuntime(session).catch(() => undefined);
          return null;
        }
        useTerminalStore.setState((state) => ({
          runtimes: {
            ...state.runtimes,
            [session.runtime.runtime_session_id]: session.runtime,
          },
        }));
        const next = { ...agentSessionsRef.current, [connectionKey]: session };
        agentSessionsRef.current = next;
        setAgentSessionsByConnectionKey(next);
        return session;
      })
      .finally(() => {
        if (agentOpenPromisesRef.current.get(connectionKey) === operation) {
          agentOpenPromisesRef.current.delete(connectionKey);
        }
        setAgentConnectionOpening(connectionKey, false);
      });
    agentOpenPromisesRef.current.set(connectionKey, operation);
    return operation;
  }

  async function ensureActiveAgentCodex() {
    if (!activeAgentConnectionKey || !activeRuntimeSessionId || !activePaneTab) {
      setAgentOpenError("请先打开一个可操作的终端标签页。");
      return;
    }
    if (agentSessionsRef.current[activeAgentConnectionKey]) return;
    const connectionKey = activeAgentConnectionKey;
    const request = {
      tabId: activePaneTab.id,
      targetRuntimeSessionId: activeRuntimeSessionId,
      targetSavedSessionId: activeSavedSessionId,
      targetLabel: activeAgentTargetLabel ?? (activePaneTab.title || activeSavedSession?.name || "当前终端"),
    };
    setAgentOpenErrorForConnection(connectionKey, null);
    try {
      await openAgentCodexForConnection(connectionKey, request);
    } catch (error) {
      setAgentOpenErrorForConnection(connectionKey, unknownErrorMessage(error, "Codex CLI 启动失败"));
    }
  }

  async function restartActiveAgentCodex() {
    if (!activeAgentConnectionKey || !activeAgentSession || agentOpenPromisesRef.current.has(activeAgentConnectionKey)) return;
    const connectionKey = activeAgentConnectionKey;
    const previousSession = activeAgentSession;
    setAgentOpenErrorForConnection(connectionKey, null);
    try {
      await stopAgentCodexSessionAndForgetRuntime(previousSession);
      removeAgentCodexSession(connectionKey, previousSession);
      if (!activePaneTab || !activeRuntimeSessionId) return;
      await openAgentCodexForConnection(connectionKey, {
        tabId: activePaneTab.id,
        targetRuntimeSessionId: activeRuntimeSessionId,
        targetSavedSessionId: activeSavedSessionId,
        targetLabel: activeAgentTargetLabel ?? (activePaneTab.title || activeSavedSession?.name || previousSession.target_label),
      });
    } catch (error) {
      setAgentOpenErrorForConnection(connectionKey, unknownErrorMessage(error, "Codex CLI 重启失败"));
    }
  }

  async function closeActiveAgentCodex() {
    if (!activeAgentConnectionKey || !activeAgentSession || agentOpenPromisesRef.current.has(activeAgentConnectionKey)) return;
    const connectionKey = activeAgentConnectionKey;
    const session = activeAgentSession;
    setAgentOpenErrorForConnection(connectionKey, null);
    try {
      await stopAgentCodexSessionAndForgetRuntime(session);
      removeAgentCodexSession(connectionKey, session);
      if (activeAgentConnectionKeyRef.current === connectionKey) setActiveTool(null);
    } catch (error) {
      setAgentOpenErrorForConnection(connectionKey, unknownErrorMessage(error, "Codex CLI 关闭失败"));
    }
  }

  async function loadSshContainers(
    savedSessionId: string,
    runtimeSessionId: string | null = null,
    isCancelled: () => boolean = () => false,
  ) {
    setContainerPanelState((current) => ({ ...current, loading: true, error: null }));
    try {
      const items = isExternalSessionId(savedSessionId)
        ? await listSshContainers(savedSessionId, { runtimeSessionId })
        : await listSshContainers(savedSessionId);
      if (isCancelled()) return;
      setContainerPanelState({ items, loading: false, error: null });
    } catch (error) {
      if (isCancelled()) return;
      setContainerPanelState({
        items: [],
        loading: false,
        error: isExternalSessionId(savedSessionId)
          ? unknownErrorMessage(error, "加载容器失败", { blankStringFallback: true, objectMessage: true })
          : fallbackOnlyErrorMessage(error, "加载容器失败"),
      });
    }
  }

  async function refreshActiveSshContainers() {
    if (!activeSshContainersEnabled || !activeSshSessionId) {
      setContainerPanelState(EMPTY_CONTAINER_PANEL_STATE);
      return;
    }
    await loadSshContainers(
      activeSshSessionId,
      isExternalSessionId(activeSshSessionId) ? activeRuntimeSessionId : null,
    );
  }

  async function changeExternalContainerRuntime(runtime: string) {
    if (!activeExternalSshSession || !activeExternalSshOptions) return;
    const nextOptions: SshOptions = {
      ...activeExternalSshOptions,
      container: {
        ...(activeExternalSshOptions.container ?? DEFAULT_EXTERNAL_SSH_OPTIONS.container!),
        enabled: true,
        runtime,
      },
    };
    try {
      const savedOptions = await updateExternalSshOptions(activeExternalSshSession.id, nextOptions);
      setExternalSshOptionsById((current) => ({ ...current, [activeExternalSshSession.id]: savedOptions }));
      await loadSshContainers(activeExternalSshSession.id, activeRuntimeSessionId);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "更新临时 SSH 容器类型失败"));
    }
  }

  async function saveExternalTunnelOptions(sessionId: string, options: SshOptions) {
    try {
      const savedOptions = await updateExternalSshOptions(sessionId, options);
      setExternalSshOptionsById((current) => ({ ...current, [sessionId]: savedOptions }));
      setSshTunnelNeedsReconnectBySessionId((current) => ({ ...current, [sessionId]: true }));
      setExternalSshTunnelEditor(null);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "保存临时 SSH 隧道失败"));
    }
  }

  function activeSshTunnelTarget(): ActiveSshTunnelTarget | null {
    if (!activeSshSessionId) return null;
    if (activeSavedSession?.type === "ssh") {
      return {
        sessionId: activeSavedSession.id,
        savedSession: activeSavedSession,
        baseOptions: activeSavedSession.ssh_options ?? {},
        host: activeSavedSession.host,
        hostServiceTargetHost: activeSavedSession.host,
        external: false,
      };
    }
    if (activeExternalSshSession) {
      return {
        sessionId: activeExternalSshSession.id,
        savedSession: null,
        baseOptions: activeExternalSshOptions ?? DEFAULT_EXTERNAL_SSH_OPTIONS,
        host: activeExternalSshSession.host,
        hostServiceTargetHost: externalSshHostServiceTarget(activeExternalSshSession),
        external: true,
      };
    }
    return null;
  }

  function openActiveSshTunnelEditor(mode: "create" | "edit", index: number | null = null) {
    const target = activeSshTunnelTarget();
    if (!target) return;
    const tunnels = target.baseOptions.tunnels ?? [];
    const selectedTunnel = mode === "edit" && index !== null ? tunnels[index] : null;
    if (mode === "edit" && !selectedTunnel) return;
    const initialTunnel = selectedTunnel ?? {
      ...emptySshTunnel("host_service"),
      remote_host: target.hostServiceTargetHost,
    };
    setSshTunnelEditor({
      ...target,
      mode,
      index: mode === "edit" ? index : null,
      tunnel: initialTunnel,
    });
  }

  function requestDeleteActiveSshTunnel(index: number) {
    const target = activeSshTunnelTarget();
    const tunnel = target?.baseOptions.tunnels?.[index];
    if (!target || !tunnel) return;
    setPendingSshTunnelDelete({ ...target, index, tunnel });
  }

  async function persistSshTunnelChanges(target: ActiveSshTunnelTarget, tunnels: SshTunnel[]) {
    const options = { ...target.baseOptions, tunnels };
    if (target.external) {
      const savedOptions = await updateExternalSshOptions(target.sessionId, options);
      setExternalSshOptionsById((current) => ({ ...current, [target.sessionId]: savedOptions }));
    } else {
      if (!target.savedSession) throw new Error("SSH 会话不存在");
      await saveSession(savedSessionDraftWithSshOptions(target.savedSession, options));
    }
    setSshTunnelNeedsReconnectBySessionId((current) => ({ ...current, [target.sessionId]: true }));
  }

  async function saveSshTunnel(tunnel: SshTunnel) {
    const editor = sshTunnelEditor;
    if (!editor) return;
    const tunnels = [...(editor.baseOptions.tunnels ?? [])];
    if (editor.mode === "create") {
      tunnels.push(tunnel);
    } else if (editor.index !== null) {
      tunnels[editor.index] = tunnel;
    }
    try {
      await persistSshTunnelChanges(editor, tunnels);
      setSshTunnelEditor(null);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "保存 SSH 隧道失败"));
    }
  }

  async function confirmDeleteSshTunnel() {
    const pending = pendingSshTunnelDelete;
    if (!pending) return;
    try {
      const tunnels = (pending.baseOptions.tunnels ?? []).filter((_, index) => index !== pending.index);
      await persistSshTunnelChanges(pending, tunnels);
      setPendingSshTunnelDelete(null);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "删除 SSH 隧道失败"));
    }
  }

  function reconnectActiveSsh() {
    if (!activePaneTab?.runtime_session_id || !activePaneTab.saved_session_id) return;
    void terminalActions.reconnectTerminal(
      activeTab?.active_pane_id ?? "",
      activePaneTab.id,
      activePaneTab.saved_session_id,
      activePaneTab.runtime_session_id,
    );
    setSshTunnelNeedsReconnectBySessionId((current) => ({
      ...current,
      [activePaneTab.saved_session_id as string]: false,
    }));
  }

  async function startStoppedSshContainer(container: SshContainerInfo) {
    if (!activeSshContainersEnabled || !activeSshSessionId || container.running || containerStartPendingRef.current) return;
    containerStartPendingRef.current = true;
    const sessionId = activeSshSessionId;
    const runtimeId = isExternalSessionId(sessionId) ? activeRuntimeSessionId : null;
    const sourceTargetKey = containerTargetKey;
    const isCancelled = () => containerTargetKeyRef.current !== sourceTargetKey;
    setContainerPanelState((current) => ({ ...current, error: null }));
    try {
      await startSshContainer(sessionId, container.id, runtimeId);
      if (!isCancelled()) await loadSshContainers(sessionId, runtimeId, isCancelled);
    } catch (error) {
      if (isCancelled()) return;
      setContainerPanelState((current) => ({
        ...current,
        error: unknownErrorMessage(error, "启动容器失败", { blankStringFallback: true, objectMessage: true }),
      }));
    } finally {
      containerStartPendingRef.current = false;
    }
  }

  async function enterSshContainer(container: SshContainerInfo) {
    const terminalLayoutState = useTerminalLayoutStore.getState();
    const latestActiveTab = terminalLayoutState.tabs.find((tab) => tab.id === terminalLayoutState.activeTabId) ?? terminalLayoutState.tabs[0];
    const latestActivePane = latestActiveTab ? findPane(latestActiveTab.root, latestActiveTab.active_pane_id) : null;
    const latestActiveLeaf = latestActivePane?.kind === "leaf" ? latestActivePane : null;
    const latestActivePaneTab = latestActiveLeaf ? getActiveTerminalTab(latestActiveLeaf) : null;
    const latestSavedSessionId = latestActivePaneTab?.saved_session_id ?? null;
    const latestSavedSession = latestSavedSessionId
      ? (useSessionStore.getState().sessions.find((session) => session.id === latestSavedSessionId) ?? null)
      : null;
    const latestExternalOptions =
      latestSavedSessionId && isExternalSessionId(latestSavedSessionId)
        ? (externalSshOptionsById[latestSavedSessionId] ?? DEFAULT_EXTERNAL_SSH_OPTIONS)
        : null;
    const latestContainerEnabled =
      latestSavedSession?.type === "ssh"
        ? latestSavedSession.ssh_options?.container?.enabled === true
        : latestExternalOptions?.container?.enabled === true;
    if (!latestActiveTab || !latestActivePaneTab || !latestContainerEnabled || !latestSavedSessionId) return;

    const targetTerminalLayoutId = terminalLayoutState.activeTerminalLayoutId;
    const targetTerminalLayoutTabId = latestActiveTab.id;
    const targetPaneId = latestActiveTab.active_pane_id;
    const afterPaneTabId = latestActivePaneTab.id;
    const targetSavedSessionId = latestSavedSessionId;
    if (isExternalSessionId(targetSavedSessionId)) {
      const targetRuntimeSessionId = latestActivePaneTab.runtime_session_id;
      if (!targetRuntimeSessionId) return;
      try {
        await enterSshContainerRuntime(targetSavedSessionId, targetRuntimeSessionId, container.id);
      } catch (error) {
        setTerminalError(fallbackOnlyErrorMessage(error, "进入容器失败"));
      }
      return;
    }
    const title = container.name?.trim() || container.id.slice(0, 12);
    const targetPaneTab = addPaneTabAfter(targetPaneId, afterPaneTabId);
    setTerminalError(null);
    updatePaneTerminalTab(targetTerminalLayoutId, targetTerminalLayoutTabId, targetPaneId, targetPaneTab.id, {
      title: `容器: ${title}`,
      saved_session_id: targetSavedSessionId,
      connection_source: "ssh_container",
      container_target: {
        id: container.id,
        name: container.name?.trim() || null,
      },
      restore_status: "pending",
      restore_error: null,
    });
    try {
      const runtime = await openSshContainerTerminal(targetSavedSessionId, targetPaneId, container.id, container.name);
      await bindOpenedTerminalRuntime(targetTerminalLayoutId, targetTerminalLayoutTabId, targetPaneId, targetPaneTab.id, runtime);
    } catch (error) {
      const message = fallbackOnlyErrorMessage(error, "进入容器失败");
      updatePaneTerminalTab(targetTerminalLayoutId, targetTerminalLayoutTabId, targetPaneId, targetPaneTab.id, {
        restore_status: "failed",
        restore_error: message,
      });
      setTerminalError(message);
    }
  }

  function toggleLeftTool(tool: LeftTool) {
    setActiveLeftTool((current) => (current === tool ? null : tool));
  }

  function requestTransferConflictPolicy(conflicts: TransferConflict[]) {
    return new Promise<TransferConflictPolicy | null>((resolve) => {
      setTransferConflictDialog({ conflicts, resolve });
    });
  }

  function resolveTransferConflictDialog(policy: TransferConflictPolicy | null) {
    transferConflictDialog?.resolve(policy);
    setTransferConflictDialog(null);
  }

  const terminalActions = createTerminalActions({
    workbenchId: activeTerminalLayoutId,
    workbenchTabId: activeTabId,
    activePaneTab,
    activeTab,
    setTerminalError,
    addPaneTab,
    bindRuntimeToPaneTab,
    updatePaneTerminalTab,
    openTerminal,
    openSshContainerTerminal,
    closeTerminal,
    hasPaneTerminalTab: (terminalLayoutId, terminalLayoutTabId, paneId, paneTabId) =>
      useTerminalLayoutStore.getState().hasPaneTerminalTab(terminalLayoutId, terminalLayoutTabId, paneId, paneTabId),
    writeTerminal,
    activeRuntimeSessionId,
  });

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void listenTauri("zterm:tool-pending", () => {
      void loadPendingInvocations().then((pendingInvocations) => {
        if (!disposed && pendingInvocations.length > 0) setActiveTool("agent");
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup = unlisten;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [loadPendingInvocations]);

  async function openSavedSession(session: SavedSession) {
    await openSavedSessionTarget(session, {
      openTerminalSession: terminalActions.openSession,
      prepareFileTransfer: useFileTransferStore.getState().prepareForSession,
      openFileTransferDialog: () => { setViewMode("workbench"); setFileTransferDialogOpen(true); },
    });
  }

  async function exportSessionsCsv() {
    const targetPath = await save({
      title: "导出连接 CSV（含明文密码）",
      defaultPath: "zterm-connections.csv",
      filters: [{ name: "CSV 文件", extensions: ["csv"] }],
    });
    if (typeof targetPath === "string") {
      await exportCsv(targetPath);
    }
  }

  const remoteFileActions = createRemoteFileActions({
    activeSshSessionId,
    filePath,
    setFilePath,
    requestTextInput,
    requestConflictPolicy: requestTransferConflictPolicy,
    listFiles,
    mkdir,
    upload,
    download,
    deletePath,
    renamePath,
    classifyLocalPaths,
    checkTransferConflicts,
  });

  const headerNavigation = (
    <nav className="zt-titlebar-navigation" aria-label="主导航">
      <ToolButton
        label="会话"
        active={viewMode === "workbench" && !fileTransferDialogOpen && activeLeftTool === "sessions"}
        icon={<Terminal size={16} aria-hidden="true" />}
        onClick={() => {
          setViewMode("workbench");
          setFileTransferDialogOpen(false);
          if (viewMode === "settings" || fileTransferDialogOpen) setActiveLeftTool("sessions");
          else toggleLeftTool("sessions");
        }}
      />
      <ToolButton
        label="文件传输"
        active={viewMode === "workbench" && fileTransferDialogOpen}
        icon={<ArrowLeftRight size={16} aria-hidden="true" />}
        onClick={() => {
          setViewMode("workbench");
          setFileTransferDialogOpen((current) => viewMode === "settings" || !current);
        }}
      />
      <ToolButton
        label="打开设置"
        active={viewMode === "settings"}
        icon={<Settings size={16} aria-hidden="true" />}
        onClick={() => { setFileTransferDialogOpen(false); setViewMode("settings"); }}
      />
    </nav>
  );

  const headerActions = (
    <ToolButton
      label={t(language, "agent")}
      active={viewMode === "workbench" && activeTool === "agent"}
      icon={<MessageSquareMore size={16} aria-hidden="true" />}
      onClick={() => {
        setViewMode("workbench");
        setFileTransferDialogOpen(false);
        if ((viewMode === "settings" || fileTransferDialogOpen) && activeTool === "agent") return;
        toggleRightTool("agent");
      }}
    />
  );

  if (viewMode === "settings") {
    return (
      <ZtCenteredPageLayout
        className="zt-workbench zt-workbench-settings"
        onContextMenu={(event) => event.preventDefault()}
      >
        <TitleBar navigation={headerNavigation} actions={headerActions} />
        <SettingsPage
          settings={appSettings}
          terminalProfiles={terminalProfiles}
          shortcutDefinitions={shortcutDefinitions}
          loading={settingsLoading}
          error={settingsError}
          onClose={() => setViewMode("workbench")}
          onSaveSettings={saveAppSettings}
          onResetSettings={resetAppSettingsSection}
          onDetectTerminalProfiles={detectTerminalProfiles}
          onSetDefaultTerminalProfile={setDefaultTerminalProfile}
          mcpStatus={mcpStatus}
          onSetMcpEnabled={setMcpEnabled}
          onRotateMcpToken={rotateMcpToken}
        />
      </ZtCenteredPageLayout>
    );
  }

  if (fileTransferDialogOpen) {
    return (
      <ZtCenteredPageLayout className="zt-workbench zt-workbench-settings" onContextMenu={(event) => event.preventDefault()}>
        <TitleBar navigation={headerNavigation} actions={headerActions} />
        <FileTransferDialog language={language} onClose={() => setFileTransferDialogOpen(false)} />
      </ZtCenteredPageLayout>
    );
  }

  const workbenchClassName = [
    "zt-workbench",
    activeLeftTool ? "" : "zt-workbench-left-collapsed",
    activeTool ? "" : "zt-workbench-right-collapsed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={workbenchClassName} onContextMenu={(event) => event.preventDefault()}>
      <TitleBar navigation={headerNavigation} actions={headerActions} />

      {activeLeftTool ? <aside
        className="zt-sidebar zt-sidebar-left zt-left-tools"
        aria-label="左侧管理"
      >
        {activeLeftTool ? (
          <div className="zt-left-tool-panel">

            {activeLeftTool === "sessions" ? (
              <section className="zt-session-panel" aria-label="会话管理">
                <PanelHeader
                  title="Session"
                  onClose={() => setActiveLeftTool(null)}
                />
                {sessionActionError ? (
                  <ZtInlineError onDismiss={() => setSessionActionError(null)} dismissLabel="关闭会话操作错误提示">
                    {sessionActionError}
                  </ZtInlineError>
                ) : sessionError ? (
                  <ZtInlineError>{sessionError}</ZtInlineError>
                ) : null}
                <SessionTree
                  groups={groups}
                  sessions={sessions}
                  onSaveGroup={saveGroup}
                  onSaveSession={saveSession}
                  onTestSession={testSession}
                  onSaveCredential={saveCredential}
                  onReadCredential={readCredentialSecret}
                  terminalProfiles={terminalProfiles}
                  onDeleteGroup={deleteGroup}
                  onDeleteSession={deleteSession}
                  onOpenSession={openSavedSession}
                  onExportCsv={exportSessionsCsv}
                />
              </section>
            ) : null}

          </div>
        ) : null}
      </aside> : null}

      {textInputDialog ? (
        <AppTextInputDialog
          key={textInputDialog.id}
          title={textInputDialog.title}
          label={textInputDialog.label}
          initialValue={textInputDialog.initialValue}
          requiredMessage={textInputDialog.requiredMessage}
          confirmLabel={textInputDialog.confirmLabel}
          onCancel={() => resolveTextInputDialog(null)}
          onSubmit={resolveTextInputDialog}
        />
      ) : null}

      {transferConflictDialog ? (
        <AppTransferConflictDialog
          conflicts={transferConflictDialog.conflicts}
          onCancel={() => resolveTransferConflictDialog(null)}
          onSelect={resolveTransferConflictDialog}
        />
      ) : null}

      {connectionDialogTarget ? (
        <ConnectionPickerDialog
          groups={groups}
          sessions={sessions.filter(
            (session) => session.type === "ssh" || session.type === "local" || session.type === "rdp",
          )}
          opening={connectionOpening}
          error={connectionDialogError}
          onCancel={() => {
            if (connectionOpening) return;
            setConnectionDialogTarget(null);
            setConnectionDialogError(null);
          }}
          onSelect={(choice) => void handleCreatePaneConnection(choice)}
        />
      ) : null}

      {externalSshTunnelEditor ? (
        <ExternalSshTunnelEditorDialog
          host={externalSshSessions[externalSshTunnelEditor]?.host ?? ""}
          hostServiceTargetHost={externalSshHostServiceTarget(externalSshSessions[externalSshTunnelEditor] ?? null)}
          initialOptions={externalSshOptionsById[externalSshTunnelEditor] ?? DEFAULT_EXTERNAL_SSH_OPTIONS}
          onCancel={() => setExternalSshTunnelEditor(null)}
          onSave={(options) => void saveExternalTunnelOptions(externalSshTunnelEditor, options)}
        />
      ) : null}

      {syncChannelDialogOpen ? (
        <SyncChannelDialog
          candidates={syncChannelCandidates}
          initialMemberIds={
            syncChannel?.members.map((member) => member.id) ??
            (activePaneTab && syncChannelCandidates.some((candidate) => candidate.id === activePaneTab.id)
              ? [activePaneTab.id]
              : [])
          }
          onCancel={() => setSyncChannelDialogOpen(false)}
          onSubmit={(memberIds) => {
            const members = memberIds
              .map((memberId) => syncChannelCandidates.find((candidate) => candidate.id === memberId))
              .filter((member): member is (typeof syncChannelCandidates)[number] => Boolean(member));
            if (createSyncChannel(members)) setSyncChannelDialogOpen(false);
          }}
        />
      ) : null}

      {sshTunnelEditor ? (
        <SshTunnelEditorDialog
          key={`${sshTunnelEditor.sessionId}-${sshTunnelEditor.mode}-${sshTunnelEditor.index ?? "new"}`}
          editor={sshTunnelEditor}
          onCancel={() => setSshTunnelEditor(null)}
          onSave={(tunnel) => void saveSshTunnel(tunnel)}
        />
      ) : null}

      {pendingSshTunnelDelete ? (
        <ZtConfirmDialog
          title="删除 SSH 隧道"
          message={`确认删除隧道“${pendingSshTunnelDelete.tunnel.name?.trim() || `SSH 隧道 ${pendingSshTunnelDelete.index + 1}`}”？`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setPendingSshTunnelDelete(null)}
          onConfirm={() => void confirmDeleteSshTunnel()}
        />
      ) : null}

      <main className={terminalError ? "zt-main zt-main-with-error" : "zt-main"}>
        {terminalError ? (
          <ZtInlineError
            className="zt-main-error"
            title="操作未完成"
            dismissLabel="关闭终端错误提示"
            onDismiss={() => setTerminalError(null)}
          >
            {terminalError}
          </ZtInlineError>
        ) : null}
        <TerminalLayoutStage
          sessionLabels={terminalSessionLabels}
          activePaneTools={
            <TerminalTools
              activeTool={activeTool}
              connectionKind={activeConnectionKind}
              language={language}
              onToolChange={toggleRightTool}
            />
          }
          onActivatePane={setActivePane}
          onAddPaneTab={handleRequestPaneConnection}
          onDuplicatePaneTab={(paneId, paneTabId) => void handleDuplicatePaneConnection(paneId, paneTabId)}
          onSelectPaneTab={selectPaneTab}
          onClosePaneTab={(paneId, paneTabId) => void handleClosePaneTab(paneId, paneTabId)}
          onMovePaneTab={movePaneTab}
          onSplitPane={handleSplitPane}
          onResizeSplit={resizeSplitPane}
          onClosePane={(paneId) => void handleClosePane(paneId)}
          onDisconnectTerminal={(paneId, paneTabId, runtimeSessionId) =>
            void terminalActions.disconnectTerminal(paneId, paneTabId, runtimeSessionId)
          }
          onReconnectTerminal={(paneId, paneTabId, savedSessionId, runtimeSessionId) =>
            void terminalActions.reconnectTerminal(paneId, paneTabId, savedSessionId, runtimeSessionId)
          }
        />
      </main>

      <RightToolsPanel
        activeTool={activeTool}
        onClose={() => setActiveTool(null)}
        agent={{
          session: activeAgentSession,
          activeTargetLabel: activeAgentTargetLabel,
          sessionsByConnectionKey: agentSessionsByConnectionKey,
          activeConnectionKey: activeAgentConnectionKey,
          approvalMode: mcpApprovalMode,
          error: agentOpenError ?? agentError,
          loading: Boolean(activeAgentConnectionKey && agentOpeningConnectionKeys[activeAgentConnectionKey]),
          pendingInvocations: mcpPendingInvocations,
          onApprovalModeChange: setApprovalMode,
          onClose: closeActiveAgentCodex,
          onConfirmTool: confirmTool,
          onRestart: restartActiveAgentCodex,
        }}
        files={{
          entries: fileEntries,
          error: fileError,
          loading: filesLoading,
          path: filePath,
          savedSessionId: activeSshSessionId,
          selectedPaths,
          onDelete: remoteFileActions.deleteRemotePaths,
          onDownload: remoteFileActions.downloadRemotePaths,
          onMkdir: remoteFileActions.createRemoteDirectory,
          onOpenDirectory: (path) => {
            void remoteFileActions.openDirectory(path);
          },
          onParent: remoteFileActions.openParentDirectory,
          onPathChange: setFilePath,
          onRefresh: () => remoteFileActions.refreshFiles(),
          onRename: remoteFileActions.renameRemotePath,
          onSelect: selectPath,
          onSelectAll: selectPaths,
          onUpload: remoteFileActions.uploadPath,
          onUploadDropped: remoteFileActions.uploadLocalPaths,
        }}
        history={{
          activeView: historyView,
          commandGroups,
          deduplicateHistory,
          entries: historyEntries,
          error: historyError,
          groupError: historyGroupError,
          groupLoading: historyGroupLoading,
          language: appSettings?.language ?? "zhCN",
          loading: historyLoading,
          query: historyQuery,
          historyScopeKind: activeHistoryScopeKind,
          historyScopeId: activeHistoryScopeId,
          onClear: () => {
            if (!activeHistoryScopeKind || !activeHistoryScopeId) return;
            void clearHistory(activeHistoryScopeKind, activeHistoryScopeId);
          },
          onDeleteEntries: async (entryIds) => {
            if (!activeHistoryScopeKind || !activeHistoryScopeId) return;
            await deleteHistoryEntries(activeHistoryScopeKind, activeHistoryScopeId, entryIds);
            await searchHistory({
              query: historyQuery,
              scopeKind: activeHistoryScopeKind,
              scopeId: activeHistoryScopeId,
              deduplicate: deduplicateHistory,
            });
          },
          onCopy: (command) => void navigator.clipboard?.writeText(command),
          onDeleteCommandGroup: (groupId) => deleteCommandGroup(groupId),
          onDeduplicateHistoryChange: setDeduplicateHistory,
          onQueryChange: setHistoryQuery,
          onSaveCommandGroup: (draft) => saveCommandGroup(draft),
          onSearch: (options) => {
            if (!activeHistoryScopeKind || !activeHistoryScopeId) return;
            void searchHistory({
              query: historyQuery,
              scopeKind: activeHistoryScopeKind,
              scopeId: activeHistoryScopeId,
              deduplicate: options?.deduplicate ?? deduplicateHistory,
            });
          },
          onSend: (command) => terminalActions.sendCommand(command),
          onViewChange: setHistoryView,
        }}
        monitor={{
          target: activeSavedSession?.type === "ssh"
            ? {
                kind: "ssh",
                id: activeSavedSession.id,
                name: activeSavedSession.name,
                host: activeSavedSession.host,
                port: activeSavedSession.port,
                username: activeSavedSession.username,
              }
            : !activeRuntimeInfo || activeRuntimeInfo.kind === "local"
              ? {
                  kind: "local",
                  id: LOCAL_SERVER_INFO_TARGET_ID,
                  name: "本机",
                  host: "localhost",
                  port: 0,
                  username: "",
                }
              : null,
        }}
        containers={{
          enabled: activeSshContainersEnabled,
          editableRuntime: Boolean(activeExternalSshSession),
          runtime: activeExternalSshOptions?.container?.runtime ?? activeSavedSession?.ssh_options?.container?.runtime ?? null,
          sessionName: activeSavedSession?.type === "ssh" ? activeSavedSession.name : activeExternalSshSession?.name ?? null,
          target: activeSavedSession?.type === "ssh"
            ? `${activeSavedSession.username}@${activeSavedSession.host}:${activeSavedSession.port}`
            : activeExternalSshSession
              ? `${activeExternalSshSession.username}@${activeExternalSshSession.host}:${activeExternalSshSession.port}`
              : null,
          items: containerPanelState.items,
          loading: containerPanelState.loading,
          error: containerPanelState.error,
          onEnter: enterSshContainer,
          onStart: startStoppedSshContainer,
          onRefresh: refreshActiveSshContainers,
          onRuntimeChange: changeExternalContainerRuntime,
        }}
        tunnels={{
          canManage: Boolean(activeSshSessionId) && !activeExternalSshSession,
          canCreate: true,
          editable: Boolean(activeExternalSshSession),
          needsReconnect: activeSshSessionId ? Boolean(sshTunnelNeedsReconnectBySessionId[activeSshSessionId]) : false,
          sessionName: activeSavedSession?.type === "ssh" ? activeSavedSession.name : activeExternalSshSession?.name ?? null,
          target: activeSavedSession?.type === "ssh"
            ? `${activeSavedSession.username}@${activeSavedSession.host}:${activeSavedSession.port}`
            : activeExternalSshSession
              ? `${activeExternalSshSession.username}@${activeExternalSshSession.host}:${activeExternalSshSession.port}`
              : null,
          items: activeSshTunnels,
          onEdit: () => {
            if (activeExternalSshSession) setExternalSshTunnelEditor(activeExternalSshSession.id);
          },
          onCreate: () => openActiveSshTunnelEditor("create"),
          onDeleteTunnel: requestDeleteActiveSshTunnel,
          onEditTunnel: (index) => openActiveSshTunnelEditor("edit", index),
          onReconnect: reconnectActiveSsh,
        }}
        transfers={{
          tasks: transfers,
          onCancel: (taskId) => void cancelTransfer(taskId),
          onDelete: (taskId) => void deleteTransfer(taskId),
          onPause: (taskId) => void pauseTransfer(taskId),
          onRetry: (taskId) => void retryTransfer(taskId),
          onResume: (taskId) => void resumeTransfer(taskId),
        }}
        language={language}
      />
    </div>
  );
}
