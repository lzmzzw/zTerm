// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import { nextSelectedFilePaths, type FileSelectionEvent } from "./fileSelectionModel";

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
export type TransferTaskOrigin = "sftp_panel" | "file_transfer";
export type TransferEndpointKind = "local" | "ssh";

export interface TransferEndpoint {
  kind: TransferEndpointKind;
  saved_session_id?: string | null;
  path: string;
}

export interface TransferTask {
  id: string;
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

interface TransferOptions {
  kind?: TransferKind;
  conflictPolicy?: TransferConflictPolicy;
}

interface FileState {
  entries: FileEntry[];
  transfers: TransferTask[];
  activeSavedSessionId: string | null;
  transferSessionId: string | null;
  path: string;
  selectedPaths: string[];
  selectionAnchorPath: string | null;
  loading: boolean;
  transferLoading: boolean;
  error: string | null;
  setPath: (path: string) => void;
  selectPath: (path: string | null, event?: FileSelectionEvent, orderedEntries?: FileEntry[]) => void;
  selectPaths: (paths: string[]) => void;
  clearFiles: () => void;
  listFiles: (savedSessionId: string, path?: string) => Promise<void>;
  mkdir: (savedSessionId: string, path: string) => Promise<void>;
  upload: (savedSessionId: string, localPath: string, remotePath: string, options?: TransferOptions) => Promise<void>;
  download: (savedSessionId: string, remotePath: string, localPath: string, options?: TransferOptions) => Promise<void>;
  deletePath: (savedSessionId: string, path: string, recursive: boolean) => Promise<void>;
  renamePath: (savedSessionId: string, from: string, to: string) => Promise<void>;
  classifyLocalPaths: (paths: string[]) => Promise<LocalPathInfo[]>;
  checkTransferConflicts: (savedSessionId: string, items: TransferConflictCheckItem[]) => Promise<TransferConflict[]>;
  loadTransfers: (savedSessionId: string | null) => Promise<void>;
  retryTransfer: (taskId: string) => Promise<void>;
  pauseTransfer: (taskId: string) => Promise<void>;
  resumeTransfer: (taskId: string) => Promise<void>;
  cancelTransfer: (taskId: string) => Promise<void>;
  deleteTransfer: (taskId: string) => Promise<void>;
  bindTransferEvents: () => Promise<UnlistenFn>;
}

let listFilesRequestId = 0;
let transferListRequestId = 0;
const deletedTransferIds = new Set<string>();

export const useFileStore = create<FileState>((set, get) => ({
  entries: [],
  transfers: [],
  activeSavedSessionId: null,
  transferSessionId: null,
  path: "/",
  selectedPaths: [],
  selectionAnchorPath: null,
  loading: false,
  transferLoading: false,
  error: null,
  setPath: (path) => set({ path }),
  selectPath: (path, event, orderedEntries) => {
    if (!path) {
      set({ selectedPaths: [], selectionAnchorPath: null });
      return;
    }
    const state = get();
    const entries = orderedEntries ?? state.entries;
    const selectedPaths = nextSelectedFilePaths(entries, state.selectedPaths, state.selectionAnchorPath, path, event);
    set({ selectedPaths, selectionAnchorPath: event?.shiftKey ? state.selectionAnchorPath : path });
  },
  selectPaths: (paths) => set({ selectedPaths: paths, selectionAnchorPath: paths.at(-1) ?? null }),
  clearFiles() {
    listFilesRequestId += 1;
    transferListRequestId += 1;
    set({
      entries: [],
      activeSavedSessionId: null,
      transferSessionId: null,
      path: "/",
      selectedPaths: [],
      selectionAnchorPath: null,
      loading: false,
      error: null,
    });
  },
  async listFiles(savedSessionId, path = get().path) {
    if (!savedSessionId) return;
    const requestId = listFilesRequestId + 1;
    listFilesRequestId = requestId;
    set({ activeSavedSessionId: savedSessionId, loading: true, error: null, path });
    try {
      const entries = await invoke<FileEntry[]>("sftp_list", { savedSessionId, path });
      if (listFilesRequestId === requestId) {
        set({ entries, loading: false, selectedPaths: [], selectionAnchorPath: null });
      }
    } catch (error) {
      if (listFilesRequestId === requestId) {
        set({ loading: false, error: unknownErrorMessage(error, "文件操作失败") });
      }
    }
  },
  async mkdir(savedSessionId, path) {
    await invoke("sftp_mkdir", { savedSessionId, path });
    await get().listFiles(savedSessionId);
  },
  async upload(savedSessionId, localPath, remotePath, options = {}) {
    const task = await invoke<TransferTask>("sftp_upload", {
      savedSessionId,
      localPath,
      remotePath,
      kind: options.kind,
      conflictPolicy: options.conflictPolicy,
    });
    upsertTransfer(set, task);
  },
  async download(savedSessionId, remotePath, localPath, options = {}) {
    const task = await invoke<TransferTask>("sftp_download", {
      savedSessionId,
      remotePath,
      localPath,
      kind: options.kind,
      conflictPolicy: options.conflictPolicy,
    });
    upsertTransfer(set, task);
  },
  async deletePath(savedSessionId, path, recursive) {
    await invoke("sftp_delete", { savedSessionId, path, recursive });
    await get().listFiles(savedSessionId);
  },
  async renamePath(savedSessionId, from, to) {
    await invoke("sftp_rename", { savedSessionId, from, to });
    await get().listFiles(savedSessionId);
  },
  async classifyLocalPaths(paths) {
    return invoke<LocalPathInfo[]>("sftp_classify_local_paths", { paths });
  },
  async checkTransferConflicts(savedSessionId, items) {
    return invoke<TransferConflict[]>("sftp_check_transfer_conflicts", { savedSessionId, items });
  },
  async loadTransfers(savedSessionId) {
    const requestId = transferListRequestId + 1;
    transferListRequestId = requestId;
    if (!savedSessionId) {
      set({ transfers: [], transferLoading: false, transferSessionId: null });
      return;
    }
    set({ transferLoading: true, transferSessionId: savedSessionId });
    try {
      const transfers = await invoke<TransferTask[]>("transfer_list", { savedSessionId, limit: 200 });
      if (transferListRequestId !== requestId) {
        return;
      }
      set({
        transfers: transfers.filter((task) => task.saved_session_id === savedSessionId),
        transferLoading: false,
        transferSessionId: savedSessionId,
      });
    } catch (error) {
      if (transferListRequestId === requestId) {
        set({ transferLoading: false, error: unknownErrorMessage(error, "文件操作失败") });
      }
    }
  },
  async retryTransfer(taskId) {
    const task = await invoke<TransferTask>("transfer_retry", { taskId });
    upsertTransfer(set, task);
  },
  async pauseTransfer(taskId) {
    const task = await invoke<TransferTask>("transfer_pause", { taskId });
    upsertTransfer(set, task);
  },
  async resumeTransfer(taskId) {
    const task = await invoke<TransferTask>("transfer_resume", { taskId });
    upsertTransfer(set, task);
  },
  async cancelTransfer(taskId) {
    const task = await invoke<TransferTask>("transfer_cancel", { taskId });
    upsertTransfer(set, task);
  },
  async deleteTransfer(taskId) {
    await invoke("transfer_delete", { taskId });
    deletedTransferIds.add(taskId);
    set((state) => ({ transfers: state.transfers.filter((task) => task.id !== taskId) }));
  },
  async bindTransferEvents() {
    const progress = await listen<TransferTask>("transfer:progress", (event) => {
      upsertTransfer(set, event.payload);
    });
    const done = await listen<TransferTask>("transfer:done", (event) => {
      if (typeof event.payload === "object" && event.payload && "id" in event.payload) {
        const task = event.payload;
        upsertTransfer(set, task);
        if (task.direction === "upload" && task.status === "done") {
          const state = get();
          if (state.activeSavedSessionId === task.saved_session_id) {
            void state.listFiles(task.saved_session_id, state.path);
          }
        }
      }
    });
    return () => {
      progress();
      done();
    };
  },
}));

type FileStoreSet = (partial: Partial<FileState> | ((state: FileState) => Partial<FileState>)) => void;

function upsertTransfer(set: FileStoreSet, task: TransferTask) {
  if (deletedTransferIds.has(task.id)) {
    return;
  }
  set((state) => {
    if (state.transferSessionId !== task.saved_session_id) {
      return {};
    }
    const exists = state.transfers.some((item) => item.id === task.id);
    return {
      transfers: exists
        ? state.transfers.map((item) => (item.id === task.id ? task : item))
        : [task, ...state.transfers],
    };
  });
}
