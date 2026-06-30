// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ServerInfoRequest {
    pub saved_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ServerInfoSnapshot {
    pub host_id: String,
    pub host_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub architecture: Option<String>,
    pub kernel: Option<String>,
    pub uptime_seconds: Option<u64>,
    pub load_average: Option<[f64; 3]>,
    pub cpu_usage_percent: Option<f64>,
    pub cpu_count: Option<u64>,
    pub cpu_model: Option<String>,
    pub cpu_core_usage_percents: Vec<f64>,
    pub process_count: Option<u64>,
    pub running_process_count: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_available_bytes: Option<u64>,
    pub memory_buffers_bytes: Option<u64>,
    pub memory_cached_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
    pub disk_total_bytes: Option<u64>,
    pub disk_used_bytes: Option<u64>,
    pub disk_available_bytes: Option<u64>,
    pub disk_mount: Option<String>,
    pub disks: Vec<ServerDiskInfo>,
    pub network_rx_bytes: Option<u64>,
    pub network_tx_bytes: Option<u64>,
    pub network_interfaces: Vec<ServerNetworkInterfaceInfo>,
    pub top_processes: Vec<ServerProcessInfo>,
    pub gpu_probe_status: Option<String>,
    pub gpus: Vec<ServerGpuInfo>,
    pub captured_at: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ServerDiskInfo {
    pub filesystem: String,
    pub mount: String,
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ServerNetworkInterfaceInfo {
    pub name: String,
    pub rx_bytes: Option<u64>,
    pub tx_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ServerProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_usage_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    pub memory_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ServerGpuInfo {
    pub name: String,
    pub vendor: Option<String>,
    pub driver_version: Option<String>,
    pub memory_total_bytes: Option<u64>,
    pub memory_used_bytes: Option<u64>,
    pub utilization_percent: Option<f64>,
    pub temperature_celsius: Option<f64>,
}
