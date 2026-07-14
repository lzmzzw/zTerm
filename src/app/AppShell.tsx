// Author: Liz
import { ArrowLeftRight, Bot, FolderPlus, LayoutGrid, PanelsTopLeft, Terminal } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  AppTextInputDialog,
  AppTransferConflictDialog,
  ConnectionPickerDialog,
  type ConnectionChoice,
} from "./AppShellDialogs";
import { RightToolsPanel } from "./RightToolsPanel";
import { PanelHeader, ToolButton } from "./ShellControls";
import { TitleBar } from "./TitleBar";
import { WorkspaceStage } from "./WorkspaceStage";
import { createRemoteFileActions } from "./remoteFileActions";
import { createTerminalActions } from "./terminalActions";
import type { RightTool } from "./rightTools";
import { useAppShortcutKeys } from "./useAppShortcutKeys";
import { useAppTextInputDialog } from "./useAppTextInputDialog";
import { ZtCenteredPageLayout, ZtConfirmDialog, ZtModalOverlay, ZtSurfaceFrame } from "../components/ZtUi";
import { setAiAffectedDomainsHandler, useAiStore } from "../features/ai/aiStore";
import { buildAiTerminalContext } from "../features/ai/aiTerminalContextModel";
import { FileTransferDialog } from "../features/files/FileTransferDialog";
import { useFileStore, type TransferConflict, type TransferConflictPolicy } from "../features/files/fileStore";
import type { CommandHistoryView } from "../features/history/CommandHistoryPanel";
import { resolveHistoryScope } from "../features/history/historyScopeModel";
import { useHistoryStore } from "../features/history/historyStore";
import { ModelManagerPanel } from "../features/models/ModelManagerPanel";
import { SessionTree } from "../features/sessions/SessionTree";
import { SessionGroupDialog } from "../features/sessions/SessionTreeDialogs";
import { useSessionStore } from "../features/sessions/sessionStore";
import { SshTunnelsSection } from "../features/sessions/SshTunnelsSection";
import type { SshOptions, SshTunnelMode } from "../features/sessions/types";
import { SettingsPage } from "../features/settings/SettingsPage";
import { applyAppSettings } from "../features/settings/applyAppSettings";
import { useDomI18n } from "../features/settings/domI18n";
import { useSettingsStore } from "../features/settings/settingsStore";
import { listSshContainers, type SshContainerInfo } from "../features/terminal/sshContainerApi";
import {
  externalSshChannelPolicy,
  externalSshHostServiceTarget,
  getExternalSshOptions,
  isExternalSessionId,
  takePendingExternalLaunches,
  updateExternalSshOptions,
  type ExternalSshLaunchEvent,
} from "../features/terminal/externalLaunchApi";
import { useTerminalStore } from "../features/terminal/terminalStore";
import { WorkspaceManagerPanel } from "../features/workspace/WorkspaceManagerPanel";
import { WorkspacePreviewDialog } from "../features/workspace/WorkspacePreviewDialog";
import { definitionFromDraft } from "../features/workspace/workspacePreviewModel";
import { workspaceGet, workspaceList, workspaceRemove, workspaceSave } from "../features/workspace/workspacePersistence";
import { findPane, getActiveTerminalTab } from "../features/workspace/workspaceLayout";
import { markWorkspaceRestoreQueued, runWorkspaceRestoreQueue } from "../features/workspace/workspaceRestoreScheduler";
import { DEFAULT_WORKSPACE_ID } from "../features/workspace/workspaceConstants";
import {
  isReusableConnectionTab,
  mergeWorkspaceSidebarItems,
  nextWorkspaceSortOrder,
  type WorkspaceSidebarItem,
} from "../features/workspace/workspaceShellModel";
import { useWorkspaceStore } from "../features/workspace/workspaceStore";
import type {
  WorkspaceDefinition,
  WorkspaceDefinitionDraft,
  WorkspaceSummary,
} from "../features/workspace/types";
import { scheduleIdleTask } from "../lib/renderScheduling";
import { fallbackOnlyErrorMessage, unknownErrorMessage } from "../lib/unknownErrorMessage";

type LeftTool = "workspace" | "sessions" | "models";

type ConnectionDialogTarget = {
  workspaceId: string;
  workspaceTabId: string;
  paneId: string;
};

type WorkspaceEditorState = {
  mode: "create" | "edit";
  workspace: WorkspaceDefinition;
};

type TransferConflictDialogState = {
  conflicts: TransferConflict[];
  resolve: (policy: TransferConflictPolicy | null) => void;
};

type ZtermToolActionEvent = {
  action: string;
  arguments?: Record<string, unknown> | null;
  affected_domains?: string[];
};

const EMPTY_AI_PANEL_STATE = {
  aiConversations: [],
  aiConversationPreviews: {},
  activeConversationId: null,
  aiApprovalMode: "safe" as const,
  aiMessages: [],
  aiPendingInvocations: [],
  aiContextSnapshot: null,
  agentLoading: false,
  agentError: null,
};

const EMPTY_FILE_PANEL_STATE = {
  fileEntries: [],
  filePath: "/",
  selectedPaths: [],
  filesLoading: false,
  fileError: null,
};

const EMPTY_TRANSFER_PANEL_STATE = {
  transfers: [],
};

const EMPTY_CONTAINER_PANEL_STATE = {
  items: [] as SshContainerInfo[],
  loading: false,
  error: null as string | null,
};

const DEFAULT_EXTERNAL_SSH_OPTIONS: SshOptions = {
  connect_timeout_ms: null,
  keepalive_interval_ms: null,
  proxy_command: null,
  identity_file: null,
  jump_hosts: [],
  tunnels: [],
  container: {
    enabled: true,
    runtime: "docker",
    container: "",
    shell: "/bin/sh",
    user: null,
    workdir: null,
  },
};

const EMPTY_HISTORY_PANEL_STATE = {
  historyEntries: [],
  commandGroups: [],
  historyLoading: false,
  historyError: null,
  historyGroupLoading: false,
  historyGroupError: null,
};

