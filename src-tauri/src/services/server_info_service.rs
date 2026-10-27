// Author: Liz
use std::{
    collections::HashMap,
    ffi::OsStr,
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use sysinfo::{Disks, Networks, System};

use crate::{
    error::{AppError, AppResult},
    models::{
        server_info::{
            ServerDiskInfo, ServerGpuInfo, ServerInfoRequest, ServerInfoSnapshot,
            ServerNetworkInterfaceInfo, ServerProcessInfo,
        },
        session::{SavedSession, SessionType},
    },
    services::{
        credential_service::CredentialService,
        ssh_command_service::{
            build_ssh_command_execution, reusable_connection_key_for_execution,
            SshCommandSecretResolver, SshCommandService,
        },
    },
    storage::{
        sessions::{get_session, list_sessions},
        sqlite::SqliteStore,
    },
};

const SNAPSHOT_TTL: Duration = Duration::from_millis(750);
const SLOW_TTL: Duration = Duration::from_secs(15);
const STATIC_TTL: Duration = Duration::from_secs(300);
const SLOW_MAX_AGE: Duration = Duration::from_secs(60);
const STATIC_MAX_AGE: Duration = Duration::from_secs(900);
const MAX_CACHE_ENTRIES: usize = 32;

#[derive(Clone, Default)]
pub struct ServerInfoService {
    cache: Arc<ServerInfoCache>,
}

#[derive(Default)]
struct ServerInfoCache {
    entries: Mutex<HashMap<String, CachedCollection>>,
    flights: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

#[derive(Clone)]
struct CachedCollection {
    values: HashMap<String, String>,
    completed_at: Instant,
    slow_completed_at: Option<Instant>,
    static_completed_at: Option<Instant>,
    last_used: Instant,
    captured_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RefreshPlan {
    slow: bool,
    static_info: bool,
}

impl RefreshPlan {
    fn for_cached(cached: Option<&CachedCollection>, now: Instant) -> Self {
        let expired =
            |at: Option<Instant>, ttl| at.is_none_or(|at| now.saturating_duration_since(at) >= ttl);
        Self {
            slow: expired(cached.and_then(|value| value.slow_completed_at), SLOW_TTL),
            static_info: expired(
                cached.and_then(|value| value.static_completed_at),
                STATIC_TTL,
            ),
        }
    }
}

// Building the route fingerprint needs credential references, not secret values.
// Actual SSH collection continues to resolve credentials through its own service.
struct FingerprintSecrets;

impl SshCommandSecretResolver for FingerprintSecrets {
    fn secret_for(&self, _: &str) -> AppResult<String> {
        Ok(String::new())
    }
}

fn server_info_cache_key(
    session: &SavedSession,
    all_sessions: &[SavedSession],
) -> AppResult<String> {
    let execution =
        build_ssh_command_execution(session, all_sessions, "true".into(), &FingerprintSecrets)?;
    Ok(
        reusable_connection_key_for_execution("server_info", &execution)
            .as_str()
            .to_owned(),
    )
}

impl ServerInfoService {
    pub fn new() -> Self {
        Self::default()
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
        let key = server_info_cache_key(&session, &all_sessions)?;
        let session_ref = &session;
        let all_sessions_ref = &all_sessions;
        self.snapshot_with(key, &session, |plan| async move {
            let output = ssh_commands
                .execute_reusable(
                    "server_info",
                    session_ref,
                    all_sessions_ref,
                    server_info_script(plan),
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
            Ok(output.stdout)
        })
        .await
    }

    async fn snapshot_with<F, Fut>(
        &self,
        key: String,
        session: &SavedSession,
        collect: F,
    ) -> AppResult<ServerInfoSnapshot>
    where
        F: FnOnce(RefreshPlan) -> Fut,
        Fut: Future<Output = AppResult<String>>,
    {
        let flight = {
            let mut flights = self
                .cache
                .flights
                .lock()
                .map_err(|_| AppError::ssh("资源采集锁不可用"))?;
            flights.retain(|_, value| value.strong_count() > 0);
            if let Some(flight) = flights.get(&key).and_then(Weak::upgrade) {
                flight
            } else {
                let flight = Arc::new(tokio::sync::Mutex::new(()));
                flights.insert(key.clone(), Arc::downgrade(&flight));
                flight
            }
        };
        // The async guard is released on error, panic or task cancellation.
        // No global cache lock is held while waiting or collecting over SSH.
        let _flight = flight.lock().await;
        let now = Instant::now();
        let cached = {
            let mut entries = self
                .cache
                .entries
                .lock()
                .map_err(|_| AppError::ssh("资源缓存锁不可用"))?;
            let cached = entries.get_mut(&key);
            if let Some(cached) = cached {
                cached.last_used = now;
                if now.saturating_duration_since(cached.completed_at) < SNAPSHOT_TTL {
                    return Ok(parse_server_info_values(
                        session,
                        &cached.values,
                        cached.captured_at.clone(),
                    ));
                }
                Some(cached.clone())
            } else {
                None
            }
        };
        let plan = RefreshPlan::for_cached(cached.as_ref(), now);
        let output = collect(plan).await?;
        let completed_at = Instant::now();
        let refreshed = merge_collection(
            cached.as_ref(),
            key_value_lines(&output),
            plan,
            completed_at,
        );
        let snapshot =
            parse_server_info_values(session, &refreshed.values, refreshed.captured_at.clone());
        let mut entries = self
            .cache
            .entries
            .lock()
            .map_err(|_| AppError::ssh("资源缓存锁不可用"))?;
        if !entries.contains_key(&key) && entries.len() >= MAX_CACHE_ENTRIES {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(key, refreshed);
        Ok(snapshot)
    }

    pub async fn local_snapshot(&self) -> AppResult<ServerInfoSnapshot> {
        tokio::task::spawn_blocking(collect_local_snapshot)
            .await
            .map_err(|error| AppError::terminal(format!("本机资源采集任务失败: {error}")))
    }
}

fn static_field(key: &str) -> bool {
    matches!(
        key,
        "hostname" | "os" | "architecture" | "kernel" | "cpu_count" | "cpu_model"
    )
}

fn slow_field(key: &str) -> bool {
    key.starts_with("disk_")
        || key.starts_with("process_")
        || key == "running_process_count"
        || key.starts_with("gpu_")
}

fn merge_collection(
    cached: Option<&CachedCollection>,
    fresh: HashMap<String, String>,
    plan: RefreshPlan,
    now: Instant,
) -> CachedCollection {
    let static_ok = [
        "hostname",
        "os",
        "architecture",
        "kernel",
        "cpu_count",
        "cpu_model",
    ]
    .iter()
    .all(|key| fresh.get(*key).is_some_and(|value| !value.is_empty()));
    let slow_ok = fresh
        .get("zterm_slow_complete")
        .is_some_and(|value| value == "1");
    let mut values: HashMap<_, _> = fresh
        .iter()
        .filter(|(key, _)| !static_field(key) && !slow_field(key) && !key.starts_with("zterm_"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    for (refresh, succeeded, belongs, previous_at, max_age) in [
        (
            plan.static_info,
            static_ok,
            static_field as fn(&str) -> bool,
            cached.and_then(|value| value.static_completed_at),
            STATIC_MAX_AGE,
        ),
        (
            plan.slow,
            slow_ok,
            slow_field as fn(&str) -> bool,
            cached.and_then(|value| value.slow_completed_at),
            SLOW_MAX_AGE,
        ),
    ] {
        let source = if refresh && succeeded {
            Some(&fresh)
        } else {
            cached
                .filter(|_| {
                    previous_at.is_some_and(|at| now.saturating_duration_since(at) < max_age)
                })
                .map(|cached| &cached.values)
                .or(Some(&fresh))
        };
        if let Some(source) = source {
            values.extend(
                source
                    .iter()
                    .filter(|(key, _)| belongs(key))
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
    }
    CachedCollection {
        values,
        completed_at: now,
        slow_completed_at: if plan.slow && slow_ok {
            Some(now)
        } else {
            cached.and_then(|value| value.slow_completed_at)
        },
        static_completed_at: if plan.static_info && static_ok {
            Some(now)
        } else {
            cached.and_then(|value| value.static_completed_at)
        },
        last_used: now,
        captured_at: unix_timestamp(),
    }
}

pub fn collect_local_snapshot() -> ServerInfoSnapshot {
    let mut system = System::new_all();
    std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
    system.refresh_cpu_usage();

    let disks = Disks::new_with_refreshed_list();
    let disk_items = disks
        .list()
        .iter()
        .map(|disk| {
            let total = disk.total_space();
            let available = disk.available_space();
            ServerDiskInfo {
                filesystem: os_text(disk.file_system()),
                mount: disk.mount_point().to_string_lossy().into_owned(),
                total_bytes: Some(total),
                used_bytes: Some(total.saturating_sub(available)),
                available_bytes: Some(available),
            }
        })
        .collect::<Vec<_>>();
    let primary_disk = disk_items.first();

    let networks = Networks::new_with_refreshed_list();
    let network_interfaces = networks
        .iter()
        .map(|(name, data)| ServerNetworkInterfaceInfo {
            name: name.to_string(),
            rx_bytes: Some(data.total_received()),
            tx_bytes: Some(data.total_transmitted()),
        })
        .collect::<Vec<_>>();
    let network_rx_bytes = Some(
        network_interfaces
            .iter()
            .filter_map(|item| item.rx_bytes)
            .sum(),
    );
    let network_tx_bytes = Some(
        network_interfaces
            .iter()
            .filter_map(|item| item.tx_bytes)
            .sum(),
    );

    let memory_total = system.total_memory();
    let memory_used = system.used_memory();
    let mut top_processes = system
        .processes()
        .iter()
        .map(|(pid, process)| ServerProcessInfo {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().into_owned(),
            cpu_usage_percent: Some(process.cpu_usage() as f64),
            memory_percent: (memory_total > 0)
                .then_some(process.memory() as f64 * 100.0 / memory_total as f64),
            memory_bytes: Some(process.memory()),
        })
        .collect::<Vec<_>>();
    top_processes.sort_by(|left, right| {
        right
            .cpu_usage_percent
            .partial_cmp(&left.cpu_usage_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top_processes.truncate(5);

    let hostname = System::host_name();
    ServerInfoSnapshot {
        host_id: "local-machine".to_string(),
        host_name: "本机".to_string(),
        host: "localhost".to_string(),
        port: 0,
        username: std::env::var("USERNAME")
            .or_else(|_| std::env::var("USER"))
            .unwrap_or_default(),
        hostname,
        os: System::long_os_version(),
        architecture: Some(System::cpu_arch()),
        kernel: System::kernel_version(),
        uptime_seconds: Some(System::uptime()),
        load_average: {
            let load = System::load_average();
            Some([load.one, load.five, load.fifteen])
        },
        cpu_usage_percent: Some(system.global_cpu_usage() as f64),
        cpu_count: Some(system.cpus().len() as u64),
        cpu_model: system.cpus().first().map(|cpu| cpu.brand().to_string()),
        cpu_core_usage_percents: system
            .cpus()
            .iter()
            .map(|cpu| cpu.cpu_usage() as f64)
            .collect(),
        process_count: Some(system.processes().len() as u64),
        running_process_count: None,
        memory_total_bytes: Some(memory_total),
        memory_used_bytes: Some(memory_used),
        memory_available_bytes: Some(system.available_memory()),
        memory_buffers_bytes: None,
        memory_cached_bytes: None,
        swap_total_bytes: Some(system.total_swap()),
        swap_used_bytes: Some(system.used_swap()),
        disk_total_bytes: primary_disk.and_then(|disk| disk.total_bytes),
        disk_used_bytes: primary_disk.and_then(|disk| disk.used_bytes),
        disk_available_bytes: primary_disk.and_then(|disk| disk.available_bytes),
        disk_mount: primary_disk.map(|disk| disk.mount.clone()),
        disks: disk_items,
        network_rx_bytes,
        network_tx_bytes,
        network_interfaces,
        top_processes,
        gpu_probe_status: Some("not_collected".to_string()),
        gpus: Vec::new(),
        captured_at: unix_timestamp(),
    }
}

fn os_text(value: &OsStr) -> String {
    value.to_string_lossy().into_owned()
}

pub fn parse_server_info_output(
    session: &SavedSession,
    stdout: &str,
    captured_at: String,
) -> ServerInfoSnapshot {
    let values = key_value_lines(stdout);
    parse_server_info_values(session, &values, captured_at)
}

fn parse_server_info_values(
    session: &SavedSession,
    values: &HashMap<String, String>,
    captured_at: String,
) -> ServerInfoSnapshot {
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

fn server_info_script(plan: RefreshPlan) -> String {
    format!(
        "zterm_refresh_static={}\nzterm_refresh_slow={}\n{SERVER_INFO_SCRIPT}",
        u8::from(plan.static_info),
        u8::from(plan.slow),
    )
}

const SERVER_INFO_SCRIPT: &str = r#"
if [ "$zterm_refresh_static" = 1 ]; then
printf 'hostname=%s\n' "$(hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then
  os_pretty="$(awk -F= '/^PRETTY_NAME=/ { value=$2; gsub(/^"/, "", value); gsub(/"$/, "", value); print value; exit }' /etc/os-release 2>/dev/null)"
fi
if [ -n "$os_pretty" ]; then printf 'os=%s\n' "$os_pretty"; else printf 'os=%s\n' "$(uname -s 2>/dev/null)"; fi
printf 'architecture=%s\n' "$(uname -m 2>/dev/null)"
printf 'kernel=%s\n' "$(uname -r 2>/dev/null)"
fi
if [ -r /proc/uptime ]; then awk '{ printf "uptime_seconds=%s\n", $1 }' /proc/uptime; fi
if [ -r /proc/loadavg ]; then awk '{ printf "load_average=%s %s %s\n", $1, $2, $3 }' /proc/loadavg; fi
if [ "$zterm_refresh_static" = 1 ]; then
cpu_count="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"
if [ -n "$cpu_count" ]; then printf 'cpu_count=%s\n' "$cpu_count"; fi
if [ -r /proc/cpuinfo ]; then
  awk -F: '/^(model name|Hardware|Processor)[[:space:]]*:/ { value=$2; sub(/^[[:space:]]+/, "", value); if (value != "") { printf "cpu_model=%s\n", value; exit } }' /proc/cpuinfo
fi
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
if [ "$zterm_refresh_slow" = 1 ]; then
zterm_slow_complete=1
if disk_root="$(df -Pk / 2>/dev/null)"; then
  printf '%s\n' "$disk_root" | awk 'NR==2 { printf "disk_total_bytes=%.0f\n", $2*1024; printf "disk_used_bytes=%.0f\n", $3*1024; printf "disk_available_bytes=%.0f\n", $4*1024; printf "disk_mount=%s\n", $6 }'
else zterm_slow_complete=0; fi
if disk_all="$(df -Pk 2>/dev/null)"; then
  printf '%s\n' "$disk_all" | awk 'NR > 1 { if ($1 == "tmpfs" || $1 == "devtmpfs") next; printf "disk_%d_filesystem=%s\n", idx, $1; printf "disk_%d_total_bytes=%.0f\n", idx, $2*1024; printf "disk_%d_used_bytes=%.0f\n", idx, $3*1024; printf "disk_%d_available_bytes=%.0f\n", idx, $4*1024; printf "disk_%d_mount=%s\n", idx, $6; idx++ }'
else zterm_slow_complete=0; fi
fi
if [ -r /proc/net/dev ]; then
  awk 'NR > 2 { split($0, parts, ":"); name=parts[1]; sub(/^[[:space:]]+/, "", name); sub(/[[:space:]]+$/, "", name); split(parts[2], fields, /[[:space:]]+/); rx += fields[1]; tx += fields[9]; printf "network_interface_%d_name=%s\n", idx, name; printf "network_interface_%d_rx_bytes=%.0f\n", idx, fields[1]; printf "network_interface_%d_tx_bytes=%.0f\n", idx, fields[9]; idx++ } END { printf "network_rx_bytes=%.0f\nnetwork_tx_bytes=%.0f\n", rx, tx }' /proc/net/dev
fi
if [ "$zterm_refresh_slow" = 1 ]; then
if command -v ps >/dev/null 2>&1; then
  if process_counts="$(ps -eo stat= 2>/dev/null)"; then
    printf '%s\n' "$process_counts" | awk 'NF { count++; if ($1 ~ /^R/) running++ } END { if (count > 0) printf "process_count=%d\nrunning_process_count=%d\n", count, running }'
  else zterm_slow_complete=0; fi
  if process_top="$(ps -eo pid=,comm=,pcpu=,pmem=,rss= 2>/dev/null)"; then
    if process_sorted="$(printf '%s\n' "$process_top" | sort -k3 -nr 2>/dev/null)"; then
      printf '%s\n' "$process_sorted" | awk 'NF >= 5 { printf "process_%d_pid=%s\nprocess_%d_name=%s\nprocess_%d_cpu_usage_percent=%s\nprocess_%d_memory_percent=%s\nprocess_%d_memory_bytes=%.0f\n", idx, $1, idx, $2, idx, $3, idx, $4, idx, $5*1024; idx++; if (idx >= 5) exit }'
    else zterm_slow_complete=0; fi
  else zterm_slow_complete=0; fi
fi
run_with_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
if command -v nvidia-smi >/dev/null 2>&1; then
  if gpu_lines="$(run_with_timeout 4 nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>/dev/null)"; then :; else zterm_slow_complete=0; fi
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
  if pci_lines="$(run_with_timeout 2 lspci 2>/dev/null)"; then :; else zterm_slow_complete=0; fi
  gpu_lines="$(printf '%s\n' "$pci_lines" | awk -F': ' '/(VGA compatible controller|3D controller|Display controller)/ { print $2 }')"
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
printf 'zterm_slow_complete=%s\n' "$zterm_slow_complete"
fi
"#;

#[cfg(test)]
mod cache_tests {
    use super::*;
    use crate::models::session::{AuthMode, SshOptions};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn session(id: &str) -> SavedSession {
        SavedSession {
            id: id.into(),
            name: id.into(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: format!("{id}.invalid"),
            port: 22,
            username: "test".into(),
            auth_mode: AuthMode::Agent,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_used_at_ms: None,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        }
    }

    fn full_output(cpu: u8) -> String {
        format!("hostname=test\nos=Linux\narchitecture=x86_64\nkernel=test\ncpu_count=2\ncpu_model=model\n\
                 uptime_seconds=100\nload_average=1 2 3\ncpu_usage_percent={cpu}\ncpu_core_0_usage_percent={cpu}\n\
                 memory_total_bytes=100\nmemory_used_bytes=40\nswap_used_bytes=2\n\
                 network_rx_bytes=1000\nnetwork_interface_0_name=eth0\nnetwork_interface_0_rx_bytes=1000\n\
                 disk_total_bytes=500\ndisk_0_filesystem=/dev/test\ndisk_0_mount=/\n\
                 process_count=5\nrunning_process_count=1\nprocess_0_pid=7\nprocess_0_name=test\n\
                 gpu_probe_status=nvidia_smi\ngpu_0_name=test gpu\nzterm_slow_complete=1\n")
    }

    fn age_snapshot(service: &ServerInfoService, key: &str) {
        service
            .cache
            .entries
            .lock()
            .unwrap()
            .get_mut(key)
            .unwrap()
            .completed_at = Instant::now() - SNAPSHOT_TTL;
    }

    #[test]
    fn server_info_cache_route_fingerprint_includes_target_jump_and_auth_configuration() {
        let mut target = session("target");
        target.ssh_options = Some(SshOptions {
            jump_hosts: vec!["jump".into()],
            ..SshOptions::default()
        });
        let jump = session("jump");
        let route = vec![target.clone(), jump.clone()];
        let key = server_info_cache_key(&target, &route).unwrap();
        for changed_jump in [
            SavedSession {
                host: "changed.invalid".into(),
                ..jump.clone()
            },
            SavedSession {
                updated_at_ms: 2,
                ..jump.clone()
            },
            SavedSession {
                port: 2222,
                ..jump.clone()
            },
            SavedSession {
                username: "other".into(),
                ..jump.clone()
            },
            SavedSession {
                auth_mode: AuthMode::Password,
                credential_ref: Some("test-ref".into()),
                ..jump.clone()
            },
        ] {
            assert_ne!(
                key,
                server_info_cache_key(&target, &[target.clone(), changed_jump]).unwrap()
            );
        }
        for changed_target in [
            SavedSession {
                host: "changed.invalid".into(),
                ..target.clone()
            },
            SavedSession {
                updated_at_ms: 2,
                ..target.clone()
            },
            SavedSession {
                auth_mode: AuthMode::Password,
                credential_ref: Some("test-ref".into()),
                ..target.clone()
            },
            SavedSession {
                ssh_options: Some(SshOptions {
                    proxy_command: Some("test-proxy".into()),
                    ..target.ssh_options.clone().unwrap()
                }),
                ..target.clone()
            },
        ] {
            assert_ne!(
                key,
                server_info_cache_key(&changed_target, &[changed_target.clone(), jump.clone()])
                    .unwrap()
            );
        }
    }

    #[test]
    fn server_info_cache_layers_merge_without_stale_fast_fields_or_refreshing_failed_layers() {
        let start = Instant::now();
        let full = RefreshPlan {
            slow: true,
            static_info: true,
        };
        let first = merge_collection(None, key_value_lines(&full_output(10)), full, start);
        assert_eq!(
            RefreshPlan::for_cached(Some(&first), start + Duration::from_secs(14)),
            RefreshPlan {
                slow: false,
                static_info: false
            }
        );
        assert_eq!(
            RefreshPlan::for_cached(Some(&first), start + SLOW_TTL),
            RefreshPlan {
                slow: true,
                static_info: false
            }
        );
        assert_eq!(
            RefreshPlan::for_cached(Some(&first), start + STATIC_TTL),
            full
        );
        let now = start + Duration::from_secs(16);
        let fresh = "cpu_usage_percent=20\ncpu_core_0_usage_percent=20\nmemory_used_bytes=50\nnetwork_rx_bytes=2000\n";
        let fast = merge_collection(
            Some(&first),
            key_value_lines(fresh),
            RefreshPlan {
                slow: false,
                static_info: false,
            },
            now,
        );
        let snapshot = parse_server_info_values(&session("test"), &fast.values, "time".into());
        assert_eq!(snapshot.cpu_usage_percent, Some(20.0));
        assert_eq!(snapshot.cpu_core_usage_percents, vec![20.0]);
        assert_eq!(snapshot.memory_used_bytes, Some(50));
        assert_eq!(snapshot.network_rx_bytes, Some(2000));
        assert!(snapshot.network_interfaces.is_empty());
        assert_eq!(snapshot.uptime_seconds, None);
        assert_eq!(snapshot.hostname.as_deref(), Some("test"));
        assert_eq!(snapshot.disk_total_bytes, Some(500));
        assert_eq!(snapshot.top_processes[0].pid, 7);
        assert_eq!(snapshot.gpus[0].name, "test gpu");
        assert_eq!(fast.slow_completed_at, first.slow_completed_at);
        let failed = merge_collection(Some(&first), key_value_lines("cpu_usage_percent=30\ndisk_total_bytes=999\nhostname=partial\nzterm_slow_complete=0\n"), full, now);
        assert_eq!(
            failed.values.get("disk_total_bytes"),
            first.values.get("disk_total_bytes")
        );
        assert_eq!(failed.values.get("hostname"), first.values.get("hostname"));
        assert_eq!(failed.slow_completed_at, first.slow_completed_at);
        assert_eq!(failed.static_completed_at, first.static_completed_at);
        assert_eq!(
            RefreshPlan::for_cached(Some(&failed), now),
            RefreshPlan {
                slow: true,
                static_info: false
            }
        );
        let refreshed = merge_collection(
            Some(&first),
            key_value_lines(
                "cpu_usage_percent=40\ngpu_probe_status=no_probe_command\nzterm_slow_complete=1\n",
            ),
            RefreshPlan {
                slow: true,
                static_info: false,
            },
            now,
        );
        assert_eq!(refreshed.slow_completed_at, Some(now));
        assert!(!refreshed.values.contains_key("gpu_0_name"));
        assert_eq!(
            refreshed.values.get("cpu_count"),
            first.values.get("cpu_count")
        );
        let expired = merge_collection(
            Some(&first),
            key_value_lines("cpu_usage_percent=50\nzterm_slow_complete=0\n"),
            full,
            start + STATIC_MAX_AGE,
        );
        assert!(!expired.values.contains_key("disk_total_bytes"));
        assert!(!expired.values.contains_key("hostname"));
        assert_eq!(expired.slow_completed_at, first.slow_completed_at);
        assert_eq!(expired.static_completed_at, first.static_completed_at);
    }

    #[tokio::test]
    async fn server_info_cache_singleflight_uses_completion_time_and_preserves_cached_capture_time()
    {
        let service = ServerInfoService::new();
        let count = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let first_service = service.clone();
        let first_count = Arc::clone(&count);
        let first = tokio::spawn(async move {
            first_service
                .snapshot_with("same".into(), &session("test"), |_| async move {
                    first_count.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Ok(full_output(10))
                })
                .await
                .unwrap()
        });
        started_rx.await.unwrap();
        let second_service = service.clone();
        let second_count = Arc::clone(&count);
        let second = tokio::spawn(async move {
            second_service
                .snapshot_with("same".into(), &session("test"), |_| async move {
                    second_count.fetch_add(1, Ordering::SeqCst);
                    Ok(full_output(99))
                })
                .await
                .unwrap()
        });
        // A collection may take longer than the short snapshot TTL.
        tokio::time::sleep(SNAPSHOT_TTL + Duration::from_millis(20)).await;
        release_tx.send(()).unwrap();
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
        let hit = service
            .snapshot_with("same".into(), &session("test"), |_| async {
                panic!("completed collection must still be fresh");
                #[allow(unreachable_code)]
                Ok(String::new())
            })
            .await
            .unwrap();
        assert_eq!(first.captured_at, hit.captured_at);
    }

    #[tokio::test]
    async fn server_info_cache_expired_snapshot_refreshes_fast_values_and_errors_do_not_extend_freshness(
    ) {
        let service = ServerInfoService::new();
        service
            .snapshot_with("key".into(), &session("test"), |_| async {
                Ok(full_output(10))
            })
            .await
            .unwrap();
        age_snapshot(&service, "key");
        let before = service.cache.entries.lock().unwrap()["key"].clone();
        let error = service
            .snapshot_with("key".into(), &session("test"), |plan| async move {
                assert_eq!(
                    plan,
                    RefreshPlan {
                        slow: false,
                        static_info: false
                    }
                );
                Err(AppError::ssh("test collection failed"))
            })
            .await;
        assert!(error.is_err());
        assert_eq!(
            service.cache.entries.lock().unwrap()["key"].completed_at,
            before.completed_at
        );
        let snapshot = service
            .snapshot_with("key".into(), &session("test"), |_| async {
                Ok("cpu_usage_percent=25\nmemory_used_bytes=60\nnetwork_rx_bytes=1234\n".into())
            })
            .await
            .unwrap();
        assert_eq!(snapshot.cpu_usage_percent, Some(25.0));
        assert_eq!(snapshot.memory_used_bytes, Some(60));
        assert_eq!(snapshot.network_rx_bytes, Some(1234));
        assert_eq!(snapshot.disk_total_bytes, Some(500));
    }

    #[tokio::test]
    async fn server_info_cache_cancellation_and_panic_release_singleflight() {
        let service = ServerInfoService::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let cancelled_service = service.clone();
        let cancelled = tokio::spawn(async move {
            cancelled_service
                .snapshot_with("cancel".into(), &session("test"), |_| async move {
                    started_tx.send(()).unwrap();
                    std::future::pending::<AppResult<String>>().await
                })
                .await
        });
        started_rx.await.unwrap();
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        let panic_service = service.clone();
        let panicked = tokio::spawn(async move {
            panic_service
                .snapshot_with("cancel".into(), &session("test"), |_| async {
                    panic!("test collector panic");
                    #[allow(unreachable_code)]
                    Ok(String::new())
                })
                .await
        });
        assert!(panicked.await.unwrap_err().is_panic());
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            service.snapshot_with("cancel".into(), &session("test"), |_| async {
                Ok(full_output(10))
            }),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.cpu_usage_percent, Some(10.0));
    }

    #[tokio::test]
    async fn server_info_cache_is_bounded_and_routes_do_not_share_snapshots() {
        let service = ServerInfoService::new();
        for index in 0..MAX_CACHE_ENTRIES + 4 {
            let snapshot = service
                .snapshot_with(index.to_string(), &session("test"), |_| async move {
                    Ok(full_output(index as u8))
                })
                .await
                .unwrap();
            assert_eq!(snapshot.cpu_usage_percent, Some(index as f64));
        }
        assert_eq!(
            service.cache.entries.lock().unwrap().len(),
            MAX_CACHE_ENTRIES
        );
        assert!(service.cache.flights.lock().unwrap().len() <= 1);
        assert!(!service.cache.entries.lock().unwrap().contains_key("0"));
    }

    #[test]
    fn server_info_cache_script_selects_expensive_probe_layers() {
        let fast = server_info_script(RefreshPlan {
            slow: false,
            static_info: false,
        });
        assert!(fast.starts_with("zterm_refresh_static=0\nzterm_refresh_slow=0\n"));
        assert!(fast.contains("/proc/stat"));
        assert!(fast.contains("/proc/meminfo"));
        assert!(fast.contains("/proc/net/dev"));
        assert!(fast.contains("if [ \"$zterm_refresh_slow\" = 1 ]; then"));
        let full = server_info_script(RefreshPlan {
            slow: true,
            static_info: true,
        });
        assert!(full.starts_with("zterm_refresh_static=1\nzterm_refresh_slow=1\n"));
    }
}
