// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { SshOptions } from "../sessions/types";

export interface ExternalSshLaunchEvent {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auto_open_sftp: boolean;
  remote_path: string;
}

export async function takePendingExternalLaunches(): Promise<ExternalSshLaunchEvent[]> {
  return invoke<ExternalSshLaunchEvent[]>("external_launch_take_pending");
}

export async function getExternalSshOptions(sessionId: string): Promise<SshOptions> {
  return invoke<SshOptions>("external_launch_get_ssh_options", { sessionId });
}

export async function updateExternalSshOptions(sessionId: string, sshOptions: SshOptions): Promise<SshOptions> {
  return invoke<SshOptions>("external_launch_update_ssh_options", { sessionId, sshOptions });
}

export function isExternalSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("external:");
}
