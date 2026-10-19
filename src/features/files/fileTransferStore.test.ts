// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() =>
  vi.fn(async (_eventName: string, _handler: (event: { payload: unknown }) => void) => vi.fn()),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import type { FileEntry, TransferTask } from "./fileTypes";
import { useFileTransferStore } from "./fileTransferStore";

function entry(path: string): FileEntry {
  return {
    name: path.split(/[\\/]/).pop() ?? path,
    path,
    kind: "file",
    size: 1,
    modified_at_ms: null,
    permissions: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function transferTask(overrides: Partial<TransferTask> = {}): TransferTask {
  return {
    id: "task-1",
    saved_session_id: "session-1",
    direction: "upload",
    local_path: "C:/tmp/a.txt",
    remote_path: "/tmp/a.txt",
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 100,
    transferred_bytes: 0,
    status: "queued",
    error_message: null,
    created_at_ms: 1,
    updated_at_ms: 2,
    task_origin: "file_transfer",
    source_endpoint: { kind: "local", saved_session_id: null, path: "C:/tmp/a.txt" },
    destination_endpoint: { kind: "saved_session", saved_session_id: "session-1", path: "/tmp/a.txt" },
    ...overrides,
  };
}

describe("fileTransferStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async () => vi.fn());
    useFileTransferStore.setState({
      left: {
        endpoint: { kind: "local", saved_session_id: null, path: "" },
        entries: [],
        selectedPaths: [],
        selectionAnchorPath: null,
        loading: false,
        error: null,
      },
      right: {
        endpoint: { kind: "saved_session", saved_session_id: null, path: "/" },
        entries: [],
        selectedPaths: [],
        selectionAnchorPath: null,
        loading: false,
        error: null,
      },
      transfers: [],
      transferLoading: false,
      transferError: null,
      transferErrorSessionId: null,
      conflictPolicy: "overwrite",
      defaultLocalPath: "",
      localRoots: [],
      viewStateInitialized: false,
    });
  });

  it("restores and saves the latest left and right endpoint paths", async () => {
    const restored = {
      left: { kind: "local" as const, saved_session_id: null, path: "F:/TerminalLayout/Deliverables" },
      right: { kind: "saved_session" as const, saved_session_id: "ssh-prod", path: "/srv/releases" },
    };
    invokeMock.mockResolvedValueOnce(restored).mockResolvedValueOnce(restored);

    await expect(useFileTransferStore.getState().restoreViewState()).resolves.toEqual(restored);
    await expect(useFileTransferStore.getState().saveViewState()).resolves.toEqual(restored);

    expect(useFileTransferStore.getState()).toMatchObject({
      left: { endpoint: restored.left },
      right: { endpoint: restored.right },
      viewStateInitialized: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "file_transfer_view_state_get");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "file_transfer_view_state_save", { viewState: restored });
  });

  it.each(["endpoint", "path"] as const)("ignores an in-flight listing after its %s changes without a new load", async (change) => {
    const pending = deferred<FileEntry[]>();
    const store = useFileTransferStore.getState();
    store.setEndpoint("right", { kind: "saved_session", saved_session_id: "old", path: "/old" });
    invokeMock.mockReturnValueOnce(pending.promise);
    const loading = store.loadEndpoint("right");

    if (change === "endpoint") {
      store.setEndpoint("right", { kind: "saved_session", saved_session_id: "new", path: "/new" });
    } else {
      store.setPath("right", "/new");
    }
    pending.resolve([entry("/old/stale.txt")]);
    await loading;

    expect(useFileTransferStore.getState().right).toMatchObject({
      endpoint: { path: "/new" }, entries: [], selectedPaths: [], loading: false, error: null,
    });
  });

  it("keeps a manually selected endpoint when saved view restoration resolves later", async () => {
    const pending = deferred<{ left: { kind: "local"; saved_session_id: null; path: string }; right: { kind: "saved_session"; saved_session_id: string; path: string } }>();
    invokeMock.mockReturnValueOnce(pending.promise);
    const store = useFileTransferStore.getState();
    const restoring = store.restoreViewState();
    store.setEndpoint("right", { kind: "saved_session", saved_session_id: "new", path: "/new" });
    pending.resolve({
      left: { kind: "local", saved_session_id: null, path: "C:/saved" },
      right: { kind: "saved_session", saved_session_id: "old", path: "/old" },
    });
    await restoring;

    expect(useFileTransferStore.getState().left.endpoint.path).toBe("C:/saved");
    expect(useFileTransferStore.getState().right.endpoint).toMatchObject({ saved_session_id: "new", path: "/new" });
  });

  it("keeps a rename failure out of a replacement endpoint", async () => {
    const pending = deferred<void>();
    const store = useFileTransferStore.getState();
    store.setEndpoint("right", { kind: "saved_session", saved_session_id: "old", path: "/old" });
    invokeMock.mockReturnValueOnce(pending.promise.then(() => { throw new Error("old connection failed"); }));
    const operation = store.renameEndpoint("right", "/old/a", "/old/b");
    store.setEndpoint("right", { kind: "saved_session", saved_session_id: "new", path: "/new" });
    pending.resolve();
    await operation;

    expect(useFileTransferStore.getState().right.error).toBeNull();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a replacement endpoint after deleting on the previous one", async () => {
    const pending = deferred<void>();
    const store = useFileTransferStore.getState();
    store.setEndpoint("right", { kind: "saved_session", saved_session_id: "old", path: "/old" });
    invokeMock.mockReturnValueOnce(pending.promise);
    const operation = store.deleteEndpoint("right", ["/old/a"], false);
    store.setEndpoint("right", { kind: "saved_session", saved_session_id: "new", path: "/new" });
    pending.resolve();
    await operation;

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(useFileTransferStore.getState().right.endpoint.saved_session_id).toBe("new");
  });

  it("removes the progress subscription when completion subscription registration fails", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValueOnce(unlisten).mockRejectedValueOnce(new Error("subscription failed"));

    await useFileTransferStore.getState().bindTransferEvents();

    expect(unlisten).toHaveBeenCalledOnce();
    expect(useFileTransferStore.getState().transferError).toBe("subscription failed");
  });

  it("loads a local endpoint through the file transfer IPC with the default local path", async () => {
    invokeMock.mockResolvedValueOnce("C:/Users/Ops").mockResolvedValueOnce([entry("C:/Users/Ops/a.txt")]);

    await useFileTransferStore.getState().loadEndpoint("left");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "file_transfer_default_local_path");
    expect(invokeMock).toHaveBeenNthCalledWith(2, "file_transfer_list_endpoint", {
      endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops" },
    });
    expect(useFileTransferStore.getState().left).toMatchObject({
      endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops" },
      entries: [entry("C:/Users/Ops/a.txt")],
      loading: false,
      error: null,
    });
  });

  it("loads available local roots for the Windows drive selector", async () => {
    invokeMock.mockResolvedValueOnce(["C:\\", "D:\\"]);

    await expect(useFileTransferStore.getState().loadLocalRoots()).resolves.toEqual(["C:\\", "D:\\"]);

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_local_roots");
    expect(useFileTransferStore.getState().localRoots).toEqual(["C:\\", "D:\\"]);
  });

  it("keeps the latest session preparation when an earlier default-path lookup finishes later", async () => {
    invokeMock.mockImplementation(async () => []);
    const store = useFileTransferStore.getState();
    const earlier = store.prepareForSession("old", "/old");
    useFileTransferStore.setState({ defaultLocalPath: "C:/current-default" });
    const latest = store.prepareForSession("current", "/current");
    await Promise.all([earlier, latest]);

    expect(useFileTransferStore.getState().right.endpoint).toEqual({
      kind: "saved_session", saved_session_id: "current", path: "/current",
    });
    expect(invokeMock).not.toHaveBeenCalledWith("file_transfer_list_endpoint", {
      endpoint: { kind: "saved_session", saved_session_id: "old", path: "/old" },
    });
  });

  it("checks endpoint conflicts and enqueues a remote-to-remote file transfer with endpoint snapshots", async () => {
    const source = { kind: "saved_session" as const, saved_session_id: "source-ssh", path: "/var/app.log" };
    const destination = { kind: "saved_session" as const, saved_session_id: "destination-ssh", path: "/backup/app.log" };
    const queued = transferTask({
      id: "remote-copy",
      saved_session_id: "source-ssh",
      direction: "upload",
      local_path: "/var/app.log",
      remote_path: "/backup/app.log",
      conflict_policy: "rename",
      source_endpoint: source,
      destination_endpoint: destination,
    });
    invokeMock.mockResolvedValueOnce([{ path: "/backup/app.log" }]).mockResolvedValueOnce(queued);

    await expect(
      useFileTransferStore.getState().checkConflicts([{ destination, kind: "file" }]),
    ).resolves.toEqual([{ path: "/backup/app.log" }]);
    await expect(
      useFileTransferStore.getState().enqueueTransfer(source, destination, {
        kind: "file",
        conflictPolicy: "rename",
      }),
    ).resolves.toEqual(queued);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "file_transfer_check_conflicts", {
      items: [{ destination, kind: "file" }],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "file_transfer_enqueue", {
      source,
      destination,
      kind: "file",
      conflictPolicy: "rename",
    });
    expect(useFileTransferStore.getState().transfers).toEqual([queued]);
  });

  it("prepares a saved FTP or SFTP session on the right and resets the left side to the default local path", async () => {
    useFileTransferStore.setState({ defaultLocalPath: "C:/Users/Ops" });

    await useFileTransferStore.getState().prepareForSession("ftp-prod", "/incoming");

    expect(useFileTransferStore.getState().left.endpoint).toEqual({
      kind: "local",
      saved_session_id: null,
      path: "C:/Users/Ops",
    });
    expect(useFileTransferStore.getState().right.endpoint).toEqual({
      kind: "saved_session",
      saved_session_id: "ftp-prod",
      path: "/incoming",
    });
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_list_endpoint", {
      endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops" },
    });
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_list_endpoint", {
      endpoint: { kind: "saved_session", saved_session_id: "ftp-prod", path: "/incoming" },
    });
  });

  it("loads the global file transfer task list and accepts transfer events from any session", async () => {
    const oldTask = transferTask({ id: "old-sftp", saved_session_id: "session-old", task_origin: "sftp_panel" });
    const progressTask = transferTask({
      id: "remote-copy",
      saved_session_id: "session-new",
      transferred_bytes: 40,
    });
    invokeMock.mockResolvedValueOnce([oldTask]);

    await useFileTransferStore.getState().loadTransfers();
    await useFileTransferStore.getState().bindTransferEvents();

    const progressHandler = listenMock.mock.calls.find(([eventName]) => eventName === "transfer:progress")?.[1];
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_list", { limit: 1000 });
    expect(useFileTransferStore.getState().transfers).toEqual([oldTask]);

    progressHandler?.({ payload: progressTask });

    expect(useFileTransferStore.getState().transfers).toEqual([progressTask, oldTask]);
  });

  it("does not regress a completed task when a stale progress event arrives later", async () => {
    const completed = transferTask({
      status: "done",
      transferred_bytes: 100,
      updated_at_ms: 10,
    });
    useFileTransferStore.setState({ transfers: [completed] });
    await useFileTransferStore.getState().bindTransferEvents();

    const progressHandler = listenMock.mock.calls.find(([eventName]) => eventName === "transfer:progress")?.[1];
    progressHandler?.({
      payload: transferTask({ status: "running", transferred_bytes: 100, updated_at_ms: 10 }),
    });

    expect(useFileTransferStore.getState().transfers).toEqual([completed]);
  });

  it("does not regress a completed task when an older transfer list resolves later", async () => {
    const staleRunning = transferTask({ status: "running", transferred_bytes: 100, updated_at_ms: 9 });
    const completed = transferTask({ status: "done", transferred_bytes: 100, updated_at_ms: 10 });
    const pendingList = deferred<TransferTask[]>();
    invokeMock.mockReturnValueOnce(pendingList.promise);

    const loading = useFileTransferStore.getState().loadTransfers();
    useFileTransferStore.setState({ transfers: [completed] });
    pendingList.resolve([staleRunning]);
    await loading;

    expect(useFileTransferStore.getState().transfers).toEqual([completed]);
  });

  it("keeps browser preview usable when transfer event binding is unavailable", async () => {
    listenMock.mockRejectedValueOnce(new Error("missing tauri runtime"));

    await expect(useFileTransferStore.getState().bindTransferEvents()).resolves.toBeTypeOf("function");

    expect(useFileTransferStore.getState().transferError).toContain("missing tauri runtime");
  });

  it("pauses and resumes visible tasks but clears all tasks through one unbounded IPC", async () => {
    const queued = transferTask({ id: "queued-task", status: "queued" });
    const paused = transferTask({ id: "paused-task", status: "paused" });
    const running = transferTask({ id: "running-task", status: "running" });
    useFileTransferStore.setState({ transfers: [queued, paused, running] });
    invokeMock
      .mockResolvedValueOnce({ ...queued, status: "paused" })
      .mockResolvedValueOnce({ ...paused, status: "running" })
      .mockResolvedValueOnce(6809);

    await useFileTransferStore.getState().pauseTransfers(["queued-task"]);
    await useFileTransferStore.getState().resumeTransfers(["paused-task"]);
    await useFileTransferStore.getState().clearTransfers();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "transfer_pause", { taskId: "queued-task" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "transfer_resume", { taskId: "paused-task" });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "transfer_clear_all");
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(useFileTransferStore.getState().transfers).toEqual([]);
  });

  it("keeps the current list visible when clearing all tasks fails", async () => {
    const visible = [
      transferTask({ id: "clear-1", saved_session_id: "session-a" }),
      transferTask({ id: "clear-2", saved_session_id: "session-b" }),
    ];
    useFileTransferStore.setState({ transfers: visible });
    invokeMock.mockRejectedValueOnce(new Error("数据库繁忙"));

    await expect(useFileTransferStore.getState().clearTransfers()).rejects.toThrow("数据库繁忙");

    expect(useFileTransferStore.getState().transfers).toEqual(visible);
    expect(useFileTransferStore.getState().transferError).toContain("数据库繁忙");
    expect(useFileTransferStore.getState().transferErrorSessionId).toBeNull();
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("clears a task error when its remote endpoint changes to another connection", async () => {
    useFileTransferStore.setState({
      transferError: "session-old 连接已关闭",
      transferErrorSessionId: "session-old",
      right: {
        endpoint: { kind: "saved_session", saved_session_id: "session-old", path: "/tmp" },
        entries: [],
        selectedPaths: [],
        selectionAnchorPath: null,
        loading: false,
        error: null,
      },
    });

    useFileTransferStore.getState().setEndpoint("right", {
      kind: "saved_session",
      saved_session_id: "session-new",
      path: "/srv",
    });

    expect(useFileTransferStore.getState().transferError).toBeNull();
    expect(useFileTransferStore.getState().transferErrorSessionId).toBeNull();
  });

  it("records the affected session when a task action fails", async () => {
    useFileTransferStore.setState({ transfers: [transferTask({ id: "paused-task", saved_session_id: "session-ops" })] });
    invokeMock.mockRejectedValueOnce(new Error("连接已关闭"));

    await expect(useFileTransferStore.getState().pauseTransfer("paused-task")).rejects.toThrow("连接已关闭");

    expect(useFileTransferStore.getState().transferError).toContain("连接已关闭");
    expect(useFileTransferStore.getState().transferErrorSessionId).toBe("session-ops");
  });
});
