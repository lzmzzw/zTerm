// Author: Liz
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadTerminalLayout, saveTerminalLayout } from "../features/terminal-layout/terminalLayoutPersistence";
import type { TerminalLayoutDefinition } from "../features/terminal-layout/types";
import { AppShell } from "./AppShell";
import { closeAgentCodex, openAgentCodex, setActiveAgentTerminal } from "../features/ai/agentCodexApi";
import { useFileTransferStore } from "../features/files/fileTransferStore";
import { useSyncInputStore } from "../features/terminal/syncInputStore";

const originalPrepareForSession = useFileTransferStore.getState().prepareForSession;

const storeMocks = vi.hoisted(() => ({
  noop: vi.fn(),
  asyncNoop: vi.fn().mockResolvedValue(undefined),
  setActiveAgentTerminal: vi.fn().mockResolvedValue(undefined),
  bindApprovalModeToSession: vi.fn().mockResolvedValue(undefined),
  loadPendingInvocations: vi.fn().mockResolvedValue([]),
  saveSession: vi.fn().mockResolvedValue(undefined),
  bindEvents: vi.fn().mockResolvedValue(() => undefined),
  addPaneTab: vi.fn(),
  addPaneTabAfter: vi.fn(),
  closePaneTab: vi.fn(),
  closePane: vi.fn(),
  selectPaneTab: vi.fn(),
  bindRuntimeToPane: vi.fn(),
  bindRuntimeToPaneTab: vi.fn(),
  buildActiveTerminalLayoutDraft: vi.fn(),
  restoreWorkbenchDefinition: vi.fn(),
  clearRuntimeSession: vi.fn(),
  hasPaneTerminalTab: vi.fn(() => true),
  splitActivePane: vi.fn(),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  updatePaneTerminalTab: vi.fn(),
  setActivePane: vi.fn(),
  writeTerminal: vi.fn().mockResolvedValue(undefined),
  enterSshContainerRuntime: vi.fn().mockResolvedValue(undefined),
  terminalOutputAccesses: 0,
  tauriEventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
  tauriEventListenCounts: new Map<string, number>(),
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
      shortcuts: [],
    },
  },
  deleteCommandGroup: vi.fn().mockResolvedValue(undefined),
  deleteHistoryEntries: vi.fn().mockResolvedValue(undefined),
  historyPanelProps: null as Record<string, unknown> | null,
  monitorPanelProps: null as Record<string, unknown> | null,
  transferPanelProps: null as Record<string, unknown> | null,
  fileTransferPanelProps: null as Record<string, unknown> | null,
  aiPanelProps: null as Record<string, unknown> | null,
  mcpAffectedDomainsHandler: null as ((domains: string[]) => Promise<void> | void) | null,
  mcpAffectedDomainsHandlerSetCount: 0,
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
  terminalLayoutState: {
    activeTerminalLayoutId: "terminalLayout-1",
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
  TitleBar: ({ centerContent, navigation }: { centerContent?: string | null; navigation?: ReactNode }) => <header aria-label="标题栏">{navigation}{centerContent}</header>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    storeMocks.tauriEventListenCounts.set(eventName, (storeMocks.tauriEventListenCounts.get(eventName) ?? 0) + 1);
    storeMocks.tauriEventHandlers.set(eventName, handler);
    return () => {
      storeMocks.tauriEventHandlers.delete(eventName);
    };
  }),
}));

