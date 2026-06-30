// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

type FileKind = "file" | "directory" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  modified_at_ms: number | null;
  permissions: string | null;
}

type TransferDirection = "upload" | "download";
type TransferStatus = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface TransferTask {
  id: string;
  saved_session_id: string;
  direction: TransferDirection;
  local_path: string;
  remote_path: string;
  total_bytes: number;
  transferred_bytes: number;
  status: TransferStatus;
  error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface FileState {
  entries: FileEntry[];
  transfers: TransferTask[];
  path: string;
  selectedPath: string | null;
  loading: boolean;
  transferLoading: boolean;
  error: string | null;
  setPath: (path: string) => void;
  selectPath: (path: string | null) => void;
  clearFiles: () => void;
  listFiles: (savedSessionId: string, path?: string) => Promise<void>;
  mkdir: (savedSessionId: string, path: string) => Promise<void>;
  upload: (savedSessionId: string, localPath: string, remotePath: string) => Promise<void>;
  download: (savedSessionId: string, remotePath: string, localPath: string) => Promise<void>;
  deletePath: (savedSessionId: string, path: string, recursive: boolean) => Promise<void>;
  renamePath: (savedSessionId: string, from: string, to: string) => Promise<void>;
  loadTransfers: (savedSessionId: string | null) => Promise<void>;
  retryTransfer: (taskId: string) => Promise<void>;
  bindTransferEvents: () => Promise<UnlistenFn>;
}

let listFilesRequestId = 0;

export const useFileStore = create<FileState>((set, get) => ({
  entries: [],
  transfers: [],
  path: ".",
  selectedPath: null,
  loading: false,
  transferLoading: false,
  error: null,
  setPath: (path) => set({ path }),
  selectPath: (path) => set({ selectedPath: path }),
  clearFiles() {
    listFilesRequestId += 1;
    set({ entries: [], path: ".", selectedPath: null, loading: false, error: null });
  },
  async listFiles(savedSessionId, path = get().path) {
    if (!savedSessionId) return;
    const requestId = listFilesRequestId + 1;
    listFilesRequestId = requestId;
    set({ loading: true, error: null, path });
    try {
      const entries = await invoke<FileEntry[]>("sftp_list", { savedSessionId, path });
      if (listFilesRequestId === requestId) {
        set({ entries, loading: false, selectedPath: null });
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
  async upload(savedSessionId, localPath, remotePath) {
    const task = await invoke<TransferTask>("sftp_upload", { savedSessionId, localPath, remotePath });
    upsertTransfer(set, task);
  },
  async download(savedSessionId, remotePath, localPath) {
    const task = await invoke<TransferTask>("sftp_download", { savedSessionId, remotePath, localPath });
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
  async loadTransfers(savedSessionId) {
    set({ transferLoading: true });
    try {
      const transfers = await invoke<TransferTask[]>("transfer_list", { savedSessionId, limit: 200 });
      set({ transfers, transferLoading: false });
    } catch (error) {
      set({ transferLoading: false, error: unknownErrorMessage(error, "文件操作失败") });
    }
  },
  async retryTransfer(taskId) {
    const task = await invoke<TransferTask>("transfer_retry", { taskId });
    upsertTransfer(set, task);
  },
  async bindTransferEvents() {
    const progress = await listen<TransferTask>("transfer:progress", (event) => {
      upsertTransfer(set, event.payload);
    });
    const done = await listen<TransferTask>("transfer:done", (event) => {
      if (typeof event.payload === "object" && event.payload && "id" in event.payload) {
        upsertTransfer(set, event.payload);
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
  set((state) => {
    const exists = state.transfers.some((item) => item.id === task.id);
    return {
      transfers: exists
        ? state.transfers.map((item) => (item.id === task.id ? task : item))
        : [task, ...state.transfers],
    };
  });
}
