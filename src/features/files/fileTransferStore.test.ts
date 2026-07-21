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

import type { FileEntry, TransferTask } from "./fileStore";
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
      conflictPolicy: "overwrite",
      defaultLocalPath: "",
      localRoots: [],
    });
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

  it("keeps browser preview usable when transfer event binding is unavailable", async () => {
    listenMock.mockRejectedValueOnce(new Error("missing tauri runtime"));

    await expect(useFileTransferStore.getState().bindTransferEvents()).resolves.toBeTypeOf("function");

    expect(useFileTransferStore.getState().transferError).toContain("missing tauri runtime");
  });

  it("pauses resumes and clears multiple transfer tasks through existing transfer IPC", async () => {
    const queued = transferTask({ id: "queued-task", status: "queued" });
    const paused = transferTask({ id: "paused-task", status: "paused" });
    const running = transferTask({ id: "running-task", status: "running" });
    useFileTransferStore.setState({ transfers: [queued, paused, running] });
    invokeMock
      .mockResolvedValueOnce({ ...queued, status: "paused" })
      .mockResolvedValueOnce({ ...paused, status: "running" })
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ deleted: true })
      .mockResolvedValueOnce({ deleted: true });

    await useFileTransferStore.getState().pauseTransfers(["queued-task"]);
    await useFileTransferStore.getState().resumeTransfers(["paused-task"]);
    await useFileTransferStore.getState().clearTransfers();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "transfer_pause", { taskId: "queued-task" });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "transfer_resume", { taskId: "paused-task" });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "transfer_delete", { taskId: "queued-task" });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "transfer_delete", { taskId: "paused-task" });
    expect(invokeMock).toHaveBeenNthCalledWith(5, "transfer_delete", { taskId: "running-task" });
    expect(useFileTransferStore.getState().transfers).toEqual([]);
  });
});
