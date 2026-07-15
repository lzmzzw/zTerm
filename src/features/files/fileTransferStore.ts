// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";
import type {
  FileEntry,
  TransferConflictPolicy,
  TransferEndpoint,
  TransferKind,
  TransferTask,
} from "./fileStore";
import { nextSelectedFilePaths, type FileSelectionEvent } from "./fileSelectionModel";

export type FileTransferSide = "left" | "right";

interface FileTransferPaneState {
  endpoint: TransferEndpoint;
  entries: FileEntry[];
  selectedPaths: string[];
  selectionAnchorPath: string | null;
  loading: boolean;
  error: string | null;
}

interface TransferEndpointConflict {
  path: string;
}

interface TransferEndpointConflictCheckItem {
  destination: TransferEndpoint;
  kind: TransferKind;
}

interface FileTransferState {
  left: FileTransferPaneState;
  right: FileTransferPaneState;
  transfers: TransferTask[];
  transferLoading: boolean;
  transferError: string | null;
  conflictPolicy: TransferConflictPolicy;
  defaultLocalPath: string;
  localRoots: string[];
  loadDefaultLocalPath: () => Promise<string>;
  loadLocalRoots: () => Promise<string[]>;
  setConflictPolicy: (policy: TransferConflictPolicy) => void;
  setEndpoint: (side: FileTransferSide, endpoint: TransferEndpoint) => void;
  setPath: (side: FileTransferSide, path: string) => void;
  prepareForSession: (savedSessionId: string, remotePath?: string) => Promise<void>;
  selectPath: (side: FileTransferSide, path: string | null, event?: FileSelectionEvent) => void;
  selectPaths: (side: FileTransferSide, paths: string[]) => void;
  loadEndpoint: (side: FileTransferSide) => Promise<void>;
  renameEndpoint: (side: FileTransferSide, from: string, to: string) => Promise<void>;
  deleteEndpoint: (side: FileTransferSide, paths: string[], recursive: boolean) => Promise<void>;
  checkConflicts: (items: TransferEndpointConflictCheckItem[]) => Promise<TransferEndpointConflict[]>;
  enqueueTransfer: (
    source: TransferEndpoint,
    destination: TransferEndpoint,
    options?: { kind?: TransferKind; conflictPolicy?: TransferConflictPolicy },
  ) => Promise<TransferTask>;
  loadTransfers: () => Promise<void>;
  retryTransfer: (taskId: string) => Promise<void>;
  pauseTransfer: (taskId: string) => Promise<void>;
  resumeTransfer: (taskId: string) => Promise<void>;
  cancelTransfer: (taskId: string) => Promise<void>;
  deleteTransfer: (taskId: string) => Promise<void>;
  pauseTransfers: (taskIds: string[]) => Promise<void>;
  resumeTransfers: (taskIds: string[]) => Promise<void>;
  clearTransfers: (taskIds?: string[]) => Promise<void>;
  bindTransferEvents: () => Promise<UnlistenFn>;
}

let localPathRequest: Promise<string> | null = null;
let leftRequestId = 0;
let rightRequestId = 0;
let transferListRequestId = 0;
const deletedTransferIds = new Set<string>();

const initialLeft: FileTransferPaneState = {
  endpoint: { kind: "local", saved_session_id: null, path: "" },
  entries: [],
  selectedPaths: [],
  selectionAnchorPath: null,
  loading: false,
  error: null,
};

const initialRight: FileTransferPaneState = {
  endpoint: { kind: "saved_session", saved_session_id: null, path: "/" },
  entries: [],
  selectedPaths: [],
  selectionAnchorPath: null,
  loading: false,
  error: null,
};

