// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { useHistoryStore, type CommandHistoryEntry } from "./historyStore";

function historyEntry(id: string, command: string, runtimeSessionId: string): CommandHistoryEntry {
  return {
    id,
    scope_kind: "saved_session",
    scope_id: "session-current",
    runtime_session_id: runtimeSessionId,
    command,
    cwd: null,
    exit_code: null,
    started_at_ms: 1,
    finished_at_ms: null,
  };
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

describe("historyStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHistoryStore.setState({
      entries: [],
      commandGroups: [],
      loading: false,
      error: null,
      groupLoading: false,
      groupError: null,
    });
  });

  it("keeps the latest active terminal history when an older search resolves later", async () => {
    const staleSearch = deferred<CommandHistoryEntry[]>();
    const currentEntries = [historyEntry("history-current", "pwd", "runtime-current")];
    invokeMock
      .mockReturnValueOnce(staleSearch.promise)
      .mockResolvedValueOnce(currentEntries);

    const stalePromise = useHistoryStore.getState().searchHistory({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-old",
    });
    const currentPromise = useHistoryStore.getState().searchHistory({
      query: "",
      scopeKind: "saved_session",
      scopeId: "session-current",
    });

    await currentPromise;
    expect(useHistoryStore.getState().entries).toEqual(currentEntries);
    expect(invokeMock).toHaveBeenLastCalledWith("history_search", {
      query: null,
      scopeKind: "saved_session",
      scopeId: "session-current",
      deduplicate: false,
      limit: 1000,
    });

    staleSearch.resolve([]);
    await stalePromise;

    expect(useHistoryStore.getState().entries).toEqual(currentEntries);
    expect(useHistoryStore.getState().loading).toBe(false);
  });

  it("does not query or clear global history when no scope is active", async () => {
    await useHistoryStore.getState().searchHistory({
      query: "",
      scopeKind: null,
      scopeId: null,
    });
    await useHistoryStore.getState().clearHistory(null, null);

    expect(invokeMock).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().entries).toEqual([]);
  });

  it("deletes selected history entries within the active scope", async () => {
    invokeMock.mockResolvedValue({ deleted_count: 2 });

    await useHistoryStore.getState().deleteHistoryEntries("saved_session", "session-current", ["history-1", "history-2"]);

    expect(invokeMock).toHaveBeenCalledWith("history_delete_entries", {
      scopeKind: "saved_session",
      scopeId: "session-current",
      entryIds: ["history-1", "history-2"],
    });
  });
});
