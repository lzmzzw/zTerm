// Author: Liz
import { create } from "zustand";

import { getLeafTerminalTabs } from "../workspace/workspaceLayout";
import type { PaneNode, WorkspaceTab } from "../workspace/types";

export type TerminalInputSource = "user" | "terminal_response";

export interface SyncChannelMember {
  id: string;
  runtimeSessionId: string;
  title: string;
  host: string;
}

interface SyncInputChannel {
  id: string;
  members: SyncChannelMember[];
}

interface SyncInputState {
  channel: SyncInputChannel | null;
  createChannel: (members: SyncChannelMember[]) => boolean;
  leaveChannel: (memberId: string) => void;
  closeChannel: () => void;
  retainMembers: (availableMembers: SyncChannelMember[]) => void;
}

interface RuntimeCandidate {
  runtime_session_id: string;
  kind: string;
  title: string;
}

let nextChannelId = 1;
const runtimeWriteQueues = new Map<string, Promise<void>>();

export const useSyncInputStore = create<SyncInputState>((set) => ({
  channel: null,
  createChannel(members) {
    const uniqueMembers = Array.from(new Map(members.map((member) => [member.id, member])).values());
    if (uniqueMembers.length < 2) return false;
    set({ channel: { id: `sync-channel-${nextChannelId++}`, members: uniqueMembers } });
    return true;
  },
  leaveChannel(memberId) {
    set((state) => {
      if (!state.channel) return state;
      const members = state.channel.members.filter((member) => member.id !== memberId);
      return { channel: members.length > 0 ? { ...state.channel, members } : null };
    });
  },
  closeChannel() {
    set({ channel: null });
  },
  retainMembers(availableMembers) {
    set((state) => {
      if (!state.channel) return state;
      const availableById = new Map(availableMembers.map((member) => [member.id, member]));
      const members = state.channel.members
        .map((member) => availableById.get(member.id))
        .filter((member): member is SyncChannelMember => Boolean(member));
      return { channel: members.length > 0 ? { ...state.channel, members } : null };
    });
  },
}));

export function collectSyncChannelCandidates(
  tabs: WorkspaceTab[],
  runtimes: Record<string, RuntimeCandidate>,
  resolveHost: (savedSessionId: string | null, runtime: RuntimeCandidate) => string,
): SyncChannelMember[] {
  const candidates: SyncChannelMember[] = [];
  for (const workspaceTab of tabs) {
    visitLeaves(workspaceTab.root, (leaf) => {
      for (const terminalTab of getLeafTerminalTabs(leaf)) {
        const runtimeSessionId = terminalTab.runtime_session_id;
        if (!runtimeSessionId) continue;
        const runtime = runtimes[runtimeSessionId];
        if (!runtime || runtime.kind !== "ssh") continue;
        candidates.push({
          id: terminalTab.id,
          runtimeSessionId,
          title: terminalTab.title,
          host: resolveHost(terminalTab.saved_session_id, runtime) || runtime.title,
        });
      }
    });
  }
  return Array.from(new Map(candidates.map((candidate) => [candidate.id, candidate])).values());
}

export async function routeSyncTerminalInput(
  sourceRuntimeSessionId: string,
  data: string,
  source: TerminalInputSource,
  write: (runtimeSessionId: string, data: string) => Promise<void>,
) {
  const channel = useSyncInputStore.getState().channel;
  const sourceMember = channel?.members.find((member) => member.runtimeSessionId === sourceRuntimeSessionId);
  const targetRuntimeIds =
    source === "user" && sourceMember
      ? [
          sourceRuntimeSessionId,
          ...channel!.members
            .filter((member) => member.runtimeSessionId !== sourceRuntimeSessionId)
            .map((member) => member.runtimeSessionId),
        ]
      : [sourceRuntimeSessionId];

  await Promise.allSettled(targetRuntimeIds.map((runtimeSessionId) => enqueueRuntimeWrite(runtimeSessionId, data, write)));
}

function enqueueRuntimeWrite(
  runtimeSessionId: string,
  data: string,
  write: (runtimeSessionId: string, data: string) => Promise<void>,
) {
  const previous = runtimeWriteQueues.get(runtimeSessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => write(runtimeSessionId, data));
  runtimeWriteQueues.set(runtimeSessionId, current);
  const release = () => {
    if (runtimeWriteQueues.get(runtimeSessionId) === current) runtimeWriteQueues.delete(runtimeSessionId);
  };
  void current.then(release, release);
  return current;
}

function visitLeaves(root: PaneNode, visitor: (leaf: Extract<PaneNode, { kind: "leaf" }>) => void) {
  if (root.kind === "leaf") {
    visitor(root);
    return;
  }
  visitLeaves(root.first, visitor);
  visitLeaves(root.second, visitor);
}
