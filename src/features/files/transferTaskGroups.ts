// Author: Liz
import type { FileEntry, TransferEndpoint, TransferTask } from "./fileStore";

export interface TransferSourcePlan {
  source: TransferEndpoint;
  destination: TransferEndpoint;
  kind: "file" | "directory";
}

export interface TransferTaskGroupMeta {
  groupId?: string;
  groupName?: string;
}

export interface TransferTaskGroup {
  id: string | null;
  name: string | null;
  tasks: TransferTask[];
}

export async function expandTransferPlans(
  plans: TransferSourcePlan[],
  listDirectory: (endpoint: TransferEndpoint) => Promise<FileEntry[]>,
): Promise<TransferSourcePlan[]> {
  const files: TransferSourcePlan[] = [];
  const pendingDirectories: TransferSourcePlan[] = [];

  for (const plan of plans) {
    if (plan.kind === "directory") pendingDirectories.push(plan);
    else files.push(plan);
  }

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift();
    if (!directory) break;
    const entries = await listDirectory(directory.source);
    for (const entry of entries) {
      if (entry.kind !== "file" && entry.kind !== "directory") continue;
      const child: TransferSourcePlan = {
        source: { ...directory.source, path: entry.path },
        destination: { ...directory.destination, path: joinEndpointPath(directory.destination.path, entry.name) },
        kind: entry.kind,
      };
      if (child.kind === "directory") pendingDirectories.push(child);
      else files.push(child);
    }
  }

  return files;
}

export function createTransferTaskGroupMeta(
  plans: TransferSourcePlan[],
  expandedPlans: TransferSourcePlan[],
  directionLabel: string,
): TransferTaskGroupMeta {
  const needsGroup = plans.length > 1 || plans.some((plan) => plan.kind === "directory");
  if (!needsGroup) return {};
  return {
    groupId: createGroupId(),
    groupName: `${directionLabel} ${expandedPlans.length} 个文件`,
  };
}

export function groupTransferTasks(tasks: TransferTask[]): TransferTaskGroup[] {
  const groups: TransferTaskGroup[] = [];
  const grouped = new Map<string, TransferTaskGroup>();
  for (const task of tasks) {
    const groupId = task.group_id?.trim() || null;
    if (!groupId) {
      groups.push({ id: null, name: null, tasks: [task] });
      continue;
    }
    const existing = grouped.get(groupId);
    if (existing) {
      existing.tasks.push(task);
      continue;
    }
    const group = { id: groupId, name: task.group_name?.trim() || "文件传输", tasks: [task] };
    grouped.set(groupId, group);
    groups.push(group);
  }
  return groups;
}

function joinEndpointPath(directory: string, name: string) {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function createGroupId() {
  return globalThis.crypto?.randomUUID?.() ?? `transfer-group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
