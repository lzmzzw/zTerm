// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";

const storeMocks = vi.hoisted(() => ({
  noop: vi.fn(),
  asyncNoop: vi.fn().mockResolvedValue(undefined),
  bindEvents: vi.fn().mockResolvedValue(() => undefined),
  addPaneTab: vi.fn(),
  closePaneTab: vi.fn(),
  closeActivePane: vi.fn(),
  selectPaneTab: vi.fn(),
  bindRuntimeToPane: vi.fn(),
  bindRuntimeToPaneTab: vi.fn(),
  selectWorkspace: vi.fn(),
  selectDefaultWorkspace: vi.fn(),
  resetDefaultWorkspace: vi.fn(),
  migrateActiveWorkspaceToSavedWorkspace: vi.fn(),
  buildActiveWorkspaceDraft: vi.fn(),
  getWorkspaceRuntimeSessionIds: vi.fn((_workspaceId?: string) => ["runtime-1"]),
  closeWorkspaceRuntime: vi.fn(() => ["runtime-1"]),
  upsertWorkspaceDefinition: vi.fn(),
  updateWorkspaceRuntimeMetadata: vi.fn(),
  freezeWorkspaceRuntimeVisualSnapshots: vi.fn(),
  splitActivePane: vi.fn(),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  updatePaneTerminalTab: vi.fn(),
  selectTab: vi.fn(),
  setActivePane: vi.fn(),
  writeTerminal: vi.fn().mockResolvedValue(undefined),
  workspaceList: vi.fn().mockResolvedValue([]),
  workspaceGet: vi.fn(),
  workspaceSave: vi.fn(),
  workspaceDelete: vi.fn().mockResolvedValue(undefined),
  workspaceRemove: vi.fn().mockResolvedValue(undefined),
  cacheWorkspaceDefinition: vi.fn(),
  loadWorkspaceDefinition: vi.fn(),
  prefetchWorkspaceDefinitions: vi.fn(),
  removeWorkspace: vi.fn(),
  workspaceDefinitionState: {
    definitions: {} as Record<string, Record<string, unknown>>,
  },
  terminalOutputAccesses: 0,
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
  historyPanelProps: null as Record<string, unknown> | null,
  monitorPanelProps: null as Record<string, unknown> | null,
  modelPanelProps: null as Record<string, unknown> | null,
  loadCommandGroups: vi.fn().mockResolvedValue(undefined),
  saveCommandGroup: vi.fn().mockResolvedValue(undefined),
  searchHistory: vi.fn().mockResolvedValue(undefined),
  captureContext: vi.fn().mockResolvedValue(undefined),
  listFiles: vi.fn().mockResolvedValue(undefined),
  clearFiles: vi.fn(),
  loadTransfers: vi.fn().mockResolvedValue(undefined),
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
    output: {} as Record<string, string>,
    inputSerialByRuntime: {} as Record<string, number>,
    visualOutputTail: {} as Record<string, string>,
  },
}));

vi.mock("./TitleBar", () => ({
  TitleBar: () => <header aria-label="标题栏" />,
}));

vi.mock("../features/ai/AiPanel", () => ({
  AiPanel: () => <section aria-label="AI 面板" />,
}));

vi.mock("../features/files/FileExplorerPanel", () => ({
  FileExplorerPanel: () => <section aria-label="文件面板" />,
}));

