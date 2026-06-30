// Author: Liz
export type PaneSplitDirection = "horizontal" | "vertical";

export interface PaneTerminalTab {
  id: string;
  title: string;
  runtime_session_id: string | null;
  saved_session_id: string | null;
  connection_source?: "saved_session" | "default_local" | "missing" | null;
  path?: string | null;
  startup_command?: string | null;
  restore_status?: "queued" | "pending" | "connected" | "failed" | null;
  restore_error?: string | null;
  visual_snapshot?: PaneTerminalVisualSnapshot | null;
}

interface PaneTerminalVisualSnapshot {
  kind: "terminal_tail" | "placeholder";
  text: string;
  captured_at_ms: number;
  runtime_session_id?: string | null;
}

export interface WorkspaceTab {
  id: string;
  title: string;
  active_pane_id: string;
  root: PaneNode;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export type PaneNode =
  | {
      kind: "leaf";
      id: string;
      runtime_session_id: string | null;
      saved_session_id: string | null;
      title: string;
      active_terminal_tab_id?: string;
      terminal_tabs?: PaneTerminalTab[];
    }
  | {
      kind: "split";
      id: string;
      direction: PaneSplitDirection;
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

export type WorkspaceStatus = "running" | "closed";

export interface WorkspaceSummary {
  id: string;
  name: string;
  status: WorkspaceStatus;
  active_tab_id: string;
  tab_count: number;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface WorkspaceDefinition {
  id: string;
  name: string;
  status: WorkspaceStatus;
  active_tab_id: string;
  tabs: WorkspaceTab[];
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface WorkspaceDefinitionDraft {
  id?: string | null;
  name: string;
  status: WorkspaceStatus;
  active_tab_id: string;
  tabs: Array<Omit<WorkspaceTab, "created_at_ms" | "updated_at_ms">>;
  sort_order: number;
}

export interface WorkspaceRuntime extends WorkspaceDefinition {
  activeTabId: string;
}
