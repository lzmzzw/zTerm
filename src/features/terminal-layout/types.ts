// Author: Liz
export type PaneSplitDirection = "horizontal" | "vertical";

export interface PaneTerminalTab {
  id: string;
  title: string;
  runtime_session_id: string | null;
  saved_session_id: string | null;
  connection_source?: "saved_session" | "ssh_container" | "default_local" | "empty" | "external_ssh" | "missing" | null;
  container_target?: {
    id: string;
    name?: string | null;
  } | null;
  path?: string | null;
  startup_command?: string | null;
  restore_status?: "queued" | "pending" | "connected" | "failed" | null;
  restore_error?: string | null;
  restore_token?: string | null;
  visual_snapshot?: PaneTerminalVisualSnapshot | null;
}

interface PaneTerminalVisualSnapshot {
  kind: "terminal_tail" | "placeholder";
  text: string;
  captured_at_ms: number;
  runtime_session_id?: string | null;
}

export interface TerminalLayoutTab {
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

type TerminalLayoutStatus = "running" | "closed";

export interface TerminalLayoutDefinition {
  id: string;
  name: string;
  status: TerminalLayoutStatus;
  active_tab_id: string;
  tabs: TerminalLayoutTab[];
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface TerminalLayoutDefinitionDraft {
  id?: string | null;
  name: string;
  status: TerminalLayoutStatus;
  active_tab_id: string;
  tabs: Array<Omit<TerminalLayoutTab, "created_at_ms" | "updated_at_ms">>;
  sort_order: number;
}

export interface TerminalLayoutRuntime extends TerminalLayoutDefinition {
  activeTabId: string;
}