vi.mock("../features/files/TransferPanel", () => ({
  TransferPanel: () => <section aria-label="传输任务列表" />,
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
    onClosePaneTab,
    onClosePane,
    onSplitPane,
    workspaceActive = true,
    visualMode = "normal",
  }: {
    root: Record<string, unknown>;
    activePaneId: string;
    onAddPaneTab: (paneId: string) => void;
    onClosePaneTab: (paneId: string, paneTabId: string) => void;
    onClosePane: () => void;
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
      <button type="button" aria-label="横向分栏" onClick={() => onSplitPane("horizontal")}>
        横向分栏
      </button>
      <button type="button" aria-label="纵向分栏" onClick={() => onSplitPane("vertical")}>
        纵向分栏
      </button>
      <button type="button" aria-label="关闭当前标签" onClick={() => onClosePaneTab("pane-1", "pane-1-tab-1")}>
        关闭当前标签
      </button>
      <button type="button" aria-label="关闭当前分栏" onClick={onClosePane}>
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
    saveSession: storeMocks.asyncNoop,
    testSession: storeMocks.asyncNoop,
    deleteGroup: storeMocks.asyncNoop,
    deleteSession: storeMocks.asyncNoop,
  });
  const useSessionStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = sessionState();
    if (selector) return selector(state);
    return state;
  };
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
    newConversation: storeMocks.asyncNoop,
    confirmTool: storeMocks.asyncNoop,
  });
  const useAiStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = aiState();
    if (selector) return selector(state);
    return state;
  };
  return { useAiStore };
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

