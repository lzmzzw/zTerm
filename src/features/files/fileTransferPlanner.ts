// Author: Liz
import type { FileEntry, LocalPathInfo, TransferConflictPolicy, TransferKind } from "./fileStore";
import { joinRemotePath, remoteFileName } from "./remotePath";

export interface PlannedUploadTransfer {
  localPath: string;
  remotePath: string;
  kind: TransferKind;
  conflictPolicy: TransferConflictPolicy;
}

export interface PlannedDownloadTransfer {
  remotePath: string;
  localPath: string;
  kind: TransferKind;
  conflictPolicy: TransferConflictPolicy;
}

export function buildUploadTransferPlans({
  currentRemotePath,
  localPaths,
  conflictPolicy = "overwrite",
}: {
  currentRemotePath: string;
  localPaths: LocalPathInfo[];
  conflictPolicy?: TransferConflictPolicy;
}): PlannedUploadTransfer[] {
  return localPaths.map((localPath) => ({
    localPath: localPath.path,
    remotePath: joinRemotePath(currentRemotePath, remoteFileName(localPath.path)),
    kind: localPath.kind,
    conflictPolicy,
  }));
}

export function buildDownloadTransferPlans({
  selectedEntries,
  localDirectory,
  conflictPolicy = "overwrite",
}: {
  selectedEntries: FileEntry[];
  localDirectory: string;
  conflictPolicy?: TransferConflictPolicy;
}): PlannedDownloadTransfer[] {
  return selectedEntries.flatMap((entry) => {
    const kind = transferKindFromEntry(entry);
    if (!kind) return [];
    return [
      {
        remotePath: entry.path,
        localPath: joinLocalPath(localDirectory, entry.name || remoteFileName(entry.path)),
        kind,
        conflictPolicy,
      },
    ];
  });
}

export function transferKindFromEntry(entry: FileEntry): TransferKind | null {
  if (entry.kind === "file" || entry.kind === "directory") return entry.kind;
  return null;
}

function joinLocalPath(directory: string, name: string) {
  const separator = directory.includes("\\") ? "\\" : "/";
  const trimmed = directory.replace(/[\\/]+$/, "");
  return `${trimmed}${separator}${name}`;
}
