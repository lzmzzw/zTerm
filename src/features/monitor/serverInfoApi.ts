// Author: Liz
import { invoke } from "@tauri-apps/api/core";

export const LOCAL_SERVER_INFO_TARGET_ID = "local-machine";

export interface ServerInfoSnapshot {
  host_id: string;
  host_name: string;
  host: string;
  port: number;
  username: string;
  hostname?: string | null;
  os?: string | null;
  architecture?: string | null;
  kernel?: string | null;
  uptime_seconds?: number | null;
  load_average?: number[] | null;
  cpu_usage_percent?: number | null;
  cpu_count?: number | null;
  cpu_model?: string | null;
  cpu_core_usage_percents: number[];
  process_count?: number | null;
  running_process_count?: number | null;
  memory_total_bytes?: number | null;
  memory_used_bytes?: number | null;
  memory_available_bytes?: number | null;
  memory_buffers_bytes?: number | null;
  memory_cached_bytes?: number | null;
  swap_total_bytes?: number | null;
  swap_used_bytes?: number | null;
  disk_total_bytes?: number | null;
  disk_used_bytes?: number | null;
  disk_available_bytes?: number | null;
  disk_mount?: string | null;
  disks: ServerDiskInfo[];
  network_rx_bytes?: number | null;
  network_tx_bytes?: number | null;
  network_interfaces: ServerNetworkInterfaceInfo[];
  top_processes: ServerProcessInfo[];
  gpu_probe_status?: string | null;
  gpus: ServerGpuInfo[];
  captured_at: string;
}

interface ServerDiskInfo {
  filesystem: string;
  mount: string;
  total_bytes?: number | null;
  used_bytes?: number | null;
  available_bytes?: number | null;
}

interface ServerNetworkInterfaceInfo {
  name: string;
  rx_bytes?: number | null;
  tx_bytes?: number | null;
}

interface ServerProcessInfo {
  pid: number;
  name: string;
  cpu_usage_percent?: number | null;
  memory_percent?: number | null;
  memory_bytes?: number | null;
}

interface ServerGpuInfo {
  name: string;
  vendor?: string | null;
  driver_version?: string | null;
  memory_total_bytes?: number | null;
  memory_used_bytes?: number | null;
  utilization_percent?: number | null;
  temperature_celsius?: number | null;
}

export async function getServerInfoSnapshot(targetId: string): Promise<ServerInfoSnapshot> {
  return invoke<ServerInfoSnapshot>("server_info_snapshot", {
    savedSessionId: targetId === LOCAL_SERVER_INFO_TARGET_ID ? null : targetId,
  });
}
