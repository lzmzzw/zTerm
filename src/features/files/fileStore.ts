// Author: Liz
import { create } from "zustand";

import { invokeTauri, listenTauri, type UnlistenFn } from "../../lib/tauriClient";
import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import { nextSelectedFilePaths, type FileSelectionEvent } from "./fileSelectionModel";
import type {
  FileEntry,
  LocalPathInfo,
  TransferConflict,
  TransferConflictCheckItem,
  TransferConflictPolicy,
  TransferDoneEvent,
  TransferKind,
  TransferTask,
} from "./fileTypes";
import {
  cancelTransferTask,
  deleteTransferTask,
  pauseTransferTask,
  resumeTransferTask,
  retryTransferTask,
} from "./transferTaskApi";
import { mergeTransferTaskList, newerTransferTask } from "./transferTaskSnapshots";

interface TransferOptions {
  kind?: TransferKind;
  conflictPolicy?: TransferConflictPolicy;
  groupId?: string;
  groupName?: string;
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
  setPath(path) {
    listFilesRequestId += 1;
    set({ path, entries: [], selectedPaths: [], selectionAnchorPath: null, loading: false, error: null });
  },
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
      transfers: [],
      transferLoading: false,
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
    set({
      activeSavedSessionId: savedSessionId,
      loading: true,
      error: null,
      path,
      entries: [],
      selectedPaths: [],
      selectionAnchorPath: null,
    });
    try {
      const entries = await invokeTauri<FileEntry[]>("sftp_list", { savedSessionId, path });
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
    const currentPath = get().path;
    await invokeTauri("sftp_mkdir", { savedSessionId, path });
    if (isActiveDirectory(get(), savedSessionId, currentPath)) await get().listFiles(savedSessionId, currentPath);
  },
  async upload(savedSessionId, localPath, remotePath, options = {}) {
    const task = await invokeTauri<TransferTask>("sftp_upload", {
      savedSessionId,
      localPath,
      remotePath,
      kind: options.kind,
      conflictPolicy: options.conflictPolicy,
      groupId: options.groupId,
      groupName: options.groupName,
    });
    upsertTransfer(set, task);
  },
  async download(savedSessionId, remotePath, localPath, options = {}) {
    const task = await invokeTauri<TransferTask>("sftp_download", {
      savedSessionId,
      remotePath,
      localPath,
      kind: options.kind,
      conflictPolicy: options.conflictPolicy,
      groupId: options.groupId,
      groupName: options.groupName,
    });
    upsertTransfer(set, task);
  },
  async deletePath(savedSessionId, path, recursive) {
    const currentPath = get().path;
    await invokeTauri("sftp_delete", { savedSessionId, path, recursive });
    if (isActiveDirectory(get(), savedSessionId, currentPath)) await get().listFiles(savedSessionId, currentPath);
  },
  async renamePath(savedSessionId, from, to) {
    const currentPath = get().path;
    await invokeTauri("sftp_rename", { savedSessionId, from, to });
    if (isActiveDirectory(get(), savedSessionId, currentPath)) await get().listFiles(savedSessionId, currentPath);
  },
  async classifyLocalPaths(paths) {
    return invokeTauri<LocalPathInfo[]>("sftp_classify_local_paths", { paths });
  },
  async checkTransferConflicts(savedSessionId, items) {
    return invokeTauri<TransferConflict[]>("sftp_check_transfer_conflicts", { savedSessionId, items });
  },
  async loadTransfers(savedSessionId) {
    const requestId = transferListRequestId + 1;
    transferListRequestId = requestId;
    if (!savedSessionId) {
      set({ transfers: [], transferLoading: false, transferSessionId: null });
      return;
    }
    set({
      transferLoading: true,
      transferSessionId: savedSessionId,
      transfers: get().transferSessionId === savedSessionId ? get().transfers : [],
    });
    try {
      const transfers = await invokeTauri<TransferTask[]>("transfer_list", { savedSessionId, limit: 1000 });
      if (transferListRequestId !== requestId) {
        return;
      }
      set({
        transfers: mergeTransferTaskList(
          get().transfers,
          transfers.filter((task) => task.saved_session_id === savedSessionId),
        ),
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
    const task = await retryTransferTask(taskId);
    upsertTransfer(set, task);
  },
  async pauseTransfer(taskId) {
    const task = await pauseTransferTask(taskId);
    upsertTransfer(set, task);
  },
  async resumeTransfer(taskId) {
    const task = await resumeTransferTask(taskId);
    upsertTransfer(set, task);
  },
  async cancelTransfer(taskId) {
    const task = await cancelTransferTask(taskId);
    upsertTransfer(set, task);
  },
  async deleteTransfer(taskId) {
    await deleteTransferTask(taskId);
    deletedTransferIds.add(taskId);
    set((state) => ({ transfers: state.transfers.filter((task) => task.id !== taskId) }));
  },
  async bindTransferEvents() {
    const progress = await listenTauri<TransferTask>("transfer:progress", (event) => {
      upsertTransfer(set, event.payload);
    });
    let done: UnlistenFn;
    try {
      done = await listenTauri<TransferDoneEvent>("transfer:done", (event) => {
        const task = event.payload.task;
        if (task) {
          upsertTransfer(set, task);
          if (task.direction === "upload" && task.status === "done") {
            const state = get();
            if (state.activeSavedSessionId === task.saved_session_id) {
              void state.listFiles(task.saved_session_id, state.path);
            }
          }
        }
        if (event.payload.error && (!task || task.saved_session_id === get().activeSavedSessionId)) {
          set({ error: event.payload.error });
        }
      });
    } catch (error) {
      progress();
      throw error;
    }
    return () => {
      progress();
      done();
    };
  },
}));

type FileStoreSet = (partial: Partial<FileState> | ((state: FileState) => Partial<FileState>)) => void;

function isActiveDirectory(state: FileState, savedSessionId: string, path: string) {
  return state.activeSavedSessionId === savedSessionId && state.path === path;
}

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
        ? state.transfers.map((item) => (item.id === task.id ? newerTransferTask(item, task) : item))
        : [task, ...state.transfers],
    };
  });
}
