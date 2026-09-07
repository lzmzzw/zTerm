// Author: Liz
import type { TransferConflict, TransferConflictPolicy } from "../features/files/fileTypes";
import type { SavedSession, SavedSessionDraft, SshOptions, SshTunnel } from "../features/sessions/types";
import type { SshContainerInfo } from "../features/terminal/sshContainerApi";
import type { WorkspaceDefinition } from "../features/workspace/types";
import type { RightTool } from "./rightTools";

export type LeftTool = "workspace" | "sessions";

export type ConnectionDialogTarget = {
  workspaceId: string;
  workspaceTabId: string;
  paneId: string;
};

export type WorkspaceEditorState = {
  mode: "create" | "edit";
  workspace: WorkspaceDefinition;
};

export type TransferConflictDialogState = {
  conflicts: TransferConflict[];
  resolve: (policy: TransferConflictPolicy | null) => void;
};

export type ZtermToolActionEvent = {
  action: string;
  arguments?: Record<string, unknown> | null;
  affected_domains?: string[];
};

export const EMPTY_MCP_PANEL_STATE = {
  mcpApprovalMode: "safe" as const,
  mcpPendingInvocations: [],
  agentLoading: false,
  agentError: null,
};

export const EMPTY_FILE_PANEL_STATE = {
  fileEntries: [],
  filePath: "/",
  selectedPaths: [],
  filesLoading: false,
  fileError: null,
};

export const EMPTY_TRANSFER_PANEL_STATE = {
  transfers: [],
};

export const EMPTY_CONTAINER_PANEL_STATE = {
  items: [] as SshContainerInfo[],
  loading: false,
  error: null as string | null,
};

export const DEFAULT_EXTERNAL_SSH_OPTIONS: SshOptions = {
  connect_timeout_ms: null,
  keepalive_interval_ms: null,
  proxy_command: null,
  identity_file: null,
  jump_hosts: [],
  tunnels: [],
  container: {
    enabled: true,
    runtime: "docker",
    container: "",
    shell: "/bin/sh",
    user: null,
    workdir: null,
  },
};

export const EMPTY_HISTORY_PANEL_STATE = {
  historyEntries: [],
  commandGroups: [],
  historyLoading: false,
  historyError: null,
  historyGroupLoading: false,
  historyGroupError: null,
};

export const EMPTY_WORKSPACE_SIDEBAR_STATE = {
  workspaceDefinitions: {} as Record<string, WorkspaceDefinition>,
};

export type ActiveSshTunnelTarget = {
  sessionId: string;
  savedSession: SavedSession | null;
  baseOptions: SshOptions;
  host: string;
  hostServiceTargetHost: string;
  external: boolean;
};

export type SshTunnelEditorState = ActiveSshTunnelTarget & {
  mode: "create" | "edit";
  index: number | null;
  tunnel: SshTunnel;
};

export type PendingSshTunnelDelete = ActiveSshTunnelTarget & {
  index: number;
  tunnel: SshTunnel;
};

export function readString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

export function rightToolFromValue(value: string | null | undefined): RightTool | null {
  if (!value) return null;
  const normalized = value.trim();
  if (["agent", "files", "history", "monitor", "tunnels", "containers"].includes(normalized)) {
    return normalized as RightTool;
  }
  return null;
}

export function waitForUiTurn() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

export function savedSessionDraftWithSshOptions(session: SavedSession, sshOptions: SshOptions): SavedSessionDraft {
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    group_id: session.group_id,
    host: session.host,
    port: session.port,
    username: session.username,
    auth_mode: session.auth_mode,
    credential_ref: session.credential_ref,
    description: session.description,
    tags: session.tags,
    sort_order: session.sort_order,
    ssh_options: sshOptions,
    rdp_options: session.rdp_options,
    local_options: session.local_options,
  };
}
