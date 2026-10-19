// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTerminalOutputCachesForTest, useTerminalStore } from "./terminalStore";
import { useTerminalLayoutStore } from "../terminal-layout/terminalLayoutStore";

const invokeMock = vi.hoisted(() => vi.fn());
const eventMock = vi.hoisted(() => ({
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  listen: vi.fn((eventName: string, listener: (event: { payload: unknown }) => void) => {
    eventMock.listeners[eventName] = listener;
    return Promise.resolve(() => {
      delete eventMock.listeners[eventName];
    });
  }),
}));
const zmodemTransferMock = vi.hoisted(() => ({
  consumeTerminalZmodemData: vi.fn(),
  releaseTerminalZmodemRuntime: vi.fn(),
}));
const outputFlowMock = vi.hoisted(() => ({
  acknowledgeTerminalOutputFlow: vi.fn().mockResolvedValue(undefined),
  openTerminalOutputFlow: vi.fn().mockResolvedValue(vi.fn()),
  waitForTerminalOutputRender: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMock.listen,
}));

vi.mock("./zmodemTransfer", () => ({
  consumeTerminalZmodemData: zmodemTransferMock.consumeTerminalZmodemData,
  releaseTerminalZmodemRuntime: zmodemTransferMock.releaseTerminalZmodemRuntime,
}));

vi.mock("./terminalOutputFlow", () => outputFlowMock);

