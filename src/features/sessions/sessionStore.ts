// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

import type { SavedSession, SavedSessionDraft, SessionGroup, SessionGroupDraft, SessionTestResult, SessionTreeSnapshot } from "./types";

interface SessionState extends SessionTreeSnapshot {
  loading: boolean;
  error: string | null;
  setSnapshot: (snapshot: SessionTreeSnapshot) => void;
  loadSessions: () => Promise<void>;
  saveGroup: (draft: SessionGroupDraft) => Promise<SessionGroup>;
  deleteGroup: (groupId: string) => Promise<void>;
  saveSession: (draft: SavedSessionDraft) => Promise<SavedSession>;
  deleteSession: (sessionId: string) => Promise<void>;
  testSession: (draft: SavedSessionDraft) => Promise<SessionTestResult>;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  groups: [],
  sessions: [],
  loading: false,
  error: null,
  setSnapshot: (snapshot) => set({ groups: snapshot.groups, sessions: snapshot.sessions }),
  async loadSessions() {
    set({ loading: true, error: null });
    try {
      const snapshot = await invoke<SessionTreeSnapshot>("sessions_list");
      set({ ...snapshot, loading: false });
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "会话操作失败") });
    }
  },
  async saveGroup(draft) {
    const group = await invoke<SessionGroup>("sessions_save_group", { draft });
    await get().loadSessions();
    return group;
  },
  async deleteGroup(groupId) {
    await invoke("sessions_delete_group", { id: groupId });
    await get().loadSessions();
  },
  async saveSession(draft) {
    const session = await invoke<SavedSession>("sessions_save_session", { draft });
    await get().loadSessions();
    return session;
  },
  async deleteSession(sessionId) {
    await invoke("sessions_delete_session", { id: sessionId });
    await get().loadSessions();
  },
  async testSession(draft) {
    return invoke<SessionTestResult>("sessions_test_connection", { draft });
  },
}));
