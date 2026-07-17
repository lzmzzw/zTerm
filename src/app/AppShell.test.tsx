// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";
import { useSyncInputStore } from "../features/terminal/syncInputStore";

const storeMocks = vi.hoisted(() => ({
  noop: vi.fn(),
  asyncNoop: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn().mockResolvedValue(undefined),
  bindEvents: vi.fn().mockResolvedValue(() => undefined),
  addPaneTab: vi.fn(),
  addPaneTabAfter: vi.fn(),
  closePaneTab: vi.fn(),
  closePane: vi.fn(),
  selectPaneTab: vi.fn(),
  bindRuntimeToPane: vi.fn(),
  bindRuntimeToPaneTab: vi.fn(),
  buildActiveWorkspaceDraft: vi.fn(),
  restoreWorkbenchDefinition: vi.fn(),
  clearRuntimeSession: vi.fn(),
  getWorkspaceRuntimeSessionIds: vi.fn((_workspaceId?: string) => ["runtime-1"]),
  splitActivePane: vi.fn(),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  updatePaneTerminalTab: vi.fn(),
  selectTab: vi.fn(),
  setActivePane: vi.fn(),
  writeTerminal: vi.fn().mockResolvedValue(undefined),
  enterSshContainerRuntime: vi.fn().mockResolvedValue(undefined),
  workspaceList: vi.fn().mockResolvedValue([]),
  workspaceGet: vi.fn(),
  workspaceSave: vi.fn(),
  workspaceSaveDefaultSnapshot: vi.fn().mockResolvedValue(undefined),
  workspaceRemove: vi.fn().mockResolvedValue(undefined),
  cacheWorkspaceDefinition: vi.fn(),
  loadWorkspaceDefinition: vi.fn(),
  prefetchWorkspaceDefinitions: vi.fn(),
  removeWorkspace: vi.fn(),
  workspaceDefinitionState: {
    definitions: {} as Record<string, Record<string, unknown>>,
  },
  terminalOutputAccesses: 0,
  tauriEventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  pendingExternalLaunches: [] as Array<Record<string, unknown>>,
  externalSshOptions: {
    connect_timeout_ms: null,
    keepalive_interval_ms: null,
    proxy_command: null,
    identity_file: null,
    jump_hosts: [] as string[],
    tunnels: [] as Array<Record<string, unknown>>,
    container: {
      enabled: true,
      runtime: "docker",
      container: "",
      shell: "/bin/sh",
      user: null,
      workdir: null,
    },
  },
  getExternalSshOptions: vi.fn(),
  takePendingExternalLaunches: vi.fn(),
  updateExternalSshOptions: vi.fn(),
  settingsState: {
    appSettings: {
      language: "zhCN",
      theme: "dark",
      ui_font_size: 13,
      terminal_font_size: 13,
      default_right_tool: "agent",
      workspace_restore_strategy: "visible_first",
      shortcuts: [],
    },
  },
  deleteCommandGroup: vi.fn().mockResolvedValue(undefined),
  deleteHistoryEntries: vi.fn().mockResolvedValue(undefined),
  historyPanelProps: null as Record<string, unknown> | null,
  monitorPanelProps: null as Record<string, unknown> | null,
  modelPanelProps: null as Record<string, unknown> | null,
  transferPanelProps: null as Record<string, unknown> | null,
  fileTransferPanelProps: null as Record<string, unknown> | null,
  aiPanelProps: null as Record<string, unknown> | null,
  aiAffectedDomainsHandler: null as ((domains: string[]) => Promise<void> | void) | null,
  loadCommandGroups: vi.fn().mockResolvedValue(undefined),
  saveCommandGroup: vi.fn().mockResolvedValue(undefined),
  searchHistory: vi.fn().mockResolvedValue(undefined),
  captureContext: vi.fn().mockResolvedValue(undefined),
  listFiles: vi.fn().mockResolvedValue(undefined),
  clearFiles: vi.fn(),
  loadTransfers: vi.fn().mockResolvedValue(undefined),
  pauseTransfer: vi.fn().mockResolvedValue(undefined),
  resumeTransfer: vi.fn().mockResolvedValue(undefined),
  cancelTransfer: vi.fn().mockResolvedValue(undefined),
  deleteTransfer: vi.fn().mockResolvedValue(undefined),
  openTerminal: vi.fn().mockResolvedValue({
    runtime_session_id: "runtime-2",
    saved_session_id: "session-1",
    history_scope_kind: "saved_session",
    history_scope_id: "session-1",
    pane_id: "pane-1",
    title: "172.16.41.180",
    kind: "ssh",
    cols: 120,
    rows: 32,
  }),
  openSshContainerTerminal: vi.fn().mockResolvedValue({
    runtime_session_id: "runtime-container",
    saved_session_id: "session-1",
    history_scope_kind: "saved_session",
    history_scope_id: "session-1",
    pane_id: "pane-1",
    title: "容器: api",
    kind: "ssh_container",
    cols: 120,
    rows: 32,
  }),
  listSshContainers: vi.fn().mockResolvedValue([
    {
      id: "abc123",
      name: "api",
      image: "app:latest",
      status: "Up 3 minutes",
      running: true,
    },
    {
      id: "def456",
      name: "old",
      image: "app:old",
      status: "Exited (0) 2 hours ago",
      running: false,
    },
  ]),
  openDefaultLocalTerminal: vi.fn().mockResolvedValue({
    runtime_session_id: "runtime-local",
    saved_session_id: null,
    history_scope_kind: "local_profile",
    history_scope_id: "pwsh",
    pane_id: "pane-1",
    title: "PowerShell 7",
    kind: "local",
    cols: 120,
    rows: 32,
  }),
  workspaceState: {
    workspaces: [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ] as Array<Record<string, unknown>>,
    activeWorkspaceId: "workspace-1",
    tabs: [
      {
        id: "tab-1",
        title: "新建终端",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "新建终端",
          runtime_session_id: null,
          saved_session_id: null,
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "新建终端",
              runtime_session_id: null,
              saved_session_id: null,
            },
          ],
        },
      },
    ] as Array<Record<string, unknown>>,
    activeTabId: "tab-1",
  },
  sessionState: {
    sessions: [] as Array<Record<string, unknown>>,
  },
  terminalState: {
    runtimes: {} as Record<string, Record<string, unknown>>,
    outputTails: {} as Record<string, string>,
    inputSerialByRuntime: {} as Record<string, number>,
    visualTails: {} as Record<string, string>,
  },
}));

vi.mock("./TitleBar", () => ({
  TitleBar: ({ centerContent }: { centerContent?: string | null }) => <header aria-label="标题栏">{centerContent}</header>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    storeMocks.tauriEventHandlers.set(eventName, handler);
    return () => {
      storeMocks.tauriEventHandlers.delete(eventName);
    };
  }),
}));

vi.mock("../features/terminal/externalLaunchApi", () => ({
  externalSshChannelPolicy: (launch: { channel_policy?: string; username?: string } | null | undefined) => {
    if (launch?.channel_policy === "single_channel") return "single_channel";
    const username = launch?.username?.trim() ?? "";
    if (!username.startsWith("b64>>")) return "unknown";
    try {
      const decoded = globalThis.atob(username.slice("b64>>".length));
      return decoded.includes("@") && decoded.includes(":SSH2") ? "single_channel" : "unknown";
    } catch {
      return "unknown";
    }
  },
  externalSshHostServiceTarget: (launch: { host?: string; username?: string } | null | undefined) => {
    const username = launch?.username?.trim() ?? "";
    if (username.startsWith("b64>>")) {
      try {
        const decoded = globalThis.atob(username.slice("b64>>".length));
        if (decoded.includes("@") && decoded.includes(":SSH2")) return "127.0.0.1";
      } catch {
        return launch?.host?.trim() ?? "";
      }
    }
    return launch?.host?.trim() ?? "";
  },
  getExternalSshOptions: storeMocks.getExternalSshOptions,
  isExternalSessionId: (value: string | null | undefined) => typeof value === "string" && value.startsWith("external:"),
  takePendingExternalLaunches: storeMocks.takePendingExternalLaunches,
  updateExternalSshOptions: storeMocks.updateExternalSshOptions,
}));

vi.mock("../features/ai/AiPanel", () => ({
  AiPanel: (props: Record<string, unknown>) => {
    storeMocks.aiPanelProps = props;
    return <section aria-label="AI 面板" />;
  },
}));

vi.mock("../features/files/FileExplorerPanel", () => ({
  FileExplorerPanel: () => <section aria-label="文件面板" />,
}));

vi.mock("../features/files/TransferPanel", () => ({
  TransferPanel: (props: Record<string, unknown>) => {
    storeMocks.transferPanelProps = props;
    return <section aria-label="传输任务列表" />;
  },
}));

vi.mock("../features/files/FileTransferPanel", () => ({
  FileTransferPanel: (props: Record<string, unknown>) => {
    storeMocks.fileTransferPanelProps = props;
    return <section aria-label="文件传输面板" />;
  },
}));

vi.mock("../features/history/CommandHistoryPanel", () => ({
  CommandHistoryPanel: (props: Record<string, unknown>) => {
    storeMocks.historyPanelProps = props;
    return (
      <section
        aria-label="命令历史"
        data-history-scope-kind={(props.historyScopeKind as string | null) ?? ""}
        data-history-scope-id={(props.historyScopeId as string | null) ?? ""}
      >
        <button
          type="button"
          aria-label="切换去重历史"
          onClick={() => {
            (props.onDeduplicateHistoryChange as (enabled: boolean) => void)(true);
          }}
        >
          去重
        </button>
      </section>
    );
  },
}));

vi.mock("../features/monitor/ServerMonitorPanel", () => ({
  ServerMonitorPanel: (props: Record<string, unknown>) => {
    storeMocks.monitorPanelProps = props;
    const target = props.target as { id?: string; name?: string } | null;
    return (
      <section aria-label="资源监控" data-target-id={target?.id ?? ""}>
        {target?.name ?? "无 SSH 会话"}
      </section>
    );
  },
}));

vi.mock("../features/monitor/useServerInfoSnapshot", () => ({
  useServerInfoSnapshot: vi.fn(() => ({
    error: null,
    loading: false,
    networkTraffic: null,
    refreshIntervalMs: 3000,
    snapshot: null,
    refresh: vi.fn(),
    setRefreshIntervalMs: vi.fn(),
  })),
}));

vi.mock("../features/models/ModelManagerPanel", () => ({
  ModelManagerPanel: (props: Record<string, unknown>) => {
    storeMocks.modelPanelProps = props;
    const providers = props.providers as Array<{ name: string }>;
    return (
      <section aria-label="模型管理">
        {providers.length === 0 ? "暂无模型" : providers.map((provider) => provider.name).join(", ")}
      </section>
    );
  },
}));

vi.mock("../features/sessions/SessionTree", () => ({
  SessionTree: ({ onOpenSession }: { onOpenSession?: (session: unknown) => void }) => (
    <section aria-label="会话树">
      <button
        type="button"
        aria-label="打开测试会话"
        onClick={() =>
          onOpenSession?.({
            id: "session-1",
            name: "172.16.41.180",
            host: "172.16.41.180",
            port: 22,
            username: "ubuntu",
            type: "ssh",
            auth_mode: "none",
            group_id: null,
            tags: [],
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
          })
        }
      >
        打开测试会话
      </button>
    </section>
  ),
}));

vi.mock("../features/workspace/SplitPaneView", () => ({
  SplitPaneView: ({
    root,
    activePaneId,
    onAddPaneTab,
    onDuplicatePaneTab,
    onClosePaneTab,
    onClosePane,
    onSplitPane,
    workspaceActive = true,
    visualMode = "normal",
  }: {
    root: Record<string, unknown>;
    activePaneId: string;
    onAddPaneTab: (paneId: string) => void;
    onDuplicatePaneTab: (paneId: string, paneTabId: string) => void;
    onClosePaneTab: (paneId: string, paneTabId: string) => void;
    onClosePane: (paneId: string) => void;
    onSplitPane: (direction: "horizontal" | "vertical") => void;
    workspaceActive?: boolean;
    visualMode?: "normal" | "placeholder" | "snapshot";
  }) =>
    visualMode === "placeholder" || visualMode === "snapshot" ? (
      <section
        aria-label={visualMode === "snapshot" ? "工作区切换快照布局" : "工作区切换轻量布局"}
        data-active-pane-id={activePaneId}
      >
        {collectMockPaneTitles(root).join(" ")}
      </section>
    ) : (
      <section aria-label="终端分栏" data-workspace-active={String(workspaceActive)}>
      <span>{collectMockPaneTitles(root).join(" ")}</span>
      <button type="button" aria-label="创建连接" onClick={() => onAddPaneTab("pane-1")}>
        创建连接
      </button>
      <button type="button" aria-label="复制当前连接" onClick={() => onDuplicatePaneTab("pane-1", "pane-1-tab-1")}>
        复制当前连接
      </button>
      <button type="button" aria-label="横向分栏" onClick={() => onSplitPane("horizontal")}>
        横向分栏
      </button>
      <button type="button" aria-label="纵向分栏" onClick={() => onSplitPane("vertical")}>
        纵向分栏
      </button>
      <button type="button" aria-label="关闭当前标签" onClick={() => onClosePaneTab("pane-1", "pane-1-tab-1")}>
        关闭当前标签
      </button>
      <button type="button" aria-label="关闭当前分栏" onClick={() => onClosePane("pane-1")}>
        关闭当前分栏
      </button>
      </section>
    ),
}));

function collectMockPaneTitles(root: Record<string, unknown>): string[] {
  if (root.kind === "split") {
    return [
      ...collectMockPaneTitles(root.first as Record<string, unknown>),
      ...collectMockPaneTitles(root.second as Record<string, unknown>),
    ];
  }
  return [String(root.title ?? "")];
}

