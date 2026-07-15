// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  collectSyncChannelCandidates,
  routeSyncTerminalInput,
  useSyncInputStore,
  type SyncChannelMember,
} from "./syncInputStore";

const members: SyncChannelMember[] = [
  { id: "tab-1", runtimeSessionId: "runtime-1", title: "SSH A", host: "10.0.0.1" },
  { id: "tab-2", runtimeSessionId: "runtime-2", title: "SSH B", host: "10.0.0.2" },
  { id: "tab-3", runtimeSessionId: "runtime-3", title: "SSH C", host: "10.0.0.3" },
];

describe("syncInputStore", () => {
  beforeEach(() => {
    useSyncInputStore.getState().closeChannel();
  });

  it("creates a channel only when at least two members are selected", () => {
    expect(useSyncInputStore.getState().createChannel(members.slice(0, 1))).toBe(false);
    expect(useSyncInputStore.getState().channel).toBe(null);

    expect(useSyncInputStore.getState().createChannel(members.slice(0, 2))).toBe(true);
    expect(useSyncInputStore.getState().channel?.members.map((member) => member.id)).toEqual(["tab-1", "tab-2"]);
  });

  it("collects connected direct SSH tabs while excluding local and SSH container runtimes", () => {
    const candidates = collectSyncChannelCandidates(
      [
        {
          id: "workspace-tab",
          title: "Ops",
          active_pane_id: "pane-1",
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
          root: {
            kind: "leaf",
            id: "pane-1",
            title: "SSH A",
            runtime_session_id: "runtime-1",
            saved_session_id: "session-1",
            active_terminal_tab_id: "tab-1",
            terminal_tabs: [
              { id: "tab-1", title: "SSH A", runtime_session_id: "runtime-1", saved_session_id: "session-1" },
              { id: "tab-2", title: "Local", runtime_session_id: "runtime-local", saved_session_id: null },
              { id: "tab-3", title: "Container", runtime_session_id: "runtime-container", saved_session_id: "session-1" },
            ],
          },
        },
      ],
      {
        "runtime-1": { runtime_session_id: "runtime-1", kind: "ssh", title: "SSH A" },
        "runtime-local": { runtime_session_id: "runtime-local", kind: "local", title: "Local" },
        "runtime-container": { runtime_session_id: "runtime-container", kind: "ssh_container", title: "Container" },
      },
      () => "10.0.0.1",
    );

    expect(candidates).toEqual([
      { id: "tab-1", runtimeSessionId: "runtime-1", title: "SSH A", host: "10.0.0.1" },
    ]);
  });

  it("removes unavailable members without affecting the remaining channel members", () => {
    useSyncInputStore.getState().createChannel(members);
    useSyncInputStore.getState().retainMembers([
      { ...members[0], runtimeSessionId: "runtime-1-reconnected" },
      members[2],
    ]);
    expect(useSyncInputStore.getState().channel?.members.map((member) => member.id)).toEqual(["tab-1", "tab-3"]);
    expect(useSyncInputStore.getState().channel?.members[0].runtimeSessionId).toBe("runtime-1-reconnected");

    useSyncInputStore.getState().leaveChannel("tab-1");
    expect(useSyncInputStore.getState().channel?.members.map((member) => member.id)).toEqual(["tab-3"]);
  });

  it("broadcasts user input in member order but keeps terminal responses on the source runtime", async () => {
    useSyncInputStore.getState().createChannel(members);
    const write = vi.fn().mockResolvedValue(undefined);

    await routeSyncTerminalInput("runtime-2", "ls\r", "user", write);
    expect(write.mock.calls).toEqual([
      ["runtime-2", "ls\r"],
      ["runtime-1", "ls\r"],
      ["runtime-3", "ls\r"],
    ]);

    write.mockClear();
    await routeSyncTerminalInput("runtime-2", "\u001b[12;40R", "terminal_response", write);
    expect(write.mock.calls).toEqual([["runtime-2", "\u001b[12;40R"]]);
  });
});