export const useFileTransferStore = create<FileTransferState>((set, get) => ({
  left: initialLeft,
  right: initialRight,
  transfers: [],
  transferLoading: false,
  transferError: null,
  conflictPolicy: "overwrite",
  defaultLocalPath: "",
  localRoots: [],
  async loadDefaultLocalPath() {
    if (!localPathRequest) {
      localPathRequest = invoke<string>("file_transfer_default_local_path");
    }
    try {
      const path = await localPathRequest;
      set({ defaultLocalPath: path });
      return path;
    } catch (error) {
      localPathRequest = null;
      set({ transferError: fileTransferErrorMessage(error) });
      return "";
    }
  },
  async loadLocalRoots() {
    try {
      const roots = await invoke<string[]>("file_transfer_local_roots");
      set({ localRoots: roots });
      return roots;
    } catch (error) {
      set({ transferError: fileTransferErrorMessage(error) });
      return [];
    }
  },
  setConflictPolicy: (policy) => set({ conflictPolicy: policy }),
  setEndpoint(side, endpoint) {
    updatePane(set, side, {
      endpoint,
      entries: [],
      selectedPaths: [],
      selectionAnchorPath: null,
      error: null,
    });
  },
  setPath(side, path) {
    updatePane(set, side, (pane) => ({ endpoint: { ...pane.endpoint, path } }));
  },
  async prepareForSession(savedSessionId, remotePath = "/") {
    const defaultLocalPath = get().defaultLocalPath || (await get().loadDefaultLocalPath());
    get().setEndpoint("left", { kind: "local", saved_session_id: null, path: defaultLocalPath });
    get().setEndpoint("right", { kind: "saved_session", saved_session_id: savedSessionId, path: remotePath || "/" });
    await Promise.all([get().loadEndpoint("left"), get().loadEndpoint("right")]);
  },
  selectPath(side, path, event) {
    if (!path) {
      updatePane(set, side, { selectedPaths: [], selectionAnchorPath: null });
      return;
    }
    const pane = get()[side];
    const selectedPaths = nextSelectedFilePaths(pane.entries, pane.selectedPaths, pane.selectionAnchorPath, path, event);
    updatePane(set, side, { selectedPaths, selectionAnchorPath: event?.shiftKey ? pane.selectionAnchorPath : path });
  },
  selectPaths(side, paths) {
    updatePane(set, side, { selectedPaths: paths, selectionAnchorPath: paths.at(-1) ?? null });
  },
  async loadEndpoint(side) {
    const requestId = nextPaneRequestId(side);
    let endpoint = get()[side].endpoint;
    if (endpoint.kind === "local" && !endpoint.path.trim()) {
      const defaultLocalPath = await get().loadDefaultLocalPath();
      endpoint = { ...endpoint, path: defaultLocalPath };
      if (!isCurrentPaneRequest(side, requestId)) return;
      updatePane(set, side, (pane) => ({ endpoint: { ...pane.endpoint, path: defaultLocalPath } }));
    }
    if (endpoint.kind === "saved_session" && !endpoint.saved_session_id) {
      updatePane(set, side, { entries: [], selectedPaths: [], loading: false, error: null });
      return;
    }
    updatePane(set, side, { loading: true, error: null });
    try {
      const entries = await invoke<FileEntry[]>("file_transfer_list_endpoint", { endpoint });
      if (!isCurrentPaneRequest(side, requestId)) return;
      updatePane(set, side, {
        entries,
        loading: false,
        selectedPaths: [],
        selectionAnchorPath: null,
        error: null,
      });
    } catch (error) {
      if (isCurrentPaneRequest(side, requestId)) {
        updatePane(set, side, { loading: false, error: fileTransferErrorMessage(error) });
      }
    }
  },
  async renameEndpoint(side, from, to) {
    const endpoint = { ...get()[side].endpoint, path: from };
    try {
      await invoke("file_transfer_rename_endpoint", { endpoint, to });
      await get().loadEndpoint(side);
    } catch (error) {
      updatePane(set, side, { error: fileTransferErrorMessage(error) });
    }
  },
  async deleteEndpoint(side, paths, recursive) {
    const paneEndpoint = get()[side].endpoint;
    let operationError: unknown = null;
    try {
      for (const path of paths) {
        await invoke("file_transfer_delete_endpoint", {
          endpoint: { ...paneEndpoint, path },
          recursive,
        });
      }
    } catch (error) {
      operationError = error;
    }
    await get().loadEndpoint(side);
    if (operationError) updatePane(set, side, { error: fileTransferErrorMessage(operationError) });
  },
  checkConflicts(items) {
    return invoke<TransferEndpointConflict[]>("file_transfer_check_conflicts", { items });
  },
  async enqueueTransfer(source, destination, options = {}) {
    const task = await invoke<TransferTask>("file_transfer_enqueue", {
      source,
      destination,
      kind: options.kind,
      conflictPolicy: options.conflictPolicy,
    });
    upsertTransfer(set, task);
    return task;
  },
  async loadTransfers() {
    const requestId = transferListRequestId + 1;
    transferListRequestId = requestId;
    set({ transferLoading: true, transferError: null });
    try {
      const transfers = await invoke<TransferTask[]>("file_transfer_list", { limit: 200 });
      if (transferListRequestId === requestId) {
        set({ transfers, transferLoading: false });
      }
    } catch (error) {
      if (transferListRequestId === requestId) {
        set({ transferLoading: false, transferError: fileTransferErrorMessage(error) });
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
  async pauseTransfers(taskIds) {
    for (const taskId of taskIds) {
      await get().pauseTransfer(taskId);
    }
  },
  async resumeTransfers(taskIds) {
    for (const taskId of taskIds) {
      await get().resumeTransfer(taskId);
    }
  },
  async clearTransfers(taskIds) {
    const ids = taskIds ?? get().transfers.map((task) => task.id);
    for (const taskId of ids) {
      await invoke("transfer_delete", { taskId });
      deletedTransferIds.add(taskId);
    }
    set((state) => ({ transfers: state.transfers.filter((task) => !ids.includes(task.id)) }));
  },
  async bindTransferEvents() {
    try {
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
    } catch (error) {
      set({ transferError: fileTransferErrorMessage(error) });
      return () => {};
    }
  },
}));

type FileTransferSet = (
  partial: Partial<FileTransferState> | ((state: FileTransferState) => Partial<FileTransferState>),
) => void;

function updatePane(
  set: FileTransferSet,
  side: FileTransferSide,
  update: Partial<FileTransferPaneState> | ((pane: FileTransferPaneState) => Partial<FileTransferPaneState>),
) {
  set((state) => {
    const pane = state[side];
    const next = typeof update === "function" ? update(pane) : update;
    return { [side]: { ...pane, ...next } };
  });
}

function nextPaneRequestId(side: FileTransferSide) {
  if (side === "left") {
    leftRequestId += 1;
    return leftRequestId;
  }
  rightRequestId += 1;
  return rightRequestId;
}

function isCurrentPaneRequest(side: FileTransferSide, requestId: number) {
  return side === "left" ? leftRequestId === requestId : rightRequestId === requestId;
}

function upsertTransfer(set: FileTransferSet, task: TransferTask) {
  if (deletedTransferIds.has(task.id)) return;
  set((state) => {
    const exists = state.transfers.some((item) => item.id === task.id);
    return {
      transfers: exists
        ? state.transfers.map((item) => (item.id === task.id ? task : item))
        : [task, ...state.transfers],
    };
  });
}

function fileTransferErrorMessage(error: unknown) {
  const message = unknownErrorMessage(error, "文件传输操作失败");
  if (message.includes("reading 'invoke'") || message.includes("transformCallback")) {
    return "文件传输需要 Tauri 运行环境";
  }
  return message;
}