vi.mock("../features/sessions/sessionStore", () => {
  const sessionState = () => ({
    groups: [],
    sessions: storeMocks.sessionState.sessions,
    error: null,
    loadSessions: storeMocks.asyncNoop,
    saveGroup: storeMocks.asyncNoop,
    saveSession: storeMocks.saveSession,
    testSession: storeMocks.asyncNoop,
    deleteGroup: storeMocks.asyncNoop,
    deleteSession: storeMocks.asyncNoop,
  });
  const useSessionStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = sessionState();
    if (selector) return selector(state);
    return state;
  };
  useSessionStore.getState = sessionState;
  return { useSessionStore };
});

vi.mock("../features/settings/settingsStore", () => {
  const settingsState = () => ({
    appSettings: storeMocks.settingsState.appSettings,
    credentials: [],
    providers: [
      {
        id: "provider-1",
        name: "OpenAI Compatible",
        kind: "openai_responses",
        base_url: "http://127.0.0.1:5555/v1",
        model: "gpt-test",
        api_key_ref: "",
        enabled: true,
        is_default: true,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ],
    terminalProfiles: [
      {
        id: "pwsh",
        name: "PowerShell 7",
        path: "pwsh.exe",
        args: [],
        detected: true,
        is_default: true,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ],
    shortcutDefinitions: [],
    loading: false,
    error: null,
    loadSettings: storeMocks.asyncNoop,
    saveAppSettings: storeMocks.asyncNoop,
    resetAppSettingsSection: storeMocks.asyncNoop,
    saveCredential: storeMocks.asyncNoop,
    readCredentialSecret: vi.fn().mockResolvedValue("saved-secret"),
    deleteCredential: storeMocks.asyncNoop,
    testCredential: storeMocks.asyncNoop,
    saveProvider: storeMocks.asyncNoop,
    deleteProvider: storeMocks.asyncNoop,
    testProvider: vi.fn().mockResolvedValue("ok"),
    testProviderDraft: vi.fn().mockResolvedValue({ ok: true, message: "ok", output: "pong" }),
    startProviderDraftTestStream: vi.fn().mockResolvedValue({ test_id: "test-1" }),
    cancelProviderDraftTest: vi.fn().mockResolvedValue({ cancelled: true }),
    detectTerminalProfiles: vi.fn().mockResolvedValue([]),
    setDefaultTerminalProfile: storeMocks.asyncNoop,
  });
  const useSettingsStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = settingsState();
    if (selector) return selector(state);
    return state;
  };
  return { useSettingsStore };
});

vi.mock("../features/ai/aiStore", () => {
  const aiState = () => ({
    conversations: [],
    activeConversationId: null,
    approvalMode: "safe",
    messages: [],
    conversationPreviews: {},
    pendingInvocations: [],
    contextSnapshot: null,
    loading: false,
    error: null,
    loadConversations: storeMocks.asyncNoop,
    loadPendingInvocations: storeMocks.asyncNoop,
    captureContext: storeMocks.captureContext,
    sendChat: storeMocks.asyncNoop,
    setApprovalMode: storeMocks.asyncNoop,
    selectConversation: storeMocks.asyncNoop,
    loadConversationPreview: storeMocks.asyncNoop,
    newConversation: storeMocks.asyncNoop,
    deleteConversation: storeMocks.asyncNoop,
    confirmTool: storeMocks.asyncNoop,
  });
  const useAiStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = aiState();
    if (selector) return selector(state);
    return state;
  };
  const setAiAffectedDomainsHandler = vi.fn((handler: ((domains: string[]) => Promise<void> | void) | null) => {
    storeMocks.aiAffectedDomainsHandler = handler;
  });
  return { setAiAffectedDomainsHandler, useAiStore };
});

vi.mock("../features/files/fileStore", () => {
  const fileState = () => ({
    entries: [],
    path: "/",
    selectedPaths: [],
    selectionAnchorPath: null,
    loading: false,
    error: null,
    transfers: [],
    setPath: storeMocks.noop,
    selectPath: storeMocks.noop,
    clearFiles: storeMocks.clearFiles,
    listFiles: storeMocks.listFiles,
    mkdir: storeMocks.asyncNoop,
    upload: storeMocks.asyncNoop,
    download: storeMocks.asyncNoop,
    deletePath: storeMocks.asyncNoop,
    renamePath: storeMocks.asyncNoop,
    classifyLocalPaths: vi.fn(async () => []),
    checkTransferConflicts: vi.fn(async () => []),
    bindTransferEvents: storeMocks.bindEvents,
    loadTransfers: storeMocks.loadTransfers,
    retryTransfer: storeMocks.asyncNoop,
    pauseTransfer: storeMocks.pauseTransfer,
    resumeTransfer: storeMocks.resumeTransfer,
    cancelTransfer: storeMocks.cancelTransfer,
    deleteTransfer: storeMocks.deleteTransfer,
  });
  const useFileStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = fileState();
    if (selector) return selector(state);
    return state;
  };
  return { useFileStore };
});

vi.mock("../features/history/historyStore", () => {
  const historyState = () => ({
    entries: [],
    commandGroups: [],
    loading: false,
    error: null,
    groupLoading: false,
    groupError: null,
    searchHistory: storeMocks.searchHistory,
    clearHistory: storeMocks.asyncNoop,
    deleteHistoryEntries: storeMocks.deleteHistoryEntries,
    loadCommandGroups: storeMocks.loadCommandGroups,
    saveCommandGroup: storeMocks.saveCommandGroup,
    deleteCommandGroup: storeMocks.deleteCommandGroup,
  });
  const useHistoryStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = historyState();
    if (selector) return selector(state);
    return state;
  };
  return { useHistoryStore };
});

vi.mock("../features/terminal/sshContainerApi", () => ({
  listSshContainers: storeMocks.listSshContainers,
}));

vi.mock("../features/terminal/terminalStore", () => {
  const terminalState = (trackOutputAccess = false) => {
    const state: Record<string, unknown> = {
      bindTerminalEvents: storeMocks.bindEvents,
      openTerminal: storeMocks.openTerminal,
      openSshContainerTerminal: storeMocks.openSshContainerTerminal,
      enterSshContainerRuntime: storeMocks.enterSshContainerRuntime,
      openDefaultLocalTerminal: storeMocks.openDefaultLocalTerminal,
      closeTerminal: storeMocks.closeTerminal,
      writeTerminal: storeMocks.writeTerminal,
      resizeTerminal: vi.fn().mockResolvedValue(undefined),
      suggestCompletion: vi.fn().mockResolvedValue([]),
      runtimes: storeMocks.terminalState.runtimes,
      outputChunks: {},
      inputSerialByRuntime: storeMocks.terminalState.inputSerialByRuntime,
      getOutputTail: (runtimeSessionId: string) => {
        if (trackOutputAccess) {
          storeMocks.terminalOutputAccesses += 1;
        }
        return storeMocks.terminalState.outputTails[runtimeSessionId] ?? "";
      },
      getVisualOutputTail: (runtimeSessionId: string) => storeMocks.terminalState.visualTails[runtimeSessionId] ?? "",
      getVisualOutputTailSnapshot: () => ({ ...storeMocks.terminalState.visualTails }),
      beginLiveOutput: vi.fn(() => () => undefined),
    };
    Object.defineProperty(state, "output", {
      enumerable: true,
      get() {
        throw new Error("AppShell must not subscribe to the full terminal output map");
      },
    });
    return state;
  };
  const useTerminalStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = terminalState(true);
    return selector ? selector(state) : state;
  };
  useTerminalStore.getState = () => terminalState(false);
  return { useTerminalStore };
});

vi.mock("../features/workspace/workspacePersistence", () => ({
  workspaceList: storeMocks.workspaceList,
  workspaceGet: storeMocks.workspaceGet,
  workspaceSave: storeMocks.workspaceSave,
  workspaceSaveDefaultSnapshot: storeMocks.workspaceSaveDefaultSnapshot,
  workspaceRemove: storeMocks.workspaceRemove,
}));

