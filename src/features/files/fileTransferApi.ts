// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { FileEntry, TransferEndpoint } from "./fileTypes";

export function listTransferEndpoint(endpoint: TransferEndpoint) {
  return invoke<FileEntry[]>("file_transfer_list_endpoint", { endpoint });
}
