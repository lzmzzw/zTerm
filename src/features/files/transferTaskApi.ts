// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

import type { TransferTask } from "./fileTypes";

export function retryTransferTask(taskId: string) {
  return invokeTauri<TransferTask>("transfer_retry", { taskId });
}

export function pauseTransferTask(taskId: string) {
  return invokeTauri<TransferTask>("transfer_pause", { taskId });
}

export function resumeTransferTask(taskId: string) {
  return invokeTauri<TransferTask>("transfer_resume", { taskId });
}

export function cancelTransferTask(taskId: string) {
  return invokeTauri<TransferTask>("transfer_cancel", { taskId });
}

export async function deleteTransferTask(taskId: string) {
  await invokeTauri("transfer_delete", { taskId });
}