vi.mock("../features/terminal/terminalStore", () => {
  const terminalState = (trackOutputAccess = false) => {
    const state: Record<string, unknown> = {
      bindTerminalEvents: storeMocks.bindEvents,
      openTerminal: storeMocks.openTerminal,
      openDefaultLocalTerminal: storeMocks.openDefaultLocalTerminal,
      closeTerminal: storeMocks.closeTerminal,
      writeTerminal: storeMocks.writeTerminal,
      resizeTerminal: vi.fn().mockResolvedValue(undefined),
      suggestCompletion: vi.fn().mockResolvedValue([]),
      runtimes: storeMocks.terminalState.runtimes,
      inputSerialByRuntime: storeMocks.terminalState.inputSerialByRuntime,
      visualOutputTail: storeMocks.terminalState.visualOutputTail,
    };
    Object.defineProperty(state, "output", {
      enumerable: true,
      get() {
        if (trackOutputAccess) {
          storeMocks.terminalOutputAccesses += 1;
        }
        return storeMocks.terminalState.output;
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
  workspaceDelete: storeMocks.workspaceDelete,
  workspaceRemove: storeMocks.workspaceRemove,
}));

vi.mock("../features/workspace/workspaceStore", () => {
  const workspaceState = () => ({
    workspaces: storeMocks.workspaceState.workspaces,
    workspaceDefinitions: storeMocks.workspaceDefinitionState.definitions,
    activeWorkspaceId: storeMocks.workspaceState.activeWorkspaceId,
    tabs: storeMocks.workspaceState.tabs,
    activeTabId: storeMocks.workspaceState.activeTabId,
    selectWorkspace: storeMocks.selectWorkspace,
    selectDefaultWorkspace: storeMocks.selectDefaultWorkspace,
    resetDefaultWorkspace: storeMocks.resetDefaultWorkspace,
    migrateActiveWorkspaceToSavedWorkspace: storeMocks.migrateActiveWorkspaceToSavedWorkspace,
    upsertWorkspaceDefinition: storeMocks.upsertWorkspaceDefinition,
    updateWorkspaceRuntimeMetadata: storeMocks.updateWorkspaceRuntimeMetadata,
    freezeWorkspaceRuntimeVisualSnapshots: storeMocks.freezeWorkspaceRuntimeVisualSnapshots,
    cacheWorkspaceDefinition: storeMocks.cacheWorkspaceDefinition,
    loadWorkspaceDefinition: storeMocks.loadWorkspaceDefinition,
    prefetchWorkspaceDefinitions: storeMocks.prefetchWorkspaceDefinitions,
    buildActiveWorkspaceDraft: storeMocks.buildActiveWorkspaceDraft,
    getWorkspaceRuntimeSessionIds: storeMocks.getWorkspaceRuntimeSessionIds,
    closeWorkspaceRuntime: storeMocks.closeWorkspaceRuntime,
    removeWorkspace: storeMocks.removeWorkspace,
    updatePaneTerminalTab: storeMocks.updatePaneTerminalTab,
    selectTab: storeMocks.selectTab,
    addTab: storeMocks.noop,
    addPaneTab: storeMocks.addPaneTab,
    closePaneTab: storeMocks.closePaneTab,
    selectPaneTab: storeMocks.selectPaneTab,
    setActivePane: storeMocks.setActivePane,
    bindRuntimeToPane: storeMocks.bindRuntimeToPane,
    bindRuntimeToPaneTab: storeMocks.bindRuntimeToPaneTab,
    splitActivePane: storeMocks.splitActivePane,
    resizeSplitPane: storeMocks.noop,
    closeActivePane: storeMocks.closeActivePane,
  });
  const useWorkspaceStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = workspaceState();
    if (selector) return selector(state);
    return state;
  };
  useWorkspaceStore.getState = () => ({
    ...workspaceState(),
    buildActiveWorkspaceDraft: storeMocks.buildActiveWorkspaceDraft,
    getWorkspaceRuntimeSessionIds: storeMocks.getWorkspaceRuntimeSessionIds,
    closeWorkspaceRuntime: storeMocks.closeWorkspaceRuntime,
    removeWorkspace: storeMocks.removeWorkspace,
    updatePaneTerminalTab: storeMocks.updatePaneTerminalTab,
    cacheWorkspaceDefinition: storeMocks.cacheWorkspaceDefinition,
    loadWorkspaceDefinition: storeMocks.loadWorkspaceDefinition,
    prefetchWorkspaceDefinitions: storeMocks.prefetchWorkspaceDefinitions,
    selectWorkspace: storeMocks.selectWorkspace,
    selectDefaultWorkspace: storeMocks.selectDefaultWorkspace,
    resetDefaultWorkspace: storeMocks.resetDefaultWorkspace,
    migrateActiveWorkspaceToSavedWorkspace: storeMocks.migrateActiveWorkspaceToSavedWorkspace,
    updateWorkspaceRuntimeMetadata: storeMocks.updateWorkspaceRuntimeMetadata,
    freezeWorkspaceRuntimeVisualSnapshots: storeMocks.freezeWorkspaceRuntimeVisualSnapshots,
    selectTab: storeMocks.selectTab,
    setActivePane: storeMocks.setActivePane,
    selectPaneTab: storeMocks.selectPaneTab,
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
    storeMocks.addPaneTab.mockReturnValue({
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
    storeMocks.closeWorkspaceRuntime.mockReturnValue(["runtime-1"]);
    storeMocks.closeTerminal.mockResolvedValue(undefined);
    storeMocks.selectWorkspace.mockReset();
    storeMocks.selectDefaultWorkspace.mockReset();
    storeMocks.resetDefaultWorkspace.mockReset();
    storeMocks.migrateActiveWorkspaceToSavedWorkspace.mockReset();
    storeMocks.updatePaneTerminalTab.mockReset();
    storeMocks.selectTab.mockReset();
    storeMocks.setActivePane.mockReset();
    storeMocks.splitActivePane.mockReset();
    storeMocks.writeTerminal.mockResolvedValue(undefined);
    storeMocks.workspaceList.mockResolvedValue([]);
    storeMocks.workspaceGet.mockReset();
    storeMocks.workspaceSave.mockReset();
    storeMocks.workspaceDelete.mockResolvedValue(undefined);
    storeMocks.workspaceRemove.mockResolvedValue(undefined);
    storeMocks.removeWorkspace.mockReset();
    storeMocks.updateWorkspaceRuntimeMetadata.mockReset();
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
    storeMocks.getWorkspaceRuntimeSessionIds.mockReturnValue(["runtime-1"]);
    storeMocks.historyPanelProps = null;
    storeMocks.monitorPanelProps = null;
    storeMocks.sessionState.sessions = [];
    storeMocks.terminalState.runtimes = {};
    storeMocks.terminalState.output = {};
    storeMocks.terminalState.inputSerialByRuntime = {};
    storeMocks.terminalState.visualOutputTail = {};
    storeMocks.workspaceState.workspaces = [
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
    ];
    storeMocks.workspaceState.activeWorkspaceId = "workspace-1";
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
    const modelButton = button(view.container, "模型");

    expect(view.container.querySelector('[aria-label="左侧管理"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="左侧管理切换"]')).not.toBe(null);
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
    expect(workspacePanel?.querySelector(".zt-workspace-dot.running")?.getAttribute("title")).toBe("运行中");
    expect(workspacePanel?.querySelector(".zt-workspace-dot.dirty")).toBe(null);

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

    expect(storeMocks.workspaceGet).toHaveBeenCalledTimes(1);
    expect(storeMocks.workspaceGet).toHaveBeenCalledWith("workspace-closed");
    const dots = view.container.querySelectorAll('.zt-workspace-dot');
    const closedDot = Array.from(dots).find((d) => d.getAttribute("title") === "已关闭");
    expect(closedDot).not.toBe(undefined);

    await clickButton(view.container, "会话");
    await clickButton(view.container, "工作区");
    await act(async () => {
      await Promise.resolve();
    });

    expect(storeMocks.workspaceGet).toHaveBeenCalledTimes(1);
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
    expect(dialog?.textContent).toContain("主工作台");
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

    expect(dialog?.querySelector(".zt-workspace-preview-inspector")?.textContent).toContain("pane-5");
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
    expect(input(dialog!, "编辑工作区名称")).toHaveProperty("value", "运维巡检 副本");

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
    expect(storeMocks.migrateActiveWorkspaceToSavedWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-new", name: "发布窗口" }),
    );
    expect(storeMocks.updateWorkspaceRuntimeMetadata).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "workspace-new" }),
    );

    promptSpy.mockRestore();
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

  it("closes a running workspace without asking for unsaved-change confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "关闭工作区 运维巡检").click();
      await Promise.resolve();
    });

    const dialog = view.container.querySelector('[role="dialog"][aria-label="关闭工作区"]');
    expect(dialog).toBe(null);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeWorkspaceRuntime).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.workspaceDelete).toHaveBeenCalledWith("workspace-1");

    confirmSpy.mockRestore();
    view.unmount();
  });

  it("closes a workspace by closing each unique runtime without deleting its definition", async () => {
    storeMocks.workspaceState.workspaces = [
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
    ];
    storeMocks.getWorkspaceRuntimeSessionIds.mockReturnValue(["runtime-1", "runtime-2"]);
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "关闭工作区 运维巡检").click();
      await Promise.resolve();
    });

    expect(storeMocks.getWorkspaceRuntimeSessionIds).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.closeWorkspaceRuntime).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-2");
    expect(storeMocks.workspaceDelete).toHaveBeenCalledWith("workspace-1");

    view.unmount();
  });

  it("automatically closes the oldest inactive running workspace when the running cap is exceeded", async () => {
    storeMocks.workspaceState.workspaces = [
      runningWorkspace("workspace-active", 0, 60, "runtime-active"),
      runningWorkspace("workspace-1", 1, 10, "runtime-1"),
      runningWorkspace("workspace-2", 2, 20, "runtime-2"),
      runningWorkspace("workspace-3", 3, 30, "runtime-3"),
      runningWorkspace("workspace-4", 4, 40, "runtime-4"),
      runningWorkspace("workspace-5", 5, 50, "runtime-5"),
    ];
    storeMocks.workspaceState.activeWorkspaceId = "workspace-active";
    storeMocks.workspaceState.tabs = storeMocks.workspaceState.workspaces[0].tabs as Array<Record<string, unknown>>;
    storeMocks.workspaceState.activeTabId = "workspace-active-tab-1";
    storeMocks.getWorkspaceRuntimeSessionIds.mockImplementation((workspaceId?: string) => {
      const id = workspaceId ?? "workspace-unknown";
      return [`runtime-${id.replace("workspace-", "")}`];
    });
    const view = render(<AppShell />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.getWorkspaceRuntimeSessionIds).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeWorkspaceRuntime).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.closeWorkspaceRuntime).not.toHaveBeenCalledWith("workspace-active");

    view.unmount();
  });

  it("does not clear workspace runtime state when closing a runtime fails", async () => {
    storeMocks.workspaceState.workspaces = [
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
    ];
    storeMocks.getWorkspaceRuntimeSessionIds.mockReturnValue(["runtime-1"]);
    storeMocks.closeTerminal.mockRejectedValueOnce(new Error("PTY close failed"));
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "关闭工作区 运维巡检").click();
      await Promise.resolve();
    });

    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeWorkspaceRuntime).not.toHaveBeenCalled();
    expect(storeMocks.workspaceDelete).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("PTY close failed");

    view.unmount();
  });

  it("keeps fixed fallback text when closing a workspace runtime fails with a non-Error value", async () => {
    storeMocks.workspaceState.workspaces = [
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
    ];
    storeMocks.getWorkspaceRuntimeSessionIds.mockReturnValue(["runtime-1"]);
    storeMocks.closeTerminal.mockRejectedValueOnce("raw runtime close failure");
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await act(async () => {
      openWorkspaceContextMenu(view.container, "运维巡检");
      await Promise.resolve();
      button(view.container, "关闭工作区 运维巡检").click();
      await Promise.resolve();
    });

    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeWorkspaceRuntime).not.toHaveBeenCalled();
    expect(storeMocks.workspaceDelete).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("关闭工作区运行时失败");
    expect(view.container.textContent).not.toContain("raw runtime close failure");

    view.unmount();
  });

  it("deletes a workspace only after confirmation and successful runtime close", async () => {
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

    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeWorkspaceRuntime).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.workspaceRemove).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.removeWorkspace).toHaveBeenCalledWith("workspace-1");

    view.unmount();
  });

  it("does not delete a workspace when runtime close fails", async () => {
    storeMocks.closeTerminal.mockRejectedValueOnce(new Error("PTY close failed"));
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickWorkspaceContextAction(view.container, "运维巡检", "删除工作区 运维巡检");
    const dialog = view.container.querySelector('[role="dialog"][aria-label="删除工作区"]');

    await act(async () => {
      (dialog?.querySelector('button[type="submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.workspaceRemove).not.toHaveBeenCalled();
    expect(storeMocks.removeWorkspace).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("PTY close failed");

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

  it("deselects the active workspace and restores the hidden default workspace", async () => {
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickButton(view.container, "切换工作区 运维巡检");

    expect(storeMocks.selectDefaultWorkspace).toHaveBeenCalledTimes(1);
    expect(storeMocks.selectWorkspace).not.toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.closeTerminal).not.toHaveBeenCalled();

    view.unmount();
  });

  it("switches away from the hidden default workspace without closing its in-memory runtime", async () => {
    storeMocks.workspaceState.workspaces = [
      {
        id: "default-workspace",
        name: "默认工作区",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tabs: storeMocks.workspaceState.tabs,
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
      runningWorkspace("workspace-1", 1, 1, "runtime-explicit"),
    ];
    storeMocks.workspaceState.workspaces[1].name = "运维巡检";
    storeMocks.workspaceState.activeWorkspaceId = "default-workspace";
    storeMocks.workspaceState.tabs = storeMocks.workspaceState.workspaces[0].tabs as Array<Record<string, unknown>>;
    storeMocks.workspaceState.activeTabId = "tab-1";
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickButton(view.container, "切换工作区 运维巡检");

    expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.closeTerminal).not.toHaveBeenCalledWith("runtime-1");
    expect(storeMocks.closeWorkspaceRuntime).not.toHaveBeenCalledWith("default-workspace");

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
    expect(storeMocks.upsertWorkspaceDefinition).toHaveBeenCalledWith(expect.objectContaining({ status: "running" }));
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1", "/srv/app");
    expect(storeMocks.writeTerminal).toHaveBeenCalledWith("runtime-ssh", "source ./env.sh\r");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "workspace-1",
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

    expect(view.container.querySelector('[aria-label="工作区切换快照布局"]')?.textContent).toContain("生产机");
    expect(storeMocks.upsertWorkspaceDefinition).not.toHaveBeenCalled();
    expect(storeMocks.selectWorkspace).not.toHaveBeenCalled();
    expect(storeMocks.selectTab).not.toHaveBeenCalled();
    expect(storeMocks.openTerminal).not.toHaveBeenCalled();

    await flushWorkspacePostLayoutWork();

    expect(storeMocks.upsertWorkspaceDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
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
    expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.selectTab).toHaveBeenCalledWith("tab-1");
    expect(storeMocks.selectTab.mock.invocationCallOrder[0]).toBeLessThan(
      storeMocks.openTerminal.mock.invocationCallOrder[0],
    );
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

    expect(storeMocks.upsertWorkspaceDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
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
    expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(storeMocks.selectTab).toHaveBeenCalledWith("tab-1");
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
      "workspace-1",
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
      "workspace-1",
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
    storeMocks.terminalState.output = { "runtime-1": "line\n".repeat(1200) };
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

  it("keeps repeated running workspace switches free of restore and side-tool requests", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let now = 0;
    const performanceNowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tabs: storeMocks.workspaceState.tabs,
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
      {
        id: "workspace-2",
        name: "构建窗口",
        status: "running",
        active_tab_id: "tab-2",
        activeTabId: "tab-2",
        tabs: [
          {
            id: "tab-2",
            title: "构建",
            active_pane_id: "pane-2",
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            root: {
              kind: "leaf",
              id: "pane-2",
              title: "PowerShell 7",
              runtime_session_id: "runtime-2",
              saved_session_id: null,
              active_terminal_tab_id: "pane-2-tab-1",
              terminal_tabs: [
                {
                  id: "pane-2-tab-1",
                  title: "PowerShell 7",
                  runtime_session_id: "runtime-2",
                  saved_session_id: null,
                },
              ],
            },
          },
        ],
        tab_count: 1,
        sort_order: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    const view = render(<AppShell />);

    try {
      await clickButton(view.container, "工作区");
      for (let index = 0; index < 3; index += 1) {
        now += 10;
        await clickButton(view.container, "切换工作区 构建窗口");
        now += 10;
        await clickButton(view.container, "切换工作区 运维巡检");
      }
      now += 40;
      await flushWorkspacePostLayoutWork();

      expect(storeMocks.selectWorkspace).toHaveBeenCalledTimes(3);
      expect(storeMocks.selectDefaultWorkspace).toHaveBeenCalledTimes(3);
      expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-2");
      expect(storeMocks.openTerminal).not.toHaveBeenCalled();
      expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
      expect(storeMocks.workspaceGet).not.toHaveBeenCalled();
      expect(storeMocks.prefetchWorkspaceDefinitions).not.toHaveBeenCalled();
      expect(storeMocks.listFiles).not.toHaveBeenCalled();
      expect(storeMocks.searchHistory).not.toHaveBeenCalled();
      expect(storeMocks.loadTransfers).not.toHaveBeenCalled();
      expect(storeMocks.captureContext).not.toHaveBeenCalled();

      const summaries = infoSpy.mock.calls
        .filter(([label]) => label === "[workspace-switch]")
        .map(([, summary]) => summary as Record<string, number | string | null>);
      expect(summaries).toHaveLength(1);
      for (const summary of summaries) {
        expect(summary.click_to_layout_visible).toBeLessThanOrEqual(100);
        expect(summary.layout_to_all_scheduled_done).toBeLessThanOrEqual(100);
      }
    } finally {
      view.unmount();
      infoSpy.mockRestore();
      performanceNowSpy.mockRestore();
    }
  });

  it("freezes the leaving running workspace before selecting another running workspace", async () => {
    const workspaceA = runningWorkspace("workspace-1", 0, 1, "runtime-1");
    const workspaceB = runningWorkspace("workspace-2", 1, 2, "runtime-2");
    workspaceA.name = "运维巡检";
    workspaceB.name = "构建窗口";
    storeMocks.workspaceState.workspaces = [workspaceA, workspaceB];
    storeMocks.workspaceState.activeWorkspaceId = "workspace-1";
    storeMocks.workspaceState.tabs = workspaceA.tabs;
    storeMocks.workspaceState.activeTabId = workspaceA.activeTabId;
    storeMocks.terminalState.visualOutputTail = {
      "runtime-1": "leaving tail",
      "runtime-2": "target tail",
    };
    const view = render(<AppShell />);

    await clickButton(view.container, "工作区");
    await clickButton(view.container, "切换工作区 构建窗口");

    expect(storeMocks.freezeWorkspaceRuntimeVisualSnapshots).toHaveBeenCalledWith(
      "workspace-1",
      storeMocks.terminalState.visualOutputTail,
      expect.any(Number),
    );
    expect(storeMocks.freezeWorkspaceRuntimeVisualSnapshots.mock.invocationCallOrder[0]).toBeLessThan(
      storeMocks.selectWorkspace.mock.invocationCallOrder[0],
    );
    expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-2");

    view.unmount();
  });

  it("freezes the active running workspace before restoring a closed workspace", async () => {
    const activeWorkspace = runningWorkspace("workspace-active", 0, 1, "runtime-active");
    activeWorkspace.name = "运维巡检";
    storeMocks.workspaceState.workspaces = [
      activeWorkspace,
      {
        id: "workspace-closed",
        name: "发布窗口",
        status: "closed",
        active_tab_id: "closed-tab-1",
        activeTabId: "closed-tab-1",
        tab_count: 1,
        sort_order: 1,
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    ];
    storeMocks.workspaceState.activeWorkspaceId = "workspace-active";
    storeMocks.workspaceState.tabs = activeWorkspace.tabs;
    storeMocks.workspaceState.activeTabId = activeWorkspace.activeTabId;
    storeMocks.terminalState.visualOutputTail = {
      "runtime-active": "active tail before restore",
    };
    storeMocks.workspaceGet.mockResolvedValue({
      id: "workspace-closed",
      name: "发布窗口",
      status: "closed",
      active_tab_id: "closed-tab-1",
      sort_order: 1,
      created_at_ms: 1,
      updated_at_ms: 2,
      tabs: [
        {
          id: "closed-tab-1",
          title: "主工作台",
          active_pane_id: "closed-pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 2,
          root: {
            kind: "leaf",
            id: "closed-pane-1",
            title: "PowerShell 7",
            runtime_session_id: null,
            saved_session_id: null,
            active_terminal_tab_id: "closed-pane-1-tab-1",
            terminal_tabs: [
              {
                id: "closed-pane-1-tab-1",
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
    await clickWorkspaceContextAction(view.container, "发布窗口", "恢复工作区 发布窗口");
    await flushWorkspacePostLayoutWork();

    expect(storeMocks.freezeWorkspaceRuntimeVisualSnapshots).toHaveBeenCalledWith(
      "workspace-active",
      storeMocks.terminalState.visualOutputTail,
      expect.any(Number),
    );
    expect(storeMocks.freezeWorkspaceRuntimeVisualSnapshots.mock.invocationCallOrder[0]).toBeLessThan(
      storeMocks.upsertWorkspaceDefinition.mock.invocationCallOrder[0],
    );
    expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-closed");

    view.unmount();
  });

  it("keeps running workspace layers mounted and switches by visibility", async () => {
    storeMocks.workspaceState.workspaces = [
      {
        id: "workspace-1",
        name: "运维巡检",
        status: "running",
        active_tab_id: "tab-1",
        activeTabId: "tab-1",
        tabs: storeMocks.workspaceState.tabs,
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
      {
        id: "workspace-2",
        name: "构建窗口",
        status: "running",
        active_tab_id: "tab-2",
        activeTabId: "tab-2",
        tabs: [
          {
            id: "tab-2",
            title: "构建",
            active_pane_id: "pane-2",
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            root: {
              kind: "leaf",
              id: "pane-2",
              title: "PowerShell 7",
              runtime_session_id: "runtime-2",
              saved_session_id: null,
              active_terminal_tab_id: "pane-2-tab-1",
              terminal_tabs: [
                {
                  id: "pane-2-tab-1",
                  title: "PowerShell 7",
                  runtime_session_id: "runtime-2",
                  saved_session_id: null,
                },
              ],
            },
          },
        ],
        tab_count: 1,
        sort_order: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ];
    const view = render(<AppShell />);

    expect(view.container.querySelector('[aria-label="工作区视图 运维巡检"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="工作区视图 构建窗口"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="工作区视图 运维巡检"]')?.getAttribute("data-active")).toBe("true");
    expect(view.container.querySelector('[aria-label="工作区视图 构建窗口"]')?.getAttribute("data-active")).toBe("false");
    expect(view.container.textContent).toContain("PowerShell 7");

    await clickButton(view.container, "工作区");
    await clickButton(view.container, "切换工作区 构建窗口");

    expect(view.container.querySelector('[aria-label="工作区切换快照布局"]')).toBeNull();
    expect(storeMocks.selectWorkspace).toHaveBeenCalledWith("workspace-2");
    expect(storeMocks.openTerminal).not.toHaveBeenCalled();
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.searchHistory).not.toHaveBeenCalled();
    expect(storeMocks.captureContext).not.toHaveBeenCalled();

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

  it("opens the connection picker from a pane plus button before creating a connection", async () => {
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="创建连接"]') as HTMLButtonElement).click();
    });

    expect(view.container.querySelector('[aria-label="选择连接"]')).not.toBe(null);
    expect(storeMocks.openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(storeMocks.addPaneTab).not.toHaveBeenCalled();

    await act(async () => {
      (view.container.querySelector('[aria-label="选择默认本地终端"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(storeMocks.openDefaultLocalTerminal).toHaveBeenCalledWith("pane-1");
    expect(storeMocks.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ runtime_session_id: "runtime-local", kind: "local" }),
    );
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
      "workspace-1",
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

    expect(storeMocks.closeActivePane).toHaveBeenCalledTimes(1);
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
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({ runtime_session_id: "runtime-2", saved_session_id: "session-1", pane_id: "pane-1" }),
    );
    view.unmount();
  });

  it("refreshes right-side history and command groups for the active saved session", async () => {
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
      deduplicate: false,
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
      deduplicate: false,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith("saved_session", "session-2");
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe("saved_session");
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe("session-2");

    view.unmount();
  });

  it("refreshes command history when the active terminal receives input", async () => {
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
      deduplicate: false,
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
      deduplicate: false,
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
      deduplicate: false,
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
      deduplicate: false,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith("local_profile", "pwsh");
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe("local_profile");
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe("pwsh");

    view.unmount();
  });

  it("does not use an RDP saved session as a history fallback when no scope exists", async () => {
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
    const historyButton = view.container.querySelector('.zt-tool-rail [aria-label="历史"]') as HTMLButtonElement;

    await act(async () => {
      historyButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.searchHistory).toHaveBeenLastCalledWith({
      query: "",
      scopeKind: null,
      scopeId: null,
      deduplicate: false,
    });
    expect(storeMocks.loadCommandGroups).toHaveBeenLastCalledWith(null, null);
    expect(storeMocks.historyPanelProps?.historyScopeKind).toBe(null);
    expect(storeMocks.historyPanelProps?.historyScopeId).toBe(null);

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
      id: "session-1",
      name: "开发机 A",
      host: "172.16.41.180",
      port: 22,
      username: "ubuntu",
    });

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
      "workspace-1",
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
