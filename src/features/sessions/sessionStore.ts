// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

import type {
  SavedSession,
  SavedSessionDraft,
  SessionGroup,
  SessionGroupDraft,
  SessionTestRequest,
  SessionTestResult,
  SessionTreeSnapshot,
} from "./types";

interface SessionState extends SessionTreeSnapshot {
  loading: boolean;
  error: string | null;
  setSnapshot: (snapshot: SessionTreeSnapshot) => void;
  loadSessions: () => Promise<void>;
  saveGroup: (draft: SessionGroupDraft) => Promise<SessionGroup>;
  deleteGroup: (groupId: string) => Promise<void>;
  saveSession: (draft: SavedSessionDraft) => Promise<SavedSession>;
  deleteSession: (sessionId: string) => Promise<void>;
  testSession: (request: SessionTestRequest) => Promise<SessionTestResult>;
  exportCsv: (targetPath: string) => Promise<{ path: string; exported_records: number }>;
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
      const snapshot = await invokeTauri<SessionTreeSnapshot>("sessions_list");
      set({ ...snapshot, loading: false });
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "会话操作失败") });
    }
  },
  async saveGroup(draft) {
    const group = await invokeTauri<SessionGroup>("sessions_save_group", { draft });
    await get().loadSessions();
    return group;
  },
  async deleteGroup(groupId) {
    await invokeTauri("sessions_delete_group", { id: groupId });
    await get().loadSessions();
  },
  async saveSession(draft) {
    const session = await invokeTauri<SavedSession>("sessions_save_session", { draft });
    await get().loadSessions();
    return session;
  },
  async deleteSession(sessionId) {
    await invokeTauri("sessions_delete_session", { id: sessionId });
    await get().loadSessions();
  },
  async testSession(request) {
    return invokeTauri<SessionTestResult>("sessions_test_connection", {
      draft: request.draft,
      secret: request.secret ?? null,
    });
  },
  async exportCsv(targetPath) {
    return invokeTauri("sessions_export_csv", { targetPath });
  },
}));
