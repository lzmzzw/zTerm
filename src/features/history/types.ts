// Author: Liz
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