describe("terminalStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventMock.listeners = {};
    useTerminalStore.setState({
      runtimes: {},
      outputChunks: {},
      inputSerialByRuntime: {},
    });
    resetTerminalOutputCachesForTest();
  });

  it("passes a local working directory override when opening the default local terminal", async () => {
    invokeMock.mockResolvedValue({
      runtime_session_id: "runtime-local",
      saved_session_id: null,
      history_scope_kind: "local_profile",
      history_scope_id: "pwsh",
      pane_id: "pane-1",
      title: "PowerShell",
      kind: "local",
      initial_cwd: "C:\\work",
      cols: 120,
      rows: 32,
    });

    await useTerminalStore.getState().openDefaultLocalTerminal("pane-1", "C:\\work");

    expect(invokeMock).toHaveBeenCalledWith("terminal_open_default_local", {
      paneId: "pane-1",
      workingDirectory: "C:\\work",
    });
    expect(useTerminalStore.getState().runtimes["runtime-local"]?.initial_cwd).toBe("C:\\work");
  });

  it("passes a saved-session working directory override when opening a terminal", async () => {
    invokeMock.mockResolvedValue({
      runtime_session_id: "runtime-ssh",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "生产机",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
      rows: 32,
    });

    await useTerminalStore.getState().openTerminal("session-1", "pane-1", "/srv/app");

    expect(invokeMock).toHaveBeenCalledWith("terminal_open", {
      savedSessionId: "session-1",
      paneId: "pane-1",
      workingDirectory: "/srv/app",
    });
  });

  it("uses a validated cwd from commands sent outside the xterm input handler", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    const pathCandidate = {
      provider: "path",
      replacement_text: "tail lss.log",
      suffix: "ss.log",
      replacement_range: { start: 5, end: 6 },
      score: 0.95,
      source_label: "远端路径",
    };
    invokeMock.mockImplementation((command: string) => {
      if (command === "command_completion_resolve_cwd") return Promise.resolve("/root/lss");
      if (command === "command_completion_suggest") return Promise.resolve([pathCandidate]);
      return Promise.resolve(undefined);
    });

    await useTerminalStore.getState().writeTerminal("runtime-ssh", "cd lss\r");
    await expect(
      useTerminalStore.getState().suggestCompletion("runtime-ssh", "tail l", 6, "/root"),
    ).resolves.toEqual([pathCandidate]);

    expect(invokeMock).toHaveBeenCalledWith("command_completion_resolve_cwd", {
      request: {
        runtime_session_id: "runtime-ssh",
        current_cwd: null,
        target: "lss",
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("command_completion_suggest", {
      request: {
        runtime_session_id: "runtime-ssh",
        input: "tail l",
        cursor: 6,
        limit: 8,
        cwd: "/root/lss",
      },
    });
  });

  it("retries a cold path cache a bounded number of times and returns the refreshed path", async () => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    const systemCandidate = {
      provider: "system",
      replacement_text: "cat",
      suffix: "",
      replacement_range: { start: 0, end: 3 },
      score: 0.5,
      source_label: "远端系统命令",
    };
    const pathCandidate = {
      provider: "path",
      replacement_text: "cat logs/",
      suffix: "gs/",
      replacement_range: { start: 4, end: 6 },
      score: 0.95,
      source_label: "远端路径",
    };
    invokeMock
      .mockResolvedValueOnce([systemCandidate])
      .mockResolvedValueOnce([systemCandidate])
      .mockResolvedValueOnce([pathCandidate]);

    const pending = useTerminalStore
      .getState()
      .suggestCompletion("runtime-ssh", "cat lo", 6, "/srv");
    await vi.advanceTimersByTimeAsync(800);

    await expect(pending).resolves.toEqual([pathCandidate]);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenLastCalledWith("command_completion_suggest", {
      request: {
        runtime_session_id: "runtime-ssh",
        input: "cat lo",
        cursor: 6,
        limit: 8,
        cwd: "/srv",
      },
    });
    vi.useRealTimers();
  });

  it("stops stale cold-cache retries when a newer input request starts", async () => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    const systemCandidate = {
      provider: "system",
      replacement_text: "cat",
      suffix: "",
      replacement_range: { start: 0, end: 3 },
      score: 0.5,
      source_label: "远端系统命令",
    };
    const pathCandidate = {
      provider: "path",
      replacement_text: "cat logs/",
      suffix: "s/",
      replacement_range: { start: 4, end: 7 },
      score: 0.95,
      source_label: "远端路径",
    };
    invokeMock.mockResolvedValueOnce([systemCandidate]).mockResolvedValueOnce([pathCandidate]);

    const stale = useTerminalStore.getState().suggestCompletion("runtime-ssh", "cat lo", 6, "/srv");
    await Promise.resolve();
    const current = useTerminalStore.getState().suggestCompletion("runtime-ssh", "cat log", 7, "/srv");
    await vi.advanceTimersByTimeAsync(800);

    await expect(stale).resolves.toEqual([]);
    await expect(current).resolves.toEqual([pathCandidate]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not show a history candidate while a path command is waiting for its argument", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    invokeMock.mockResolvedValue([
      {
        provider: "history",
        replacement_text: "cd config",
        suffix: " config",
        replacement_range: { start: 0, end: 2 },
        score: 0.9,
        source_label: "当前会话历史",
      },
    ]);

    await expect(
      useTerminalStore.getState().suggestCompletion("runtime-ssh", "cd", 2, "/root"),
    ).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("never falls back to history when a remote path lookup has no matching entry", async () => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    const historyCandidate = {
      provider: "history",
      replacement_text: "cd config",
      suffix: "onfig",
      replacement_range: { start: 3, end: 4 },
      score: 0.9,
      source_label: "当前会话历史",
    };
    invokeMock.mockResolvedValue([historyCandidate]);

    const pending = useTerminalStore
      .getState()
      .suggestCompletion("runtime-ssh", "cd c", 4, "/root");
    await vi.advanceTimersByTimeAsync(800);

    await expect(pending).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("keeps archive command completion in filesystem context", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    invokeMock.mockResolvedValue([
      {
        provider: "history",
        replacement_text: "tar -xf missing.tar",
        suffix: " -xf missing.tar",
        replacement_range: { start: 0, end: 3 },
        score: 0.9,
        source_label: "当前会话历史",
      },
    ]);

    await expect(
      useTerminalStore.getState().suggestCompletion("runtime-ssh", "tar", 3, "/srv"),
    ).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("retries docker compose file options and returns only the path provider", async () => {
    vi.useFakeTimers();
    useTerminalStore.setState({
      runtimes: {
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    const historyCandidate = {
      provider: "history",
      replacement_text: "docker compose --file=config.yaml",
      suffix: "nfig.yaml",
      replacement_range: { start: 22, end: 24 },
      score: 0.9,
      source_label: "当前会话历史",
    };
    const pathCandidate = {
      provider: "path",
      replacement_text: "docker compose --file=compose.yaml",
      suffix: "mpose.yaml",
      replacement_range: { start: 22, end: 24 },
      score: 0.95,
      source_label: "远端路径",
    };
    invokeMock.mockResolvedValueOnce([historyCandidate]).mockResolvedValueOnce([pathCandidate]);

    const pending = useTerminalStore
      .getState()
      .suggestCompletion("runtime-ssh", "docker compose --file=co", 24, "/srv");
    await vi.advanceTimersByTimeAsync(300);

    await expect(pending).resolves.toEqual([pathCandidate]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("resolves cwd through the runtime-scoped IPC command", async () => {
    invokeMock.mockResolvedValue("/srv/logs");

    await expect(
      useTerminalStore.getState().resolveCwd("runtime-ssh", "/srv", "logs"),
    ).resolves.toBe("/srv/logs");
    expect(invokeMock).toHaveBeenCalledWith("command_completion_resolve_cwd", {
      request: {
        runtime_session_id: "runtime-ssh",
        current_cwd: "/srv",
        target: "logs",
      },
    });
  });

  it("opens an SSH container terminal with the selected container target", async () => {
    invokeMock.mockResolvedValue({
      runtime_session_id: "runtime-container",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-1",
      title: "容器: api",
          kind: "ssh_container",
          initial_cwd: null,
      cols: 120,
      rows: 32,
    });

    const runtime = await useTerminalStore
      .getState()
      .openSshContainerTerminal("session-1", "pane-1", "abc123", "api");

    expect(invokeMock).toHaveBeenCalledWith("terminal_open_ssh_container", {
      savedSessionId: "session-1",
      paneId: "pane-1",
      containerId: "abc123",
      containerName: "api",
    });
    expect(runtime.kind).toBe("ssh_container");
    expect(useTerminalStore.getState().runtimes["runtime-container"]).toEqual(runtime);
  });

  it("enters an SSH container through an existing external runtime", async () => {
    invokeMock.mockResolvedValue({ accepted: true });

    await useTerminalStore
      .getState()
      .enterSshContainerRuntime("external:launch-1", "runtime-external", "abc123");

    expect(invokeMock).toHaveBeenCalledWith("ssh_container_enter_runtime", {
      savedSessionId: "external:launch-1",
      runtimeSessionId: "runtime-external",
      containerId: "abc123",
    });
    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-external"]).toBe(1);
  });

  it("lists SSH containers for a saved session", async () => {
    invokeMock.mockResolvedValue([
      {
        id: "abc123",
        name: "api",
        image: "app:latest",
        status: "Up 3 minutes",
        running: true,
      },
    ]);

    const containers = await useTerminalStore.getState().listSshContainers("session-1");

    expect(invokeMock).toHaveBeenCalledWith("ssh_container_list", {
      savedSessionId: "session-1",
    });
    expect(containers[0].name).toBe("api");
  });

  it("routes raw terminal data events through the zmodem controller", async () => {
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:data"]?.({
      payload: {
        runtime_session_id: "runtime-1",
        data: "hello",
        data_base64: "aGVsbG8=",
      },
    });

    expect(zmodemTransferMock.consumeTerminalZmodemData).toHaveBeenCalledWith(
      {
        runtimeSessionId: "runtime-1",
        data: "hello",
        dataBase64: "aGVsbG8=",
      },
      {
        appendOutput: expect.any(Function),
      },
    );

    unlisten();
  });

  it("acknowledges sequenced output only after its replay append and render gate complete", async () => {
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-1") },
    });
    zmodemTransferMock.consumeTerminalZmodemData.mockImplementationOnce(
      (
        event: { runtimeSessionId: string; data: string },
        dependencies: { appendOutput: (runtimeSessionId: string, data: string) => Promise<void> },
      ) => dependencies.appendOutput(event.runtimeSessionId, event.data),
    );
    const stopLiveOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:data"]?.({
      payload: { runtime_session_id: "runtime-1", data: "ready", generation: 3, sequence: 7 },
    });
    await vi.waitFor(() => {
      expect(outputFlowMock.waitForTerminalOutputRender).toHaveBeenCalledWith({
        runtimeSessionId: "runtime-1",
        generation: 3,
        sequence: 7,
      });
    });

    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toMatchObject([{
      data: "ready",
      flow: { runtimeSessionId: "runtime-1", generation: 3, sequence: 7 },
    }]);
    expect(outputFlowMock.acknowledgeTerminalOutputFlow).toHaveBeenCalledWith({
      runtimeSessionId: "runtime-1",
      generation: 3,
      sequence: 7,
    });

    unlisten();
    stopLiveOutput();
  });

  it("acknowledges a pure ZMODEM event without waiting for an xterm write that it did not produce", async () => {
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-1") },
    });
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:data"]?.({
      payload: { runtime_session_id: "runtime-1", data: "", data_base64: "AA==", generation: 3, sequence: 8 },
    });
    await vi.waitFor(() => {
      expect(outputFlowMock.acknowledgeTerminalOutputFlow).toHaveBeenCalledWith({
        runtimeSessionId: "runtime-1",
        generation: 3,
        sequence: 8,
      });
    });

    expect(outputFlowMock.waitForTerminalOutputRender).not.toHaveBeenCalled();
    unlisten();
  });

  it("waits once on the final visible chunk when one sequence emits multiple output appends", async () => {
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-1") },
    });
    zmodemTransferMock.consumeTerminalZmodemData.mockImplementationOnce(
      (
        event: { runtimeSessionId: string },
        dependencies: { appendOutput: (runtimeSessionId: string, data: string) => Promise<void> },
      ) => {
        void dependencies.appendOutput(event.runtimeSessionId, "first");
        void dependencies.appendOutput(event.runtimeSessionId, "second");
      },
    );
    const stopLiveOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:data"]?.({
      payload: { runtime_session_id: "runtime-1", data: "", generation: 3, sequence: 9 },
    });
    await vi.waitFor(() => {
      expect(outputFlowMock.acknowledgeTerminalOutputFlow).toHaveBeenCalledWith({
        runtimeSessionId: "runtime-1",
        generation: 3,
        sequence: 9,
      });
    });

    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toMatchObject([
      { data: "first" },
      { data: "second", flow: { runtimeSessionId: "runtime-1", generation: 3, sequence: 9 } },
    ]);
    expect(outputFlowMock.waitForTerminalOutputRender).toHaveBeenCalledTimes(1);
    unlisten();
    stopLiveOutput();
  });

  it("does not let a later pure ZMODEM acknowledgement release an earlier visible sequence", async () => {
    let releaseRender: (() => void) | undefined;
    outputFlowMock.waitForTerminalOutputRender.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseRender = resolve;
        }),
    );
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-1") },
    });
    zmodemTransferMock.consumeTerminalZmodemData.mockImplementationOnce(
      (
        event: { runtimeSessionId: string; data: string },
        dependencies: { appendOutput: (runtimeSessionId: string, data: string) => Promise<void> },
      ) => dependencies.appendOutput(event.runtimeSessionId, event.data),
    );
    const stopLiveOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:data"]?.({
      payload: { runtime_session_id: "runtime-1", data: "visible", generation: 3, sequence: 10 },
    });
    await vi.waitFor(() => expect(outputFlowMock.waitForTerminalOutputRender).toHaveBeenCalledTimes(1));
    eventMock.listeners["terminal:data"]?.({
      payload: { runtime_session_id: "runtime-1", data: "", data_base64: "AA==", generation: 3, sequence: 11 },
    });
    await Promise.resolve();

    expect(outputFlowMock.acknowledgeTerminalOutputFlow).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().outputChunks["runtime-1"]?.[0]?.flow).toEqual({
      runtimeSessionId: "runtime-1",
      generation: 3,
      sequence: 10,
    });
    releaseRender?.();
    await vi.waitFor(() => {
      expect(outputFlowMock.acknowledgeTerminalOutputFlow.mock.calls).toEqual([
        [{ runtimeSessionId: "runtime-1", generation: 3, sequence: 10 }],
        [{ runtimeSessionId: "runtime-1", generation: 3, sequence: 11 }],
      ]);
    });

    unlisten();
    stopLiveOutput();
  });

  it("refreshes command history when the shell reports a submitted command", async () => {
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:history-changed"]?.({
      payload: { runtime_session_id: "runtime-1" },
    });
    eventMock.listeners["terminal:history-changed"]?.({
      payload: { runtime_session_id: "runtime-1" },
    });

    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-1"]).toBe(2);
    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-2"]).toBeUndefined();
    unlisten();
  });

  it("removes a naturally exited runtime and marks its terminalLayout tab as disconnected", async () => {
    const terminalLayout = useTerminalLayoutStore.getState().runtime;
    const terminalLayoutTab = {
      id: "tab-exit",
      title: "SSH",
      active_pane_id: "pane-exit",
      root: {
        kind: "leaf" as const,
        id: "pane-exit",
        title: "SSH",
        runtime_session_id: "runtime-1",
        saved_session_id: "session-1",
        active_terminal_tab_id: "pane-exit-tab-1",
        terminal_tabs: [{
          id: "pane-exit-tab-1",
          title: "SSH",
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          restore_status: "connected" as const,
        }],
      },
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    const activeTerminalLayout = {
      ...terminalLayout,
      tabs: [terminalLayoutTab],
      activeTabId: terminalLayoutTab.id,
      active_tab_id: terminalLayoutTab.id,
    };
    useTerminalLayoutStore.setState({
      runtime: activeTerminalLayout,
      activeTerminalLayoutId: activeTerminalLayout.id,
      tabs: activeTerminalLayout.tabs,
      activeTabId: activeTerminalLayout.activeTabId,
    });
    useTerminalStore.setState({
      runtimes: {
        "runtime-1": {
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-exit",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
    });
    const unlisten = await useTerminalStore.getState().bindTerminalEvents();

    eventMock.listeners["terminal:exit"]?.({
      payload: { runtime_session_id: "runtime-1", exit_code: 255, message: null },
    });

    expect(useTerminalStore.getState().runtimes["runtime-1"]).toBeUndefined();
    const root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("leaf");
    if (root.kind === "leaf") {
      expect(root.runtime_session_id).toBeNull();
      expect(root.terminal_tabs?.[0]).toMatchObject({
        runtime_session_id: null,
        restore_status: "failed",
        restore_error: "终端已退出（退出码 255）",
      });
    }
    expect(zmodemTransferMock.releaseTerminalZmodemRuntime).toHaveBeenCalledWith("runtime-1");
    unlisten();
  });

  it("trims accumulated terminal output so terminalLayout switches do not replay large histories", () => {
    const chunk = "a".repeat(50_010);

    useTerminalStore.getState().appendOutput("runtime-1", `prefix-${chunk}`);

    const output = useTerminalStore.getState().getOutputTail("runtime-1");
    expect(output).toHaveLength(50_000);
    expect(output.startsWith("prefix-")).toBe(false);
    expect(output).toBe("a".repeat(50_000));
  });

  it("does not apply a closed runtime's cwd resolution after its ID is reused", async () => {
    let resolveOldCwd: ((value: string | null) => void) | undefined;
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-old") },
    });
    invokeMock.mockImplementation((command: string) => {
      if (command === "terminal_write") return Promise.resolve();
      if (command === "command_completion_resolve_cwd") {
        return new Promise<string | null>((resolve) => {
          resolveOldCwd = resolve;
        });
      }
      if (command === "command_completion_suggest") return Promise.resolve([]);
      return Promise.resolve();
    });

    await useTerminalStore.getState().writeTerminal("runtime-1", "cd stale\r");
    await Promise.resolve();
    useTerminalStore.getState().forgetTerminalRuntime("runtime-1");
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-new") },
    });
    resolveOldCwd?.("/old-runtime");
    await Promise.resolve();
    await Promise.resolve();

    await useTerminalStore.getState().suggestCompletion("runtime-1", "ls", 2, "/new-runtime");

    expect(invokeMock).toHaveBeenLastCalledWith("command_completion_suggest", {
      request: {
        runtime_session_id: "runtime-1",
        input: "ls",
        cursor: 2,
        limit: 8,
        cwd: "/new-runtime",
      },
    });
  });

  it("does not let an old live-output cleanup remove a reused runtime subscription", () => {
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-old") },
    });
    const stopOldOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");

    useTerminalStore.getState().forgetTerminalRuntime("runtime-1");
    useTerminalStore.setState({
      runtimes: { "runtime-1": runtime("runtime-1", "session-new") },
    });
    const stopNewOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");
    stopOldOutput();
    useTerminalStore.getState().appendOutput("runtime-1", "new runtime output");

    expect(useTerminalStore.getState().outputChunks["runtime-1"]?.[0]?.data).toBe("new runtime output");
    stopNewOutput();
  });

  it("keeps a shorter visual output tail for terminalLayout switch snapshots", () => {
    const chunk = "b".repeat(12_000);

    useTerminalStore.getState().appendOutput("runtime-1", `prefix-${chunk}`);

    const visualTail = useTerminalStore.getState().getVisualOutputTail("runtime-1");
    expect(visualTail).toHaveLength(8_000);
    expect(visualTail.startsWith("prefix-")).toBe(false);
    expect(visualTail).toBe("b".repeat(8_000));
  });

  it("keeps background output in cache without publishing live chunks", () => {
    useTerminalStore.getState().appendOutput("runtime-1", "background");

    expect(useTerminalStore.getState().getOutputTail("runtime-1")).toBe("background");
    expect(useTerminalStore.getState().getVisualOutputTail("runtime-1")).toBe("background");
    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toBeUndefined();
  });

  it("publishes live chunks only while a runtime has a live output subscription", () => {
    const stopLiveOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");

    useTerminalStore.getState().appendOutput("runtime-1", "hello");
    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toEqual([
      { serial: 1, data: "hello" },
    ]);

    stopLiveOutput();
    useTerminalStore.getState().appendOutput("runtime-1", " background");

    expect(useTerminalStore.getState().getOutputTail("runtime-1")).toBe("hello background");
    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toBeUndefined();
  });

  it("opens output flow when a live terminal consumer starts", async () => {
    const stopLiveOutput = useTerminalStore.getState().beginLiveOutput("runtime-1");

    await vi.waitFor(() => {
      expect(outputFlowMock.openTerminalOutputFlow).toHaveBeenCalledWith("runtime-1");
    });
    stopLiveOutput();
  });

  it("increments the input serial only after submitted terminal input is written", async () => {
    invokeMock.mockResolvedValue(undefined);

    await useTerminalStore.getState().writeTerminal("runtime-1", "l");
    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-1"]).toBeUndefined();

    await useTerminalStore.getState().writeTerminal("runtime-1", "s\r");
    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-1"]).toBe(1);

    invokeMock.mockRejectedValueOnce(new Error("write failed"));
    await expect(useTerminalStore.getState().writeTerminal("runtime-1", "pwd\r")).rejects.toThrow("write failed");
    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-1"]).toBe(1);
  });

  it("releases the zmodem controller when closing a terminal runtime", async () => {
    invokeMock.mockResolvedValue({ closed: true });
    useTerminalStore.setState({
      runtimes: {
        "runtime-1": {
          runtime_session_id: "runtime-1",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-1",
          title: "SSH",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
          rows: 32,
        },
      },
      outputChunks: { "runtime-1": [{ serial: 1, data: "hello" }] },
      inputSerialByRuntime: { "runtime-1": 3 },
    });
    useTerminalStore.getState().appendOutput("runtime-1", "hello");

    await useTerminalStore.getState().closeTerminal("runtime-1");

    expect(invokeMock).toHaveBeenCalledWith("terminal_close", {
      runtimeSessionId: "runtime-1",
      releaseExternalSession: undefined,
    });
    expect(zmodemTransferMock.releaseTerminalZmodemRuntime).toHaveBeenCalledWith("runtime-1");
    expect(useTerminalStore.getState().runtimes["runtime-1"]).toBeUndefined();
    expect(useTerminalStore.getState().inputSerialByRuntime["runtime-1"]).toBeUndefined();
    expect(useTerminalStore.getState().getVisualOutputTail("runtime-1")).toBe("");
    expect(useTerminalStore.getState().getOutputTail("runtime-1")).toBe("");
  });

  it("does not expose a terminal cwd probe API", () => {
    expect("probeTerminalCwd" in useTerminalStore.getState()).toBe(false);
  });
});

function runtime(runtimeSessionId: string, savedSessionId: string) {
  return {
    runtime_session_id: runtimeSessionId,
    saved_session_id: savedSessionId,
    history_scope_kind: "saved_session" as const,
    history_scope_id: savedSessionId,
    pane_id: "pane-1",
    title: "SSH",
    kind: "ssh" as const,
    initial_cwd: null,
    cols: 120,
    rows: 32,
  };
}
