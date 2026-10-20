// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

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
  return invokeTauri<SshContainerInfo[]>("ssh_container_list", payload);
}

export async function startSshContainer(
  savedSessionId: string,
  containerId: string,
  runtimeSessionId: string | null = null,
): Promise<void> {
  return invokeTauri<void>("ssh_container_start", { savedSessionId, containerId, runtimeSessionId });
}
