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

import { useFileStore, type FileEntry } from "./fileStore";

function entry(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    kind: "file",
    size: 1,
    modified_at_ms: null,
    permissions: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("fileStore", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async () => vi.fn());
    useFileStore.setState({
      entries: [],
      transfers: [],
      activeSavedSessionId: null,
      path: "/",
      selectedPaths: [],
      selectionAnchorPath: null,
      loading: false,
      transferLoading: false,
      error: null,
    });
  });

  it("keeps the latest SFTP list result when an older active context request resolves later", async () => {
    const stale = deferred<FileEntry[]>();
    const currentEntries = [entry("/srv/current.log")];
    invokeMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(currentEntries);

    const staleRequest = useFileStore.getState().listFiles("session-old", "/srv/old");
    const currentRequest = useFileStore.getState().listFiles("session-current", "/srv/current");

    await currentRequest;
    expect(useFileStore.getState().entries).toEqual(currentEntries);
    expect(useFileStore.getState().path).toBe("/srv/current");

    stale.resolve([entry("/srv/old.log")]);
    await staleRequest;

    expect(useFileStore.getState().entries).toEqual(currentEntries);
    expect(useFileStore.getState().path).toBe("/srv/current");
    expect(useFileStore.getState().loading).toBe(false);
  });

  it("clears stale SFTP entries and ignores an in-flight list after leaving the SSH context", async () => {
    const stale = deferred<FileEntry[]>();
    invokeMock.mockReturnValueOnce(stale.promise);

    const request = useFileStore.getState().listFiles("session-old", "/srv/old");
    useFileStore.getState().clearFiles();

    expect(useFileStore.getState()).toMatchObject({
      entries: [],
      path: "/",
      selectedPaths: [],
      loading: false,
      error: null,
    });

    stale.resolve([entry("/srv/old.log")]);
    await request;

    expect(useFileStore.getState()).toMatchObject({
      entries: [],
      path: "/",
      selectedPaths: [],
      loading: false,
      error: null,
    });
  });

  it("passes transfer kind and conflict policy to upload and download IPC calls", async () => {
    const queuedTask = {
      id: "task-1",
      saved_session_id: "session-1",
      direction: "upload",
      local_path: "C:/tmp/a.txt",
      remote_path: "/a.txt",
      kind: "file",
      conflict_policy: "rename",
      total_bytes: 1,
      transferred_bytes: 0,
      status: "queued",
      error_message: null,
      created_at_ms: 1,
      updated_at_ms: 1,
    };
    invokeMock.mockResolvedValue(queuedTask);

    await useFileStore.getState().upload("session-1", "C:/tmp/a.txt", "/a.txt", {
      kind: "file",
      conflictPolicy: "rename",
    });
    await useFileStore.getState().download("session-1", "/logs", "D:/Downloads/logs", {
      kind: "directory",
      conflictPolicy: "skip",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "sftp_upload", {
      savedSessionId: "session-1",
      localPath: "C:/tmp/a.txt",
      remotePath: "/a.txt",
      kind: "file",
      conflictPolicy: "rename",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "sftp_download", {
      savedSessionId: "session-1",
      remotePath: "/logs",
      localPath: "D:/Downloads/logs",
      kind: "directory",
      conflictPolicy: "skip",
    });
  });

  it("classifies local paths and checks transfer conflicts through IPC", async () => {
    invokeMock
      .mockResolvedValueOnce([{ path: "C:/tmp/a.txt", kind: "file" }])
      .mockResolvedValueOnce([{ direction: "download", path: "D:/Downloads/a.txt" }]);

    await expect(useFileStore.getState().classifyLocalPaths(["C:/tmp/a.txt"])).resolves.toEqual([
      { path: "C:/tmp/a.txt", kind: "file" },
    ]);
    await expect(
      useFileStore.getState().checkTransferConflicts("session-1", [
        {
          direction: "download",
          localPath: "D:/Downloads/a.txt",
          remotePath: "/a.txt",
          kind: "file",
        },
      ]),
    ).resolves.toEqual([{ direction: "download", path: "D:/Downloads/a.txt" }]);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "sftp_classify_local_paths", {
      paths: ["C:/tmp/a.txt"],
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "sftp_check_transfer_conflicts", {
      savedSessionId: "session-1",
      items: [
        {
          direction: "download",
          localPath: "D:/Downloads/a.txt",
          remotePath: "/a.txt",
          kind: "file",
        },
      ],
    });
  });

  it("refreshes the active SFTP list after an upload task completes", async () => {
    invokeMock.mockResolvedValueOnce([entry("/srv/old.txt")]);
    await useFileStore.getState().listFiles("session-1", "/srv");
    expect(useFileStore.getState().entries).toEqual([entry("/srv/old.txt")]);

    await useFileStore.getState().bindTransferEvents();
    const doneHandler = listenMock.mock.calls.find(([eventName]) => eventName === "transfer:done")?.[1];
    expect(doneHandler).toBeTypeOf("function");

    invokeMock.mockResolvedValueOnce([entry("/srv/new.txt")]);
    doneHandler?.({
      payload: {
        id: "task-1",
        saved_session_id: "session-1",
        direction: "upload",
        local_path: "C:/tmp/new.txt",
        remote_path: "/srv/new.txt",
        kind: "file",
        conflict_policy: "overwrite",
        total_bytes: 1,
        transferred_bytes: 1,
        status: "done",
        error_message: null,
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenLastCalledWith("sftp_list", {
      savedSessionId: "session-1",
      path: "/srv",
    });
    expect(useFileStore.getState().entries).toEqual([entry("/srv/new.txt")]);
  });

  it("does not refresh the file list for an upload completed by a stale SSH session", async () => {
    invokeMock.mockResolvedValueOnce([entry("/srv/current.txt")]);
    await useFileStore.getState().listFiles("session-current", "/srv");
    await useFileStore.getState().bindTransferEvents();
    const doneHandler = listenMock.mock.calls.find(([eventName]) => eventName === "transfer:done")?.[1];
    invokeMock.mockClear();

    doneHandler?.({
      payload: {
        id: "task-stale",
        saved_session_id: "session-stale",
        direction: "upload",
        local_path: "C:/tmp/stale.txt",
        remote_path: "/srv/stale.txt",
        kind: "file",
        conflict_policy: "overwrite",
        total_bytes: 1,
        transferred_bytes: 1,
        status: "done",
        error_message: null,
        created_at_ms: 1,
        updated_at_ms: 2,
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useFileStore.getState().entries).toEqual([entry("/srv/current.txt")]);
  });
});
