// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
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
    vi.clearAllMocks();
    useFileStore.setState({
      entries: [],
      transfers: [],
      path: ".",
      selectedPath: null,
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
      path: ".",
      selectedPath: null,
      loading: false,
      error: null,
    });

    stale.resolve([entry("/srv/old.log")]);
    await request;

    expect(useFileStore.getState()).toMatchObject({
      entries: [],
      path: ".",
      selectedPath: null,
      loading: false,
      error: null,
    });
  });
});
