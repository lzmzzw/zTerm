// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTerminalOutputCachesForTest, useTerminalStore } from "./terminalStore";

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
      cols: 120,
      rows: 32,
    });

    await useTerminalStore.getState().openDefaultLocalTerminal("pane-1", "C:\\work");

    expect(invokeMock).toHaveBeenCalledWith("terminal_open_default_local", {
      paneId: "pane-1",
      workingDirectory: "C:\\work",
    });
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

  it("opens an SSH container terminal with the selected container target", async () => {
    invokeMock.mockResolvedValue({
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

  it("trims accumulated terminal output so workspace switches do not replay large histories", () => {
    const chunk = "a".repeat(50_010);

    useTerminalStore.getState().appendOutput("runtime-1", `prefix-${chunk}`);

    const output = useTerminalStore.getState().getOutputTail("runtime-1");
    expect(output).toHaveLength(50_000);
    expect(output.startsWith("prefix-")).toBe(false);
    expect(output).toBe("a".repeat(50_000));
  });

  it("keeps a shorter visual output tail for workspace switch snapshots", () => {
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
    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toEqual({
      serial: 1,
      data: "hello",
    });

    stopLiveOutput();
    useTerminalStore.getState().appendOutput("runtime-1", " background");

    expect(useTerminalStore.getState().getOutputTail("runtime-1")).toBe("hello background");
    expect(useTerminalStore.getState().outputChunks["runtime-1"]).toBeUndefined();
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
          cols: 120,
          rows: 32,
        },
      },
      outputChunks: { "runtime-1": { serial: 1, data: "hello" } },
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
