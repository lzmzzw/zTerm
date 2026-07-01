// Author: Liz
import type { TransferEndpoint, TransferKind } from "./fileStore";
import { joinRemotePath, parentRemotePath, remoteFileName } from "./remotePath";

export function endpointFileName(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? "transfer";
}

export function joinEndpointPath(endpoint: TransferEndpoint, name: string) {
  if (endpoint.kind === "ssh") {
    return joinRemotePath(endpoint.path, name);
  }
  const separator = endpoint.path.includes("\\") ? "\\" : "/";
  return `${endpoint.path.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function parentEndpointPath(endpoint: TransferEndpoint) {
  if (endpoint.kind === "ssh") {
    return parentRemotePath(endpoint.path);
  }
  const normalized = endpoint.path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  if (index <= 0) return endpoint.path;
  return normalized.slice(0, index);
}

export function endpointDisplayPath(endpoint: TransferEndpoint | undefined, fallbackLocalPath: string) {
  if (!endpoint) return "";
  if (endpoint.kind === "local") return endpoint.path || fallbackLocalPath;
  return endpoint.path || "/";
}

export function legacyTransferSourcePath(task: {
  direction: "upload" | "download";
  local_path: string;
  remote_path: string;
}) {
  return task.direction === "upload" ? task.local_path : task.remote_path;
}

export function legacyTransferDestinationPath(task: {
  direction: "upload" | "download";
  local_path: string;
  remote_path: string;
}) {
  return task.direction === "upload" ? task.remote_path : task.local_path;
}

export function endpointTargetPath(destination: TransferEndpoint, sourcePath: string) {
  return joinEndpointPath(destination, endpointFileName(sourcePath) || remoteFileName(sourcePath));
}

export function transferKindFromFileKind(kind: string): TransferKind | null {
  if (kind === "file" || kind === "directory") return kind;
  return null;
}
