// Author: Liz
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import type {
  FileEntry,
  LocalPathInfo,
  TransferConflict,
  TransferConflictCheckItem,
  TransferConflictPolicy,
  TransferKind,
} from "../features/files/fileStore";
import { buildDownloadTransferPlans, buildUploadTransferPlans } from "../features/files/fileTransferPlanner";
import {
  createTransferTaskGroupMeta,
  expandTransferPlans,
  type TransferSourcePlan,
} from "../features/files/transferTaskGroups";
import { joinRemotePath, parentRemotePath, remoteFileName } from "../features/files/remotePath";

interface TextInputOptions {
  title: string;
  label: string;
  initialValue?: string;
  requiredMessage: string;
  confirmLabel?: string;
}

interface RemoteFileActionDependencies {
  activeSshSessionId: string | null;
  filePath: string;
  setFilePath: (path: string) => void;
  requestTextInput: (options: TextInputOptions) => Promise<string | null>;
  requestConflictPolicy: (conflicts: TransferConflict[]) => Promise<TransferConflictPolicy | null>;
  listFiles: (savedSessionId: string, path: string) => Promise<unknown> | unknown;
  mkdir: (savedSessionId: string, path: string) => Promise<unknown> | unknown;
  upload: (
    savedSessionId: string,
    localPath: string,
    remotePath: string,
    options?: {
      kind?: TransferKind;
      conflictPolicy?: TransferConflictPolicy;
      groupId?: string;
      groupName?: string;
    },
  ) => Promise<unknown> | unknown;
  download: (
    savedSessionId: string,
    remotePath: string,
    localPath: string,
    options?: {
      kind?: TransferKind;
      conflictPolicy?: TransferConflictPolicy;
      groupId?: string;
      groupName?: string;
    },
  ) => Promise<unknown> | unknown;
  deletePath: (savedSessionId: string, path: string, recursive: boolean) => Promise<unknown> | unknown;
  renamePath: (savedSessionId: string, from: string, to: string) => Promise<unknown> | unknown;
  classifyLocalPaths: (paths: string[]) => Promise<LocalPathInfo[]>;
  checkTransferConflicts: (savedSessionId: string, items: TransferConflictCheckItem[]) => Promise<TransferConflict[]>;
  listTransferEndpoint?: (endpoint: TransferSourcePlan["source"]) => Promise<FileEntry[]>;
  selectUploadPaths?: () => Promise<string[]>;
  selectDownloadDirectory?: () => Promise<string | null>;
}