const EMPTY_WORKSPACE_SIDEBAR_STATE = {
  workspaceDefinitions: {} as Record<string, WorkspaceDefinition>,
};

function readString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

function rightToolFromValue(value: string | null | undefined): RightTool | null {
  if (!value) return null;
  const normalized = value.trim();
  if (["agent", "files", "history", "monitor", "tunnels", "containers"].includes(normalized)) {
    return normalized as RightTool;
  }
  return null;
}

export function AppShell() {
  const {
    groups,
    sessions,
    sessionError,
    loadSessions,
    saveGroup,
    saveSession,
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
      testSession: state.testSession,
      deleteGroup: state.deleteGroup,
      deleteSession: state.deleteSession,
    })),
  );
  const {
    appSettings,
    providers,
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
    saveProvider,
    deleteProvider,
    startProviderDraftTestStream,
    cancelProviderDraftTest,
    detectTerminalProfiles,
    setDefaultTerminalProfile,
    setMcpEnabled,
    rotateMcpToken,
  } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      providers: state.providers,
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
      saveProvider: state.saveProvider,
      deleteProvider: state.deleteProvider,
      startProviderDraftTestStream: state.startProviderDraftTestStream,
      cancelProviderDraftTest: state.cancelProviderDraftTest,
      detectTerminalProfiles: state.detectTerminalProfiles,
      setDefaultTerminalProfile: state.setDefaultTerminalProfile,
      setMcpEnabled: state.setMcpEnabled,
      rotateMcpToken: state.rotateMcpToken,
    })),
  );
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [sessionFolderDialogOpen, setSessionFolderDialogOpen] = useState(false);
  const [fileTransferDialogOpen, setFileTransferDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"workbench" | "settings">("workbench");
  const [activeLeftTool, setActiveLeftTool] = useState<LeftTool | null>(null);
  const [activeTool, setActiveTool] = useState<RightTool | null>(null);
  const [containerPanelState, setContainerPanelState] = useState(EMPTY_CONTAINER_PANEL_STATE);
  const [workspaceSummaries, setWorkspaceSummaries] = useState<WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [workspaceEditor, setWorkspaceEditor] = useState<WorkspaceEditorState | null>(null);
  const [pendingRestoreWorkspace, setPendingRestoreWorkspace] = useState<WorkspaceSidebarItem | null>(null);
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<WorkspaceSidebarItem | null>(null);
  const [externalSshSessions, setExternalSshSessions] = useState<Record<string, ExternalSshLaunchEvent>>({});
  const { textInputDialog, requestTextInput, resolveTextInputDialog } = useAppTextInputDialog();
  const [transferConflictDialog, setTransferConflictDialog] = useState<TransferConflictDialogState | null>(null);
  const [connectionDialogTarget, setConnectionDialogTarget] = useState<ConnectionDialogTarget | null>(null);
  const [connectionDialogError, setConnectionDialogError] = useState<string | null>(null);
  const [connectionOpening, setConnectionOpening] = useState(false);
  const [externalSshOptionsById, setExternalSshOptionsById] = useState<Record<string, SshOptions>>({});
  const [externalSshTunnelEditor, setExternalSshTunnelEditor] = useState<string | null>(null);
  const [externalSshTunnelNeedsReconnect, setExternalSshTunnelNeedsReconnect] = useState<Record<string, boolean>>({});
  const restoringWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const workspaceRestoreEpochRef = useRef(0);
  const processedExternalLaunchIdsRef = useRef<Set<string>>(new Set());
  const workspaceSummaryIdsRef = useRef<Set<string>>(new Set());
  const activeContextTokenRef = useRef(0);
  const [historyView, setHistoryView] = useState<CommandHistoryView>("history");
  const [deduplicateHistory, setDeduplicateHistory] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const {
    loadConversations,
    loadPendingInvocations,
    captureContext,
    sendChat,
    cancelChat,
    setApprovalMode,
    selectConversation,
    loadConversationPreview,
    newConversation,
    deleteConversation,
    confirmTool,
  } = useAiStore(
    useShallow((state) => ({
      loadConversations: state.loadConversations,
      loadPendingInvocations: state.loadPendingInvocations,
      captureContext: state.captureContext,
      sendChat: state.sendChat,
      cancelChat: state.cancelChat,
      setApprovalMode: state.setApprovalMode,
      selectConversation: state.selectConversation,
      loadConversationPreview: state.loadConversationPreview,
      newConversation: state.newConversation,
      deleteConversation: state.deleteConversation,
      confirmTool: state.confirmTool,
    })),
  );
  const {
    aiConversations,
    aiConversationPreviews,
    activeConversationId,
    aiApprovalMode,
    aiMessages,
    aiPendingInvocations,
    aiContextSnapshot,
    agentLoading,
    agentError,
  } = useAiStore(
    useShallow((state) =>
      activeTool === "agent"
        ? {
            aiConversations: state.conversations,
            aiConversationPreviews: state.conversationPreviews,
            activeConversationId: state.activeConversationId,
            aiApprovalMode: state.approvalMode,
            aiMessages: state.messages,
            aiPendingInvocations: state.pendingInvocations,
            aiContextSnapshot: state.contextSnapshot,
            agentLoading: state.loading,
            agentError: state.error,
          }
        : EMPTY_AI_PANEL_STATE,
    ),
  );
  const {
    setPath: setFilePath,
    selectPath,
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
    loadCommandGroups,
    saveCommandGroup,
    deleteCommandGroup,
  } = useHistoryStore(
    useShallow((state) => ({
      searchHistory: state.searchHistory,
      clearHistory: state.clearHistory,
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
    activeWorkspaceId,
    tabs,
    activeTabId,
  } = useWorkspaceStore(
    useShallow((state) => ({
      activeWorkspaceId: state.activeWorkspaceId,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    })),
  );
  const { workspaceDefinitions } = useWorkspaceStore(
    useShallow((state) =>
      activeLeftTool === "workspace"
        ? {
            workspaceDefinitions: state.workspaceDefinitions,
          }
        : EMPTY_WORKSPACE_SIDEBAR_STATE,
    ),
  );
  const {
    cacheWorkspaceDefinition,
    loadCachedWorkspaceDefinition,
    prefetchWorkspaceDefinitions,
    buildActiveWorkspaceDraft,
    restoreWorkbenchDefinition,
    clearRuntimeSession,
    getWorkspaceRuntimeSessionIds,
    removeWorkspace,
    updatePaneTerminalTab,
    selectTab,
    addPaneTab,
    addPaneTabAfter,
    closePaneTab,
    selectPaneTab,
    movePaneTab,
    setActivePane,
    bindRuntimeToPaneTab,
    splitActivePane,
    resizeSplitPane,
    closeActivePane,
  } = useWorkspaceStore(
    useShallow((state) => ({
      cacheWorkspaceDefinition: state.cacheWorkspaceDefinition,
      loadCachedWorkspaceDefinition: state.loadWorkspaceDefinition,
      prefetchWorkspaceDefinitions: state.prefetchWorkspaceDefinitions,
      buildActiveWorkspaceDraft: state.buildActiveWorkspaceDraft,
      restoreWorkbenchDefinition: state.restoreWorkbenchDefinition,
      clearRuntimeSession: state.clearRuntimeSession,
      getWorkspaceRuntimeSessionIds: state.getWorkspaceRuntimeSessionIds,
      removeWorkspace: state.removeWorkspace,
      updatePaneTerminalTab: state.updatePaneTerminalTab,
      selectTab: state.selectTab,
      addPaneTab: state.addPaneTab,
      addPaneTabAfter: state.addPaneTabAfter,
      closePaneTab: state.closePaneTab,
      selectPaneTab: state.selectPaneTab,
      movePaneTab: state.movePaneTab,
      setActivePane: state.setActivePane,
      bindRuntimeToPaneTab: state.bindRuntimeToPaneTab,
      splitActivePane: state.splitActivePane,
      resizeSplitPane: state.resizeSplitPane,
      closeActivePane: state.closeActivePane,
    })),
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activePane = activeTab ? findPane(activeTab.root, activeTab.active_pane_id) : null;
  const activeLeaf = activePane?.kind === "leaf" ? activePane : null;
  const activePaneTab = activeLeaf ? getActiveTerminalTab(activeLeaf) : null;
  const activeSavedSessionId = activePaneTab?.saved_session_id ?? null;
  const activeSavedSession = activeSavedSessionId ? sessions.find((session) => session.id === activeSavedSessionId) ?? null : null;
  const activeExternalSshSession =
    activeSavedSessionId && isExternalSessionId(activeSavedSessionId) ? (externalSshSessions[activeSavedSessionId] ?? null) : null;
  const activeExternalSshOptions = activeExternalSshSession
    ? (externalSshOptionsById[activeExternalSshSession.id] ?? DEFAULT_EXTERNAL_SSH_OPTIONS)
    : null;
  const activeExternalSshChannelPolicy = activeExternalSshSession
    ? externalSshChannelPolicy(activeExternalSshSession)
    : null;
  const activeExternalSshSingleChannel = activeExternalSshChannelPolicy === "single_channel";
  const activeSshSessionId = activeSavedSession?.type === "ssh" ? activeSavedSession.id : activeExternalSshSession?.id ?? null;
  const activeSshTunnels =
    activeSavedSession?.type === "ssh"
      ? (activeSavedSession.ssh_options?.tunnels ?? [])
      : (activeExternalSshOptions?.tunnels ?? []);
  const activeSshContainersEnabled =
    activeSavedSession?.type === "ssh"
      ? activeSavedSession.ssh_options?.container?.enabled === true
      : activeExternalSshOptions?.container?.enabled === true && !activeExternalSshSingleChannel;
  const activeRuntimeSessionId = activePaneTab?.runtime_session_id ?? null;
  const bindTerminalEvents = useTerminalStore((state) => state.bindTerminalEvents);
  const openTerminal = useTerminalStore((state) => state.openTerminal);
  const openSshContainerTerminal = useTerminalStore((state) => state.openSshContainerTerminal);
  const enterSshContainerRuntime = useTerminalStore((state) => state.enterSshContainerRuntime);
  const openDefaultLocalTerminal = useTerminalStore((state) => state.openDefaultLocalTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const getTerminalOutputTail = useTerminalStore((state) => state.getOutputTail);
  const activeRuntimeInfo = useTerminalStore((state) =>
    activeRuntimeSessionId ? (state.runtimes[activeRuntimeSessionId] ?? null) : null,
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
    savedSessionType: activeSavedSession?.type,
    savedSessionLocalProfileId: activeSavedSession?.local_options?.profile_id,
    defaultLocalProfileId: terminalProfiles.find((profile) => profile.is_default)?.id,
  });
  const activeHistoryScopeKind = activeHistoryScope.scopeKind;
  const activeHistoryScopeId = activeHistoryScope.scopeId;
  const language = appSettings?.language ?? "zhCN";
  const workspaceRestoreStrategy = appSettings?.workspace_restore_strategy ?? "visible_first";
  const recentTerminalOutput =
    activeTool === "agent" && activeRuntimeSessionId
      ? getTerminalOutputTail(activeRuntimeSessionId).slice(-4000)
      : "";
  const aiTerminalContext = useMemo(
    () => {
      if (!activeRuntimeSessionId) return null;
      return buildAiTerminalContext({
        runtimeSessionId: activeRuntimeSessionId,
        savedSessionId: activeSavedSessionId,
        paneId: activeTab?.active_pane_id ?? null,
        title: activePaneTab?.title ?? activePane?.id ?? null,
        cwd: activePaneTab?.path ?? null,
        recentOutput: recentTerminalOutput,
        activeTool,
      });
    },
    [
      activePane?.id,
      activePaneTab?.path,
      activePaneTab?.title,
      activeRuntimeSessionId,
      activeSavedSessionId,
      activeTab?.active_pane_id,
      activeTool,
      recentTerminalOutput,
    ],
  );

  useDomI18n(language);

  useEffect(() => {
    void loadSessions();
    void loadSettings();
    void loadConversations();
    void loadPendingInvocations();
    void refreshWorkspaceSummaries();
  }, [loadConversations, loadPendingInvocations, loadSessions, loadSettings]);

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
    if (activeTool === "tunnels" && activeSshTunnels.length === 0 && !activeExternalSshSession) {
      setActiveTool(null);
    }
  }, [activeExternalSshSession, activeSshTunnels.length, activeTool]);

  useEffect(() => {
    if (activeTool === "containers" && !activeSshContainersEnabled) {
      setActiveTool(null);
    }
  }, [activeSshContainersEnabled, activeTool]);

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

  useEffect(() => {
    if (activeTool !== "agent") {
      activeContextTokenRef.current += 1;
      return undefined;
    }

    const token = activeContextTokenRef.current + 1;
    activeContextTokenRef.current = token;
    const context = aiTerminalContext;
    if (!context) {
      activeContextTokenRef.current += 1;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (activeContextTokenRef.current !== token) return;
      void captureContext(context);
    }, 120);

    return () => {
      window.clearTimeout(timer);
      if (activeContextTokenRef.current === token) {
        activeContextTokenRef.current += 1;
      }
    };
  }, [
    aiTerminalContext,
    activeTool,
    captureContext,
  ]);

  useAppShortcutKeys(
    appSettings?.shortcuts ?? [],
    {
      activePaneId: activeLeaf?.id ?? null,
      activePaneTabId: activePaneTab?.id ?? null,
      newTabPaneId: activeTab?.active_pane_id ?? null,
    },
    {
      onOpenSettings: () => setViewMode("settings"),
      onAddTerminalTab: addPaneTab,
      onCloseTerminalTab: (paneId, paneTabId) => void closePaneTab(paneId, paneTabId),
      onSplitPane: splitActivePane,
      onToggleRightTool: toggleRightTool,
    },
  );

  useEffect(() => {
    setAiAffectedDomainsHandler((domains) => {
      void refreshAffectedDomains(domains);
    });
    return () => setAiAffectedDomainsHandler(null);
  });

  const handleExternalSshLaunch = useCallback(
    async (launch: ExternalSshLaunchEvent) => {
      if (!launch.id || processedExternalLaunchIdsRef.current.has(launch.id)) return;
      processedExternalLaunchIdsRef.current.add(launch.id);
      setExternalSshSessions((current) => ({ ...current, [launch.id]: launch }));
      setExternalSshOptionsById((current) => ({ ...current, [launch.id]: current[launch.id] ?? DEFAULT_EXTERNAL_SSH_OPTIONS }));

      const workspaceState = useWorkspaceStore.getState();
      const targetWorkspaceId = workspaceState.activeWorkspaceId;
      const targetWorkspaceTab = workspaceState.tabs.find((tab) => tab.id === workspaceState.activeTabId) ?? workspaceState.tabs[0];
      const targetPane = targetWorkspaceTab ? findPane(targetWorkspaceTab.root, targetWorkspaceTab.active_pane_id) : null;
      const targetLeaf = targetPane?.kind === "leaf" ? targetPane : null;
      const activeTargetPaneTab = targetLeaf ? getActiveTerminalTab(targetLeaf) : null;
      if (!targetWorkspaceTab || !targetLeaf || !activeTargetPaneTab) {
        setTerminalError("外部 SSH 连接无法定位目标分栏");
        return;
      }

      const targetPaneId = targetWorkspaceTab.active_pane_id;
      const targetPaneTab = isReusableConnectionTab(activeTargetPaneTab) ? activeTargetPaneTab : addPaneTab(targetPaneId);
      updatePaneTerminalTab(targetWorkspaceId, targetWorkspaceTab.id, targetPaneId, targetPaneTab.id, {
        title: launch.name,
        saved_session_id: launch.id,
        connection_source: "external_ssh",
        restore_status: "pending",
        restore_error: null,
      });

      setTerminalError(null);
      try {
        const runtime = await openTerminal(launch.id, targetPaneId);
        bindRuntimeToPaneTab(targetWorkspaceId, targetWorkspaceTab.id, targetPaneId, targetPaneTab.id, runtime);
        if (launch.auto_open_sftp) {
          const remotePath = launch.remote_path?.trim() || "/";
          setFilePath(remotePath);
          setActiveTool("files");
          await listFiles(launch.id, remotePath);
          await loadTransfers(launch.id);
        }
      } catch (error) {
        const message = fallbackOnlyErrorMessage(error, "打开外部 SSH 连接失败");
        updatePaneTerminalTab(targetWorkspaceId, targetWorkspaceTab.id, targetPaneId, targetPaneTab.id, {
          restore_status: "failed",
          restore_error: message,
        });
        setTerminalError(message);
      }
    },
    [addPaneTab, bindRuntimeToPaneTab, listFiles, loadTransfers, openTerminal, setFilePath, updatePaneTerminalTab],
  );

  const drainPendingExternalLaunches = useCallback(async () => {
    const launches = await takePendingExternalLaunches();
    for (const launch of launches) {
      await handleExternalSshLaunch(launch);
    }
  }, [handleExternalSshLaunch]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const drain = () =>
      drainPendingExternalLaunches().catch((error) => {
        if (!disposed) setTerminalError(fallbackOnlyErrorMessage(error, "读取外部启动请求失败"));
      });
    void listen("zterm:external-ssh-launch", () => {
      void drain();
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        cleanup = unlisten;
        void drain();
      })
      .catch((error) => {
        void drain();
        if (!disposed) setTerminalError(fallbackOnlyErrorMessage(error, "监听外部启动请求失败"));
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [drainPendingExternalLaunches]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void listen<ZtermToolActionEvent>("zterm:tool-action", (event) => {
      void handleZtermToolAction(event.payload);
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
  });

  async function refreshWorkspaceSummaries() {
    try {
      const summaries = await workspaceList();
      workspaceSummaryIdsRef.current = new Set(summaries.map((workspace) => workspace.id));
      setWorkspaceSummaries(summaries);
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "加载工作区失败"));
    }
  }

  async function refreshAffectedDomains(domains: string[]) {
    const domainSet = new Set(domains);
    if (domainSet.has("sessions")) {
      await loadSessions();
    }
    if (domainSet.has("models") || domainSet.has("settings") || domainSet.has("terminal")) {
      await loadSettings();
    }
    if (domainSet.has("workspace")) {
      await refreshWorkspaceSummaries();
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
      case "workspace.open_tool": {
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
          await terminalActions.openSession(session);
        }
        break;
      }
      case "workspace.restore": {
        const workspaceId = readString(args, "workspace_id");
        if (workspaceId) await handleRestoreWorkspace(workspaceId);
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

  function handleCreateWorkspace() {
    const initialDraft = buildActiveWorkspaceDraft();
    if (!initialDraft) {
      setWorkspaceActionError("当前没有可保存的工作区");
      return;
    }

    setWorkspaceActionError(null);
    setWorkspaceEditor({
      mode: "create",
      workspace: definitionFromDraft({
        ...initialDraft,
        id: null,
        name: "新建工作区",
        status: "closed",
        sort_order: nextWorkspaceSortOrder(workspaceSidebarItems),
      }),
    });
  }

  function handleSaveWorkspace(workspaceId: string) {
    const target = workspaceSidebarItems.find((workspace) => workspace.id === workspaceId);
    const currentDraft = buildActiveWorkspaceDraft();
    if (!target || !currentDraft) {
      setWorkspaceActionError("当前工作台或目标工作区不存在");
      return;
    }

    setWorkspaceActionError(null);
    setWorkspaceEditor({
      mode: "edit",
      workspace: definitionFromDraft({
        ...currentDraft,
        id: target.id,
        name: target.name,
        status: "closed",
        sort_order: target.sort_order,
      }),
    });
  }

  async function handleEditWorkspace(workspaceId: string) {
    setWorkspaceActionError(null);
    try {
      const definition = await resolveWorkspaceDefinition(workspaceId);
      setWorkspaceEditor({
        mode: "edit",
        workspace: definition,
      });
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "加载工作区编辑失败"));
    }
  }

  async function handleWorkspaceEditorSave(draft: WorkspaceDefinitionDraft) {
    setWorkspaceActionError(null);
    try {
      const mode = workspaceEditor?.mode ?? "edit";
      const saved = await workspaceSave(mode === "create" ? { ...draft, id: null } : draft);
      cacheWorkspaceDefinition(saved);
      if (mode === "create") {
        setSelectedWorkspaceId(saved.id);
      }
      setWorkspaceEditor(null);
      await refreshWorkspaceSummaries();
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "保存工作区失败"));
    }
  }

  function handleDeleteWorkspace(workspaceId: string) {
    setWorkspaceActionError(null);
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
      setWorkspaceActionError("默认工作区不能删除");
      return;
    }
    const workspace = workspaceSidebarItems.find((item) => item.id === workspaceId);
    if (!workspace) {
      setWorkspaceActionError("工作区不存在或已删除");
      return;
    }
    setPendingDeleteWorkspace(workspace);
  }

  async function confirmDeleteWorkspace() {
    const workspace = pendingDeleteWorkspace;
    if (!workspace) return;
    setWorkspaceActionError(null);
    if (workspace.id === DEFAULT_WORKSPACE_ID) {
      setWorkspaceActionError("默认工作区不能删除");
      setPendingDeleteWorkspace(null);
      return;
    }

    try {
      await workspaceRemove(workspace.id);
      setWorkspaceSummaries((summaries) => {
        const nextSummaries = summaries.filter((summary) => summary.id !== workspace.id);
        workspaceSummaryIdsRef.current = new Set(nextSummaries.map((summary) => summary.id));
        return nextSummaries;
      });
      removeWorkspace(workspace.id);
      if (selectedWorkspaceId === workspace.id) setSelectedWorkspaceId(null);
      setPendingDeleteWorkspace(null);
      await refreshWorkspaceSummaries();
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "删除工作区失败"));
    }
  }

  async function handleRestoreWorkspace(workspaceId: string) {
    setWorkspaceActionError(null);
    setSelectedWorkspaceId(workspaceId);
    if (restoringWorkspaceIdsRef.current.has(workspaceId)) return;
    const runtimeSessionIds = getWorkspaceRuntimeSessionIds(DEFAULT_WORKSPACE_ID);
    if (runtimeSessionIds.length > 0) {
      const workspace = workspaceSidebarItems.find((item) => item.id === workspaceId);
      if (!workspace) {
        setWorkspaceActionError("工作区不存在或已删除");
        return;
      }
      setPendingRestoreWorkspace(workspace);
      return;
    }
    await executeWorkspaceRestore(workspaceId);
  }

  async function confirmRestoreWorkspace() {
    const workspaceId = pendingRestoreWorkspace?.id;
    if (!workspaceId) return;
    setPendingRestoreWorkspace(null);
    await executeWorkspaceRestore(workspaceId);
  }

  async function closeCurrentWorkbenchRuntimes(): Promise<boolean> {
    const runtimeSessionIds = getWorkspaceRuntimeSessionIds(DEFAULT_WORKSPACE_ID);
    const closeResults = await Promise.allSettled(
      runtimeSessionIds.map((runtimeSessionId) => closeTerminal(runtimeSessionId)),
    );
    let failedReason: unknown = null;
    closeResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        clearRuntimeSession(runtimeSessionIds[index]);
      } else if (failedReason === null) {
        failedReason = result.reason;
      }
    });
    if (failedReason !== null) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(failedReason, "关闭当前工作台终端失败"));
      return false;
    }
    return true;
  }

  async function executeWorkspaceRestore(workspaceId: string) {
    if (restoringWorkspaceIdsRef.current.has(workspaceId)) return;
    const epoch = workspaceRestoreEpochRef.current + 1;
    workspaceRestoreEpochRef.current = epoch;
    restoringWorkspaceIdsRef.current.add(workspaceId);
    try {
      if (!(await closeCurrentWorkbenchRuntimes())) return;
      const definition = await resolveWorkspaceDefinition(workspaceId);
      if (workspaceRestoreEpochRef.current !== epoch) return;
      const queuedDefinition = markWorkspaceRestoreQueued({ ...definition, status: "running" as const });
      const workbenchDefinition: WorkspaceDefinition = {
        ...queuedDefinition,
        id: DEFAULT_WORKSPACE_ID,
        name: "默认工作区",
      };
      restoreWorkbenchDefinition(workbenchDefinition);
      await restoreWorkspaceTerminals(workbenchDefinition, epoch);
      if (workspaceRestoreEpochRef.current === epoch) await refreshWorkspaceSummaries();
    } catch (error) {
      if (workspaceRestoreEpochRef.current === epoch) {
        setWorkspaceActionError(fallbackOnlyErrorMessage(error, "恢复工作区失败"));
      }
    } finally {
      restoringWorkspaceIdsRef.current.delete(workspaceId);
    }
  }

  async function resolveWorkspaceDefinition(workspaceId: string): Promise<WorkspaceDefinition> {
    return loadCachedWorkspaceDefinition(workspaceId, workspaceGet);
  }

  async function restoreWorkspaceTerminals(workspace: WorkspaceDefinition, switchEpoch?: number) {
    await runWorkspaceRestoreQueue({
      workspace,
      sessions,
      strategy: workspaceRestoreStrategy,
      isCancelled: () => switchEpoch !== undefined && workspaceRestoreEpochRef.current !== switchEpoch,
      openTerminal,
      openDefaultLocalTerminal,
      openSshContainerTerminal,
      writeTerminal,
      closeTerminal,
      updatePaneTerminalTab,
    });
  }

  function handleRequestPaneConnection(paneId: string) {
    if (!activeTab) return;
    setActivePane(paneId);
    setConnectionDialogTarget({
      workspaceId: activeWorkspaceId,
      workspaceTabId: activeTab.id,
      paneId,
    });
    setConnectionDialogError(null);
  }

  async function handleCreatePaneConnection(choice: ConnectionChoice) {
    if (!connectionDialogTarget || connectionOpening) return;
    const target = connectionDialogTarget;
    const state = useWorkspaceStore.getState();
    const targetTab =
      state.activeWorkspaceId === target.workspaceId
        ? state.tabs.find((tab) => tab.id === target.workspaceTabId)
        : state.workspaces
            .find((workspace) => workspace.id === target.workspaceId)
            ?.tabs.find((tab) => tab.id === target.workspaceTabId);
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
      const runtime =
        choice.kind === "default_local"
          ? await openDefaultLocalTerminal(target.paneId)
          : await openTerminal(choice.session.id, target.paneId);
      bindRuntimeToPaneTab(target.workspaceId, target.workspaceTabId, target.paneId, targetPaneTab.id, runtime);
      setConnectionDialogTarget(null);
    } catch (openError) {
      const message = fallbackOnlyErrorMessage(openError, "打开终端失败");
      setConnectionDialogError(message);
      setTerminalError(message);
    } finally {
      setConnectionOpening(false);
    }
  }

  async function handleCloseActivePane() {
    closeActivePane();
  }

  function handleSplitPane(direction: "horizontal" | "vertical") {
    splitActivePane(direction);
  }

  function toggleRightTool(tool: RightTool) {
    setActiveTool((current) => (current === tool ? null : tool));
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
      setExternalSshTunnelNeedsReconnect((current) => ({ ...current, [sessionId]: true }));
      setExternalSshTunnelEditor(null);
    } catch (error) {
      setTerminalError(fallbackOnlyErrorMessage(error, "保存临时 SSH 隧道失败"));
    }
  }

  function reconnectActiveExternalSsh() {
    if (!activePaneTab?.runtime_session_id || !activePaneTab.saved_session_id) return;
    void terminalActions.reconnectTerminal(
      activeTab?.active_pane_id ?? "",
      activePaneTab.id,
      activePaneTab.saved_session_id,
      activePaneTab.runtime_session_id,
    );
    setExternalSshTunnelNeedsReconnect((current) => ({
      ...current,
      [activePaneTab.saved_session_id as string]: false,
    }));
  }

  async function enterSshContainer(container: SshContainerInfo) {
    const workspaceState = useWorkspaceStore.getState();
    const latestActiveTab = workspaceState.tabs.find((tab) => tab.id === workspaceState.activeTabId) ?? workspaceState.tabs[0];
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

    const targetWorkspaceId = workspaceState.activeWorkspaceId;
    const targetWorkspaceTabId = latestActiveTab.id;
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
    updatePaneTerminalTab(targetWorkspaceId, targetWorkspaceTabId, targetPaneId, targetPaneTab.id, {
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
      bindRuntimeToPaneTab(targetWorkspaceId, targetWorkspaceTabId, targetPaneId, targetPaneTab.id, runtime);
    } catch (error) {
      const message = fallbackOnlyErrorMessage(error, "进入容器失败");
      updatePaneTerminalTab(targetWorkspaceId, targetWorkspaceTabId, targetPaneId, targetPaneTab.id, {
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
    workbenchId: activeWorkspaceId,
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
    writeTerminal,
    activeRuntimeSessionId,
  });

  async function createSessionFolder(name: string) {
    setSessionActionError(null);
    try {
      await saveGroup({
        parent_id: null,
        name,
        expanded: true,
        sort_order: groups.length,
      });
      setSessionFolderDialogOpen(false);
    } catch (error) {
      setSessionActionError(fallbackOnlyErrorMessage(error, "保存文件夹失败"));
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

  const workspaceSidebarItems = useMemo(
    () => mergeWorkspaceSidebarItems(workspaceSummaries, workspaceDefinitions),
    [workspaceDefinitions, workspaceSummaries],
  );

  useEffect(() => {
    if (activeLeftTool !== "workspace") return;

    for (const workspace of workspaceSidebarItems) {
      if (workspace.preview_root) continue;
      void loadCachedWorkspaceDefinition(workspace.id, workspaceGet)
        .catch((error) => {
          if (!workspaceSummaryIdsRef.current.has(workspace.id)) return;
          setWorkspaceActionError(fallbackOnlyErrorMessage(error, "加载工作区缩略图失败"));
        });
    }
  }, [activeLeftTool, loadCachedWorkspaceDefinition, workspaceSidebarItems]);

  useEffect(() => {
    const recentClosedWorkspaceIds = [...workspaceSummaries]
      .filter(
        (workspace) =>
          workspace.id !== DEFAULT_WORKSPACE_ID &&
          workspace.status === "closed" &&
          !workspaceDefinitions[workspace.id],
      )
      .sort((left, right) => right.updated_at_ms - left.updated_at_ms)
      .slice(0, 3)
      .map((workspace) => workspace.id);
    if (recentClosedWorkspaceIds.length === 0) return undefined;
    return scheduleIdleTask(() => {
      void prefetchWorkspaceDefinitions(recentClosedWorkspaceIds, workspaceGet);
    });
  }, [prefetchWorkspaceDefinitions, workspaceDefinitions, workspaceSummaries]);

  if (viewMode === "settings") {
    return (
      <ZtCenteredPageLayout
        className="zt-workbench zt-workbench-settings"
        onContextMenu={(event) => event.preventDefault()}
      >
        <TitleBar />
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

  const workbenchClassName = [
    "zt-workbench",
    activeLeftTool ? "" : "zt-workbench-left-collapsed",
    activeTool ? "" : "zt-workbench-right-collapsed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={workbenchClassName} onContextMenu={(event) => event.preventDefault()}>
      <TitleBar />

      <aside
        className={
          activeLeftTool
            ? "zt-sidebar zt-sidebar-left zt-left-tools"
            : "zt-sidebar zt-sidebar-left zt-left-tools zt-left-tools-collapsed"
        }
        aria-label="左侧管理"
      >
        <nav className="zt-left-rail" aria-label="左侧管理切换">
          <ToolButton
            label="工作区"
            active={activeLeftTool === "workspace"}
            icon={<PanelsTopLeft size={16} aria-hidden="true" />}
            onClick={() => toggleLeftTool("workspace")}
          />
          <ToolButton
            label="会话"
            active={activeLeftTool === "sessions"}
            icon={<Terminal size={16} aria-hidden="true" />}
            onClick={() => toggleLeftTool("sessions")}
          />
          <ToolButton
            label="文件传输"
            active={fileTransferDialogOpen}
            icon={<ArrowLeftRight size={16} aria-hidden="true" />}
            onClick={() => setFileTransferDialogOpen((current) => !current)}
          />
          <ToolButton
            label="模型"
            active={activeLeftTool === "models"}
            icon={<Bot size={16} aria-hidden="true" />}
            onClick={() => toggleLeftTool("models")}
          />
          <ToolButton
            label="打开设置"
            active={false}
            className="zt-left-rail-settings"
            icon={<LayoutGrid size={16} aria-hidden="true" />}
            onClick={() => setViewMode("settings")}
          />
        </nav>

        {activeLeftTool ? (
          <div className="zt-left-tool-panel">
            {activeLeftTool === "workspace" ? (
              <WorkspaceManagerPanel
                workspaces={workspaceSidebarItems}
                sessions={sessions}
                selectedWorkspaceId={selectedWorkspaceId}
                error={workspaceActionError}
                onCreateWorkspace={handleCreateWorkspace}
                onSaveWorkspace={handleSaveWorkspace}
                onSelectWorkspace={setSelectedWorkspaceId}
                onClearWorkspaceSelection={() => setSelectedWorkspaceId(null)}
                onEditWorkspace={(workspaceId) => void handleEditWorkspace(workspaceId)}
                onRestoreWorkspace={(workspaceId) => void handleRestoreWorkspace(workspaceId)}
                onDeleteWorkspace={handleDeleteWorkspace}
              />
            ) : null}

            {activeLeftTool === "sessions" ? (
              <section className="zt-session-panel" aria-label="会话管理">
                <PanelHeader
                  title="Session"
                  action={
                    <button
                      type="button"
                      aria-label="添加文件夹"
                      title="添加文件夹"
                      onClick={() => setSessionFolderDialogOpen(true)}
                    >
                      <FolderPlus size={14} aria-hidden="true" />
                    </button>
                  }
                />
                {sessionError || sessionActionError ? (
                  <div className="zt-empty-line">{sessionError ?? sessionActionError}</div>
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
                  onOpenSession={terminalActions.openSession}
                />
              </section>
            ) : null}

            {activeLeftTool === "models" ? (
              <ModelManagerPanel
                providers={providers}
                loading={settingsLoading}
                error={settingsError}
                onSaveProvider={saveProvider}
                onDeleteProvider={deleteProvider}
                onStartProviderDraftTest={startProviderDraftTestStream}
                onCancelProviderDraftTest={cancelProviderDraftTest}
              />
            ) : null}
          </div>
        ) : null}
      </aside>

      {sessionFolderDialogOpen ? (
        <SessionGroupDialog
          title="新建组"
          initialName=""
          onCancel={() => setSessionFolderDialogOpen(false)}
          onSave={createSessionFolder}
        />
      ) : null}

      {fileTransferDialogOpen ? (
        <FileTransferDialog language={language} onClose={() => setFileTransferDialogOpen(false)} />
      ) : null}

      {workspaceEditor ? (
        <WorkspacePreviewDialog
          mode={workspaceEditor.mode}
          workspace={workspaceEditor.workspace}
          sessions={sessions}
          onCancel={() => setWorkspaceEditor(null)}
          onSave={(draft) => void handleWorkspaceEditorSave(draft)}
        />
      ) : null}

      {pendingDeleteWorkspace ? (
        <ZtConfirmDialog
          title="删除工作区"
          message={`确认删除工作区“${pendingDeleteWorkspace.name}”？删除后该工作区定义和布局快照将无法恢复。`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setPendingDeleteWorkspace(null)}
          onConfirm={() => void confirmDeleteWorkspace()}
        />
      ) : null}

      {pendingRestoreWorkspace ? (
        <ZtConfirmDialog
          title="恢复工作区"
          message={`恢复工作区“${pendingRestoreWorkspace.name}”将关闭当前工作台中的全部终端，是否继续？`}
          confirmLabel="确认恢复"
          onCancel={() => setPendingRestoreWorkspace(null)}
          onConfirm={() => void confirmRestoreWorkspace()}
        />
      ) : null}

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
          sessions={sessions}
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
          singleChannel={externalSshChannelPolicy(externalSshSessions[externalSshTunnelEditor] ?? null) === "single_channel"}
          onCancel={() => setExternalSshTunnelEditor(null)}
          onSave={(options) => void saveExternalTunnelOptions(externalSshTunnelEditor, options)}
        />
      ) : null}

      <main className="zt-main">
        {terminalError ? <div className="zt-terminal-error">{terminalError}</div> : null}
        <WorkspaceStage
          onActivatePane={setActivePane}
          onAddPaneTab={handleRequestPaneConnection}
          onSelectPaneTab={selectPaneTab}
          onClosePaneTab={(paneId, paneTabId) => closePaneTab(paneId, paneTabId)}
          onMovePaneTab={movePaneTab}
          onSplitPane={handleSplitPane}
          onResizeSplit={resizeSplitPane}
          onClosePane={() => void handleCloseActivePane()}
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
        agent={{
          activeRuntimeSessionId,
          activePaneId: activeTab?.active_pane_id ?? null,
          activePaneTitle: activeRuntimeSessionId ? (activePaneTab?.title ?? activePane?.id ?? null) : null,
          activeSavedSessionId,
          approvalMode: aiApprovalMode,
          error: agentError,
          loading: agentLoading,
          providersAvailable: providers.some((provider) => provider.enabled),
          recentTerminalOutput,
          conversations: aiConversations,
          conversationPreviews: aiConversationPreviews,
          activeConversationId,
          messages: aiMessages,
          contextSnapshot: aiContextSnapshot,
          pendingInvocations: aiPendingInvocations,
          language: appSettings?.language ?? "zhCN",
          onApprovalModeChange: setApprovalMode,
          onConfirmTool: confirmTool,
          onDeleteConversation: deleteConversation,
          onLoadConversationPreview: loadConversationPreview,
          onNewConversation: newConversation,
          onSelectConversation: selectConversation,
          onSendChat: (message) => sendChat(message, aiTerminalContext),
          onCancelChat: cancelChat,
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
          onSend: (command) => void terminalActions.sendCommand(command),
          onViewChange: setHistoryView,
        }}
        monitor={{
          target: activeSavedSession?.type === "ssh"
            ? {
                id: activeSavedSession.id,
                name: activeSavedSession.name,
                host: activeSavedSession.host,
                port: activeSavedSession.port,
                username: activeSavedSession.username,
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
          onRefresh: refreshActiveSshContainers,
          onRuntimeChange: changeExternalContainerRuntime,
        }}
        tunnels={{
          editable: Boolean(activeExternalSshSession),
          needsReconnect: activeExternalSshSession ? Boolean(externalSshTunnelNeedsReconnect[activeExternalSshSession.id]) : false,
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
          onReconnect: reconnectActiveExternalSsh,
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
        onActiveToolChange={toggleRightTool}
      />
    </div>
  );
}

function ExternalSshTunnelEditorDialog({
  host,
  hostServiceTargetHost,
  initialOptions,
  singleChannel,
  onCancel,
  onSave,
}: {
  host: string;
  hostServiceTargetHost: string;
  initialOptions: SshOptions;
  singleChannel: boolean;
  onCancel: () => void;
  onSave: (options: SshOptions) => void;
}) {
  const [sshOptions, setSshOptions] = useState<SshOptions>(initialOptions);
  const [newTunnelMode, setNewTunnelMode] = useState<SshTunnelMode>("host_service");

  return (
    <ZtModalOverlay className="zt-session-modal-backdrop">
      <ZtSurfaceFrame
        className="zt-session-dialog zt-session-editor-dialog zt-transient-tunnel-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="临时 SSH 隧道"
      >
        <header>
          <strong>临时 SSH 隧道</strong>
          <button type="button" aria-label="关闭临时 SSH 隧道编辑" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="zt-session-editor-body zt-transient-tunnel-body">
          <div className="zt-session-editor-fields zt-transient-tunnel-fields">
            <SshTunnelsSection
              sshOptions={sshOptions}
              host={host}
              hostServiceTargetHost={hostServiceTargetHost}
              hostServiceTargetEditable={true}
              maxTunnels={singleChannel ? 1 : undefined}
              maxTunnelsMessage={singleChannel ? "单通道临时 SSH 只支持一个隧道" : undefined}
              allowedModes={singleChannel ? ["host_service"] : undefined}
              newTunnelMode={newTunnelMode}
              onNewTunnelModeChange={setNewTunnelMode}
              onSshOptionsChange={setSshOptions}
            />
          </div>
        </div>
        <div className="zt-session-editor-messages" aria-live="polite">
          <p className="zt-settings-status">临时隧道保存后需要重连当前 SSH 才会生效。</p>
        </div>
        <footer>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" aria-label="保存临时隧道" onClick={() => onSave(sshOptions)}>
            保存临时隧道
          </button>
        </footer>
      </ZtSurfaceFrame>
    </ZtModalOverlay>
  );
}
