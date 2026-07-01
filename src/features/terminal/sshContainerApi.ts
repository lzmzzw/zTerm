// Author: Liz
import { invoke } from "@tauri-apps/api/core";

export interface SshContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  running: boolean;
}

export async function listSshContainers(savedSessionId: string): Promise<SshContainerInfo[]> {
  return invoke<SshContainerInfo[]>("ssh_container_list", { savedSessionId });
}
