// Author: Liz
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::{
    error::{AppError, AppResult},
    models::{
        server_info::{
            ServerDiskInfo, ServerGpuInfo, ServerInfoRequest, ServerInfoSnapshot,
            ServerNetworkInterfaceInfo, ServerProcessInfo,
        },
        session::{SavedSession, SessionType},
    },
    services::{credential_service::CredentialService, ssh_command_service::SshCommandService},
    storage::{
        sessions::{get_session, list_sessions},
        sqlite::SqliteStore,
    },
};

#[derive(Clone, Default)]
pub struct ServerInfoService;

impl ServerInfoService {
    pub fn new() -> Self {
        Self
    }

    pub async fn snapshot(
        &self,
        store: &SqliteStore,
        ssh_commands: SshCommandService,
        credential_service: CredentialService,
        request: ServerInfoRequest,
    ) -> AppResult<ServerInfoSnapshot> {
        let session = get_session(store, &request.saved_session_id)?;
        if session.session_type != SessionType::Ssh {
            return Err(AppError::unsupported("资源监控只支持 SSH 会话"));
        }
        let all_sessions = list_sessions(store)?.sessions;
        let output = ssh_commands
            .execute_reusable(
                "server_info",
                &session,
                &all_sessions,
                SERVER_INFO_SCRIPT.to_string(),
                &credential_service,
            )
            .await?;
        if !output.success {
            let detail = if output.stderr.trim().is_empty() {
                output.stdout.trim()
            } else {
                output.stderr.trim()
            };
            return Err(AppError::ssh(if detail.is_empty() {
                "服务器信息采集失败".to_string()
            } else {
                detail.to_string()
            }));
        }
        Ok(parse_server_info_output(
            &session,
            &output.stdout,
            unix_timestamp(),
        ))
    }
}

pub fn parse_server_info_output(
    session: &SavedSession,
    stdout: &str,
    captured_at: String,
) -> ServerInfoSnapshot {
    let values = key_value_lines(stdout);
    ServerInfoSnapshot {
        host_id: session.id.clone(),
        host_name: session.name.clone(),
        host: session.host.clone(),
        port: session.port,
        username: session.username.clone(),
        hostname: optional_text(&values, "hostname"),
        os: optional_text(&values, "os"),
        architecture: optional_text(&values, "architecture"),
        kernel: optional_text(&values, "kernel"),
        uptime_seconds: parse_u64(&values, "uptime_seconds"),
        load_average: parse_load_average(&values),
        cpu_usage_percent: parse_f64(&values, "cpu_usage_percent"),
        cpu_count: parse_u64(&values, "cpu_count"),
        cpu_model: optional_text(&values, "cpu_model"),
        cpu_core_usage_percents: parse_indexed_f64(&values, "cpu_core_", "_usage_percent"),
        process_count: parse_u64(&values, "process_count"),
        running_process_count: parse_u64(&values, "running_process_count"),
        memory_total_bytes: parse_u64(&values, "memory_total_bytes"),
        memory_used_bytes: parse_u64(&values, "memory_used_bytes"),
        memory_available_bytes: parse_u64(&values, "memory_available_bytes"),
        memory_buffers_bytes: parse_u64(&values, "memory_buffers_bytes"),
        memory_cached_bytes: parse_u64(&values, "memory_cached_bytes"),
        swap_total_bytes: parse_u64(&values, "swap_total_bytes"),
        swap_used_bytes: parse_u64(&values, "swap_used_bytes"),
        disk_total_bytes: parse_u64(&values, "disk_total_bytes"),
        disk_used_bytes: parse_u64(&values, "disk_used_bytes"),
        disk_available_bytes: parse_u64(&values, "disk_available_bytes"),
        disk_mount: optional_text(&values, "disk_mount"),
        disks: parse_disks(&values),
        network_rx_bytes: parse_u64(&values, "network_rx_bytes"),
        network_tx_bytes: parse_u64(&values, "network_tx_bytes"),
        network_interfaces: parse_network_interfaces(&values),
        top_processes: parse_processes(&values),
        gpu_probe_status: optional_text(&values, "gpu_probe_status"),
        gpus: parse_gpus(&values),
        captured_at,
    }
}

fn key_value_lines(stdout: &str) -> HashMap<String, String> {
    stdout
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .filter(|(key, _)| !key.is_empty())
        .collect()
}

