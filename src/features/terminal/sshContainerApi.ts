// Author: Liz
import { invoke } from "@tauri-apps/api/core";

export interface SshContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
}

export async function listSshContainers(
  savedSessionId: string,
  options: { runtimeSessionId?: string | null } = {},
): Promise<SshContainerInfo[]> {
  const payload: { savedSessionId: string; runtimeSessionId?: string } = { savedSessionId };
  if (options.runtimeSessionId) {
    payload.runtimeSessionId = options.runtimeSessionId;
  }
  return invoke<SshContainerInfo[]>("ssh_container_list", payload);
}
