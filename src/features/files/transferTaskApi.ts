// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { TransferTask } from "./fileTypes";

export function retryTransferTask(taskId: string) {
  return invoke<TransferTask>("transfer_retry", { taskId });
}

export function pauseTransferTask(taskId: string) {
  return invoke<TransferTask>("transfer_pause", { taskId });
}

export function resumeTransferTask(taskId: string) {
  return invoke<TransferTask>("transfer_resume", { taskId });
}

export function cancelTransferTask(taskId: string) {
  return invoke<TransferTask>("transfer_cancel", { taskId });
}

export async function deleteTransferTask(taskId: string) {
  await invoke("transfer_delete", { taskId });
}