vi.mock("../features/terminal/externalLaunchApi", () => ({
  externalSshChannelPolicy: (launch: { channel_policy?: string; username?: string } | null | undefined) => {
    if (["unknown", "multi_channel", "single_channel"].includes(launch?.channel_policy ?? "")) {
      return launch!.channel_policy;
    }
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

vi.mock("../features/ai/AgentCodexPanel", () => ({
  AgentCodexPanel: (props: Record<string, unknown>) => {
    storeMocks.aiPanelProps = props;
    return <section aria-label="AI 面板" />;
  },
}));

vi.mock("../features/ai/agentCodexApi", () => ({
  openAgentCodex: vi.fn(async (request: { tabId: string; targetRuntimeSessionId: string; targetSavedSessionId: string | null; targetLabel: string }) => ({
    agent_session_id: `agent-${request.tabId}`,
    target_runtime_session_id: request.targetRuntimeSessionId,
    target_saved_session_id: request.targetSavedSessionId,
    target_label: request.targetLabel,
    approval_mode: "safe",
    runtime: {
      runtime_session_id: `agent-runtime-${request.tabId}`,
      saved_session_id: null,
      history_scope_kind: null,
      history_scope_id: null,
      pane_id: `agent:${request.tabId}`,
      title: `Codex · ${request.targetLabel}`,
      kind: "local",
      cols: 80,
      rows: 30,
    },
  })),
  closeAgentCodex: vi.fn(async () => undefined),
  setActiveAgentTerminal: storeMocks.setActiveAgentTerminal,
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

vi.mock("../features/terminal-layout/SplitPaneView", () => ({
  SplitPaneView: ({
    root,
    activePaneId,
    onAddPaneTab,
    onDuplicatePaneTab,
    onClosePaneTab,
    onClosePane,
    onSplitPane,
    terminalLayoutActive = true,
    visualMode = "normal",
  }: {
    root: Record<string, unknown>;
    activePaneId: string;
    onAddPaneTab: (paneId: string) => void;
    onDuplicatePaneTab: (paneId: string, paneTabId: string) => void;
    onClosePaneTab: (paneId: string, paneTabId: string) => void;
    onClosePane: (paneId: string) => void;
    onSplitPane: (direction: "horizontal" | "vertical") => void;
    terminalLayoutActive?: boolean;
    visualMode?: "normal" | "placeholder" | "snapshot";
  }) =>
    visualMode === "placeholder" || visualMode === "snapshot" ? (
      <section
        aria-label={visualMode === "snapshot" ? "终端布局切换快照布局" : "终端布局切换轻量布局"}
        data-active-pane-id={activePaneId}
      >
        {collectMockPaneTitles(root).join(" ")}
      </section>
    ) : (
      <section aria-label="终端分栏" data-terminal-layout-active={String(terminalLayoutActive)}>
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

vi.mock("../features/ai/mcpStore", () => {
  const mcpState = () => ({
    approvalMode: "safe",
    approvalSessionId: null,
    pendingInvocations: [],
    loading: false,
    error: null,
    loadPendingInvocations: storeMocks.loadPendingInvocations,
    setApprovalMode: storeMocks.asyncNoop,
    bindApprovalModeToSession: storeMocks.bindApprovalModeToSession,
    confirmTool: storeMocks.asyncNoop,
  });
  const useMcpStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = mcpState();
    if (selector) return selector(state);
    return state;
  };
  const setMcpAffectedDomainsHandler = vi.fn((handler: ((domains: string[]) => Promise<void> | void) | null) => {
    storeMocks.mcpAffectedDomainsHandlerSetCount += 1;
    storeMocks.mcpAffectedDomainsHandler = handler;
  });
  return { setMcpAffectedDomainsHandler, useMcpStore };
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
      forgetTerminalRuntime: (runtimeSessionId: string) => {
        const { [runtimeSessionId]: _runtime, ...runtimes } = storeMocks.terminalState.runtimes;
        storeMocks.terminalState.runtimes = runtimes;
      },
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
  (useTerminalStore as unknown as { setState: (updater: unknown) => void }).setState = vi.fn((updater: unknown) => {
    const current = terminalState(false);
    const next = typeof updater === "function"
      ? (updater as (state: Record<string, unknown>) => Record<string, unknown>)(current)
      : updater;
    if (next && typeof next === "object" && "runtimes" in next) {
      storeMocks.terminalState.runtimes = (next as { runtimes: Record<string, Record<string, unknown>> }).runtimes;
    }
  });
  useTerminalStore.getState = () => terminalState(false);
  return { useTerminalStore };
});


vi.mock("../features/terminal-layout/terminalLayoutStore", () => {
  const terminalLayoutState = () => ({
    activeTerminalLayoutId: storeMocks.terminalLayoutState.activeTerminalLayoutId,
    tabs: storeMocks.terminalLayoutState.tabs,
    activeTabId: storeMocks.terminalLayoutState.activeTabId,
    buildActiveTerminalLayoutDraft: storeMocks.buildActiveTerminalLayoutDraft,
    restoreWorkbenchDefinition: storeMocks.restoreWorkbenchDefinition,
    clearRuntimeSession: storeMocks.clearRuntimeSession,
    hasPaneTerminalTab: storeMocks.hasPaneTerminalTab,
    updatePaneTerminalTab: storeMocks.updatePaneTerminalTab,
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
  const useTerminalLayoutStore = (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = terminalLayoutState();
    if (selector) return selector(state);
    return state;
  };
  useTerminalLayoutStore.getState = () => ({
    ...terminalLayoutState(),
    buildActiveTerminalLayoutDraft: storeMocks.buildActiveTerminalLayoutDraft,
    restoreWorkbenchDefinition: storeMocks.restoreWorkbenchDefinition,
    clearRuntimeSession: storeMocks.clearRuntimeSession,
    hasPaneTerminalTab: storeMocks.hasPaneTerminalTab,
    updatePaneTerminalTab: storeMocks.updatePaneTerminalTab,
    setActivePane: storeMocks.setActivePane,
    selectPaneTab: storeMocks.selectPaneTab,
    addPaneTabAfter: storeMocks.addPaneTabAfter,
    bindRuntimeToPane: storeMocks.bindRuntimeToPane,
    bindRuntimeToPaneTab: storeMocks.bindRuntimeToPaneTab,
  });
  return { useTerminalLayoutStore };
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





function activeTerminalTerminalLayoutTab() {
  return {
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
  };
}

function sharedSshConnectionTerminalLayoutTab(activePaneTabId = "pane-1-tab-1") {
  const terminalTabs = [
    {
      id: "pane-1-tab-1",
      title: "开发机 A",
      runtime_session_id: "runtime-1",
      saved_session_id: "session-1",
    },
    {
      id: "pane-1-tab-2",
      title: "开发机 A（第二标签）",
      runtime_session_id: "runtime-2",
      saved_session_id: "session-1",
    },
  ];
  const active = terminalTabs.find((terminalTab) => terminalTab.id === activePaneTabId) ?? terminalTabs[0];
  return {
    id: "tab-1",
    title: active.title,
    active_pane_id: "pane-1",
    root: {
      kind: "leaf",
      id: "pane-1",
      title: active.title,
      runtime_session_id: active.runtime_session_id,
      saved_session_id: active.saved_session_id,
      active_terminal_tab_id: active.id,
      terminal_tabs: terminalTabs,
    },
  };
}

vi.mock("../features/terminal-layout/terminalLayoutPersistence", () => ({ loadTerminalLayout: vi.fn().mockResolvedValue(null), saveTerminalLayout: vi.fn().mockResolvedValue(undefined) }));

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadTerminalLayout).mockReset().mockResolvedValue(null);
    vi.mocked(saveTerminalLayout).mockReset().mockResolvedValue(undefined);
    useFileTransferStore.setState({ prepareForSession: originalPrepareForSession });
    useSyncInputStore.getState().closeChannel();
    storeMocks.mcpAffectedDomainsHandler = null;
    storeMocks.mcpAffectedDomainsHandlerSetCount = 0;
    storeMocks.tauriEventHandlers.clear();
    storeMocks.tauriEventListenCounts.clear();
    storeMocks.loadPendingInvocations.mockResolvedValue([]);
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
    storeMocks.setActivePane.mockReset();
    storeMocks.splitActivePane.mockReset();
    storeMocks.writeTerminal.mockResolvedValue(undefined);
    storeMocks.terminalOutputAccesses = 0;
    storeMocks.settingsState.appSettings = {
      language: "zhCN",
      theme: "dark",
      ui_font_size: 13,
      terminal_font_size: 13,
      default_right_tool: "agent",
      shortcuts: [],
    };
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
    storeMocks.terminalLayoutState.activeTerminalLayoutId = "default-terminalLayout";
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.activeTabId = "tab-1";
    storeMocks.buildActiveTerminalLayoutDraft.mockReturnValue({
      id: "default-terminalLayout",
      name: "默认终端布局",
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

  it("does not overwrite persisted state before loading finishes or after a read failure", async () => {
    vi.useFakeTimers();
    const pending = deferred<TerminalLayoutDefinition | null>();
    vi.mocked(loadTerminalLayout).mockReturnValueOnce(pending.promise);
    const view = render(<AppShell />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(500); });
    expect(saveTerminalLayout).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("read failed")); await Promise.resolve(); await vi.advanceTimersByTimeAsync(500); });
    expect(saveTerminalLayout).not.toHaveBeenCalled();
    view.unmount(); vi.useRealTimers();
  });
  it("does not replace user changes made during startup loading", async () => {
    vi.useFakeTimers();
    const pending = deferred<TerminalLayoutDefinition | null>();
    vi.mocked(loadTerminalLayout).mockReturnValueOnce(pending.promise);
    const view = render(<AppShell />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    storeMocks.terminalLayoutState.tabs = [...storeMocks.terminalLayoutState.tabs];
    await act(async () => { pending.resolve({ ...storeMocks.buildActiveTerminalLayoutDraft(), created_at_ms: 1, updated_at_ms: 1 }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(storeMocks.restoreWorkbenchDefinition).not.toHaveBeenCalled();
    expect(saveTerminalLayout).toHaveBeenCalledTimes(1);
    view.unmount(); vi.useRealTimers();
  });
  it("restores the single layout and then autosaves the current layout", async () => {
    vi.useFakeTimers();
    vi.mocked(loadTerminalLayout).mockResolvedValueOnce({ ...storeMocks.buildActiveTerminalLayoutDraft(), created_at_ms: 1, updated_at_ms: 1 });
    const view = render(<AppShell />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(storeMocks.restoreWorkbenchDefinition).toHaveBeenCalledTimes(1);
    expect(saveTerminalLayout).toHaveBeenCalledTimes(1);
    view.unmount(); vi.useRealTimers();
  });

  it("keeps global tool listeners stable across rerenders", async () => {
    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.tauriEventListenCounts.get("zterm:tool-action")).toBe(1);
    expect(storeMocks.mcpAffectedDomainsHandlerSetCount).toBe(1);

    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeMocks.tauriEventListenCounts.get("zterm:tool-action")).toBe(1);
    expect(storeMocks.mcpAffectedDomainsHandlerSetCount).toBe(1);
    view.unmount();
  });

  it("opens the Agent approval surface when an external MCP call becomes pending", async () => {
    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector('[aria-label="AI 面板"]')).toBe(null);
    storeMocks.loadPendingInvocations.mockResolvedValueOnce([
      {
        id: "pending-1",
        tool_id: "ssh.execute",
        tool_title: "执行 SSH 命令",
        risk_level: "high",
        arguments_summary: "saved_session_id=session-1, script=[redacted]",
        requires_confirmation: true,
        status: "pending",
      },
    ]);

    const handler = storeMocks.tauriEventHandlers.get("zterm:tool-pending");
    expect(handler).toBeDefined();
    await act(async () => {
      handler?.({ payload: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[aria-label="AI 面板"]')).not.toBe(null);
    view.unmount();
  });

  it("opens a saved SSH connection in a requested visible split for sidebar Codex", async () => {
    storeMocks.sessionState.sessions = [
      {
        id: "session-1",
        name: "生产机",
        type: "ssh",
        group_id: null,
        host: "10.20.30.40",
        port: 22,
        username: "ops",
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
    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const handler = storeMocks.tauriEventHandlers.get("zterm:tool-action");
    expect(handler).toBeDefined();
    await act(async () => {
      handler?.({
        payload: {
          action: "terminal.open",
          arguments: {
            saved_session_id: "session-1",
            placement: "split_vertical",
          },
          affected_domains: ["terminal"],
        },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 1));
    });

    expect(storeMocks.splitActivePane).toHaveBeenCalledWith("vertical");
    expect(storeMocks.openTerminal).toHaveBeenCalledWith("session-1", "pane-1");
    expect(storeMocks.splitActivePane.mock.invocationCallOrder[0]).toBeLessThan(
      storeMocks.openTerminal.mock.invocationCallOrder[0],
    );
    view.unmount();
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
    Object.assign(storeMocks.terminalLayoutState.tabs[0].root as Record<string, unknown>, {
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
    Object.assign(storeMocks.terminalLayoutState.tabs[0].root as Record<string, unknown>, {
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
        local_options: { working_directory: "D:\\terminalLayout\\zterm" },
      },
    ];
    Object.assign(storeMocks.terminalLayoutState.tabs[0].root as Record<string, unknown>, {
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

    expect(view.container.querySelector('[aria-label="标题栏"]')?.textContent).toBe("D:\\terminalLayout\\zterm");
    view.unmount();
  });

  it("opens a multi-channel external SSH launch with SSH tools collapsed", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "ops@cloud.example.test:2200",
        host: "cloud.example.test",
        port: 2200,
        username: "ops",
        auto_open_sftp: true,
        remote_path: "/srv/app",
        channel_policy: "multi_channel",
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
      "default-terminalLayout",
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
      "default-terminalLayout",
      "tab-1",
      "pane-1",
      "pane-1-tab-1",
      expect.objectContaining({
        runtime_session_id: "runtime-external",
        saved_session_id: "external:launch-1",
      }),
    );
    expect(view.container.querySelector(".zt-right-tools-collapsed")).not.toBe(null);
    expect(storeMocks.listFiles).not.toHaveBeenCalled();
    expect(storeMocks.loadTransfers).not.toHaveBeenCalled();

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
        channel_policy: "multi_channel",
      },
    ];
    storeMocks.terminalLayoutState.tabs = [
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
    expect(view.container.querySelector(".zt-right-tools-collapsed")).not.toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SFTP 文件"]')).not.toBe(null);
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

  it("hides SFTP, container, and tunnel tools for single-channel external SSH", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=@172.21.195.223:222",
        host: "172.21.195.223",
        port: 222,
        username: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=",
        auto_open_sftp: false,
        remote_path: "/",
        channel_policy: "single_channel",
      },
    ];
    storeMocks.terminalLayoutState.tabs = [
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

    expect(view.container.querySelector('.zt-tool-rail [aria-label="SFTP 文件"]')).toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 容器"]')).toBe(null);
    expect(view.container.querySelector('.zt-tool-rail [aria-label="SSH 隧道"]')).toBe(null);
    expect(storeMocks.listSshContainers).not.toHaveBeenCalled();

    view.unmount();
  });

  it("edits transient SSH tunnels in a tunnel-only dialog and marks them as requiring reconnect", async () => {
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:launch-1",
        name: "ops@cloud.example.test:2200",
        host: "cloud.example.test",
        port: 2200,
        username: "ops",
        auto_open_sftp: false,
        remote_path: "/",
        channel_policy: "multi_channel",
      },
    ];
    storeMocks.terminalLayoutState.tabs = [
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
    expect(targetHostInput.value).toBe("cloud.example.test");
    await clickButton(view.container, "保存临时隧道");

    expect(storeMocks.updateExternalSshOptions).toHaveBeenCalledWith(
      "external:launch-1",
      expect.objectContaining({
        tunnels: [
          expect.objectContaining({
            mode: "host_service",
            kind: "local",
            remote_host: "cloud.example.test",
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
    expect(view.container.querySelector('.zt-titlebar-navigation [aria-label="Sessions"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-titlebar-navigation [aria-label="File Transfer"]')).not.toBe(null);
    expect(view.container.querySelector('.zt-titlebar-navigation [aria-label="Models"]')).toBe(null);
    expect(view.container.querySelector('.zt-titlebar-navigation [aria-label="Open Settings"]')).not.toBe(null);
    expect(view.container.querySelector('[aria-label="Terminal Panes"]')).not.toBe(null);
    expect(view.container.textContent).toContain("New Terminal");

    const dynamicButton = document.createElement("button");
    dynamicButton.setAttribute("aria-label", "打开设置");
    dynamicButton.textContent = "确认删除";
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

    expect(dynamicButton.getAttribute("aria-label")).toBe("Open Settings");
    expect(dynamicButton.textContent).toBe("Confirm Delete");
    expect(skipped.textContent).toBe("新建终端");
    expect(ftpText.getAttribute("aria-label")).toBe("New FTP Session");
    expect(ftpText.textContent).toContain("Initial Remote Directory");
    expect(ftpText.textContent).toContain("Anonymous Login");
    expect(ftpText.textContent).toContain("FTP does not encrypt credentials");
    expect(sftpCredentialName.textContent).toBe("发布 SFTP SFTP Key Passphrase");

    view.unmount();
  });

  it("opens settings page from the titlebar settings icon without mounting removed bottom dock", async () => {
    const view = render(<AppShell />);
    const settingsButton = view.container.querySelector('.zt-titlebar-navigation [aria-label="打开设置"]') as HTMLButtonElement;

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
    expect(view.container.querySelector('[aria-label="标题栏"]')?.querySelector('[aria-label="打开设置"]')?.getAttribute("aria-pressed")).toBe("true");

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

  it("keeps the session rail available without a layout manager", async () => {
    const view = render(<AppShell />);
    expect(view.container.querySelector('[aria-label="会话"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="终端布局管理"]')).toBeNull();
    view.unmount();
  });

  it("does not expose model management inside settings after moving models to the foreground sidebar", async () => {
    const view = render(<AppShell />);

    await clickButton(view.container, "打开设置");

    expect(view.container.querySelector('[aria-label="设置分类"]')?.textContent).not.toContain("模型");

    view.unmount();
  });







  it("opens a FileZilla-format SFTP launch in the file transfer dialog with the remote endpoint on the right", async () => {
    const prepareForSession = vi.fn().mockResolvedValue(undefined);
    useFileTransferStore.setState({ prepareForSession });
    storeMocks.pendingExternalLaunches = [
      {
        id: "external:filezilla-1",
        name: "release@example.test:2222",
        host: "example.test",
        port: 2222,
        username: "release",
        auto_open_sftp: false,
        remote_path: "/srv/releases",
        channel_policy: "unknown",
        file_transfer_protocol: "sftp",
      },
    ];

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(prepareForSession).toHaveBeenCalledWith("external:filezilla-1", "/srv/releases");
    expect(view.container.querySelector('[aria-label="文件传输"]')).not.toBe(null);
    expect(storeMocks.openTerminal).not.toHaveBeenCalled();

    view.unmount();
  });

  it("lets users dismiss a terminal operation error", async () => {
    storeMocks.takePendingExternalLaunches.mockRejectedValue(new Error("SSH connection refused"));

    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = view.container.querySelector('.zt-main-error[role="alert"]');
    expect(alert?.textContent).toContain("操作未完成");
    expect(alert?.textContent).toContain("SSH connection refused");

    act(() => {
      button(view.container, "关闭终端错误提示").click();
    });
    expect(view.container.querySelector(".zt-main-error")).toBeNull();
    expect(view.container.querySelector("main")?.classList.contains("zt-main-with-error")).toBe(false);

    view.unmount();
  });

  it("opens a second-instance external SSH launch in a new pane tab", async () => {
    storeMocks.terminalLayoutState.tabs = [
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
      "default-terminalLayout",
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

  it("starts a bound Codex session without capturing target output in the React agent layer", async () => {
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalState.outputTails = { "runtime-1": "line\n".repeat(1200) };
    const view = render(<AppShell />);

    expect(storeMocks.terminalOutputAccesses).toBe(0);
    expect(storeMocks.captureContext).not.toHaveBeenCalled();

    const agentButton = view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement;
    await act(async () => {
      agentButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.terminalOutputAccesses).toBe(0);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 140));
    });
    expect(storeMocks.captureContext).not.toHaveBeenCalled();
    expect(storeMocks.aiPanelProps).toEqual(
      expect.objectContaining({
        session: expect.objectContaining({ target_runtime_session_id: "runtime-1" }),
      }),
    );

    view.unmount();
  });

  it("uses the saved SSH connection name while the Agent session is still opening", async () => {
    const opening = deferred<Awaited<ReturnType<typeof openAgentCodex>>>();
    vi.mocked(openAgentCodex).mockImplementationOnce(() => opening.promise);
    storeMocks.sessionState.sessions = [{ id: "session-1", name: "生产 SSH", type: "ssh", host: "10.0.0.1" }];
    const tab = activeTerminalTerminalLayoutTab();
    tab.root.title = "临时巡检标签";
    tab.root.terminal_tabs[0].title = "临时巡检标签";
    storeMocks.terminalLayoutState.tabs = [tab];
    storeMocks.terminalState.runtimes = {
      "runtime-1": { runtime_session_id: "runtime-1", kind: "ssh", title: "临时巡检标签" },
    };
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledWith(expect.objectContaining({
      targetLabel: "生产 SSH",
    }));
    expect(storeMocks.aiPanelProps).toEqual(expect.objectContaining({
      activeTargetLabel: "生产 SSH",
      session: null,
    }));
    view.unmount();
  });

  it("syncs the active SSH runtime and clears it when switching to local", async () => {
    storeMocks.sessionState.sessions = [{ id: "session-1", name: "开发机 A", type: "ssh", host: "10.0.0.1" }];
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    storeMocks.terminalState.runtimes = {
      "runtime-1": { runtime_session_id: "runtime-1", kind: "ssh", title: "开发机 A" },
      "runtime-local": { runtime_session_id: "runtime-local", kind: "local", title: "PowerShell" },
    };
    const view = render(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(setActiveAgentTerminal)).toHaveBeenLastCalledWith("runtime-1");

    storeMocks.terminalLayoutState.tabs = [{
      ...activeTerminalTerminalLayoutTab(),
      root: {
        ...activeTerminalTerminalLayoutTab().root,
        title: "PowerShell",
        runtime_session_id: "runtime-local",
        saved_session_id: null,
        terminal_tabs: [{
          id: "pane-1-tab-1",
          title: "PowerShell",
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          connection_source: "default_local",
        }],
      },
    }];
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(setActiveAgentTerminal)).toHaveBeenLastCalledWith(null);
    view.unmount();
  });

  it("serializes active runtime sync when switching tabs quickly", async () => {
    storeMocks.sessionState.sessions = [{ id: "session-1", name: "开发机 A", type: "ssh", host: "10.0.0.1" }];
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    storeMocks.terminalState.runtimes = {
      "runtime-1": { runtime_session_id: "runtime-1", kind: "ssh", title: "开发机 A" },
      "runtime-2": { runtime_session_id: "runtime-2", kind: "ssh", title: "开发机 A" },
    };
    const first = deferred<void>();
    const second = deferred<void>();
    vi.mocked(setActiveAgentTerminal)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const view = render(<AppShell />);

    storeMocks.terminalLayoutState.tabs = [{
      ...activeTerminalTerminalLayoutTab(),
      root: {
        ...activeTerminalTerminalLayoutTab().root,
        runtime_session_id: "runtime-2",
        terminal_tabs: [{
          id: "pane-1-tab-1",
          title: "开发机 A",
          runtime_session_id: "runtime-2",
          saved_session_id: "session-1",
        }],
      },
    }];
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(setActiveAgentTerminal)).toHaveBeenCalledTimes(1);

    second.resolve();
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(setActiveAgentTerminal)).toHaveBeenCalledTimes(1);

    first.resolve();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vi.mocked(setActiveAgentTerminal).mock.calls.map(([runtime]) => runtime)).toEqual([
      "runtime-1",
      "runtime-2",
    ]);
    view.unmount();
  });

  it("shares one Codex session between terminal tabs opened from the same SSH connection", async () => {
    storeMocks.terminalLayoutState.tabs = [sharedSshConnectionTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledTimes(1);
    expect(storeMocks.aiPanelProps?.session).toEqual(expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }));

    storeMocks.terminalLayoutState.tabs = [sharedSshConnectionTerminalLayoutTab("pane-1-tab-2")];
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledTimes(1);
    expect(storeMocks.aiPanelProps?.session).toEqual(expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }));

    const secondConnectionTab = sharedSshConnectionTerminalLayoutTab("pane-1-tab-2");
    secondConnectionTab.root.terminal_tabs = [
      {
        id: "pane-1-tab-2",
        title: "开发机 A（第二标签）",
        runtime_session_id: "runtime-2",
        saved_session_id: "session-1",
      },
    ];
    secondConnectionTab.root.active_terminal_tab_id = "pane-1-tab-2";
    secondConnectionTab.root.runtime_session_id = "runtime-2";
    storeMocks.terminalLayoutState.tabs = [secondConnectionTab];
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(closeAgentCodex)).not.toHaveBeenCalled();

    storeMocks.terminalLayoutState.tabs = [
      {
        ...activeTerminalTerminalLayoutTab(),
        root: {
          ...activeTerminalTerminalLayoutTab().root,
          runtime_session_id: null,
          saved_session_id: null,
          terminal_tabs: [{ id: "pane-1-tab-empty", title: "新建终端", runtime_session_id: null, saved_session_id: null }],
        },
      },
    ];
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }),
    );
    view.unmount();
  });

  it("keeps the Codex terminal mounted when switching from Agent to another sidebar tool", async () => {
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
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="历史"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(view.container.querySelector('[aria-label="AI 面板"]')).not.toBeNull();
    expect(storeMocks.aiPanelProps?.session).toEqual(expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }));
    view.unmount();
  });

  it("closes an opening Codex session when its last connection tab disappears", async () => {
    const opening = deferred<Awaited<ReturnType<typeof openAgentCodex>>>();
    vi.mocked(openAgentCodex).mockImplementationOnce(() => opening.promise);
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledTimes(1);

    storeMocks.terminalLayoutState.tabs = [
      {
        ...activeTerminalTerminalLayoutTab(),
        root: {
          ...activeTerminalTerminalLayoutTab().root,
          runtime_session_id: null,
          saved_session_id: null,
          terminal_tabs: [{ id: "pane-1-tab-empty", title: "新建终端", runtime_session_id: null, saved_session_id: null }],
        },
      },
    ];
    view.rerender(<AppShell />);

    opening.resolve({
      agent_session_id: "agent-opening",
      target_runtime_session_id: "runtime-1",
      target_saved_session_id: "session-1",
      target_label: "开发机 A",
      approval_mode: "safe",
      runtime: {
        runtime_session_id: "agent-runtime-opening",
        saved_session_id: null,
        history_scope_kind: null,
        history_scope_id: null,
        pane_id: "agent:pane-1-tab-1",
        title: "Codex · 开发机 A",
        kind: "local",
        initial_cwd: null,
        cols: 80,
        rows: 30,
      },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledWith(expect.objectContaining({ agent_session_id: "agent-opening" }));
    view.unmount();
  });

  it("keeps an opening Codex session when the same SSH connection is reopened before launch resolves", async () => {
    const opening = deferred<Awaited<ReturnType<typeof openAgentCodex>>>();
    vi.mocked(openAgentCodex).mockImplementationOnce(() => opening.promise);
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    storeMocks.terminalLayoutState.tabs = [
      {
        ...activeTerminalTerminalLayoutTab(),
        root: {
          ...activeTerminalTerminalLayoutTab().root,
          runtime_session_id: null,
          saved_session_id: null,
          terminal_tabs: [{ id: "pane-1-tab-empty", title: "新建终端", runtime_session_id: null, saved_session_id: null }],
        },
      },
    ];
    view.rerender(<AppShell />);

    const reopened = sharedSshConnectionTerminalLayoutTab("pane-1-tab-2");
    reopened.root.terminal_tabs = [reopened.root.terminal_tabs[1]];
    storeMocks.terminalLayoutState.tabs = [reopened];
    view.rerender(<AppShell />);

    opening.resolve({
      agent_session_id: "agent-reopened",
      target_runtime_session_id: "runtime-1",
      target_saved_session_id: "session-1",
      target_label: "开发机 A",
      approval_mode: "safe",
      runtime: {
        runtime_session_id: "agent-runtime-reopened",
        saved_session_id: null,
        history_scope_kind: null,
        history_scope_id: null,
        pane_id: "agent:pane-1-tab-1",
        title: "Codex · 开发机 A",
        kind: "local",
        initial_cwd: null,
        cols: 80,
        rows: 30,
      },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeAgentCodex)).not.toHaveBeenCalled();
    expect(storeMocks.aiPanelProps?.session).toEqual(expect.objectContaining({ agent_session_id: "agent-reopened" }));
    view.unmount();
  });

  it("does not let a concurrent close callback remove the restarted shared Codex session", async () => {
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const onRestart = storeMocks.aiPanelProps?.onRestart as () => Promise<void>;
    const onClose = storeMocks.aiPanelProps?.onClose as () => Promise<void>;
    const restartClose = deferred<void>();
    const staleClose = deferred<void>();
    vi.mocked(closeAgentCodex)
      .mockImplementationOnce(() => restartClose.promise)
      .mockImplementationOnce(() => staleClose.promise);
    vi.mocked(openAgentCodex).mockImplementationOnce(async (request) => ({
      agent_session_id: "agent-restarted",
      target_runtime_session_id: request.targetRuntimeSessionId,
      target_saved_session_id: request.targetSavedSessionId,
      target_label: request.targetLabel,
      approval_mode: "safe",
      runtime: {
        runtime_session_id: "agent-runtime-restarted",
        saved_session_id: null,
        history_scope_kind: null,
        history_scope_id: null,
        pane_id: "agent:pane-1-tab-1",
        title: "Codex · 开发机 A",
        kind: "local",
        initial_cwd: null,
        cols: 80,
        rows: 30,
      },
    }));

    let restarting!: Promise<void>;
    let closing!: Promise<void>;
    await act(async () => {
      restarting = onRestart();
      closing = onClose();
    });
    restartClose.resolve();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    staleClose.resolve();
    await act(async () => {
      await Promise.all([restarting, closing]);
    });

    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledTimes(2);
    expect(storeMocks.aiPanelProps?.session).toEqual(expect.objectContaining({ agent_session_id: "agent-restarted" }));
    view.unmount();
  });

  it("does not collapse a newly selected Agent panel when an earlier connection closes asynchronously", async () => {
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const closeFirstConnection = storeMocks.aiPanelProps?.onClose as () => Promise<void>;
    const delayedClose = deferred<void>();
    vi.mocked(closeAgentCodex).mockImplementationOnce(() => delayedClose.promise);
    let closingFirstConnection!: Promise<void>;
    await act(async () => {
      closingFirstConnection = closeFirstConnection();
    });

    const secondConnection = activeTerminalTerminalLayoutTab();
    secondConnection.root = {
      ...secondConnection.root,
      title: "开发机 B",
      runtime_session_id: "runtime-2",
      saved_session_id: "session-2",
      active_terminal_tab_id: "pane-1-tab-2",
      terminal_tabs: [{ id: "pane-1-tab-2", title: "开发机 B", runtime_session_id: "runtime-2", saved_session_id: "session-2" }],
    };
    storeMocks.terminalLayoutState.tabs = [secondConnection];
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    delayedClose.resolve();
    await act(async () => {
      await closingFirstConnection;
    });

    expect((view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(storeMocks.aiPanelProps?.session).toEqual(expect.objectContaining({ agent_session_id: "agent-pane-1-tab-2" }));
    view.unmount();
  });

  it("clears the shared Agent binding after its Codex PTY exits naturally", async () => {
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(storeMocks.terminalState.runtimes).toHaveProperty("agent-runtime-pane-1-tab-1");

    storeMocks.terminalState.runtimes = {};
    view.rerender(<AppShell />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }),
    );
    expect(storeMocks.aiPanelProps?.session).toBeNull();
    view.unmount();
  });

  it("restarts the active Codex CLI after closing its PTY and revoking its MCP binding", async () => {
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const onRestart = storeMocks.aiPanelProps?.onRestart as () => Promise<void>;

    await act(async () => {
      await onRestart();
    });

    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }),
    );
    expect(vi.mocked(openAgentCodex)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(openAgentCodex).mock.invocationCallOrder[1]).toBeGreaterThan(
      vi.mocked(closeAgentCodex).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(openAgentCodex)).toHaveBeenLastCalledWith({
      tabId: "pane-1-tab-1",
      targetRuntimeSessionId: "runtime-1",
      targetSavedSessionId: "session-1",
      targetLabel: "开发机 A",
    });
    expect(storeMocks.aiPanelProps?.session).toEqual(
      expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }),
    );
    view.unmount();
  });

  it("closes the active Codex CLI, revokes its MCP binding, and collapses the Agent panel", async () => {
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const onClose = storeMocks.aiPanelProps?.onClose as () => Promise<void>;

    await act(async () => {
      await onClose();
    });

    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }),
    );
    expect(view.container.querySelector('[aria-label="AI 面板"]')).toBeNull();
    expect(view.container.querySelector(".zt-workbench")?.classList.contains("zt-workbench-right-collapsed")).toBe(true);
    view.unmount();
  });

  it("keeps the Agent panel open when backend Codex cleanup fails", async () => {
    storeMocks.terminalLayoutState.tabs = [activeTerminalTerminalLayoutTab()];
    vi.mocked(closeAgentCodex).mockRejectedValueOnce(new Error("close failed"));
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const onClose = storeMocks.aiPanelProps?.onClose as () => Promise<void>;

    await act(async () => {
      await onClose();
    });

    expect(vi.mocked(closeAgentCodex)).toHaveBeenCalledWith(
      expect.objectContaining({ agent_session_id: "agent-pane-1-tab-1" }),
    );
    expect(view.container.querySelector('[aria-label="AI 面板"]')).not.toBeNull();
    expect(storeMocks.aiPanelProps?.error).toContain("close failed");
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

  it("shows a no-target Codex panel for the startup placeholder pane", async () => {
    const view = render(<AppShell />);

    const agentButton = view.container.querySelector('.zt-tool-rail [aria-label="Agent"]') as HTMLButtonElement;
    await act(async () => {
      agentButton.click();
      await Promise.resolve();
    });

    expect(storeMocks.aiPanelProps).toEqual(
      expect.objectContaining({
        session: null,
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
    storeMocks.terminalLayoutState.tabs = [
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
      "default-terminalLayout",
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
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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
      "default-terminalLayout",
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
    storeMocks.terminalLayoutState.tabs = [
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

    expect(storeMocks.bindApprovalModeToSession).toHaveBeenCalledWith("session-1");
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
    storeMocks.terminalLayoutState.tabs = [
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
    const transferButton = view.container.querySelector('.zt-titlebar-navigation [aria-label="文件传输"]') as HTMLButtonElement;

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
    storeMocks.terminalLayoutState.tabs = [
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

    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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

  it.each(["ssh", "local"] as const)("refreshes history and groups for the %s connection bound to the active terminal tab", async (kind) => {
    storeMocks.terminalState.runtimes = {
      "runtime-a": {
        runtime_session_id: "runtime-a",
        saved_session_id: "session-a",
        history_scope_kind: "saved_session",
        history_scope_id: "session-a",
        kind,
      },
      "runtime-b": {
        runtime_session_id: "runtime-b",
        saved_session_id: "session-b",
        history_scope_kind: "saved_session",
        history_scope_id: "session-b",
        kind,
      },
    };
    storeMocks.terminalLayoutState.tabs = [
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

    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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
    const view = render(<AppShell />);

    await act(async () => {
      (view.container.querySelector('[aria-label="复制当前连接"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(storeMocks.addPaneTabAfter).toHaveBeenCalledWith("pane-1", "pane-1-tab-1");
    expect(storeMocks.updatePaneTerminalTab).toHaveBeenCalledWith(
      "default-terminalLayout",
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
      "default-terminalLayout",
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
    storeMocks.terminalLayoutState.tabs[0].root = {
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
    storeMocks.terminalLayoutState.tabs = [
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

    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs[0].root = {
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
    storeMocks.terminalLayoutState.tabs[0].root = {
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
    storeMocks.terminalLayoutState.tabs = [
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
      "default-terminalLayout",
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
      "default-terminalLayout",
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
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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
    storeMocks.terminalLayoutState.tabs = [
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

    storeMocks.terminalLayoutState.activeTerminalLayoutId = "terminalLayout-other";
    storeMocks.terminalLayoutState.activeTabId = "tab-other";

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
      "default-terminalLayout",
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
