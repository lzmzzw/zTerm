// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

import type { FileEntry, TransferEndpoint } from "./fileTypes";

export function listTransferEndpoint(endpoint: TransferEndpoint) {
  return invokeTauri<FileEntry[]>("file_transfer_list_endpoint", { endpoint });
}
