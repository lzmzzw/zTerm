// Author: Liz
import { describe, expect, it, vi } from "vitest";

import type { RuntimeSessionInfo } from "../features/terminal/terminalStore";
import type { PaneTerminalTab, WorkspaceTab } from "../features/workspace/types";
import type { SavedSession } from "../features/sessions/types";
import { createTerminalActions } from "./terminalActions";

describe("terminalActions", () => {
  it("opens a saved session into the currently active empty pane tab", async () => {
    const deps = dependencies();
    const actions = createTerminalActions(deps);

    await actions.openSession(savedSession());

    expect(deps.openTerminal).toHaveBeenCalledWith("session-1", "pane-1");
    expect(deps.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-tab-1",
      runtimeInfo(),
    );
  });

  it("adds a new pane tab before opening when the active pane tab already has a runtime", async () => {
    const deps = dependencies({
      activePaneTab: paneTab({ runtime_session_id: "runtime-existing" }),
      addedPaneTab: paneTab({ id: "pane-tab-2" }),
    });
    const actions = createTerminalActions(deps);

    await actions.openSession(savedSession());

    expect(deps.addPaneTab).toHaveBeenCalledWith("pane-1");
    expect(deps.bindRuntimeToPaneTab).toHaveBeenCalledWith(
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-tab-2",
      runtimeInfo(),
    );
  });

  it("disconnects a runtime and marks the pane tab as failed", async () => {
    const deps = dependencies();
    const actions = createTerminalActions(deps);

    await actions.disconnectTerminal("pane-1", "pane-tab-1", "runtime-1");

    expect(deps.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(deps.updatePaneTerminalTab).toHaveBeenCalledWith("workspace-1", "tab-1", "pane-1", "pane-tab-1", {
      runtime_session_id: null,
      restore_status: "failed",
      restore_error: "已断开连接",
    });
  });

  it("marks reconnect failures on the target pane tab", async () => {
    const deps = dependencies({
      openTerminal: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const actions = createTerminalActions(deps);

    await actions.reconnectTerminal("pane-1", "pane-tab-1", "session-1", "runtime-1");

    expect(deps.closeTerminal).toHaveBeenCalledWith("runtime-1");
    expect(deps.updatePaneTerminalTab).toHaveBeenNthCalledWith(
      1,
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-tab-1",
      {
        runtime_session_id: null,
        restore_status: "pending",
        restore_error: null,
      },
    );
    expect(deps.updatePaneTerminalTab).toHaveBeenNthCalledWith(
      2,
      "workspace-1",
      "tab-1",
      "pane-1",
      "pane-tab-1",
      {
        restore_status: "failed",
        restore_error: "connection refused",
      },
    );
    expect(deps.setTerminalError).toHaveBeenLastCalledWith("connection refused");
  });

  it("sends trimmed commands to the active runtime", async () => {
    const deps = dependencies({ activeRuntimeSessionId: "runtime-active" });
    const actions = createTerminalActions(deps);

    await actions.sendCommand("  ls -la  ");
    await actions.sendCommand("   ");

    expect(deps.writeTerminal).toHaveBeenCalledTimes(1);
    expect(deps.writeTerminal).toHaveBeenCalledWith("runtime-active", "ls -la\r");
  });

  it("reports an error when sending without an active runtime", async () => {
    const deps = dependencies({ activeRuntimeSessionId: null });
    const actions = createTerminalActions(deps);

    await actions.sendCommand("pwd");

    expect(deps.writeTerminal).not.toHaveBeenCalled();
    expect(deps.setTerminalError).toHaveBeenCalledWith("当前没有活动终端");
  });

  it("keeps fixed fallback text for non-Error command send failures", async () => {
    const deps = dependencies({
      activeRuntimeSessionId: "runtime-active",
      writeTerminal: vi.fn(async () => {
        throw "raw write failure";
      }),
    });
    const actions = createTerminalActions(deps);

    await actions.sendCommand("pwd");

    expect(deps.setTerminalError).toHaveBeenLastCalledWith("发送命令失败");
  });
});

function dependencies({
  activePaneTab = paneTab(),
  addedPaneTab = paneTab({ id: "pane-tab-added" }),
  activeRuntimeSessionId = "runtime-active",
  openTerminal = vi.fn(async () => runtimeInfo()),
  writeTerminal = vi.fn(async () => undefined),
}: {
  activePaneTab?: PaneTerminalTab | null;
  addedPaneTab?: PaneTerminalTab;
  activeRuntimeSessionId?: string | null;
  openTerminal?: (savedSessionId: string, paneId: string) => Promise<RuntimeSessionInfo>;
  writeTerminal?: (runtimeSessionId: string, data: string) => Promise<void>;
} = {}) {
  return {
    activeWorkspaceId: "workspace-1",
    activeWorkspaceTabId: "tab-1",
    activePaneTab,
    activeTab: workspaceTab(),
    setTerminalError: vi.fn(),
    addPaneTab: vi.fn(() => addedPaneTab),
    bindRuntimeToPaneTab: vi.fn(),
    updatePaneTerminalTab: vi.fn(),
    openTerminal,
    closeTerminal: vi.fn(async () => undefined),
    writeTerminal,
    activeRuntimeSessionId,
  };
}

function workspaceTab(): WorkspaceTab {
  return {
    id: "tab-1",
    title: "工作区",
    active_pane_id: "pane-1",
    root: {
      kind: "leaf",
      id: "pane-1",
      runtime_session_id: null,
      saved_session_id: null,
      title: "终端",
      active_terminal_tab_id: "pane-tab-1",
      terminal_tabs: [paneTab()],
    },
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

function paneTab(overrides: Partial<PaneTerminalTab> = {}): PaneTerminalTab {
  return {
    id: "pane-tab-1",
    title: "终端",
    runtime_session_id: null,
    saved_session_id: null,
    ...overrides,
  };
}

function runtimeInfo(): RuntimeSessionInfo {
  return {
    runtime_session_id: "runtime-1",
    saved_session_id: "session-1",
    history_scope_kind: "saved_session",
    history_scope_id: "session-1",
    pane_id: "pane-1",
    title: "生产主机",
    kind: "ssh",
    cols: 120,
    rows: 32,
  };
}

function savedSession(): SavedSession {
  return {
    id: "session-1",
    name: "生产主机",
    type: "ssh",
    group_id: null,
    host: "192.0.2.10",
    port: 22,
    username: "ops",
    auth_mode: "password",
    credential_ref: null,
    description: null,
    tags: [],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
  };
}
