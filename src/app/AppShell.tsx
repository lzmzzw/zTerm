// Author: Liz
import { ArrowLeftRight, Bot, FolderPlus, LayoutGrid, PanelsTopLeft, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { useWorkspaceVisualSwitch } from "./useWorkspaceVisualSwitch";
import { ZtConfirmDialog } from "../components/ZtUi";
import { useAiStore } from "../features/ai/aiStore";
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
import { SettingsPage } from "../features/settings/SettingsPage";
import { applyAppSettings } from "../features/settings/applyAppSettings";
import { useDomI18n } from "../features/settings/domI18n";
import { useSettingsStore } from "../features/settings/settingsStore";
import { listSshContainers, type SshContainerInfo } from "../features/terminal/sshContainerApi";
import { useTerminalStore } from "../features/terminal/terminalStore";
import { SplitPaneView } from "../features/workspace/SplitPaneView";
import { WorkspaceManagerPanel } from "../features/workspace/WorkspaceManagerPanel";
import { WorkspacePreviewDialog } from "../features/workspace/WorkspacePreviewDialog";
import { definitionFromDraft } from "../features/workspace/workspacePreviewModel";
import { workspaceDelete, workspaceGet, workspaceList, workspaceRemove, workspaceSave } from "../features/workspace/workspacePersistence";
import { findPane, getActiveTerminalTab } from "../features/workspace/workspaceLayout";
import { markWorkspaceRestoreQueued, runWorkspaceRestoreQueue } from "../features/workspace/workspaceRestoreScheduler";
import { DEFAULT_WORKSPACE_ID } from "../features/workspace/workspaceConstants";
import {
  definitionFromRuntime,
  hasRuntimeTabs,
  isReusableConnectionTab,
  mergeWorkspaceSidebarItems,
  nextWorkspaceSortOrder,
  type WorkspaceSidebarItem,
} from "../features/workspace/workspaceShellModel";
import { useWorkspaceStore } from "../features/workspace/workspaceStore";
import type {
  WorkspaceDefinition,
  WorkspaceDefinitionDraft,
  WorkspaceRuntime,
  WorkspaceSummary,
} from "../features/workspace/types";
import { scheduleAfterPaintDelay, scheduleIdleTask } from "../lib/renderScheduling";
import { fallbackOnlyErrorMessage } from "../lib/unknownErrorMessage";

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

const DEFAULT_MAX_RUNNING_WORKSPACES = 5;

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

const EMPTY_HISTORY_PANEL_STATE = {
  historyEntries: [],
  commandGroups: [],
  historyLoading: false,
  historyError: null,
  historyGroupLoading: false,
  historyGroupError: null,
};

const EMPTY_WORKSPACE_SIDEBAR_STATE = {
  workspaceRuntimes: [] as WorkspaceRuntime[],
  workspaceDefinitions: {} as Record<string, WorkspaceDefinition>,
};

export function AppShell() {
  const {
    workspaceSwitchOverlay,
    workspaceVisualSwitchActive,
    beginWorkspaceVisualSwitch,
    isWorkspaceSwitchEpochCurrent,
    markWorkspaceSwitchMetric,
    startWorkspaceSwitchMetrics,
  } = useWorkspaceVisualSwitch();
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
    settingsLoading,
    settingsError,
    loadSettings,
    saveAppSettings,
    resetAppSettingsSection,
    saveCredential,
    readCredentialSecret,
    saveProvider,
    deleteProvider,
    testProviderDraft,
    detectTerminalProfiles,
    setDefaultTerminalProfile,
  } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      providers: state.providers,
      terminalProfiles: state.terminalProfiles,
      shortcutDefinitions: state.shortcutDefinitions,
      settingsLoading: state.loading,
      settingsError: state.error,
      loadSettings: state.loadSettings,
      saveAppSettings: state.saveAppSettings,
      resetAppSettingsSection: state.resetAppSettingsSection,
      saveCredential: state.saveCredential,
      readCredentialSecret: state.readCredentialSecret,
      saveProvider: state.saveProvider,
      deleteProvider: state.deleteProvider,
      testProviderDraft: state.testProviderDraft,
      detectTerminalProfiles: state.detectTerminalProfiles,
      setDefaultTerminalProfile: state.setDefaultTerminalProfile,
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
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  const [workspaceEditor, setWorkspaceEditor] = useState<WorkspaceEditorState | null>(null);
  const [pendingDeleteWorkspace, setPendingDeleteWorkspace] = useState<WorkspaceSidebarItem | null>(null);
  const { textInputDialog, requestTextInput, resolveTextInputDialog } = useAppTextInputDialog();
  const [transferConflictDialog, setTransferConflictDialog] = useState<TransferConflictDialogState | null>(null);
  const [connectionDialogTarget, setConnectionDialogTarget] = useState<ConnectionDialogTarget | null>(null);
  const [connectionDialogError, setConnectionDialogError] = useState<string | null>(null);
  const [connectionOpening, setConnectionOpening] = useState(false);
  const restoringWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const autoClosingWorkspaceIdsRef = useRef<Set<string>>(new Set());
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
  const {
    workspaceRuntimes,
    workspaceDefinitions,
  } = useWorkspaceStore(
    useShallow((state) =>
      activeLeftTool === "workspace"
        ? {
            workspaceRuntimes: state.workspaces,
            workspaceDefinitions: state.workspaceDefinitions,
          }
        : EMPTY_WORKSPACE_SIDEBAR_STATE,
    ),
  );
  const runningWorkspaceCapWorkspaces = useWorkspaceStore((state) => state.workspaces);
  const {
    selectWorkspace,
    selectDefaultWorkspace,
    migrateActiveWorkspaceToSavedWorkspace,
    upsertWorkspaceDefinition,
    updateWorkspaceRuntimeMetadata,
    freezeWorkspaceRuntimeVisualSnapshots,
    cacheWorkspaceDefinition,
    loadCachedWorkspaceDefinition,
    prefetchWorkspaceDefinitions,
    buildActiveWorkspaceDraft,
    getWorkspaceRuntimeSessionIds,
    closeWorkspaceRuntime,
    removeWorkspace,
    updatePaneTerminalTab,
    selectTab,
    addPaneTab,
    addPaneTabAfter,
    closePaneTab,
    selectPaneTab,
    setActivePane,
    bindRuntimeToPaneTab,
    splitActivePane,
    resizeSplitPane,
    closeActivePane,
  } = useWorkspaceStore(
    useShallow((state) => ({
      selectWorkspace: state.selectWorkspace,
      selectDefaultWorkspace: state.selectDefaultWorkspace,
      migrateActiveWorkspaceToSavedWorkspace: state.migrateActiveWorkspaceToSavedWorkspace,
      upsertWorkspaceDefinition: state.upsertWorkspaceDefinition,
      updateWorkspaceRuntimeMetadata: state.updateWorkspaceRuntimeMetadata,
      freezeWorkspaceRuntimeVisualSnapshots: state.freezeWorkspaceRuntimeVisualSnapshots,
      cacheWorkspaceDefinition: state.cacheWorkspaceDefinition,
      loadCachedWorkspaceDefinition: state.loadWorkspaceDefinition,
      prefetchWorkspaceDefinitions: state.prefetchWorkspaceDefinitions,
      buildActiveWorkspaceDraft: state.buildActiveWorkspaceDraft,
      getWorkspaceRuntimeSessionIds: state.getWorkspaceRuntimeSessionIds,
      closeWorkspaceRuntime: state.closeWorkspaceRuntime,
      removeWorkspace: state.removeWorkspace,
      updatePaneTerminalTab: state.updatePaneTerminalTab,
      selectTab: state.selectTab,
      addPaneTab: state.addPaneTab,
      addPaneTabAfter: state.addPaneTabAfter,
      closePaneTab: state.closePaneTab,
      selectPaneTab: state.selectPaneTab,
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
  const activeSshSessionId = activeSavedSession?.type === "ssh" ? activeSavedSession.id : null;
  const activeSshTunnels = activeSavedSession?.type === "ssh" ? (activeSavedSession.ssh_options?.tunnels ?? []) : [];
  const activeSshContainersEnabled =
    activeSavedSession?.type === "ssh" && activeSavedSession.ssh_options?.container?.enabled === true;
  const activeRuntimeSessionId = activePaneTab?.runtime_session_id ?? null;
  const bindTerminalEvents = useTerminalStore((state) => state.bindTerminalEvents);
  const openTerminal = useTerminalStore((state) => state.openTerminal);
  const openSshContainerTerminal = useTerminalStore((state) => state.openSshContainerTerminal);
  const openDefaultLocalTerminal = useTerminalStore((state) => state.openDefaultLocalTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const activeRuntimeInfo = useTerminalStore((state) =>
    activeRuntimeSessionId ? (state.runtimes[activeRuntimeSessionId] ?? null) : null,
  );
  const activeRuntimeInputSerial = useTerminalStore((state) =>
    activeTool === "history" && !workspaceVisualSwitchActive && activeRuntimeSessionId
      ? (state.inputSerialByRuntime[activeRuntimeSessionId] ?? 0)
      : 0,
  );
  const activeTerminalOutput = useTerminalStore((state) =>
    activeTool === "agent" && !workspaceVisualSwitchActive && activeRuntimeSessionId
      ? (state.output[activeRuntimeSessionId] ?? "")
      : "",
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
  const recentTerminalOutput = activeTerminalOutput.slice(-4000);
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
    if (workspaceVisualSwitchActive) return;
    if (activeTool === "files" && activeSshSessionId) {
      void listFiles(activeSshSessionId, filePath);
      return;
    }
    if (activeTool === "files") {
      clearFiles();
    }
  }, [activeSshSessionId, activeTool, clearFiles, filePath, listFiles, workspaceVisualSwitchActive]);

  useEffect(() => {
    if (activeTool === "tunnels" && activeSshTunnels.length === 0) {
      setActiveTool(null);
    }
  }, [activeSshTunnels.length, activeTool]);

  useEffect(() => {
    if (activeTool === "containers" && !activeSshContainersEnabled) {
      setActiveTool(null);
    }
  }, [activeSshContainersEnabled, activeTool]);

  useEffect(() => {
    if (workspaceVisualSwitchActive || activeTool !== "containers") return undefined;
    if (!activeSshContainersEnabled || !activeSshSessionId) {
      setContainerPanelState(EMPTY_CONTAINER_PANEL_STATE);
      return undefined;
    }

    let cancelled = false;
    void loadSshContainers(activeSshSessionId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [activeSshContainersEnabled, activeSshSessionId, activeTool, workspaceVisualSwitchActive]);

  useEffect(() => {
    if (workspaceVisualSwitchActive) {
      return;
    }
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
    workspaceVisualSwitchActive,
  ]);

  useEffect(() => {
    if (workspaceVisualSwitchActive) return;
    if (activeTool === "files") {
      void loadTransfers(activeSshSessionId);
    }
  }, [activeSshSessionId, activeTool, loadTransfers, workspaceVisualSwitchActive]);

  useEffect(() => {
    if (workspaceVisualSwitchActive || activeTool !== "agent") {
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
    workspaceVisualSwitchActive,
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

  async function refreshWorkspaceSummaries() {
    try {
      const summaries = await workspaceList();
      setWorkspaceSummaries(summaries);
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "加载工作区失败"));
    }
  }

  async function closeWorkspaceRuntimeForCap(workspaceId: string) {
    if (autoClosingWorkspaceIdsRef.current.has(workspaceId)) return;
    autoClosingWorkspaceIdsRef.current.add(workspaceId);
    try {
      const runtimeSessionIds = getWorkspaceRuntimeSessionIds(workspaceId);
      const closeResults = await Promise.allSettled(
        runtimeSessionIds.map((runtimeSessionId) => closeTerminal(runtimeSessionId)),
      );
      const failedClose = closeResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedClose) {
        setWorkspaceActionError(fallbackOnlyErrorMessage(failedClose.reason, "自动关闭后台工作区失败"));
        return;
      }
      closeWorkspaceRuntime(workspaceId);
    } finally {
      autoClosingWorkspaceIdsRef.current.delete(workspaceId);
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
        name: initialDraft.id === DEFAULT_WORKSPACE_ID ? "新建工作区" : `${initialDraft.name} 副本`,
        status: "closed",
        sort_order: nextWorkspaceSortOrder(workspaceSidebarItems),
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

  function freezeActiveWorkspaceBeforeSwitch(nextWorkspaceId: string) {
    const state = useWorkspaceStore.getState();
    const leavingWorkspaceId = state.activeWorkspaceId;
    if (!leavingWorkspaceId || leavingWorkspaceId === nextWorkspaceId) return;
    const leavingWorkspace = state.workspaces.find(
      (workspace) => workspace.id === leavingWorkspaceId && workspace.status === "running",
    );
    if (!leavingWorkspace) return;
    freezeWorkspaceRuntimeVisualSnapshots(
      leavingWorkspaceId,
      useTerminalStore.getState().visualOutputTail,
      Date.now(),
    );
  }

  async function handleSelectWorkspace(workspaceId: string) {
    if (workspaceId === activeWorkspaceId) {
      freezeActiveWorkspaceBeforeSwitch(DEFAULT_WORKSPACE_ID);
      selectDefaultWorkspace();
      return;
    }
    const runtime = workspaceRuntimes.find((workspace) => workspace.id === workspaceId);
    if (runtime?.status === "running") {
      startWorkspaceSwitchMetrics(workspaceId);
      freezeActiveWorkspaceBeforeSwitch(workspaceId);
      selectWorkspace(workspaceId);
      markWorkspaceSwitchMetric(workspaceId, "store_committed");
      scheduleAfterPaintDelay(() => {
        markWorkspaceSwitchMetric(workspaceId, "snapshot_visible");
        markWorkspaceSwitchMetric(workspaceId, "layout_visible");
        markWorkspaceSwitchMetric(workspaceId, "active_xterm_live");
        markWorkspaceSwitchMetric(workspaceId, "first_visible_connected");
        markWorkspaceSwitchMetric(workspaceId, "all_visible_connected");
        markWorkspaceSwitchMetric(workspaceId, "all_scheduled_done");
      }, 0);
      return;
    }
    await handleRestoreWorkspace(workspaceId);
  }

  async function handleWorkspaceEditorSave(draft: WorkspaceDefinitionDraft) {
    setWorkspaceActionError(null);
    try {
      const mode = workspaceEditor?.mode ?? "edit";
      const saved = await workspaceSave(mode === "create" ? { ...draft, id: null } : draft);
      cacheWorkspaceDefinition(saved);
      if (mode === "create") {
        migrateActiveWorkspaceToSavedWorkspace(saved);
      } else {
        updateWorkspaceRuntimeMetadata(saved);
      }
      setWorkspaceEditor(null);
      await refreshWorkspaceSummaries();
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "保存工作区失败"));
    }
  }

  async function closeWorkspaceRuntimeSafely(workspaceId: string, fallbackMessage: string): Promise<boolean> {
    const runtimeSessionIds = getWorkspaceRuntimeSessionIds(workspaceId);
    const closeResults = await Promise.allSettled(
      runtimeSessionIds.map((runtimeSessionId) => closeTerminal(runtimeSessionId)),
    );
    const failedClose = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedClose) {
      const reason = failedClose.reason;
      setWorkspaceActionError(fallbackOnlyErrorMessage(reason, fallbackMessage));
      return false;
    }

    closeWorkspaceRuntime(workspaceId);
    return true;
  }

  async function handleCloseWorkspace(workspaceId: string) {
    setWorkspaceActionError(null);
    const closed = await closeWorkspaceRuntimeSafely(workspaceId, "关闭工作区运行时失败");
    if (!closed) return;
    try {
      await workspaceDelete(workspaceId);
      await refreshWorkspaceSummaries();
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "关闭工作区失败"));
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

    const closed = await closeWorkspaceRuntimeSafely(workspace.id, "删除工作区运行时失败");
    if (!closed) return;

    try {
      await workspaceRemove(workspace.id);
      removeWorkspace(workspace.id);
      setPendingDeleteWorkspace(null);
      await refreshWorkspaceSummaries();
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "删除工作区失败"));
    }
  }

  async function handleRestoreWorkspace(workspaceId: string) {
    startWorkspaceSwitchMetrics(workspaceId);
    setWorkspaceActionError(null);
    if (restoringWorkspaceIdsRef.current.has(workspaceId)) {
      const runtime = workspaceRuntimes.find((workspace) => workspace.id === workspaceId);
      if (runtime) {
        beginWorkspaceVisualSwitch(runtime, {
          commit: () => selectWorkspace(workspaceId),
          completeMetricsOnCommit: true,
        });
      }
      return;
    }
    restoringWorkspaceIdsRef.current.add(workspaceId);
    try {
      const definition = await resolveWorkspaceDefinition(workspaceId);
      const runningDefinition = markWorkspaceRestoreQueued({ ...definition, status: "running" as const });
      const epoch = beginWorkspaceVisualSwitch(runningDefinition, {
        commit: () => {
          freezeActiveWorkspaceBeforeSwitch(workspaceId);
          upsertWorkspaceDefinition(runningDefinition);
          selectWorkspace(runningDefinition.id);
          selectTab(runningDefinition.active_tab_id);
        },
        onLive: () => {
          markWorkspaceSwitchMetric(workspaceId, "restore_queue_started");
          void (async () => {
            try {
              await restoreWorkspaceTerminals(runningDefinition, epoch ?? undefined);
              await refreshWorkspaceSummaries();
            } catch (error) {
              setWorkspaceActionError(fallbackOnlyErrorMessage(error, "恢复工作区失败"));
            } finally {
              restoringWorkspaceIdsRef.current.delete(workspaceId);
            }
          })();
        },
        onCancel: () => {
          restoringWorkspaceIdsRef.current.delete(workspaceId);
        },
      });
      if (epoch === null) {
        restoringWorkspaceIdsRef.current.delete(workspaceId);
      }
    } catch (error) {
      setWorkspaceActionError(fallbackOnlyErrorMessage(error, "恢复工作区失败"));
      restoringWorkspaceIdsRef.current.delete(workspaceId);
    }
  }

  async function resolveWorkspaceDefinition(workspaceId: string): Promise<WorkspaceDefinition> {
    const runtime = workspaceRuntimes.find((workspace) => workspace.id === workspaceId);
    if (workspaceId === activeWorkspaceId) {
      const draft = buildActiveWorkspaceDraft();
      if (draft?.id === workspaceId) {
        return definitionFromDraft(draft, runtime);
      }
    }
    if (runtime && hasRuntimeTabs(runtime)) {
      return definitionFromRuntime(runtime);
    }
    return loadCachedWorkspaceDefinition(workspaceId, workspaceGet);
  }

  async function restoreWorkspaceTerminals(workspace: WorkspaceDefinition, switchEpoch?: number) {
    await runWorkspaceRestoreQueue({
      workspace,
      sessions,
      strategy: workspaceRestoreStrategy,
      isCancelled: () => switchEpoch !== undefined && !isWorkspaceSwitchEpochCurrent(switchEpoch),
      openTerminal,
      openDefaultLocalTerminal,
      openSshContainerTerminal,
      writeTerminal,
      closeTerminal,
      updatePaneTerminalTab,
      metrics: {
        onFirstVisibleConnected: () =>
          markWorkspaceSwitchMetric(workspace.id, "first_visible_connected"),
        onAllVisibleConnected: () =>
          markWorkspaceSwitchMetric(workspace.id, "all_visible_connected"),
        onAllScheduledDone: () =>
          markWorkspaceSwitchMetric(workspace.id, "all_scheduled_done"),
      },
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

  async function loadSshContainers(savedSessionId: string, isCancelled: () => boolean = () => false) {
    setContainerPanelState((current) => ({ ...current, loading: true, error: null }));
    try {
      const items = await listSshContainers(savedSessionId);
      if (isCancelled()) return;
      setContainerPanelState({ items, loading: false, error: null });
    } catch (error) {
      if (isCancelled()) return;
      setContainerPanelState({
        items: [],
        loading: false,
        error: fallbackOnlyErrorMessage(error, "加载容器失败"),
      });
    }
  }

  async function refreshActiveSshContainers() {
    if (!activeSshContainersEnabled || !activeSshSessionId) {
      setContainerPanelState(EMPTY_CONTAINER_PANEL_STATE);
      return;
    }
    await loadSshContainers(activeSshSessionId);
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
    if (!latestActiveTab || !latestActivePaneTab || latestSavedSession?.type !== "ssh") return;
    if (latestSavedSession.ssh_options?.container?.enabled !== true) return;

    const targetWorkspaceId = workspaceState.activeWorkspaceId;
    const targetWorkspaceTabId = latestActiveTab.id;
    const targetPaneId = latestActiveTab.active_pane_id;
    const afterPaneTabId = latestActivePaneTab.id;
    const targetSavedSessionId = latestSavedSession.id;
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
    activeWorkspaceId,
    activeWorkspaceTabId: activeTabId,
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
    () => mergeWorkspaceSidebarItems(workspaceSummaries, workspaceRuntimes, workspaceDefinitions),
    [workspaceDefinitions, workspaceRuntimes, workspaceSummaries],
  );

  useEffect(() => {
    if (activeLeftTool !== "workspace") return;

    for (const workspace of workspaceSidebarItems) {
      if (workspace.status !== "closed") continue;
      if (workspace.preview_root) continue;
      void loadCachedWorkspaceDefinition(workspace.id, workspaceGet)
        .catch((error) => {
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

  useEffect(() => {
    const runningWorkspaces = runningWorkspaceCapWorkspaces.filter(
      (workspace) =>
        workspace.id !== DEFAULT_WORKSPACE_ID &&
        workspace.status === "running" &&
        Array.isArray(workspace.tabs) &&
        workspace.tabs.length > 0,
    );
    if (runningWorkspaces.length <= DEFAULT_MAX_RUNNING_WORKSPACES) return;

    const overflow = runningWorkspaces.length - DEFAULT_MAX_RUNNING_WORKSPACES;
    const candidates = runningWorkspaces
      .filter(
        (workspace) =>
          workspace.id !== activeWorkspaceId && !autoClosingWorkspaceIdsRef.current.has(workspace.id),
      )
      .sort(
        (left, right) =>
          left.updated_at_ms - right.updated_at_ms ||
          left.sort_order - right.sort_order ||
          left.name.localeCompare(right.name),
      )
      .slice(0, overflow);

    for (const workspace of candidates) {
      void closeWorkspaceRuntimeForCap(workspace.id);
    }
  }, [activeWorkspaceId, runningWorkspaceCapWorkspaces]);

  if (viewMode === "settings") {
    return (
      <div className="zt-workbench zt-workbench-settings" onContextMenu={(event) => event.preventDefault()}>
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
        />
      </div>
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
                activeWorkspaceId={activeWorkspaceId}
                error={workspaceActionError}
                onCreateWorkspace={handleCreateWorkspace}
                onSelectWorkspace={(workspaceId) => void handleSelectWorkspace(workspaceId)}
                onEditWorkspace={(workspaceId) => void handleEditWorkspace(workspaceId)}
                onRestoreWorkspace={(workspaceId) => void handleRestoreWorkspace(workspaceId)}
                onCloseWorkspace={(workspaceId) => void handleCloseWorkspace(workspaceId)}
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
                onTestProviderDraft={testProviderDraft}
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

      <main className="zt-main">
        {terminalError ? <div className="zt-terminal-error">{terminalError}</div> : null}
        <WorkspaceStage
          activeWorkspaceId={activeWorkspaceId}
          onActivatePane={setActivePane}
          onAddPaneTab={handleRequestPaneConnection}
          onSelectPaneTab={selectPaneTab}
          onClosePaneTab={(paneId, paneTabId) => closePaneTab(paneId, paneTabId)}
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
        {workspaceSwitchOverlay ? (
          <div className="zt-workspace-switch-overlay" aria-hidden="true">
            <SplitPaneView
              key={`overlay-${workspaceSwitchOverlay.id}`}
              root={workspaceSwitchOverlay.root}
              activePaneId={workspaceSwitchOverlay.activePaneId}
              onActivatePane={() => undefined}
              onAddPaneTab={() => undefined}
              onSelectPaneTab={() => undefined}
              onClosePaneTab={() => undefined}
              onSplitPane={() => undefined}
              onResizeSplit={() => undefined}
              onClosePane={() => undefined}
              visualMode="snapshot"
            />
          </div>
        ) : null}
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
          sessionName: activeSavedSession?.type === "ssh" ? activeSavedSession.name : null,
          target: activeSavedSession?.type === "ssh"
            ? `${activeSavedSession.username}@${activeSavedSession.host}:${activeSavedSession.port}`
            : null,
          items: containerPanelState.items,
          loading: containerPanelState.loading,
          error: containerPanelState.error,
          onEnter: enterSshContainer,
          onRefresh: refreshActiveSshContainers,
        }}
        tunnels={{
          sessionName: activeSavedSession?.type === "ssh" ? activeSavedSession.name : null,
          target: activeSavedSession?.type === "ssh"
            ? `${activeSavedSession.username}@${activeSavedSession.host}:${activeSavedSession.port}`
            : null,
          items: activeSshTunnels,
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
