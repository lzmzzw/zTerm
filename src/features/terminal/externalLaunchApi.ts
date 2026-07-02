// Author: Liz
import { invoke } from "@tauri-apps/api/core";

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

export function isExternalSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("external:");
}