fn optional_text(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_u64(values: &HashMap<String, String>, key: &str) -> Option<u64> {
    let value = values.get(key)?;
    value
        .split_once('.')
        .map(|(integer, _)| integer)
        .unwrap_or(value)
        .parse()
        .ok()
}

fn parse_u32(values: &HashMap<String, String>, key: &str) -> Option<u32> {
    parse_u64(values, key).and_then(|value| u32::try_from(value).ok())
}

fn parse_f64(values: &HashMap<String, String>, key: &str) -> Option<f64> {
    values.get(key)?.parse().ok()
}

fn parse_load_average(values: &HashMap<String, String>) -> Option<[f64; 3]> {
    let parts = values
        .get("load_average")?
        .split_whitespace()
        .filter_map(|part| part.parse::<f64>().ok())
        .collect::<Vec<_>>();
    if parts.len() < 3 {
        None
    } else {
        Some([parts[0], parts[1], parts[2]])
    }
}

fn parse_indexed_f64(values: &HashMap<String, String>, prefix: &str, suffix: &str) -> Vec<f64> {
    let mut entries = values
        .keys()
        .filter_map(|key| {
            let index = key.strip_prefix(prefix)?.strip_suffix(suffix)?;
            index.parse::<usize>().ok().map(|index| (index, key))
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(index, _)| *index);
    entries
        .into_iter()
        .filter_map(|(_, key)| values.get(key)?.parse::<f64>().ok())
        .collect()
}

fn parse_disks(values: &HashMap<String, String>) -> Vec<ServerDiskInfo> {
    indexed_rows(values, "disk_", "mount")
        .into_iter()
        .filter_map(|index| {
            let prefix = format!("disk_{index}_");
            Some(ServerDiskInfo {
                filesystem: optional_text(values, &format!("{prefix}filesystem"))
                    .unwrap_or_else(|| "-".to_string()),
                mount: optional_text(values, &format!("{prefix}mount"))?,
                total_bytes: parse_u64(values, &format!("{prefix}total_bytes")),
                used_bytes: parse_u64(values, &format!("{prefix}used_bytes")),
                available_bytes: parse_u64(values, &format!("{prefix}available_bytes")),
            })
        })
        .collect()
}

fn parse_network_interfaces(values: &HashMap<String, String>) -> Vec<ServerNetworkInterfaceInfo> {
    indexed_rows(values, "network_interface_", "name")
        .into_iter()
        .filter_map(|index| {
            let prefix = format!("network_interface_{index}_");
            Some(ServerNetworkInterfaceInfo {
                name: optional_text(values, &format!("{prefix}name"))?,
                rx_bytes: parse_u64(values, &format!("{prefix}rx_bytes")),
                tx_bytes: parse_u64(values, &format!("{prefix}tx_bytes")),
            })
        })
        .collect()
}

fn parse_processes(values: &HashMap<String, String>) -> Vec<ServerProcessInfo> {
    indexed_rows(values, "process_", "pid")
        .into_iter()
        .filter_map(|index| {
            let prefix = format!("process_{index}_");
            Some(ServerProcessInfo {
                pid: parse_u32(values, &format!("{prefix}pid"))?,
                name: optional_text(values, &format!("{prefix}name"))?,
                cpu_usage_percent: parse_f64(values, &format!("{prefix}cpu_usage_percent")),
                memory_percent: parse_f64(values, &format!("{prefix}memory_percent")),
                memory_bytes: parse_u64(values, &format!("{prefix}memory_bytes")),
            })
        })
        .collect()
}

fn parse_gpus(values: &HashMap<String, String>) -> Vec<ServerGpuInfo> {
    indexed_rows(values, "gpu_", "name")
        .into_iter()
        .filter_map(|index| {
            let prefix = format!("gpu_{index}_");
            Some(ServerGpuInfo {
                name: optional_text(values, &format!("{prefix}name"))?,
                vendor: optional_text(values, &format!("{prefix}vendor")),
                driver_version: optional_text(values, &format!("{prefix}driver_version")),
                memory_total_bytes: parse_u64(values, &format!("{prefix}memory_total_bytes")),
                memory_used_bytes: parse_u64(values, &format!("{prefix}memory_used_bytes")),
                utilization_percent: parse_f64(values, &format!("{prefix}utilization_percent")),
                temperature_celsius: parse_f64(values, &format!("{prefix}temperature_celsius")),
            })
        })
        .collect()
}

fn indexed_rows(values: &HashMap<String, String>, prefix: &str, marker_field: &str) -> Vec<usize> {
    let mut indices = values
        .keys()
        .filter_map(|key| {
            let rest = key.strip_prefix(prefix)?;
            let (index, field) = rest.split_once('_')?;
            if field == marker_field {
                index.parse::<usize>().ok()
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    indices.sort_unstable();
    indices.dedup();
    indices
}

fn unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

const SERVER_INFO_SCRIPT: &str = r#"
printf 'hostname=%s\n' "$(hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then
  os_pretty="$(awk -F= '/^PRETTY_NAME=/ { value=$2; gsub(/^"/, "", value); gsub(/"$/, "", value); print value; exit }' /etc/os-release 2>/dev/null)"
fi
if [ -n "$os_pretty" ]; then printf 'os=%s\n' "$os_pretty"; else printf 'os=%s\n' "$(uname -s 2>/dev/null)"; fi
printf 'architecture=%s\n' "$(uname -m 2>/dev/null)"
printf 'kernel=%s\n' "$(uname -r 2>/dev/null)"
if [ -r /proc/uptime ]; then awk '{ printf "uptime_seconds=%s\n", $1 }' /proc/uptime; fi
if [ -r /proc/loadavg ]; then awk '{ printf "load_average=%s %s %s\n", $1, $2, $3 }' /proc/loadavg; fi
cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"
if [ -n "$cpu_count" ]; then printf 'cpu_count=%s\n' "$cpu_count"; fi
if [ -r /proc/cpuinfo ]; then
  awk -F: '/^(model name|Hardware|Processor)[[:space:]]*:/ { value=$2; sub(/^[[:space:]]+/, "", value); if (value != "") { printf "cpu_model=%s\n", value; exit } }' /proc/cpuinfo
fi
if [ -r /proc/stat ]; then
  read_cpu_snapshot() {
    awk '/^cpu[0-9]* / { total=0; for (i=2; i<=NF; i++) total += $i; idle=$5 + $6; printf "%s %s %s\n", $1, idle, total }' /proc/stat
  }
  { read_cpu_snapshot; printf "__ZTERM_CPU_AFTER__\n"; sleep 0.12 2>/dev/null || sleep 1; read_cpu_snapshot; } | awk '
    $1 == "__ZTERM_CPU_AFTER__" { after=1; next }
    after != 1 { before_idle[$1]=$2; before_total[$1]=$3; next }
    { key=$1; if (!(key in before_total)) next; idle=$2-before_idle[key]; total=$3-before_total[key]; if (total <= 0) next; usage=(total-idle)*100/total; if (key == "cpu") printf "cpu_usage_percent=%.2f\n", usage; else if (key ~ /^cpu[0-9]+$/) { core_index=substr(key, 4); printf "cpu_core_%s_usage_percent=%.2f\n", core_index, usage } }'
fi
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/ { mt=$2*1024 } /^MemAvailable:/ { ma=$2*1024 } /^Buffers:/ { mb=$2*1024 } /^Cached:/ { mc=$2*1024 } /^SwapTotal:/ { st=$2*1024 } /^SwapFree:/ { sf=$2*1024 } END { if (mt > 0) { printf "memory_total_bytes=%.0f\nmemory_used_bytes=%.0f\nmemory_available_bytes=%.0f\nmemory_buffers_bytes=%.0f\nmemory_cached_bytes=%.0f\n", mt, mt-ma, ma, mb, mc } if (st >= 0) printf "swap_total_bytes=%.0f\nswap_used_bytes=%.0f\n", st, st-sf }' /proc/meminfo
fi
df -Pk / 2>/dev/null | awk 'NR==2 { printf "disk_total_bytes=%.0f\n", $2*1024; printf "disk_used_bytes=%.0f\n", $3*1024; printf "disk_available_bytes=%.0f\n", $4*1024; printf "disk_mount=%s\n", $6 }'
df -Pk 2>/dev/null | awk 'NR > 1 { if ($1 == "tmpfs" || $1 == "devtmpfs") next; printf "disk_%d_filesystem=%s\n", idx, $1; printf "disk_%d_total_bytes=%.0f\n", idx, $2*1024; printf "disk_%d_used_bytes=%.0f\n", idx, $3*1024; printf "disk_%d_available_bytes=%.0f\n", idx, $4*1024; printf "disk_%d_mount=%s\n", idx, $6; idx++ }'
if [ -r /proc/net/dev ]; then
  awk 'NR > 2 { split($0, parts, ":"); name=parts[1]; sub(/^[[:space:]]+/, "", name); sub(/[[:space:]]+$/, "", name); split(parts[2], fields, /[[:space:]]+/); rx += fields[1]; tx += fields[9]; printf "network_interface_%d_name=%s\n", idx, name; printf "network_interface_%d_rx_bytes=%.0f\n", idx, fields[1]; printf "network_interface_%d_tx_bytes=%.0f\n", idx, fields[9]; idx++ } END { printf "network_rx_bytes=%.0f\nnetwork_tx_bytes=%.0f\n", rx, tx }' /proc/net/dev
fi
if command -v ps >/dev/null 2>&1; then
  ps -eo stat= 2>/dev/null | awk '{ count++; if ($1 ~ /^R/) running++ } END { if (count > 0) printf "process_count=%d\nrunning_process_count=%d\n", count, running }'
  ps -eo pid=,comm=,pcpu=,pmem=,rss= 2>/dev/null | sort -k3 -nr 2>/dev/null | awk 'NF >= 5 { printf "process_%d_pid=%s\nprocess_%d_name=%s\nprocess_%d_cpu_usage_percent=%s\nprocess_%d_memory_percent=%s\nprocess_%d_memory_bytes=%.0f\n", idx, $1, idx, $2, idx, $3, idx, $4, idx, $5*1024; idx++; if (idx >= 5) exit }'
fi
run_with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_lines="$(run_with_timeout 4 nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null || true)"
  gpu_count="$(printf '%s\n' "$gpu_lines" | awk 'NF { count++ } END { print count+0 }')"
  if [ "$gpu_count" -gt 0 ] 2>/dev/null; then
    printf 'gpu_probe_status=nvidia_smi\n'
    gpu_index=0
    printf '%s\n' "$gpu_lines" | while IFS=, read -r name driver mt mu util temp; do
      name="$(printf '%s' "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [ -z "$name" ] && continue
      printf 'gpu_%s_name=%s\n' "$gpu_index" "$name"; printf 'gpu_%s_vendor=NVIDIA\n' "$gpu_index"
      driver="$(printf '%s' "$driver" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [ -n "$driver" ] && [ "$driver" != "N/A" ] && printf 'gpu_%s_driver_version=%s\n' "$gpu_index" "$driver"
      awk -v i="$gpu_index" -v mt="$mt" -v mu="$mu" -v util="$util" -v temp="$temp" 'BEGIN { gsub(/^[[:space:]]+|[[:space:]]+$/, "", mt); gsub(/^[[:space:]]+|[[:space:]]+$/, "", mu); gsub(/^[[:space:]]+|[[:space:]]+$/, "", util); gsub(/^[[:space:]]+|[[:space:]]+$/, "", temp); if (mt ~ /^[0-9.]+$/) printf "gpu_%s_memory_total_bytes=%.0f\n", i, mt*1048576; if (mu ~ /^[0-9.]+$/) printf "gpu_%s_memory_used_bytes=%.0f\n", i, mu*1048576; if (util ~ /^[0-9.]+$/) printf "gpu_%s_utilization_percent=%s\n", i, util; if (temp ~ /^[0-9.]+$/) printf "gpu_%s_temperature_celsius=%s\n", i, temp }'
      gpu_index=$((gpu_index + 1))
    done
  else
    printf 'gpu_probe_status=nvidia_smi_no_devices\n'
  fi
elif command -v lspci >/dev/null 2>&1; then
  gpu_lines="$(run_with_timeout 2 lspci 2>/dev/null | awk -F': ' '/(VGA compatible controller|3D controller|Display controller)/ { print $2 }')"
  gpu_count="$(printf '%s\n' "$gpu_lines" | awk 'NF { count++ } END { print count+0 }')"
  if [ "$gpu_count" -gt 0 ] 2>/dev/null; then
    printf 'gpu_probe_status=lspci\n'
    gpu_index=0
    printf '%s\n' "$gpu_lines" | while IFS= read -r name; do name="$(printf '%s' "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; [ -z "$name" ] && continue; printf 'gpu_%s_name=%s\n' "$gpu_index" "$name"; gpu_index=$((gpu_index + 1)); done
  else
    printf 'gpu_probe_status=lspci_no_devices\n'
  fi
else
  printf 'gpu_probe_status=no_probe_command\n'
fi
"#;