vi.mock("../features/workspace/workspaceStore", () => {
  const workspaceState = () => ({
    workspaces: storeMocks.workspaceState.workspaces,
    workspaceDefinitions: storeMocks.workspaceDefinitionState.definitions,
    activeWorkspaceId: storeMocks.workspaceState.activeWorkspaceId,
    tabs: storeMocks.workspaceState.tabs,
    activeTabId: storeMocks.workspaceState.activeTabId,
    cacheWorkspaceDefinition: storeMocks.cacheWorkspaceDefinition,
    loadWorkspaceDefinition: storeMocks.loadWorkspaceDefinition,
    prefetchWorkspaceDefinitions: storeMocks.prefetchWorkspaceDefinitions,
    buildActiveWorkspaceDraft: storeMocks.buildActiveWorkspaceDraft,
    restoreWorkbenchDefinition: storeMocks.restoreWorkbenchDefinition,
    clearRuntimeSession: storeMocks.clearRuntimeSession,
    getWorkspaceRuntimeSessionIds: storeMocks.getWorkspaceRuntimeSessionIds,
    removeWorkspace: storeMocks.removeWorkspace,
    updatePaneTerminalTab: storeMocks.updatePaneTerminalTab,
    selectTab: storeMocks.selectTab,
    addTab: storeMocks.noop,
    addPaneTab: storeMocks.addPaneTab,
    addPaneTabAfter: storeMocks.addPaneTabAfter,
    closePaneTab: storeMocks.closePaneTab,
    selectPaneTab: storeMocks.selectPaneTab,
    setActivePane: storeMocks.setActivePane,
    bindRuntimeToPane: storeMocks.bindRuntimeToPane,
    bindRuntimeToPaneTab: storeMocks.bindRuntimeToPaneTab,
    splitActivePane: storeMocks.splitActivePane,
    resizeSplitPane: storeMocks.noop,
    closePane: storeMocks.closePane,
  });
  const useWorkspaceStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = workspaceState();
    if (selector) return selector(state);
    return state;
  };
  useWorkspaceStore.getState = () => ({
    ...workspaceState(),
    buildActiveWorkspaceDraft: storeMocks.buildActiveWorkspaceDraft,
    restoreWorkbenchDefinition: storeMocks.restoreWorkbenchDefinition,
    clearRuntimeSession: storeMocks.clearRuntimeSession,
    getWorkspaceRuntimeSessionIds: storeMocks.getWorkspaceRuntimeSessionIds,
    removeWorkspace: storeMocks.removeWorkspace,
    updatePaneTerminalTab: storeMocks.updatePaneTerminalTab,
    cacheWorkspaceDefinition: storeMocks.cacheWorkspaceDefinition,
    loadWorkspaceDefinition: storeMocks.loadWorkspaceDefinition,
    prefetchWorkspaceDefinitions: storeMocks.prefetchWorkspaceDefinitions,
    selectTab: storeMocks.selectTab,
    setActivePane: storeMocks.setActivePane,
    selectPaneTab: storeMocks.selectPaneTab,
    addPaneTabAfter: storeMocks.addPaneTabAfter,
    bindRuntimeToPane: storeMocks.bindRuntimeToPane,
    bindRuntimeToPaneTab: storeMocks.bindRuntimeToPaneTab,
  });
  return { useWorkspaceStore };
});

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    rerender(nextUi: ReactElement) {
      act(() => {
        root.render(nextUi);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, label: string) {
  const match = container.querySelector(`button[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match as HTMLButtonElement;
}

function input(container: ParentNode, label: string) {
  const match = container.querySelector(`input[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Input not found: ${label}`);
  }
  return match as HTMLInputElement;
}

function textarea(container: ParentNode, label: string) {
  const match = container.querySelector(`textarea[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Textarea not found: ${label}`);
  }
  return match as HTMLTextAreaElement;
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flushDomI18n() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function clickButton(container: HTMLElement, label: string) {
  await act(async () => {
    button(container, label).click();
  });
}

function openWorkspaceContextMenu(container: HTMLElement, workspaceName: string) {
  const item = container.querySelector(`[aria-label="工作区 ${workspaceName}"]`);
  if (!item) {
    throw new Error(`Workspace item not found: ${workspaceName}`);
  }
  item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 96 }));
}

async function clickWorkspaceContextAction(container: HTMLElement, workspaceName: string, actionLabel: string) {
  await act(async () => {
    openWorkspaceContextMenu(container, workspaceName);
    await Promise.resolve();
    button(container, actionLabel).click();
    await Promise.resolve();
  });
}

async function flushWorkspacePostLayoutWork() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
        return;
      }
      window.setTimeout(resolve, 0);
    });
    await new Promise((resolve) => window.setTimeout(resolve, 380));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function workspaceSplitRoot() {
  return {
    kind: "split",
    id: "split-root",
    direction: "horizontal",
    ratio: 0.5,
    first: {
      kind: "split",
      id: "split-left",
      direction: "vertical",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-1",
        title: "PowerShell 7",
        runtime_session_id: null,
        saved_session_id: null,
        active_terminal_tab_id: "pane-1-tab-1",
        terminal_tabs: [
          {
            id: "pane-1-tab-1",
            title: "PowerShell 7",
            runtime_session_id: null,
            saved_session_id: null,
            connection_source: "default_local",
          },
        ],
      },
      second: {
        kind: "leaf",
        id: "pane-5",
        title: "172.16.41.181",
        runtime_session_id: null,
        saved_session_id: "session-1",
        active_terminal_tab_id: "pane-5-tab-1",
        terminal_tabs: [
          {
            id: "pane-5-tab-1",
            title: "172.16.41.181",
            runtime_session_id: null,
            saved_session_id: "session-1",
            connection_source: "saved_session",
            path: "/srv/app",
          },
        ],
      },
    },
    second: {
      kind: "split",
      id: "split-right",
      direction: "vertical",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-4",
        title: "PowerShell 7",
        runtime_session_id: null,
        saved_session_id: null,
        active_terminal_tab_id: "pane-4-tab-1",
        terminal_tabs: [
          {
            id: "pane-4-tab-1",
            title: "PowerShell 7",
            runtime_session_id: null,
            saved_session_id: null,
            connection_source: "default_local",
          },
        ],
      },
      second: {
        kind: "leaf",
        id: "pane-6",
        title: "PowerShell 7",
        runtime_session_id: null,
        saved_session_id: null,
        active_terminal_tab_id: "pane-6-tab-1",
        terminal_tabs: [
          {
            id: "pane-6-tab-1",
            title: "PowerShell 7",
            runtime_session_id: null,
            saved_session_id: null,
            connection_source: "default_local",
          },
        ],
      },
    },
  } as const;
}

function runningWorkspace(id: string, sortOrder: number, updatedAtMs: number, runtimeSessionId: string) {
  return {
    id,
    name: `工作区 ${id}`,
    status: "running",
    active_tab_id: `${id}-tab-1`,
    activeTabId: `${id}-tab-1`,
    tab_count: 1,
    sort_order: sortOrder,
    created_at_ms: updatedAtMs,
    updated_at_ms: updatedAtMs,
    tabs: [
      {
        id: `${id}-tab-1`,
        title: "主工作台",
        active_pane_id: `${id}-pane-1`,
        sort_order: 0,
        created_at_ms: updatedAtMs,
        updated_at_ms: updatedAtMs,
        root: {
          kind: "leaf",
          id: `${id}-pane-1`,
          title: `终端 ${id}`,
          runtime_session_id: runtimeSessionId,
          saved_session_id: null,
          active_terminal_tab_id: `${id}-pane-1-tab-1`,
          terminal_tabs: [
            {
              id: `${id}-pane-1-tab-1`,
              title: `终端 ${id}`,
              runtime_session_id: runtimeSessionId,
              saved_session_id: null,
              connection_source: "default_local",
            },
          ],
        },
      },
    ],
  };
}

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncInputStore.getState().closeChannel();
    storeMocks.aiAffectedDomainsHandler = null;
    storeMocks.tauriEventHandlers.clear();
    storeMocks.pendingExternalLaunches = [];
    storeMocks.takePendingExternalLaunches.mockImplementation(async () =>
      storeMocks.pendingExternalLaunches.splice(0),
    );
    storeMocks.externalSshOptions = {
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
    storeMocks.getExternalSshOptions.mockImplementation(async () => storeMocks.externalSshOptions);
    storeMocks.updateExternalSshOptions.mockImplementation(async (_sessionId: string, nextOptions: Record<string, unknown>) => {
      storeMocks.externalSshOptions = {
        ...storeMocks.externalSshOptions,
        ...nextOptions,
      };
      return storeMocks.externalSshOptions;
    });
    storeMocks.addPaneTab.mockReturnValue({
      id: "pane-1-tab-created",
      title: "新建终端",
      runtime_session_id: null,
      saved_session_id: null,
    });
    storeMocks.addPaneTabAfter.mockReturnValue({
      id: "pane-1-tab-created",
      title: "新建终端",
      runtime_session_id: null,
      saved_session_id: null,
    });
    storeMocks.openDefaultLocalTerminal.mockResolvedValue({
      runtime_session_id: "runtime-local",
      saved_session_id: null,
      history_scope_kind: "local_profile",
      history_scope_id: "pwsh",
      pane_id: "pane-1",
      title: "PowerShell 7",
      kind: "local",
      cols: 120,
      rows: 32,
    });
    storeMocks.openTerminal.mockResolvedValue({
      runtime_session_id: "runtime-2",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "172.16.41.180",
      kind: "ssh",
      cols: 120,
      rows: 32,
    });
    storeMocks.openSshContainerTerminal.mockResolvedValue({
      runtime_session_id: "runtime-container",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "容器: api",
      kind: "ssh_container",
      cols: 120,
      rows: 32,
    });
    storeMocks.listSshContainers.mockResolvedValue([
      {
        id: "abc123",
        name: "api",
        image: "app:latest",
        status: "Up 3 minutes",
        running: true,
      },
      {
        id: "def456",
        name: "old",
        image: "app:old",
        status: "Exited (0) 2 hours ago",
        running: false,
      },
    ]);
    storeMocks.closeTerminal.mockResolvedValue(undefined);
    storeMocks.updatePaneTerminalTab.mockReset();
    storeMocks.selectTab.mockReset();
    storeMocks.setActivePane.mockReset();
    storeMocks.splitActivePane.mockReset();
    storeMocks.writeTerminal.mockResolvedValue(undefined);
    storeMocks.workspaceList.mockResolvedValue([
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "closed",
        active_tab_id: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ]);
    storeMocks.workspaceGet.mockReset();
    storeMocks.workspaceGet.mockImplementation(async (workspaceId: string) => {
      const draft = storeMocks.buildActiveWorkspaceDraft();
      if (!draft) throw new Error(`workspace not found: ${workspaceId}`);
      if (workspaceId === "default-workspace") {
        return {
          ...draft,
          id: workspaceId,
          name: "默认工作区",
          status: "closed",
          created_at_ms: 1,
          updated_at_ms: 1,
          tabs: [],
        };
      }
      return {
        ...draft,
        id: workspaceId,
        name: workspaceId === "workspace-1" ? "运维巡检" : draft.name,
        status: "closed",
        created_at_ms: 1,
        updated_at_ms: 1,
        tabs: draft.tabs.map((tab: Record<string, unknown>) => ({
          ...tab,
          created_at_ms: 1,
          updated_at_ms: 1,
        })),
      };
    });
    storeMocks.workspaceSave.mockReset();
    storeMocks.workspaceSaveDefaultSnapshot.mockReset();
    storeMocks.workspaceSaveDefaultSnapshot.mockResolvedValue(undefined);
    storeMocks.workspaceRemove.mockResolvedValue(undefined);
    storeMocks.removeWorkspace.mockReset();
    storeMocks.workspaceDefinitionState.definitions = {};
    storeMocks.terminalOutputAccesses = 0;
    storeMocks.cacheWorkspaceDefinition.mockImplementation((definition: Record<string, unknown>) => {
      storeMocks.workspaceDefinitionState.definitions[String(definition.id)] = definition;
    });
    storeMocks.loadWorkspaceDefinition.mockImplementation(
      async (workspaceId: string, loader: (workspaceId: string) => Promise<Record<string, unknown>>) => {
        const cached = storeMocks.workspaceDefinitionState.definitions[workspaceId];
        if (cached) return cached;
        const definition = await loader(workspaceId);
        storeMocks.workspaceDefinitionState.definitions[String(definition.id)] = definition;
        return definition;
      },
    );
    storeMocks.prefetchWorkspaceDefinitions.mockImplementation(
      async (workspaceIds: string[], loader: (workspaceId: string) => Promise<Record<string, unknown>>) => {
        await Promise.all(
          workspaceIds.map((workspaceId) =>
            storeMocks.loadWorkspaceDefinition(workspaceId, loader).catch(() => undefined),
          ),
        );
      },
    );
    storeMocks.settingsState.appSettings = {
      language: "zhCN",
      theme: "dark",
      ui_font_size: 13,
      terminal_font_size: 13,
      default_right_tool: "agent",
      workspace_restore_strategy: "visible_first",
      shortcuts: [],
    };
    storeMocks.getWorkspaceRuntimeSessionIds.mockReturnValue([]);
    storeMocks.historyPanelProps = null;
    storeMocks.monitorPanelProps = null;
    storeMocks.transferPanelProps = null;
    storeMocks.fileTransferPanelProps = null;
    storeMocks.aiPanelProps = null;
    storeMocks.pauseTransfer.mockResolvedValue(undefined);
    storeMocks.resumeTransfer.mockResolvedValue(undefined);
    storeMocks.cancelTransfer.mockResolvedValue(undefined);
    storeMocks.deleteTransfer.mockResolvedValue(undefined);
    storeMocks.sessionState.sessions = [];
    storeMocks.terminalState.runtimes = {};
    storeMocks.terminalState.outputTails = {};
    storeMocks.terminalState.inputSerialByRuntime = {};
    storeMocks.terminalState.visualTails = {};
    storeMocks.workspaceState.workspaces = [
      {
        id: "default-workspace",
        name: "默认工作区",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.activeWorkspaceId = "default-workspace";
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "新建终端",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "新建终端",
          runtime_session_id: null,
          saved_session_id: null,
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "新建终端",
              runtime_session_id: null,
              saved_session_id: null,
            },
          ],
        },
      },
    ];
    storeMocks.workspaceState.workspaces[0].tabs = storeMocks.workspaceState.tabs;
    storeMocks.workspaceState.activeTabId = "tab-1";
    storeMocks.buildActiveWorkspaceDraft.mockReturnValue({
      id: "default-workspace",
      name: "默认工作区",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "生产机",
            runtime_session_id: null,
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                connection_source: "saved_session",
                path: "/srv/app",
              },
            ],
          },
        },
      ],
    });
  });

  it("shows the active SSH host in the titlebar", () => {
    storeMocks.sessionState.sessions = [
      {
        id: "ssh-1",
        name: "生产机",
        type: "ssh",
        group_id: null,
        host: "10.20.30.40",
        port: 22,
        username: "root",
        auth_mode: "none",
        credential_ref: null,
        description: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: null,
      },
    ];
    Object.assign(storeMocks.workspaceState.tabs[0].root as Record<string, unknown>, {
      runtime_session_id: "runtime-ssh",
      saved_session_id: "ssh-1",
      terminal_tabs: [
        {
          id: "pane-1-tab-1",
          title: "生产机",
          runtime_session_id: "runtime-ssh",
          saved_session_id: "ssh-1",
        },
      ],
    });

    const view = render(<AppShell />);

    expect(view.container.querySelector('[aria-label="标题栏"]')?.textContent).toBe("10.20.30.40");
    view.unmount();
  });

  it("shows all channel hosts in the titlebar while a channel member is active", () => {
    storeMocks.sessionState.sessions = [
      {
        id: "ssh-1", name: "生产机 A", type: "ssh", group_id: null, host: "10.20.30.40", port: 22,
        username: "root", auth_mode: "none", credential_ref: null, description: null, tags: [], sort_order: 0,
        created_at_ms: 1, updated_at_ms: 1, last_used_at_ms: null,
      },
      {
        id: "ssh-2", name: "生产机 B", type: "ssh", group_id: null, host: "10.20.30.41", port: 22,
        username: "root", auth_mode: "none", credential_ref: null, description: null, tags: [], sort_order: 1,
        created_at_ms: 1, updated_at_ms: 1, last_used_at_ms: null,
      },
    ];
    storeMocks.terminalState.runtimes = {
      "runtime-1": { runtime_session_id: "runtime-1", kind: "ssh", title: "生产机 A" },
      "runtime-2": { runtime_session_id: "runtime-2", kind: "ssh", title: "生产机 B" },
    };
    Object.assign(storeMocks.workspaceState.tabs[0].root as Record<string, unknown>, {
      runtime_session_id: "runtime-1",
      saved_session_id: "ssh-1",
      active_terminal_tab_id: "pane-1-tab-1",
      terminal_tabs: [
        { id: "pane-1-tab-1", title: "生产机 A", runtime_session_id: "runtime-1", saved_session_id: "ssh-1" },
        { id: "pane-1-tab-2", title: "生产机 B", runtime_session_id: "runtime-2", saved_session_id: "ssh-2" },
      ],
    });
    useSyncInputStore.getState().createChannel([
      { id: "pane-1-tab-1", runtimeSessionId: "runtime-1", title: "生产机 A", host: "10.20.30.40" },
      { id: "pane-1-tab-2", runtimeSessionId: "runtime-2", title: "生产机 B", host: "10.20.30.41" },
    ]);

    const view = render(<AppShell />);

    expect(view.container.querySelector('[aria-label="标题栏"]')?.textContent).toBe(
      "频道：10.20.30.40、10.20.30.41",
    );
    view.unmount();
  });

  it("shows the configured working directory for the active local terminal", () => {
    storeMocks.sessionState.sessions = [
      {
        id: "local-1",
        name: "项目终端",
        type: "local",
        group_id: null,
        host: "localhost",
        port: 1,
        username: "",
        auth_mode: "none",
        credential_ref: null,
        description: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: null,
        local_options: { working_directory: "D:\\workspace\\zterm" },
      },
    ];
    Object.assign(storeMocks.workspaceState.tabs[0].root as Record<string, unknown>, {
      runtime_session_id: "runtime-local",
      saved_session_id: "local-1",
      terminal_tabs: [
        {
          id: "pane-1-tab-1",
          title: "项目终端",
          runtime_session_id: "runtime-local",
          saved_session_id: "local-1",
        },
      ],
    });

    const view = render(<AppShell />);

    expect(view.container.querySelector('[aria-label="标题栏"]')?.textContent).toBe("D:\\workspace\\zterm");
    view.unmount();
  });

  it("opens a pending external SSH launch and automatically loads SFTP files", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "ops@cloud.example.test:2200",
        host: "cloud.example.test",
        port: 2200,
        username: "ops",
        auto_open_sftp: true,
        remote_path: "/srv/app",
      },
    ];
    storeMocks.openTerminal.mockResolvedValueOnce({
      runtime_session_id: "runtime-external",
      saved_session_id: "external:launch-1",
      history_scope_kind: null,
      history_scope_id: null,
      pane_id: "pane-1",
      title: "ops@cloud.example.test:2200",
      kind: "ssh",
      cols: 120,
      rows: 32,
    });

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({
        title: "ops@cloud.example.test:2200",
        saved_session_id: "external:launch-1",
        connection_source: "external_ssh",
        restore_status: "pending",
      }),
    );
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("external:launch-1", "pane-1");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({
        runtime_session_id: "runtime-external",
        saved_session_id: "external:launch-1",
      }),
    );
    expect(storeMocks.listFiles).toHaveBeenCalledWith("external:launch-1", "/srv/app");
    expect(storeMocks.loadTransfers).toHaveBeenCalledWith("external:launch-1");

    view.unmount();
  });

  it("shows transient SSH container and tunnel tools and updates the selected container runtime", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "ops@cloud.example.test:2200",
        host: "cloud.example.test",
        port: 2200,
        username: "ops",
        auto_open_sftp: false,
        remote_path: "/",
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "ops@cloud.example.test:2200",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "ops@cloud.example.test:2200",
          runtime_session_id: "runtime-external",
          saved_session_id: "external:launch-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "ops@cloud.example.test:2200",
              runtime_session_id: "runtime-external",
              saved_session_id: "external:launch-1",
              connection_source: "external_ssh",
            },
          ],
        },
      },
    ];

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.getExternalSshOptions).toHaveBeenCalledWith("external:launch-1");
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 容器"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 隧道"]')).not.toBe(null);

    await clickButton(view.container, "SSH 容器");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.listSshContainers).toHaveBeenCalledWith("external:launch-1", {
      runtimeSessionId: "runtime-external",
    });
    expect(view.container.querySelector('[aria-label="容器运行时"]')?.textContent).toContain("Docker");

    await act(async () => {
      (view.container.querySelector('[aria-label="进入容器 api"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.enterSshContainerRuntime).toHaveBeenCalledWith("external:launch-1", "runtime-external", "abc123");
    expect(storeMocks.addPaneTabAfter).not.toHaveBeenCalled();
    expect(storeMocks.openSshContainerTerminal).not.toHaveBeenCalled();

    await act(async () => {
      (view.container.querySelector('[aria-label="容器运行时"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (document.body.querySelector('[role="option"][data-value="podman"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.updateExternalSshOptions).toHaveBeenCalledWith(
      "external:launch-1",
      expect.objectContaining({
        container: expect.objectContaining({ enabled: true, runtime: "podman" }),
      }),
    );
    expect(storeMocks.listSshContainers).toHaveBeenLastCalledWith("external:launch-1", {
      runtimeSessionId: "runtime-external",
    });

    view.unmount();
  });

  it("shows SSH tools and limits tunnel editing for single-channel external SSH", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=@172.21.195.223:222",
        host: "172.21.195.223",
        port: 222,
        username: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=",
        auto_open_sftp: false,
        remote_path: "/",
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "bhost",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "bhost",
          runtime_session_id: "runtime-external",
          saved_session_id: "external:launch-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "bhost",
              runtime_session_id: "runtime-external",
              saved_session_id: "external:launch-1",
              connection_source: "external_ssh",
            },
          ],
        },
      },
    ];

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 容器"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 隧道"]')).not.toBe(null);
    expect(storeMocks.listSshContainers).not.toHaveBeenCalled();

    await clickButton(view.container, "SSH 隧道");
    await clickButton(view.container, "添加临时 SSH 隧道");
    await clickButton(view.container, "添加隧道");

    expect(view.container.textContent).toContain("单通道临时 SSH 只支持一个隧道");
    expect((button(view.container, "添加隧道") as HTMLButtonElement).disabled).toBe(true);

    view.unmount();
  });

  it("edits transient SSH tunnels in a tunnel-only dialog and marks them as requiring reconnect", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=@172.21.195.223:222",
        host: "172.21.195.223",
        port: 222,
        username: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=",
        auto_open_sftp: false,
        remote_path: "/",
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "ops@cloud.example.test:2200",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "ops@cloud.example.test:2200",
          runtime_session_id: "runtime-external",
          saved_session_id: "external:launch-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "ops@cloud.example.test:2200",
              runtime_session_id: "runtime-external",
              saved_session_id: "external:launch-1",
              connection_source: "external_ssh",
            },
          ],
        },
      },
    ];

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await clickButton(view.container, "SSH 隧道");
    expect(view.container.querySelector(".zt-transient-tunnel-panel")).not.toBe(null);
    expect(view.container.querySelector(".zt-transient-tunnel-actions")).not.toBe(null);
    expect(view.container.querySelector('[aria-label="新增隧道"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="添加临时 SSH 隧道"]')).not.toBe(null);
    expect(view.container.textContent).toContain("当前 SSH 连接没有配置隧道");

    await clickButton(view.container, "添加临时 SSH 隧道");
    const dialog = view.container.querySelector('[role="dialog"]');
    expect(dialog?.classList.contains("zt-transient-tunnel-dialog")).toBe(true);
    expect(dialog?.querySelector(".zt-transient-tunnel-body")).not.toBe(null);
    expect(dialog?.textContent).toContain("临时 SSH 隧道");
    expect(dialog?.textContent).toContain("添加隧道");
    expect(dialog?.querySelector('[aria-label="认证方式"]')).toBe(null);
    expect(dialog?.querySelector('input[aria-label="主机"]')).toBe(null);

    await clickButton(view.container, "添加隧道");
    const targetHostInput = input(dialog!, "主机目标地址");
    expect(targetHostInput.readOnly).toBe(false);
    expect(targetHostInput.value).toBe("127.0.0.1");
    await clickButton(view.container, "保存临时隧道");

    expect(storeMocks.updateExternalSshOptions).toHaveBeenCalledWith(
      "external:launch-1",
      expect.objectContaining({
        tunnels: [
          expect.objectContaining({
            mode: "host_service",
            kind: "local",
            remote_host: "127.0.0.1",
          }),
        ],
      }),
    );
    expect(view.container.textContent).toContain("重连后生效");
    expect(view.container.querySelector('[aria-label="重连临时 SSH"]')).not.toBe(null);

    view.unmount();
  });

  it("translates workbench chrome and dynamic DOM text when language is English", async () => {
    storeMocks.settingsState.appSettings = {
      ...storeMocks.settingsState.appSettings,
      language: "enUS",
    };
    const view = render(<AppShell />);

    await flushDomI18n();

    expect(view.container.querySelector('[aria-label="Title Bar"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-left-rail [aria-label="Workspace"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-left-rail [aria-label="Sessions"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-left-rail [aria-label="File Transfer"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-left-rail [aria-label="Models"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-left-rail [aria-label="Open Settings"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="Terminal Panes"]')).not.toBe(null);
    expect(view.container.textContent).toContain("New Terminal");

    const dynamicButton = document.createElement("button");
    dynamicButton.setAttribute("aria-label", "删除工作区 运维巡检");
    dynamicButton.textContent = "确认删除工作区";
    view.container.appendChild(dynamicButton);

    const skipped = document.createElement("div");
    skipped.dataset.noI18n = "true";
    skipped.textContent = "新建终端";
    view.container.appendChild(skipped);

    const ftpText = document.createElement("div");
    ftpText.innerHTML = "<span>初始远程目录</span><span>匿名登录</span><span>FTP 不加密账号、密码和传输内容；敏感环境请使用 SFTP。</span>";
    ftpText.setAttribute("aria-label", "新建 FTP 会话");
    view.container.appendChild(ftpText);
    const sftpCredentialName = document.createElement("span");
    sftpCredentialName.textContent = "发布 SFTP SFTP 密钥密码";
    view.container.appendChild(sftpCredentialName);

    await flushDomI18n();

    expect(dynamicButton.getAttribute("aria-label")).toBe("Delete Workspace 运维巡检");
    expect(dynamicButton.textContent).toBe("Confirm Delete Workspace");
    expect(skipped.textContent).toBe("新建终端");
    expect(ftpText.getAttribute("aria-label")).toBe("New FTP Session");
    expect(ftpText.textContent).toContain("Initial Remote Directory");
    expect(ftpText.textContent).toContain("Anonymous Login");
    expect(ftpText.textContent).toContain("FTP does not encrypt credentials");
    expect(sftpCredentialName.textContent).toBe("发布 SFTP SFTP Key Passphrase");

    view.unmount();
  });

  it("opens settings page from the bottom left rail settings icon without mounting removed bottom dock", async () => {
    const view = render(<AppShell />);
    const settingsButton = view.container.querySelector('.zt-left-rail [aria-label="打开设置"]') as HTMLButtonElement;

    expect(settingsButton).not.toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="打开设置"]')).toBe(null);

    await act(async () => {
      settingsButton.click();
    });

    expect(view.container.querySelector('[aria-label="关闭设置"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="返回工作台"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="底部面板"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="状态栏"]')).toBe(null);
    expect(view.container.querySelector(".zt-statusbar")).toBe(null);
    expect(view.container.textContent).not.toContain("Sender");
    expect(view.container.textContent).not.toContain("UTF-8");
    expect(view.container.querySelector('[aria-label="标题栏"]')?.querySelector('[aria-label="打开设置"]')).toBe(null);

    await act(async () => {
      (view.container.querySelector('[aria-label="关闭设置"]') as HTMLButtonElement).click();
    });

    expect(view.container.querySelector('[aria-label="终端分栏"]')).not.toBe(null);

    view.unmount();
  });

  it("prevents the default context menu on the workbench and settings page", async () => {
    const view = render(<AppShell />);
    const workbench = view.container.querySelector(".zt-workbench") as HTMLElement;
    const workbenchEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    workbench.dispatchEvent(workbenchEvent);
    expect(workbenchEvent.defaultPrevented).toBe(true);

    await clickButton(view.container, "打开设置");
    const settingsWorkbench = view.container.querySelector(".zt-workbench-settings") as HTMLElement;
    const settingsEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    settingsWorkbench.dispatchEvent(settingsEvent);
    expect(settingsEvent.defaultPrevented).toBe(true);

    view.unmount();
  });

  it("keeps the left rail visible while workspace and session panels start collapsed", async () => {
    const view = render(<AppShell />);
    const workbench = view.container.querySelector(".zt-workbench");
    const workspaceButton = button(view.container, "工作区");
    const sessionButton = button(view.container, "会话");
    const fileTransferButton = button(view.container, "文件传输");
    const modelButton = button(view.container, "模型");
    const leftRailLabels = Array.from(view.container.querySelectorAll(".zt-left-rail button")).map((item) =>
      item.getAttribute("aria-label"),
    );

    expect(view.container.querySelector('[aria-label="左侧管理"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="左侧管理切换"]')).not.toBe(null);
    expect(leftRailLabels).toEqual(["会话", "工作区", "模型", "文件传输", "打开设置"]);
    expect(view.container.querySelector('[aria-label="工作区管理"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="会话管理"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="会话树"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-left-collapsed")).toBe(true);
    expect(view.container.querySelector('[aria-label="展开左侧栏"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="折叠左侧栏"]')).toBe(null);
    expect(workspaceButton.getAttribute("aria-pressed")).toBe("false");
    expect(workspaceButton.getAttribute("aria-expanded")).toBe("false");
    expect(workspaceButton.querySelector("svg")?.classList.contains("lucide-panels-top-left")).toBe(true);
    expect(sessionButton.getAttribute("aria-pressed")).toBe("false");
    expect(sessionButton.getAttribute("aria-expanded")).toBe("false");
    expect(fileTransferButton.getAttribute("aria-pressed")).toBe("false");
    expect(fileTransferButton.getAttribute("aria-expanded")).toBe("false");
    expect(modelButton.querySelector("svg")?.classList.contains("lucide-bot")).toBe(true);

    view.unmount();
  });

  it("toggles workspace and session panels from the left rail", async () => {
    const view = render(<AppShell />);
    const workbench = view.container.querySelector(".zt-workbench");

    await clickButton(view.container, "工作区");

    expect(view.container.querySelector('[aria-label="工作区管理"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="会话管理"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-left-collapsed")).toBe(false);
    expect(button(view.container, "工作区").getAttribute("aria-pressed")).toBe("true");
    expect(button(view.container, "工作区").getAttribute("aria-expanded")).toBe("true");

    await clickButton(view.container, "工作区");

    expect(view.container.querySelector('[aria-label="工作区管理"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-left-collapsed")).toBe(true);
    expect(button(view.container, "工作区").getAttribute("aria-pressed")).toBe("false");
    expect(button(view.container, "工作区").getAttribute("aria-expanded")).toBe("false");

    await clickButton(view.container, "会话");

    expect(view.container.querySelector('[aria-label="会话树"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="会话管理"]')).not.toBe(null);
    expect(button(view.container, "添加文件夹").classList.contains("zt-panel-action-button")).toBe(true);
    expect(view.container.querySelector('[aria-label="工作区管理"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-left-collapsed")).toBe(false);
    expect(button(view.container, "会话").getAttribute("aria-pressed")).toBe("true");
    expect(button(view.container, "会话").getAttribute("aria-expanded")).toBe("true");

    await clickButton(view.container, "模型");

    expect(view.container.querySelector('[aria-label="模型管理"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="工作区管理"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="会话管理"]')).toBe(null);
    expect(button(view.container, "模型").getAttribute("aria-pressed")).toBe("true");
    expect(button(view.container, "模型").getAttribute("aria-expanded")).toBe("true");
    expect(button(view.container, "会话").getAttribute("aria-pressed")).toBe("false");
    expect(storeMocks.modelPanelProps?.providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "OpenAI Compatible" })]),
    );

    await clickButton(view.container, "工作区");

    expect(view.container.querySelector('[aria-label="工作区管理"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="会话管理"]')).toBe(null);
    expect(button(view.container, "工作区").getAttribute("aria-pressed")).toBe("true");
    expect(button(view.container, "会话").getAttribute("aria-pressed")).toBe("false");

    await clickButton(view.container, "工作区");

    expect(view.container.querySelector('[aria-label="工作区管理"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="会话管理"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-left-collapsed")).toBe(true);

    view.unmount();
  });

  it("does not expose model management inside settings after moving models to the foreground sidebar", async () => {
    const view = render(<AppShell />);

    await clickButton(view.container, "打开设置");

    expect(view.container.querySelector('[aria-label="设置分类"]')?.textContent).not.toContain("模型");
    expect(view.container.querySelector('[aria-label="AI Provider 设置"]')).toBe(null);

    view.unmount();
  });

  it("renders workspace management from the left workspace rail button", async () => {
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");

    const workspacePanel = view.container.querySelector('[aria-label="工作区管理"]');
    const sessionPanel = view.container.querySelector('[aria-label="会话管理"]');

    expect(workspacePanel).not.toBe(null);
    expect(sessionPanel).toBe(null);
    expect(workspacePanel?.querySelector(".zt-panel-header")?.textContent).toContain("Workspace");
    expect(workspacePanel?.querySelector(".zt-panel-header > svg")).toBe(null);
    expect(workspacePanel?.textContent).toContain("运维巡检");
    expect(workspacePanel?.querySelector(".zt-workspace-dot")).toBe(null);
    expect(workspacePanel?.querySelector('[aria-label="新建工作区"]')).not.toBeNull();

    view.unmount();
  });

  it("loads closed workspace definitions once for sidebar layout thumbnails", async () => {
    storeMocks.workspaceList.mockResolvedValue([
      {
        id: "workspace-closed",
        name: "发布窗口",
        status: "closed",
        active_tab_id: "tab-closed",
        tab_count: 1,
        sort_order: 2,
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    ]);
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-closed",
      name: "发布窗口",
      status: "closed",
      active_tab_id: "tab-closed",
      sort_order: 2,
      created_at_ms: 1,
      updated_at_ms: 2,
      tabs: [
        {
          id: "tab-closed",
          title: "发布",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 2,
          root: workspaceSplitRoot(),
        },
      ],
    });
    const view = render(<AppShell />);

    await act(async () => {
      await Promise.resolve();
    });
    await clickButton(view.container, "工作区");
    await act(async () => {
      await Promise.resolve();
    });

    expect(storeMocks.workspaceGet).toHaveBeenCalledTimes(2);
    expect(storeMocks.workspaceGet).toHaveBeenCalledWith("default-workspace");
    expect(storeMocks.workspaceGet).toHaveBeenCalledWith("workspace-closed");
    expect(view.container.querySelector('.zt-workspace-thumbnail.placeholder')).not.toBeNull();

    await clickButton(view.container, "会话");
    await clickButton(view.container, "工作区");
    await act(async () => {
      await Promise.resolve();
    });

    expect(storeMocks.workspaceGet).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("does not render live running workspace roots as sidebar thumbnails", async () => {
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "主工作台",
            active_pane_id: "pane-4",
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            root: workspaceSplitRoot(),
          },
        ],
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");

    expect(view.container.querySelector(".zt-workspace-layout-preview.thumbnail")).toBe(null);
    expect(view.container.querySelector(".zt-workspace-thumbnail.placeholder")).not.toBe(null);

    view.unmount();
  });

  it("opens a workspace preview dialog for editing tab connection and path metadata", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        host: "10.0.0.10",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickWorkspaceContextAction(view.container, "运维巡检", "编辑工作区 运维巡检");

    const dialog = view.container.querySelector('.zt-workspace-preview-dialog[aria-label="编辑工作区 运维巡检"]');
    expect(dialog).not.toBe(null);
    expect(dialog?.querySelector('[aria-label="编辑工作区名称"]')).toHaveProperty("value", "运维巡检");
    expect(dialog?.textContent).not.toContain("主工作台");
    expect(dialog?.textContent).toContain("生产机");
    expect(dialog?.querySelector('[aria-label="编辑标签路径"]')).toHaveProperty("value", "/srv/app");
    expect(dialog?.querySelector('[aria-label="编辑标签连接"]')).toHaveProperty("value", "session-1");

    view.unmount();
  });

  it("shows a faithful four-pane workspace preview with a right-side terminal tab editor", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "172.16.41.181",
        host: "172.16.41.181",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.buildActiveWorkspaceDraft.mockReturnValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "running",
      active_tab_id: "tab-1",
      sort_order: 0,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-4",
          sort_order: 0,
          root: workspaceSplitRoot(),
        },
        {
          id: "tab-2",
          title: "备用",
          active_pane_id: "pane-extra",
          sort_order: 1,
          root: {
            kind: "leaf",
            id: "pane-extra",
            title: "备用终端",
            runtime_session_id: null,
            saved_session_id: null,
            active_terminal_tab_id: "pane-extra-tab-1",
            terminal_tabs: [
              {
                id: "pane-extra-tab-1",
                title: "备用终端",
                runtime_session_id: null,
                saved_session_id: null,
              },
            ],
          },
        },
      ],
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickWorkspaceContextAction(view.container, "运维巡检", "编辑工作区 运维巡检");

    const dialog = view.container.querySelector('.zt-workspace-preview-dialog[aria-label="编辑工作区 运维巡检"]');
    expect(dialog?.querySelectorAll(".zt-workspace-layout-pane")).toHaveLength(4);
    expect(dialog?.querySelector(".zt-workspace-layout-pane.selected")?.getAttribute("data-pane-id")).toBe("pane-4");
    expect(dialog?.querySelector('[aria-label="切换工作区标签 备用"]')).not.toBe(null);
    expect(dialog?.querySelector('[aria-label="终端标签 pane-4-tab-1"]')).not.toBe(null);
    expect(dialog?.querySelector('[aria-label="编辑标签路径"]')).toHaveProperty("value", "");

    await act(async () => {
      (dialog?.querySelector('[data-pane-id="pane-5"]') as HTMLButtonElement).click();
    });

    expect(dialog?.querySelector(".zt-workspace-preview-inspector")?.textContent).not.toContain("pane-5");
    expect(dialog?.querySelector('[aria-label="终端标签 pane-5-tab-1"]')).not.toBe(null);
    expect(dialog?.querySelector('[aria-label="编辑标签连接"]')).toHaveProperty("value", "session-1");
    expect(dialog?.querySelector('[aria-label="编辑标签路径"]')).toHaveProperty("value", "/srv/app");

    await act(async () => {
      (dialog?.querySelector('[aria-label="切换工作区标签 备用"]') as HTMLButtonElement).click();
    });

    expect(dialog?.querySelectorAll(".zt-workspace-layout-pane")).toHaveLength(1);
    expect(dialog?.textContent).toContain("备用终端");

    view.unmount();
  });

  it("creates a workspace from the current runtime layout through the workspace editor", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    storeMocks.workspaceSave.mockResolvedValue({
      id: "workspace-new",
      name: "发布窗口",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 1,
      created_at_ms: 2,
      updated_at_ms: 2,
      tabs: [],
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      (view.container.querySelector('[aria-label="新建工作区"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const dialog = view.container.querySelector('.zt-workspace-preview-dialog[aria-label="新建工作区"]');
    expect(dialog).not.toBe(null);
    expect(dialog?.textContent).not.toContain("127.0.0.1");
    expect(dialog?.textContent).not.toContain("localhost");
    expect(promptSpy).not.toHaveBeenCalled();
    expect(input(dialog!, "编辑工作区名称")).toHaveProperty("value", "新建工作区");

    change(input(dialog!, "编辑工作区名称"), "发布窗口");

    await act(async () => {
      button(dialog as HTMLElement, "保存工作区").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.workspaceSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: null,
        name: "发布窗口",
        status: "closed",
        sort_order: 1,
      }),
    );
    expect(view.container.querySelector('[aria-label="保存工作区"]')).not.toBeNull();

    promptSpy.mockRestore();
    view.unmount();
  });

  it("opens a second-instance external SSH launch in a new pane tab", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "Existing SSH",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "Existing SSH",
          runtime_session_id: "runtime-existing",
          saved_session_id: "session-existing",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "Existing SSH",
              runtime_session_id: "runtime-existing",
              saved_session_id: "session-existing",
            },
          ],
        },
      },
    ];
    storeMocks.addPaneTab.mockReturnValue({ id: "pane-1-tab-2" });

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    storeMocks.pendingExternalLaunches.push({
      id: "external:launch-2",
      name: "ops@second.example.test:22",
      host: "second.example.test",
      port: 22,
      username: "ops",
      auto_open_sftp: false,
      remote_path: "/",
    });
    await act(async () => {
      storeMocks.tauriEventHandlers.get("zterm:external-ssh-launch")?.({ payload: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.takePendingExternalLaunches).toHaveBeenCalledTimes(2);
    expect(storeMocks.addPaneTab).toHaveBeenCalledWith("pane-1");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-2",
      expect.objectContaining({
        saved_session_id: "external:launch-2",
        connection_source: "external_ssh",
      }),
    );
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("external:launch-2", "pane-1");

    view.unmount();
  });

  it("opens manual save from the live workbench snapshot for the selected workspace", async () => {
    storeMocks.workspaceSave.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 2,
      tabs: [],
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickButton(view.container, "选择工作区 运维巡检");
    await clickButton(view.container, "保存工作区");

    const dialog = view.container.querySelector('.zt-workspace-preview-dialog[aria-label="编辑工作区 运维巡检"]');
    expect(dialog).not.toBeNull();
    expect(input(dialog!, "编辑工作区名称")).toHaveProperty("value", "运维巡检");
    expect(dialog?.textContent).toContain("生产机");

    await act(async () => {
      button(dialog as HTMLElement, "保存工作区").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.workspaceSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-1", name: "运维巡检", active_tab_id: "tab-1" }),
    );
    expect(storeMocks.restoreWorkbenchDefinition).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not probe terminal cwd when saving workspace metadata from the editor", async () => {
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "主工作台",
            active_pane_id: "pane-1",
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            root: {
              kind: "leaf",
              id: "pane-1",
              title: "PowerShell 7",
              runtime_session_id: "runtime-local",
              saved_session_id: null,
              active_terminal_tab_id: "pane-1-tab-1",
              terminal_tabs: [
                {
                  id: "pane-1-tab-1",
                  title: "PowerShell 7",
                  runtime_session_id: "runtime-local",
                  saved_session_id: null,
                  connection_source: "default_local",
                  path: "C:\\existing",
                },
              ],
            },
          },
        ],
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.tabs = storeMocks.workspaceState.workspaces[0].tabs as Array<Record<string, unknown>>;
    storeMocks.buildActiveWorkspaceDraft.mockReturnValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "PowerShell 7",
            runtime_session_id: null,
            saved_session_id: null,
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "PowerShell 7",
                runtime_session_id: null,
                saved_session_id: null,
                connection_source: "default_local",
                path: "C:\\existing",
              },
            ],
          },
        },
      ],
    });
    storeMocks.terminalState.runtimes = {
      "runtime-local": {
        runtime_session_id: "runtime-local",
        saved_session_id: null,
        history_scope_kind: "local_profile",
        history_scope_id: "pwsh",
        pane_id: "pane-1",
        title: "PowerShell 7",
        kind: "local",
        cols: 120,
        rows: 32,
      },
    };
    storeMocks.workspaceSave.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 2,
      tabs: [],
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickWorkspaceContextAction(view.container, "运维巡检", "编辑工作区 运维巡检");

    const dialog = view.container.querySelector('.zt-workspace-preview-dialog[aria-label="编辑工作区 运维巡检"]');
    expect(dialog).not.toBe(null);
    expect(input(dialog!, "编辑标签路径")).toHaveProperty("value", "C:\\existing");
    change(textarea(dialog!, "编辑连接后指令"), "npm run dev");

    await act(async () => {
      button(dialog as HTMLElement, "保存工作区").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.updatePaneTerminalTab).not.toHaveBeenCalledWith(
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ path: expect.any(String) }),
    );
    expect(storeMocks.workspaceSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workspace-1",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            root: expect.objectContaining({
              terminal_tabs: expect.arrayContaining([
                expect.objectContaining({
                  id: "pane-1-tab-1",
                  path: "C:\\existing",
                  startup_command: "npm run dev",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );

    view.unmount();
  });

  it("deletes a saved workspace without touching the live workbench runtime", async () => {
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickWorkspaceContextAction(view.container, "运维巡检", "删除工作区 运维巡检");

    const dialog = view.container.querySelector('[role="dialog"][aria-label="删除工作区"]');
    expect(dialog?.textContent).toContain("确认删除工作区“运维巡检”");

    await act(async () => {
      (dialog?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.closeTerminal).not.toHaveBeenCalled();
    expect(storeMocks.workspaceRemove).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.removeWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(view.container.querySelector('[aria-label="新建工作区"]')).not.toBeNull();

    view.unmount();
  });

  it("confirms before restore and aborts after partially failing to close live runtimes", async () => {
    storeMocks.getWorkspaceRuntimeSessionIds.mockReturnValue(["runtime-ok", "runtime-failed"]);
    storeMocks.closeTerminal.mockImplementation(async (runtimeSessionId: string) => {
      if (runtimeSessionId === "runtime-failed") throw new Error("close failed");
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      await Promise.resolve();
    });
    storeMocks.workspaceGet.mockClear();
    await clickWorkspaceContextAction(view.container, "运维巡检", "恢复工作区 运维巡检");

    const dialog = view.container.querySelector('[role="dialog"][aria-label="恢复工作区"]');
    expect(dialog?.textContent).toContain("将关闭当前工作台中的全部终端");
    expect(storeMocks.workspaceGet).not.toHaveBeenCalled();

    await act(async () => {
      (dialog?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.clearRuntimeSession).toHaveBeenCalledWith("runtime-ok");
    expect(storeMocks.clearRuntimeSession).not.toHaveBeenCalledWith("runtime-failed");
    expect(storeMocks.restoreWorkbenchDefinition).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("close failed");
    view.unmount();
  });

  it("does not show a thumbnail error when a deleted workspace's in-flight preview request fails", async () => {
    const deletedPreview = deferred<Record<string, unknown>>();
    const deletedWorkspace = {
      id: "workspace-deleted",
      name: "待删除工作区",
      status: "closed" as const,
      active_tab_id: "deleted-tab",
      tab_count: 1,
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    const remainingWorkspace = {
      id: "workspace-remaining",
      name: "保留工作区",
      status: "closed" as const,
      active_tab_id: "remaining-tab",
      tab_count: 1,
      sort_order: 1,
      created_at_ms: 1,
      updated_at_ms: 2,
    };
    const refreshedSummaries = deferred<(typeof remainingWorkspace)[]>();
    storeMocks.workspaceState.workspaces = [];
    storeMocks.workspaceState.activeWorkspaceId = "default-workspace";
    storeMocks.workspaceList
      .mockResolvedValueOnce([deletedWorkspace, remainingWorkspace])
      .mockImplementationOnce(() => refreshedSummaries.promise);
    storeMocks.prefetchWorkspaceDefinitions.mockResolvedValue(undefined);
    storeMocks.workspaceGet.mockImplementation((workspaceId: string) => {
      if (workspaceId === deletedWorkspace.id) return deletedPreview.promise;
      return Promise.resolve({
        ...remainingWorkspace,
        tabs: [
          {
            id: "remaining-tab",
            title: "保留",
            active_pane_id: "pane-1",
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 2,
            root: workspaceSplitRoot(),
          },
        ],
      });
    });
    const view = render(<AppShell />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await clickButton(view.container, "工作区");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(storeMocks.workspaceGet).toHaveBeenCalledWith("workspace-deleted");

    await clickWorkspaceContextAction(view.container, "待删除工作区", "删除工作区 待删除工作区");
    const dialog = view.container.querySelector('[role="dialog"][aria-label="删除工作区"]');
    await act(async () => {
      (dialog?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      deletedPreview.reject(new Error("workspace has been deleted"));
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    expect(view.container.textContent).not.toContain("加载工作区缩略图失败");
    expect(view.container.querySelector('[aria-label="工作区 待删除工作区"]')).toBeNull();

    await act(async () => {
      refreshedSummaries.resolve([remainingWorkspace]);
      await Promise.resolve();
    });
    expect(view.container.querySelector('[aria-label="工作区 保留工作区"]')).not.toBeNull();

    view.unmount();
  });

  it("hides the default workspace from workspace management", async () => {
    storeMocks.workspaceState.workspaces = [
      {
        id: "default-workspace",
        name: "默认工作区",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.activeWorkspaceId = "default-workspace";
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");

    expect(view.container.querySelector('[aria-label="工作区 默认工作区"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="切换工作区 默认工作区"]')).toBeNull();
    expect(view.container.querySelector('[role="dialog"][aria-label="删除工作区"]')).toBe(null);
    expect(storeMocks.workspaceRemove).not.toHaveBeenCalled();

    view.unmount();
  });

  it("does not auto-open a default local terminal while a workspace tab is restoring", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "主工作台",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "生产机",
          runtime_session_id: null,
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "生产机",
              runtime_session_id: null,
              saved_session_id: "session-1",
              connection_source: "saved_session",
              restore_status: "pending",
            },
          ],
        },
      },
    ];

    const view = render(<AppShell />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();

    view.unmount();
  });

  it("restores the previous default workspace layout and connections on startup", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        host: "10.0.0.10",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceGet.mockResolvedValue({
      id: "default-workspace",
      name: "默认工作区",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "生产机",
            runtime_session_id: null,
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                connection_source: "saved_session",
              },
            ],
          },
        },
      ],
    });
    storeMocks.openTerminal.mockResolvedValue({
      runtime_session_id: "runtime-restored",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "生产机",
      kind: "ssh",
      cols: 120,
      rows: 32,
    });

    const view = render(<AppShell />);
    await flushWorkspacePostLayoutWork();

    expect(storeMocks.workspaceGet).toHaveBeenCalledWith("default-workspace");
    expect(storeMocks.restoreWorkbenchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ id: "default-workspace", status: "running" }),
    );
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1", null);
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ runtime_session_id: "runtime-restored", restore_status: "connected" }),
    );

    view.unmount();
  });

  it("restores workspace terminals and sends the configured startup command after connect", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        host: "10.0.0.10",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "closed",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.buildActiveWorkspaceDraft.mockReturnValueOnce(null);
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "生产机",
            runtime_session_id: null,
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                connection_source: "saved_session",
                path: "/srv/app",
                startup_command: "source ./env.sh",
              },
            ],
          },
        },
      ],
    });
    storeMocks.openTerminal.mockResolvedValue({
      runtime_session_id: "runtime-ssh",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "生产机",
      kind: "ssh",
      cols: 120,
      rows: 32,
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "恢复工作区 运维巡检").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushWorkspacePostLayoutWork();

    expect(storeMocks.workspaceGet).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.restoreWorkbenchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ id: "default-workspace", status: "running" }),
    );
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1", "/srv/app");
    expect(storeMocks.writeTerminal).toHaveBeenCalledWith("runtime-ssh", "source ./env.sh\r");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ restore_status: "connected", runtime_session_id: "runtime-ssh" }),
    );

    view.unmount();
  });

  it("selects the restored workspace before the first terminal connection finishes", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        host: "10.0.0.10",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "closed",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.buildActiveWorkspaceDraft.mockReturnValueOnce(null);
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "生产机",
            runtime_session_id: null,
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                connection_source: "saved_session",
              },
            ],
          },
        },
      ],
    });
    const opened = deferred<{
      runtime_session_id: string;
      saved_session_id: string;
      history_scope_kind: string;
      history_scope_id: string;
      pane_id: string;
      title: string;
      kind: string;
      cols: number;
      rows: number;
    }>();
    storeMocks.openTerminal.mockReturnValueOnce(opened.promise);
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "恢复工作区 运维巡检").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.restoreWorkbenchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "default-workspace",
        status: "running",
        tabs: [
          expect.objectContaining({
            root: expect.objectContaining({
              terminal_tabs: [expect.objectContaining({ restore_status: "queued", restore_error: null })],
            }),
          }),
        ],
      }),
    );
    expect(view.container.querySelector('[aria-label="保存工作区"]')).not.toBeNull();
    expect(storeMocks.openTerminal).toHaveBeenCalledTimes(1);
    expect(storeMocks.updatePaneTerminalTab).not.toHaveBeenCalledWith(
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ restore_status: "connected" }),
    );

    await act(async () => {
      opened.resolve({
        runtime_session_id: "runtime-ssh",
        saved_session_id: "session-1",
        history_scope_kind: "saved_session",
        history_scope_id: "session-1",
        pane_id: "pane-1",
        title: "生产机",
        kind: "ssh",
        cols: 120,
        rows: 32,
      });
      await opened.promise;
      await Promise.resolve();
    });

    view.unmount();
  });

  it("restores only the saved layout without opening terminals when the restore strategy is layout_only", async () => {
    storeMocks.settingsState.appSettings = {
      ...storeMocks.settingsState.appSettings,
      workspace_restore_strategy: "layout_only",
    };
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "closed",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.buildActiveWorkspaceDraft.mockReturnValueOnce(null);
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "PowerShell 7",
            runtime_session_id: null,
            saved_session_id: null,
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "PowerShell 7",
                runtime_session_id: null,
                saved_session_id: null,
                connection_source: "default_local",
              },
            ],
          },
        },
      ],
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "恢复工作区 运维巡检").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushWorkspacePostLayoutWork();

    expect(storeMocks.restoreWorkbenchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "default-workspace",
        status: "running",
        tabs: [
          expect.objectContaining({
            root: expect.objectContaining({
              terminal_tabs: [expect.objectContaining({ restore_status: "queued", restore_error: null })],
            }),
          }),
        ],
      }),
    );
    expect(storeMocks.openTerminal).not.toHaveBeenCalled();
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.updatePaneTerminalTab).not.toHaveBeenCalled();

    view.unmount();
  });

  it("does not generate an SSH cd command from recorded workspace paths", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        host: "10.0.0.10",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "closed",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.buildActiveWorkspaceDraft.mockReturnValueOnce(null);
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "生产机",
            runtime_session_id: null,
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                connection_source: "saved_session",
                path: "/srv/app\nrm -rf /",
              },
            ],
          },
        },
      ],
    });
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "恢复工作区 运维巡检").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushWorkspacePostLayoutWork();

    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1", "/srv/app\nrm -rf /");
    expect(storeMocks.writeTerminal).not.toHaveBeenCalled();
    expect(storeMocks.closeTerminal).not.toHaveBeenCalled();
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ restore_status: "connected", restore_error: null }),
    );

    view.unmount();
  });

  it("closes a restored runtime when sending the startup command fails", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        host: "10.0.0.10",
        port: 22,
        username: "ops",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "closed",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.buildActiveWorkspaceDraft.mockReturnValueOnce(null);
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-1",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作台",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "生产机",
            runtime_session_id: null,
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                connection_source: "saved_session",
                path: "/srv/app",
                startup_command: "source ./env.sh",
              },
            ],
          },
        },
      ],
    });
    storeMocks.openTerminal.mockResolvedValue({
      runtime_session_id: "runtime-ssh",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "生产机",
      kind: "ssh",
      cols: 120,
      rows: 32,
    });
    storeMocks.writeTerminal.mockRejectedValueOnce(new Error("write failed"));
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "恢复工作区 运维巡检").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushWorkspacePostLayoutWork();

    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1", "/srv/app");
    expect(storeMocks.writeTerminal).toHaveBeenCalledWith("runtime-ssh", "source ./env.sh\r");
    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-ssh");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ restore_status: "failed", restore_error: "write failed" }),
    );

    view.unmount();
  });

  it("keeps the right tool panel collapsed on startup even when settings define a default right tool", async () => {
    const view = render(<AppShell />);
    const workbench = view.container.querySelector(".zt-workbench");
    const agentButton = view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement;
    const rightRailButtons = Array.from(view.container.querySelectorAll(".zt-tool-rail button"));

    expect(view.container.querySelector('[aria-label="AI 面板"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-right-collapsed")).toBe(true);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="打开设置"]')).toBe(null);
    expect(rightRailButtons.at(-1)).toBe(agentButton);
    expect(agentButton.classList.contains("zt-tool-rail-agent")).toBe(true);
    expect(agentButton.querySelector("svg")?.classList.contains("lucide-message-square-more")).toBe(true);
    expect(agentButton.getAttribute("aria-pressed")).toBe("false");
    expect(agentButton.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      agentButton.click();
    });

    expect(view.container.querySelector('[aria-label="AI 面板"]')).not.toBe(null);
    expect(workbench?.classList.contains("zt-workbench-right-collapsed")).toBe(false);
    expect(agentButton.getAttribute("aria-pressed")).toBe("true");
    expect(agentButton.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      agentButton.click();
    });

    expect(view.container.querySelector('[aria-label="AI 面板"]')).toBe(null);
    expect(workbench?.classList.contains("zt-workbench-right-collapsed")).toBe(true);
    expect(agentButton.getAttribute("aria-pressed")).toBe("false");
    expect(agentButton.getAttribute("aria-expanded")).toBe("false");

    view.unmount();
  });

  it("does not read active terminal output while the AI tool is collapsed", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    storeMocks.workspaceState.workspaces[0].tabs = storeMocks.workspaceState.tabs;
    storeMocks.terminalState.outputTails = { "runtime-1": "line\n".repeat(1200) };
    const view = render(<AppShell />);

    expect(storeMocks.terminalOutputAccesses).toBe(0);
    expect(storeMocks.captureContext).not.toHaveBeenCalled();

    const agentButton = view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement;
    await act(async () => {
      agentButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.terminalOutputAccesses).toBeGreaterThan(0);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 140));
    });
    expect(storeMocks.captureContext).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime_session_id: "runtime-1",
        recent_output_tail: expect.stringContaining("line"),
      }),
    );

    view.unmount();
  });

  it("refreshes affected workspace domains after AI tool completion", async () => {
    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });
    storeMocks.workspaceList.mockClear();

    await act(async () => {
      await storeMocks.aiAffectedDomainsHandler?.(["workspace"]);
    });

    expect(storeMocks.workspaceList).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("leaves the startup pane empty instead of opening the default local terminal", async () => {
    const view = render(<AppShell />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.addPaneTab).not.toHaveBeenCalled();
    expect(storeMocks.bindRuntimeToPaneTab).not.toHaveBeenCalled();

    view.unmount();
  });

  it("does not bind the AI panel or capture terminal context for the startup placeholder pane", async () => {
    const view = render(<AppShell />);

    const agentButton = view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement;
    await act(async () => {
      agentButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.aiPanelProps).toEqual(
      expect.objectContaining({
        activeRuntimeSessionId: null,
        activePaneTitle: null,
      }),
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 140));
    });

    expect(storeMocks.captureContext).not.toHaveBeenCalled();
    view.unmount();
  });

  it("opens the connection picker without creating or offering a synthetic default local connection", async () => {
    storeMocks.sessionState.sessions = [
      { id: "ftp-1", name: "文件 FTP", type: "ftp", host: "ftp.test", port: 21, username: "ops", auth_mode: "password", group_id: null, tags: [], sort_order: 0, created_at_ms: 1, updated_at_ms: 1 },
      { id: "sftp-1", name: "文件 SFTP", type: "sftp", host: "sftp.test", port: 22, username: "ops", auth_mode: "password", group_id: null, tags: [], sort_order: 1, created_at_ms: 1, updated_at_ms: 1 },
    ];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="创建连接"]') as HTMLButtonElement).click();
    });

    expect(view.container.querySelector('[aria-label="选择连接"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="选择默认本地终端"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="选择连接 文件 FTP"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="选择连接 文件 SFTP"]')).toBe(null);
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.addPaneTab).not.toHaveBeenCalled();
    expect(storeMocks.bindRuntimeToPaneTab).not.toHaveBeenCalled();
    view.unmount();
  });

  it("creates a new pane tab for a selected saved session when the current pane tab is connected", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "测试 SSH",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "172.16.41.180",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "172.16.41.180",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-existing",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "172.16.41.180",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-existing",
            },
          ],
        },
      },
    ];
    storeMocks.workspaceState.workspaces[0].tabs = storeMocks.workspaceState.tabs;
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="创建连接"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (view.container.querySelector('[aria-label="选择连接 测试 SSH"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(storeMocks.addPaneTab).toHaveBeenCalledWith("pane-1");
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-created",
      expect.objectContaining({ runtime_session_id: "runtime-2", saved_session_id: "session-1" }),
    );

    view.unmount();
  });

  it("creates split panes without opening the default local terminal", async () => {
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="纵向分栏"]') as HTMLButtonElement).click();
    });

    expect(storeMocks.splitActivePane).toHaveBeenCalledWith("vertical");
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.bindRuntimeToPaneTab).not.toHaveBeenCalled();

    view.unmount();
  });

  it("keeps an empty pane after the last pane tab is closed", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "172.16.41.180",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "172.16.41.180",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "172.16.41.180",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="关闭当前标签"]') as HTMLButtonElement).click();
    });

    expect(storeMocks.closePaneTab).toHaveBeenCalledWith("pane-1", "pane-1-tab-1");
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.bindRuntimeToPaneTab).not.toHaveBeenCalled();
    view.unmount();
  });

  it("keeps an empty pane after the only pane is closed", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "172.16.41.180",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "172.16.41.180",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "172.16.41.180",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="关闭当前分栏"]') as HTMLButtonElement).click();
    });

    expect(storeMocks.closePane).toHaveBeenCalledWith("pane-1");
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.bindRuntimeToPaneTab).not.toHaveBeenCalled();
    view.unmount();
  });

  it("opens a session in the current empty terminal tab", async () => {
    const view = render(<AppShell />);

    await clickButton(view.container, "会话");

    await act(async () => {
      (view.container.querySelector('[aria-label="打开测试会话"]') as HTMLButtonElement).click();
    });

    expect(storeMocks.addPaneTab).not.toHaveBeenCalled();
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ runtime_session_id: "runtime-2", saved_session_id: "session-1", pane_id: "pane-1" }),
    );
    view.unmount();
  });

  it("loads SFTP files and current-session transfers from the merged files panel", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const filesButton = view.container.querySelector('.zt-tool-rail [aria-label="SFTP 文件"]') as HTMLButtonElement;

    expect(view.container.querySelector('.zt-tool-rail [aria-label="传输任务"]')).toBe(null);
    expect(storeMocks.loadTransfers).not.toHaveBeenCalled();

    await act(async () => {
      filesButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.listFiles).toHaveBeenLastCalledWith("session-1", "/");
    expect(storeMocks.loadTransfers).toHaveBeenLastCalledWith("session-1");
    expect(view.container.querySelector('[aria-label="文件面板"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="传输任务列表"]')).not.toBe(null);
    expect(storeMocks.transferPanelProps?.onPause).toBeTypeOf("function");
    expect(storeMocks.transferPanelProps?.onResume).toBeTypeOf("function");
    expect(storeMocks.transferPanelProps?.onCancel).toBeTypeOf("function");
    expect(storeMocks.transferPanelProps?.onDelete).toBeTypeOf("function");

    view.unmount();
  });

  it("opens the independent file transfer panel without loading current-session SFTP data", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const transferButton = view.container.querySelector('.zt-left-rail [aria-label="文件传输"]') as HTMLButtonElement;

    expect(view.container.querySelector('.zt-tool-rail [aria-label="文件传输"]')).toBe(null);
    expect(transferButton).not.toBe(null);

    await act(async () => {
      transferButton.click();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[role="dialog"][aria-label="文件传输"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="文件传输面板"]')).not.toBe(null);
    expect(storeMocks.fileTransferPanelProps?.language).toBe("zhCN");
    expect(transferButton.getAttribute("aria-pressed")).toBe("true");
    expect(storeMocks.listFiles).not.toHaveBeenCalled();
    expect(storeMocks.loadTransfers).not.toHaveBeenCalled();

    await clickButton(view.container, "关闭文件传输");

    expect(view.container.querySelector('[role="dialog"][aria-label="文件传输"]')).toBe(null);

    view.unmount();
  });

  it("refreshes right-side history and command groups for the active saved session", async () => {
    storeMocks.terminalState.runtimes = {
      "runtime-1": {
        runtime_session_id: "runtime-1",
        saved_session_id: "session-1",
        history_scope_kind: "saved_session",
        history_scope_id: "session-1",
        kind: "ssh",
      },
    };
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const historyButton = view.container.querySelector('.zt-tool-rail [aria-label="历史"]') as HTMLButtonElement;

    await act(async () => {
      historyButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-1",
      deduplicate: true,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith("saved_session", "session-1");
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe("saved_session");
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe("session-1");

    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 B",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 B",
          runtime_session_id: "runtime-2",
          saved_session_id: "session-2",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 B",
              runtime_session_id: "runtime-2",
              saved_session_id: "session-2",
            },
          ],
        },
      },
    ];

    await act(async () => {
      view.rerender(<AppShell />);
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-2",
      deduplicate: true,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith("saved_session", "session-2");
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe("saved_session");
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe("session-2");

    view.unmount();
  });

  it("refreshes command history when the active terminal receives input", async () => {
    storeMocks.terminalState.runtimes = {
      "runtime-1": {
        runtime_session_id: "runtime-1",
        saved_session_id: "session-1",
        history_scope_kind: "saved_session",
        history_scope_id: "session-1",
        kind: "ssh",
      },
    };
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    storeMocks.terminalState.inputSerialByRuntime = { "runtime-1": 0 };
    const view = render(<AppShell />);
    const historyButton = view.container.querySelector('.zt-tool-rail [aria-label="历史"]') as HTMLButtonElement;

    await act(async () => {
      historyButton.click();
      await Promise.resolve();
    });
    storeMocks.searchHistory.mockClear();

    await act(async () => {
      storeMocks.terminalState.inputSerialByRuntime = { "runtime-1": 1 };
      view.rerender(<AppShell />);
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-1",
      deduplicate: true,
    });

    const deduplicateButton = view.container.querySelector('[aria-label="切换去重历史"]') as HTMLButtonElement;
    await act(async () => {
      deduplicateButton.click();
      await Promise.resolve();
    });
    storeMocks.searchHistory.mockClear();

    await act(async () => {
      storeMocks.terminalState.inputSerialByRuntime = { "runtime-1": 2 };
      view.rerender(<AppShell />);
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-1",
      deduplicate: true,
    });

    view.unmount();
  });

  it("refreshes history for the ssh connection bound to the active terminal tab", async () => {
    storeMocks.terminalState.runtimes = {
      "runtime-a": {
        runtime_session_id: "runtime-a",
        saved_session_id: "session-a",
        history_scope_kind: "saved_session",
        history_scope_id: "session-a",
        kind: "ssh",
      },
      "runtime-b": {
        runtime_session_id: "runtime-b",
        saved_session_id: "session-b",
        history_scope_kind: "saved_session",
        history_scope_id: "session-b",
        kind: "ssh",
      },
    };
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-a",
          saved_session_id: "session-a",
          active_terminal_tab_id: "pane-1-tab-a",
          terminal_tabs: [
            {
              id: "pane-1-tab-a",
              title: "开发机 A",
              runtime_session_id: "runtime-a",
              saved_session_id: "session-a",
            },
            {
              id: "pane-1-tab-b",
              title: "开发机 B",
              runtime_session_id: "runtime-b",
              saved_session_id: "session-b",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const historyButton = view.container.querySelector('.zt-tool-rail [aria-label="历史"]') as HTMLButtonElement;

    await act(async () => {
      historyButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-a",
      deduplicate: true,
    });

    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 B",
          runtime_session_id: "runtime-b",
          saved_session_id: "session-b",
          active_terminal_tab_id: "pane-1-tab-b",
          terminal_tabs: [
            {
              id: "pane-1-tab-a",
              title: "开发机 A",
              runtime_session_id: "runtime-a",
              saved_session_id: "session-a",
            },
            {
              id: "pane-1-tab-b",
              title: "开发机 B",
              runtime_session_id: "runtime-b",
              saved_session_id: "session-b",
            },
          ],
        },
      },
    ];

    await act(async () => {
      view.rerender(<AppShell />);
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-b",
      deduplicate: true,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith("saved_session", "session-b");
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe("saved_session");
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe("session-b");

    view.unmount();
  });

  it("refreshes history and command groups for the active local terminal profile", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "PowerShell 7",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "PowerShell 7",
          runtime_session_id: "runtime-pwsh",
          saved_session_id: null,
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "PowerShell 7",
              runtime_session_id: "runtime-pwsh",
              saved_session_id: null,
            },
          ],
        },
      },
    ];
    storeMocks.terminalState.runtimes = {
      "runtime-pwsh": {
        runtime_session_id: "runtime-pwsh",
        saved_session_id: null,
        history_scope_kind: "local_profile",
        history_scope_id: "pwsh",
        pane_id: "pane-1",
        title: "PowerShell 7",
        kind: "local",
        cols: 120,
        rows: 32,
      },
    };
    const view = render(<AppShell />);
    const historyButton = view.container.querySelector('.zt-tool-rail [aria-label="历史"]') as HTMLButtonElement;

    await act(async () => {
      historyButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: "local_profile",
      scopeId: "pwsh",
      deduplicate: true,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith("local_profile", "pwsh");
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe("local_profile");
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe("pwsh");

    view.unmount();
  });

  it("hides history for an active RDP placeholder", () => {
    storeMocks.sessionState.sessions = [
      {
        id: "rdp-1",
        name: "Windows",
        host: "10.0.0.20",
        port: 3389,
        username: "ops",
        type: "rdp",
        auth_mode: "password",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "Windows",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "Windows",
          runtime_session_id: "runtime-rdp",
          saved_session_id: "rdp-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "Windows",
              runtime_session_id: "runtime-rdp",
              saved_session_id: "rdp-1",
            },
          ],
        },
      },
    ];
    storeMocks.terminalState.runtimes = {
      "runtime-rdp": {
        runtime_session_id: "runtime-rdp",
        saved_session_id: "rdp-1",
        history_scope_kind: null,
        history_scope_id: null,
        pane_id: "pane-1",
        title: "Windows",
        kind: "rdp_placeholder",
        cols: 120,
        rows: 32,
      },
    };
    const view = render(<AppShell />);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="历史"]')).toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SFTP 文件"]')).toBe(null);

    view.unmount();
  });

  it("opens resource monitor for the active SSH saved session", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const monitorButton = view.container.querySelector('.zt-tool-rail [aria-label="资源监控"]') as HTMLButtonElement;

    await act(async () => {
      monitorButton.click();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[aria-label="资源监控"]')).not.toBe(null);
    expect(storeMocks.monitorPanelProps?.target).toEqual({
      kind: "ssh",
      id: "session-1",
      name: "开发机 A",
      host: "172.16.41.180",
      port: 22,
      username: "ubuntu",
    });

    view.unmount();
  });

  it("duplicates the clicked saved connection into a new adjacent pane tab", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "生产机",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "生产机",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "生产机",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
              connection_source: "saved_session",
              path: "/srv/app",
            },
          ],
        },
      },
    ];
    storeMocks.workspaceState.workspaces[0].tabs = storeMocks.workspaceState.tabs;
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="复制当前连接"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(storeMocks.addPaneTabAfter).toHaveBeenCalledWith("pane-1", "pane-1-tab-1");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-created",
      expect.objectContaining({
        saved_session_id: "session-1",
        connection_source: "saved_session",
        path: "/srv/app",
        restore_status: "pending",
      }),
    );
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1", "/srv/app");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-created",
      expect.objectContaining({ runtime_session_id: "runtime-2" }),
    );
    view.unmount();
  });

  it("does not duplicate an empty placeholder pane tab", async () => {
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="复制当前连接"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(storeMocks.addPaneTabAfter).not.toHaveBeenCalled();
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    view.unmount();
  });

  it("opens resource monitor for the local machine without an active connection", async () => {
    const view = render(<AppShell />);
    const monitorButton = view.container.querySelector('.zt-tool-rail [aria-label="资源监控"]') as HTMLButtonElement;
    const rightRailLabels = Array.from(view.container.querySelectorAll(".zt-tool-rail button")).map((item) =>
      item.getAttribute("aria-label"),
    );

    expect(rightRailLabels).toEqual(["资源监控", "Agent"]);

    await act(async () => {
      monitorButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.monitorPanelProps?.target).toEqual({
      kind: "local",
      id: "local-machine",
      name: "本机",
      host: "localhost",
      port: 0,
      username: "",
    });

    view.unmount();
  });

  it("keeps showing the local machine when the active terminal is local", async () => {
    storeMocks.terminalState.runtimes = {
      "runtime-local": {
        runtime_session_id: "runtime-local",
        saved_session_id: null,
        history_scope_kind: "local_profile",
        history_scope_id: "powershell",
        pane_id: "pane-1",
        title: "PowerShell",
        kind: "local",
        cols: 120,
        rows: 32,
      },
    };
    storeMocks.workspaceState.tabs[0].root = {
      kind: "leaf",
      id: "pane-1",
      title: "PowerShell",
      runtime_session_id: "runtime-local",
      saved_session_id: null,
      active_terminal_tab_id: "pane-1-tab-1",
      terminal_tabs: [
        {
          id: "pane-1-tab-1",
          title: "PowerShell",
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          connection_source: "default_local",
        },
      ],
    };
    const view = render(<AppShell />);
    const monitorButton = view.container.querySelector('.zt-tool-rail [aria-label="资源监控"]') as HTMLButtonElement;
    const rightRailLabels = Array.from(view.container.querySelectorAll(".zt-tool-rail button")).map((item) =>
      item.getAttribute("aria-label"),
    );

    expect(rightRailLabels).toEqual(["资源监控", "历史", "Agent"]);

    await act(async () => {
      monitorButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.monitorPanelProps?.target).toEqual(expect.objectContaining({ kind: "local", id: "local-machine" }));

    view.unmount();
  });

  it("shows SSH tools while an opened SSH tab is active, regardless of saved tunnel configuration", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        ssh_options: {
          tunnels: [
            {
              mode: "host_service",
              kind: "local",
              name: "管理后台",
              auto_open: true,
              bind_address: "127.0.0.1",
              local_port: 18080,
              remote_host: "127.0.0.1",
              remote_port: 8080,
            },
            {
              mode: "socks",
              kind: "dynamic",
              auto_open: false,
              bind_address: "127.0.0.1",
              local_port: 1080,
            },
          ],
        },
      },
      {
        id: "session-2",
        name: "开发机 B",
        host: "172.16.41.181",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
        ssh_options: { tunnels: [] },
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const tunnelButton = view.container.querySelector('.zt-tool-rail [aria-label="SSH 隧道"]') as HTMLButtonElement;

    expect(tunnelButton).not.toBe(null);
    expect(tunnelButton.querySelector("svg")?.classList.contains("lucide-cable")).toBe(true);

    await act(async () => {
      tunnelButton.click();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[aria-label="SSH 隧道"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="新增隧道"]')?.classList.contains("zt-panel-action-button")).toBe(true);
    const tunnelTarget = view.container.querySelector(".zt-tunnel-panel > .zt-target-summary");
    expect(tunnelTarget?.children[0]?.tagName).toBe("STRONG");
    expect(tunnelTarget?.children[1]?.tagName).toBe("SPAN");
    expect(view.container.textContent).toContain("开发机 A");
    expect(view.container.textContent).toContain("ubuntu@172.16.41.180:22");
    expect(view.container.textContent).toContain("管理后台");
    expect(view.container.textContent).toContain("127.0.0.1:18080");
    expect(view.container.textContent).toContain("127.0.0.1:8080");
    expect(view.container.textContent).toContain("手动打开");

    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 B",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 B",
          runtime_session_id: "runtime-2",
          saved_session_id: "session-2",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 B",
              runtime_session_id: "runtime-2",
              saved_session_id: "session-2",
            },
          ],
        },
      },
    ];

    await act(async () => {
      view.rerender(<AppShell />);
      await Promise.resolve();
    });

    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 隧道"]')).not.toBe(null);

    view.unmount();
  });

  it("creates a tunnel for the active saved SSH session", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        credential_ref: null,
        description: null,
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: null,
        ssh_options: { tunnels: [] },
      },
    ];
    storeMocks.workspaceState.tabs[0].root = {
      kind: "leaf",
      id: "pane-1",
      title: "开发机 A",
      runtime_session_id: "runtime-1",
      saved_session_id: "session-1",
      active_terminal_tab_id: "pane-1-tab-1",
      terminal_tabs: [
        {
          id: "pane-1-tab-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          connection_source: "saved_session",
        },
      ],
    };
    const view = render(<AppShell />);

    await clickButton(view.container, "SSH 隧道");
    await clickButton(view.container, "新增隧道");

    expect(view.container.querySelector('[role="dialog"][aria-label="新增 SSH 隧道"]')).not.toBe(null);
    await clickButton(view.container, "SOCKS / 高级");
    expect(input(view.container, "SOCKS 监听端口")).not.toBe(null);
    await clickButton(view.container, "访问主机服务");
    expect(input(view.container, "主机目标端口")).not.toBe(null);
    change(input(view.container, "隧道名称"), "管理后台");
    change(input(view.container, "主机目标端口"), "8080");
    change(input(view.container, "本机监听端口"), "18080");
    await clickButton(view.container, "保存隧道");

    expect(storeMocks.saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "session-1",
        ssh_options: expect.objectContaining({
          tunnels: [
            expect.objectContaining({
              name: "管理后台",
              kind: "local",
              local_port: 18080,
              remote_port: 8080,
            }),
          ],
        }),
      }),
    );
    expect(view.container.querySelector('[role="dialog"][aria-label="新增 SSH 隧道"]')).toBe(null);

    view.unmount();
  });

  it("reconnects from the SSH title context menu and edits or deletes a selected tunnel", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        credential_ref: null,
        description: null,
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: null,
        ssh_options: {
          tunnels: [
            {
              mode: "host_service",
              kind: "local",
              name: "管理后台",
              auto_open: true,
              bind_address: "127.0.0.1",
              local_port: 18080,
              remote_host: "172.16.41.180",
              remote_port: 8080,
            },
          ],
        },
      },
    ];
    storeMocks.workspaceState.tabs[0].root = {
      kind: "leaf",
      id: "pane-1",
      title: "开发机 A",
      runtime_session_id: "runtime-1",
      saved_session_id: "session-1",
      active_terminal_tab_id: "pane-1-tab-1",
      terminal_tabs: [
        {
          id: "pane-1-tab-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          connection_source: "saved_session",
        },
      ],
    };
    const view = render(<AppShell />);
    await clickButton(view.container, "SSH 隧道");

    await act(async () => {
      view.container
        .querySelector(".zt-tunnel-target")
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 80 }));
      await Promise.resolve();
    });
    await clickButton(view.container, "重连");

    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1", { releaseExternalSession: true });
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1");
    expect(storeMocks.closeTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      storeMocks.openTerminal.mock.invocationCallOrder[0],
    );

    await act(async () => {
      view.container
        .querySelector('[role="listitem"][aria-label="管理后台"]')
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 140, clientY: 160 }));
      await Promise.resolve();
    });
    await clickButton(view.container, "编辑");
    change(input(view.container, "隧道名称"), "管理后台新");
    await clickButton(view.container, "保存隧道");

    expect(storeMocks.saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "session-1",
        ssh_options: expect.objectContaining({
          tunnels: [expect.objectContaining({ name: "管理后台新", local_port: 18080 })],
        }),
      }),
    );

    await act(async () => {
      view.container
        .querySelector('[role="listitem"][aria-label="管理后台"]')
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 140, clientY: 160 }));
      await Promise.resolve();
    });
    await clickButton(view.container, "删除");
    expect(view.container.querySelector('[role="dialog"][aria-label="删除 SSH 隧道"]')).not.toBe(null);
    await act(async () => {
      const confirmDeleteButton = Array.from(view.container.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === "确认删除",
      );
      (confirmDeleteButton as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(storeMocks.saveSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "session-1",
        ssh_options: expect.objectContaining({ tunnels: [] }),
      }),
    );

    view.unmount();
  });

  it("lists SSH containers and opens a selected running container in a tab to the right", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        ssh_options: {
          container: {
            enabled: true,
            runtime: "docker",
            container: "legacy-default-ignored",
            shell: "/bin/bash",
            user: null,
            workdir: "/srv/app",
          },
        },
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
              connection_source: "saved_session",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);
    const containerButton = view.container.querySelector('.zt-tool-rail [aria-label="SSH 容器"]') as HTMLButtonElement;

    expect(containerButton).not.toBe(null);
    expect(containerButton.querySelector("svg")?.classList.contains("lucide-box")).toBe(true);

    await act(async () => {
      containerButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.listSshContainers).toHaveBeenCalledWith("session-1");
    const containerPanel = view.container.querySelector(".zt-tunnel-panel.zt-container-panel");
    expect(containerPanel).not.toBe(null);
    const containerTarget = containerPanel?.querySelector(":scope > .zt-target-summary");
    expect(containerTarget?.children[0]?.tagName).toBe("STRONG");
    expect(containerTarget?.children[1]?.tagName).toBe("SPAN");
    expect(containerTarget?.children[2]?.tagName).toBe("BUTTON");
    expect(view.container.textContent).toContain("api");
    expect(view.container.textContent).toContain("old");
    expect(view.container.textContent).not.toContain("Up 3 minutes");
    expect(view.container.querySelector('[aria-label="刷新容器"]')?.getAttribute("title")).toBe("刷新");
    expect(view.container.querySelector('[aria-label="进入容器 api"]')?.getAttribute("title")).toBe("进入容器");
    expect(view.container.querySelector('[aria-label="进入容器 api"] svg')).not.toBe(null);
    expect((view.container.querySelector('[aria-label="进入容器 old"]') as HTMLButtonElement).disabled).toBe(true);
    const enterApiButton = view.container.querySelector('[aria-label="进入容器 api"]') as HTMLButtonElement;

    await act(async () => {
      enterApiButton.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      enterApiButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.addPaneTabAfter).toHaveBeenCalledTimes(1);
    expect(storeMocks.addPaneTabAfter).toHaveBeenCalledWith("pane-1", "pane-1-tab-1");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-created",
      expect.objectContaining({
        title: "容器: api",
        saved_session_id: "session-1",
        connection_source: "ssh_container",
        container_target: { id: "abc123", name: "api" },
        restore_status: "pending",
      }),
    );
    expect(storeMocks.openSshContainerTerminal).toHaveBeenCalledTimes(1);
    expect(storeMocks.openSshContainerTerminal).toHaveBeenCalledWith("session-1", "pane-1", "abc123", "api");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-created",
      expect.objectContaining({ runtime_session_id: "runtime-container", kind: "ssh_container" }),
    );

    view.unmount();
  });

  it("shows the container tool while an opened SSH tab is active even when containers are not enabled", () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "开发机 A",
        host: "172.16.41.180",
        port: 22,
        username: "ubuntu",
        type: "ssh",
        auth_mode: "none",
        group_id: null,
        tags: [],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        ssh_options: {
          container: {
            enabled: false,
            runtime: "docker",
            container: "",
            shell: "/bin/sh",
            user: null,
            workdir: null,
          },
        },
      },
    ];
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "开发机 A",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "开发机 A",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "开发机 A",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];

    const view = render(<AppShell />);

    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 容器"]')).not.toBe(null);

    view.unmount();
  });

  it("adds a terminal tab in the active pane before opening a session when the current tab is connected", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "172.16.41.180",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "172.16.41.180",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "172.16.41.180",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    const view = render(<AppShell />);

    await clickButton(view.container, "会话");

    await act(async () => {
      (view.container.querySelector('[aria-label="打开测试会话"]') as HTMLButtonElement).click();
    });

    expect(storeMocks.addPaneTab).toHaveBeenCalledWith("pane-1");
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1");
    expect(storeMocks.addPaneTab.mock.invocationCallOrder[0]).toBeLessThan(
      storeMocks.openTerminal.mock.invocationCallOrder[0],
    );
    view.unmount();
  });

  it("binds an asynchronously opened SSH session to the pane tab chosen before focus changes", async () => {
    storeMocks.workspaceState.tabs = [
      {
        id: "tab-1",
        title: "172.16.41.180",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "172.16.41.180",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "172.16.41.180",
              runtime_session_id: "runtime-1",
              saved_session_id: "session-1",
            },
          ],
        },
      },
    ];
    storeMocks.addPaneTab.mockReturnValueOnce({
      id: "pane-1-tab-2",
      title: "新建终端",
      runtime_session_id: null,
      saved_session_id: null,
    });
    const opened = deferred<{
      runtime_session_id: string;
      saved_session_id: string;
      history_scope_kind: string;
      history_scope_id: string;
      pane_id: string;
      title: string;
      kind: string;
      cols: number;
      rows: number;
    }>();
    storeMocks.openTerminal.mockReturnValueOnce(opened.promise);
    const view = render(<AppShell />);

    await clickButton(view.container, "会话");
    await act(async () => {
      (view.container.querySelector('[aria-label="打开测试会话"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    storeMocks.workspaceState.activeWorkspaceId = "workspace-other";
    storeMocks.workspaceState.activeTabId = "tab-other";

    await act(async () => {
      opened.resolve({
        runtime_session_id: "runtime-2",
        saved_session_id: "session-1",
        history_scope_kind: "saved_session",
        history_scope_id: "session-1",
        pane_id: "pane-1",
        title: "172.16.41.180",
        kind: "ssh",
        cols: 120,
        rows: 32,
      });
      await opened.promise;
      await Promise.resolve();
    });

    expect(storeMocks.addPaneTab).toHaveBeenCalledWith("pane-1");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "default-workspace",
      "tab-1",
      "pane-1",
      "pane-1-tab-2",
      expect.objectContaining({ runtime_session_id: "runtime-2", saved_session_id: "session-1" }),
    );
    expect(storeMocks.bindRuntimeToPane).not.toHaveBeenCalledWith(
      expect.objectContaining({ runtime_session_id: "runtime-2" }),
    );

    view.unmount();
  });
});