export function createRemoteFileActions({
  activeSshSessionId,
  filePath,
  setFilePath,
  requestTextInput,
  requestConflictPolicy,
  listFiles,
  mkdir,
  upload,
  download,
  deletePath,
  renamePath,
  classifyLocalPaths,
  checkTransferConflicts,
  listTransferEndpoint = defaultListTransferEndpoint,
  selectUploadPaths = defaultSelectUploadPaths,
  selectDownloadDirectory = defaultSelectDownloadDirectory,
}: RemoteFileActionDependencies) {
  async function refreshFiles(path = filePath) {
    if (activeSshSessionId) {
      await listFiles(activeSshSessionId, path);
    }
  }

  async function openDirectory(path: string) {
    setFilePath(path);
    await refreshFiles(path);
  }

  async function openParentDirectory() {
    await openDirectory(parentRemotePath(filePath));
  }

  async function createRemoteDirectory() {
    if (!activeSshSessionId) return;
    const path = await requestTextInput({
      title: "新建文件夹",
      label: "文件夹路径",
      initialValue: joinRemotePath(filePath, "new-folder"),
      requiredMessage: "请填写文件夹路径",
    });
    if (!path) return;
    await mkdir(activeSshSessionId, path);
  }

  async function uploadPath() {
    if (!activeSshSessionId) return;
    const paths = await selectUploadPaths();
    await uploadLocalPaths(paths);
  }

  async function uploadLocalPaths(paths: string[]) {
    if (!activeSshSessionId || paths.length === 0) return;
    const localPaths = await classifyLocalPaths(paths);
    if (localPaths.length === 0) return;
    const initialPlans = buildUploadTransferPlans({ currentRemotePath: filePath, localPaths });
    const sourcePlans: TransferSourcePlan[] = initialPlans.map((plan) => ({
      source: { kind: "local", saved_session_id: null, path: plan.localPath },
      destination: { kind: "saved_session", saved_session_id: activeSshSessionId, path: plan.remotePath },
      kind: plan.kind,
    }));
    const expandedPlans = await expandTransferPlans(sourcePlans, listTransferEndpoint);
    if (expandedPlans.length === 0) return;
    const conflictPlans = expandedPlans.map((plan) => ({
      localPath: plan.source.path,
      remotePath: plan.destination.path,
      kind: plan.kind,
      conflictPolicy: "overwrite" as const,
    }));
    const conflictPolicy = await resolveConflictPolicy(activeSshSessionId, "upload", conflictPlans);
    if (!conflictPolicy) return;
    const groupMeta = createTransferTaskGroupMeta(sourcePlans, expandedPlans, "上传");
    for (const plan of expandedPlans) {
      await upload(activeSshSessionId, plan.source.path, plan.destination.path, {
        kind: "file",
        conflictPolicy,
        ...groupMeta,
      });
    }
  }

  async function downloadRemotePaths(entries: FileEntry[]) {
    if (!activeSshSessionId) return;
    const localDirectory = await selectDownloadDirectory();
    if (!localDirectory) return;
    const initialPlans = buildDownloadTransferPlans({ selectedEntries: entries, localDirectory });
    if (initialPlans.length === 0) return;
    const sourcePlans: TransferSourcePlan[] = initialPlans.map((plan) => ({
      source: { kind: "saved_session", saved_session_id: activeSshSessionId, path: plan.remotePath },
      destination: { kind: "local", saved_session_id: null, path: plan.localPath },
      kind: plan.kind,
    }));
    const expandedPlans = await expandTransferPlans(sourcePlans, listTransferEndpoint);
    if (expandedPlans.length === 0) return;
    const conflictPlans = expandedPlans.map((plan) => ({
      remotePath: plan.source.path,
      localPath: plan.destination.path,
      kind: plan.kind,
      conflictPolicy: "overwrite" as const,
    }));
    const conflictPolicy = await resolveConflictPolicy(activeSshSessionId, "download", conflictPlans);
    if (!conflictPolicy) return;
    const groupMeta = createTransferTaskGroupMeta(sourcePlans, expandedPlans, "下载");
    for (const plan of expandedPlans) {
      await download(activeSshSessionId, plan.source.path, plan.destination.path, {
        kind: "file",
        conflictPolicy,
        ...groupMeta,
      });
    }
  }

  async function renameRemotePath(from: string) {
    if (!activeSshSessionId) return;
    const nextName = await requestTextInput({
      title: "重命名",
      label: "重命名为",
      initialValue: remoteFileName(from),
      requiredMessage: "请填写新名称",
    });
    if (!nextName) return;
    const to = joinRemotePath(parentRemotePath(from), nextName);
    if (to === from) return;
    await renamePath(activeSshSessionId, from, to);
  }

  async function deleteRemotePaths(paths: string[], recursive: boolean) {
    if (!activeSshSessionId) return;
    for (const path of paths) {
      await deletePath(activeSshSessionId, path, recursive);
    }
  }

  return {
    refreshFiles,
    openDirectory,
    openParentDirectory,
    createRemoteDirectory,
    uploadPath,
    uploadLocalPaths,
    downloadRemotePaths,
    renameRemotePath,
    deleteRemotePaths,
  };

  async function resolveConflictPolicy(
    savedSessionId: string,
    direction: "upload" | "download",
    plans: Array<{ localPath: string; remotePath: string; kind: TransferKind; conflictPolicy: TransferConflictPolicy }>,
  ) {
    const conflicts = await checkTransferConflicts(
      savedSessionId,
      plans.map((plan) => ({
        direction,
        localPath: plan.localPath,
        remotePath: plan.remotePath,
        kind: plan.kind,
      })),
    );
    if (conflicts.length === 0) return "overwrite" satisfies TransferConflictPolicy;
    return requestConflictPolicy(conflicts);
  }
}

async function defaultSelectUploadPaths() {
  const selected = await open({
    title: "选择要上传的文件或文件夹",
    multiple: true,
    directory: false,
  });
  return normalizeDialogSelection(selected);
}

async function defaultSelectDownloadDirectory() {
  const selected = await open({
    title: "选择下载目录",
    multiple: false,
    directory: true,
  });
  return typeof selected === "string" ? selected : null;
}

function defaultListTransferEndpoint(endpoint: TransferSourcePlan["source"]) {
  return invoke<FileEntry[]>("file_transfer_list_endpoint", { endpoint });
}

function normalizeDialogSelection(selected: string | string[] | null) {
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}
