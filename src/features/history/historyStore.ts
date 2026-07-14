// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

export interface CommandHistoryEntry {
  id: string;
  scope_kind: HistoryScopeKind | null;
  scope_id: string | null;
  runtime_session_id: string;
  command: string;
  cwd: string | null;
  exit_code: number | null;
  started_at_ms: number;
  finished_at_ms: number | null;
}

export type HistoryScopeKind = "saved_session" | "local_profile";

interface HistorySearchInput {
  query: string;
  scopeKind?: HistoryScopeKind | null;
  scopeId?: string | null;
  deduplicate?: boolean;
  limit?: number;
}

interface SessionCommandGroupItem {
  id: string;
  group_id: string;
  command: string;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SessionCommandGroup {
  id: string;
  saved_session_id: string | null;
  scope_kind: HistoryScopeKind;
  scope_id: string;
  name: string;
  items: SessionCommandGroupItem[];
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SessionCommandGroupDraft {
  id?: string;
  saved_session_id: string | null;
  scope_kind: HistoryScopeKind;
  scope_id: string;
  name: string;
  commands: string[];
}

interface HistoryState {
  entries: CommandHistoryEntry[];
  commandGroups: SessionCommandGroup[];
  loading: boolean;
  error: string | null;
  groupLoading: boolean;
  groupError: string | null;
  searchHistory: (input: HistorySearchInput) => Promise<void>;
  clearHistory: (scopeKind: HistoryScopeKind | null, scopeId: string | null) => Promise<void>;
  deleteHistoryEntries: (scopeKind: HistoryScopeKind | null, scopeId: string | null, entryIds: string[]) => Promise<void>;
  loadCommandGroups: (scopeKind: HistoryScopeKind | null, scopeId: string | null) => Promise<void>;
  saveCommandGroup: (draft: SessionCommandGroupDraft) => Promise<void>;
  deleteCommandGroup: (groupId: string) => Promise<void>;
}

let historySearchRequestId = 0;
let commandGroupsRequestId = 0;

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  commandGroups: [],
  loading: false,
  error: null,
  groupLoading: false,
  groupError: null,
  async searchHistory({
    query,
    scopeKind = null,
    scopeId = null,
    deduplicate = false,
    limit = 1000,
  }) {
    if (!scopeKind || !scopeId) {
      set({ entries: [], loading: false, error: null });
      return;
    }
    const requestId = (historySearchRequestId += 1);
    set({ loading: true, error: null });
    try {
      const entries = await invoke<CommandHistoryEntry[]>("history_search", {
        query: query.trim() || null,
        scopeKind,
        scopeId,
        deduplicate,
        limit,
      });
      if (requestId !== historySearchRequestId) return;
      set({ entries, loading: false });
    } catch (error) {
      if (requestId !== historySearchRequestId) return;
      set({ loading: false, error: unknownErrorMessage(error, "历史命令操作失败") });
    }
  },
  async clearHistory(scopeKind, scopeId) {
    if (!scopeKind || !scopeId) {
      set({ entries: [], loading: false, error: null });
      return;
    }
    await invoke("history_clear", { scopeKind, scopeId });
    await get().searchHistory({ query: "", scopeKind, scopeId });
  },
  async deleteHistoryEntries(scopeKind, scopeId, entryIds) {
    if (!scopeKind || !scopeId || entryIds.length === 0) return;
    try {
      await invoke("history_delete_entries", { scopeKind, scopeId, entryIds });
    } catch (error) {
      set({ error: unknownErrorMessage(error, "历史命令操作失败") });
      throw error;
    }
  },
  async loadCommandGroups(scopeKind, scopeId) {
    const requestId = (commandGroupsRequestId += 1);
    if (!scopeKind || !scopeId) {
      set({ commandGroups: [], groupLoading: false, groupError: null });
      return;
    }
    set({ groupLoading: true, groupError: null });
    try {
      const commandGroups = await invoke<SessionCommandGroup[]>("history_command_group_list", {
        scopeKind,
        scopeId,
      });
      if (requestId !== commandGroupsRequestId) return;
      set({ commandGroups, groupLoading: false });
    } catch (error) {
      if (requestId !== commandGroupsRequestId) return;
      set({ groupLoading: false, groupError: unknownErrorMessage(error, "历史命令操作失败") });
    }
  },
  async saveCommandGroup(draft) {
    set({ groupLoading: true, groupError: null });
    try {
      await invoke<SessionCommandGroup>("history_command_group_save", { draft });
      const commandGroups = await invoke<SessionCommandGroup[]>("history_command_group_list", {
        scopeKind: draft.scope_kind,
        scopeId: draft.scope_id,
      });
      set({ commandGroups, groupLoading: false });
    } catch (error) {
      set({ groupLoading: false, groupError: unknownErrorMessage(error, "历史命令操作失败") });
      throw error;
    }
  },
  async deleteCommandGroup(groupId) {
    set({ groupLoading: true, groupError: null });
    try {
      await invoke("history_command_group_delete", { groupId });
      set((state) => ({
        commandGroups: state.commandGroups.filter((group) => group.id !== groupId),
        groupLoading: false,
      }));
    } catch (error) {
      set({ groupLoading: false, groupError: unknownErrorMessage(error, "历史命令操作失败") });
      throw error;
    }
  },
}));
