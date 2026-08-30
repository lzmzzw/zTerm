// Author: Liz
type FileKind = "file" | "directory" | "symlink" | "other";
export type TransferKind = "file" | "directory";
export type TransferConflictPolicy = "overwrite" | "skip" | "rename";

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  modified_at_ms: number | null;
  permissions: string | null;
}

export type TransferDirection = "upload" | "download";
export type TransferStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
type TransferTaskOrigin = "sftp_panel" | "file_transfer";
type TransferEndpointKind = "local" | "saved_session";

export interface TransferEndpoint {
  kind: TransferEndpointKind;
  saved_session_id?: string | null;
  path: string;
}

export interface TransferTask {
  id: string;
  group_id?: string | null;
  group_name?: string | null;
  saved_session_id: string;
  direction: TransferDirection;
  local_path: string;
  remote_path: string;
  kind: TransferKind | null;
  conflict_policy: TransferConflictPolicy;
  total_bytes: number;
  transferred_bytes: number;
  status: TransferStatus;
  error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  task_origin?: TransferTaskOrigin;
  source_endpoint?: TransferEndpoint;
  destination_endpoint?: TransferEndpoint;
}

export interface TransferDoneEvent {
  task_id: string;
  task: TransferTask | null;
  error: string | null;
}

export interface LocalPathInfo {
  path: string;
  kind: TransferKind;
}

export interface TransferConflictCheckItem {
  direction: TransferDirection;
  localPath: string;
  remotePath: string;
  kind: TransferKind;
}

export interface TransferConflict {
  direction: TransferDirection;
  path: string;
}
