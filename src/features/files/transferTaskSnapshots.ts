// Author: Liz
import type { TransferTask } from "./fileTypes";

const terminalTransferStatuses = new Set<TransferTask["status"]>(["done", "failed", "cancelled"]);

export function newerTransferTask(current: TransferTask, incoming: TransferTask) {
  if (incoming.updated_at_ms > current.updated_at_ms) return incoming;
  if (incoming.updated_at_ms < current.updated_at_ms) return current;

  if (terminalTransferStatuses.has(current.status) && !terminalTransferStatuses.has(incoming.status)) {
    return current;
  }
  return incoming;
}

export function mergeTransferTaskList(current: TransferTask[], incoming: TransferTask[]) {
  const currentById = new Map(current.map((task) => [task.id, task]));
  return incoming.map((task) => {
    const existing = currentById.get(task.id);
    return existing ? newerTransferTask(existing, task) : task;
  });
}
