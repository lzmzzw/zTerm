// Author: Liz
import { open } from "@tauri-apps/plugin-dialog";

import type {
  FileEntry,
  LocalPathInfo,
  TransferConflict,
  TransferConflictCheckItem,
  TransferConflictPolicy,
  TransferKind,
} from "../features/files/fileStore";
import { buildDownloadTransferPlans, buildUploadTransferPlans } from "../features/files/fileTransferPlanner";
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
    options?: { kind?: TransferKind; conflictPolicy?: TransferConflictPolicy },
  ) => Promise<unknown> | unknown;
  download: (
    savedSessionId: string,
    remotePath: string,
    localPath: string,
    options?: { kind?: TransferKind; conflictPolicy?: TransferConflictPolicy },
  ) => Promise<unknown> | unknown;
  deletePath: (savedSessionId: string, path: string, recursive: boolean) => Promise<unknown> | unknown;
  renamePath: (savedSessionId: string, from: string, to: string) => Promise<unknown> | unknown;
  classifyLocalPaths: (paths: string[]) => Promise<LocalPathInfo[]>;
  checkTransferConflicts: (savedSessionId: string, items: TransferConflictCheckItem[]) => Promise<TransferConflict[]>;
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
    const conflictPolicy = await resolveConflictPolicy(activeSshSessionId, "upload", initialPlans);
    if (!conflictPolicy) return;
    const plans =
      conflictPolicy === "overwrite"
        ? initialPlans
        : buildUploadTransferPlans({ currentRemotePath: filePath, localPaths, conflictPolicy });
    for (const plan of plans) {
      await upload(activeSshSessionId, plan.localPath, plan.remotePath, {
        kind: plan.kind,
        conflictPolicy: plan.conflictPolicy,
      });
    }
  }

  async function downloadRemotePaths(entries: FileEntry[]) {
    if (!activeSshSessionId) return;
    const localDirectory = await selectDownloadDirectory();
    if (!localDirectory) return;
    const initialPlans = buildDownloadTransferPlans({ selectedEntries: entries, localDirectory });
    if (initialPlans.length === 0) return;
    const conflictPolicy = await resolveConflictPolicy(activeSshSessionId, "download", initialPlans);
    if (!conflictPolicy) return;
    const plans =
      conflictPolicy === "overwrite"
        ? initialPlans
        : buildDownloadTransferPlans({ selectedEntries: entries, localDirectory, conflictPolicy });
    for (const plan of plans) {
      await download(activeSshSessionId, plan.remotePath, plan.localPath, {
        kind: plan.kind,
        conflictPolicy: plan.conflictPolicy,
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

function normalizeDialogSelection(selected: string | string[] | null) {
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}
