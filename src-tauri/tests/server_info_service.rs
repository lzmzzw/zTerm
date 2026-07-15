// Author: Liz
use zterm_lib::{
    error::AppError,
    models::{
        server_info::ServerInfoSnapshot,
        session::{AuthMode, SavedSession, SessionType, SshOptions},
    },
    services::{
        server_info_service::{collect_local_snapshot, parse_server_info_output},
        ssh_command_service::{
            build_ssh_command_execution, reusable_connection_key_for_execution,
            reusable_connection_metadata_for_execution, SshCommandSecretResolver,
        },
    },
};

#[test]
fn collects_local_machine_resource_snapshot() {
    let snapshot = collect_local_snapshot();

    assert_eq!(snapshot.host_id, "local-machine");
    assert_eq!(snapshot.host_name, "本机");
    assert_eq!(snapshot.host, "localhost");
    assert_eq!(snapshot.port, 0);
    assert!(snapshot.cpu_count.is_some_and(|count| count > 0));
    assert!(snapshot.memory_total_bytes.is_some_and(|bytes| bytes > 0));
    assert!(snapshot.process_count.is_some_and(|count| count > 0));
    assert!(!snapshot.captured_at.is_empty());
}

#[derive(Default)]
struct StaticSecrets;

impl SshCommandSecretResolver for StaticSecrets {
    fn secret_for(&self, credential_ref: &str) -> zterm_lib::error::AppResult<String> {
        match credential_ref {
            "credential:target-password" => Ok("target-password-secret".to_string()),
            "credential:target-password-2" => Ok("target-password-secret-2".to_string()),
            "credential:target-key-passphrase" => Ok("target-key-passphrase-secret".to_string()),
            "credential:jump-password" => Ok("jump-password-secret".to_string()),
            other => Err(AppError::not_found(format!("missing secret: {other}"))),
        }
    }
}

#[test]
fn parses_complete_linux_server_info_snapshot() {
    let snapshot = parse_server_info_output(
        &ssh_session("ssh-1", "生产服务器", "app.example.test", "deploy"),
        r#"
hostname=prod-app-01
os=Ubuntu 24.04 LTS
architecture=x86_64
kernel=6.8.0-40-generic
uptime_seconds=186400.12
load_average=0.18 0.24 0.31
cpu_usage_percent=12.50
cpu_count=4
cpu_model=AMD EPYC Preview
cpu_core_0_usage_percent=8.20
cpu_core_1_usage_percent=12.40
process_count=142
running_process_count=3
memory_total_bytes=8589934592
memory_used_bytes=3221225472
memory_available_bytes=5368709120
memory_buffers_bytes=268435456
memory_cached_bytes=1572864000
swap_total_bytes=2147483648
swap_used_bytes=0
disk_total_bytes=68719476736
disk_used_bytes=19327352832
disk_available_bytes=49392123904
disk_mount=/
disk_0_filesystem=/dev/vda1
disk_0_total_bytes=68719476736
disk_0_used_bytes=19327352832
disk_0_available_bytes=49392123904
disk_0_mount=/
network_interface_0_name=eth0
network_interface_0_rx_bytes=10345678
network_interface_0_tx_bytes=7765432
network_rx_bytes=10345678
network_tx_bytes=7765432
process_0_pid=4201
process_0_name=node
process_0_cpu_usage_percent=8.20
process_0_memory_percent=1.40
process_0_memory_bytes=75497472
gpu_probe_status=nvidia_smi
gpu_0_name=NVIDIA RTX 4090
gpu_0_vendor=NVIDIA
gpu_0_driver_version=555.42
gpu_0_memory_total_bytes=25769803776
gpu_0_memory_used_bytes=6442450944
gpu_0_utilization_percent=36.50
gpu_0_temperature_celsius=54
"#,
        "1770000000".to_string(),
    );

    assert_eq!(
        snapshot,
        ServerInfoSnapshot {
            host_id: "ssh-1".to_string(),
            host_name: "生产服务器".to_string(),
            host: "app.example.test".to_string(),
            port: 22,
            username: "deploy".to_string(),
            hostname: Some("prod-app-01".to_string()),
            os: Some("Ubuntu 24.04 LTS".to_string()),
            architecture: Some("x86_64".to_string()),
            kernel: Some("6.8.0-40-generic".to_string()),
            uptime_seconds: Some(186400),
            load_average: Some([0.18, 0.24, 0.31]),
            cpu_usage_percent: Some(12.5),
            cpu_count: Some(4),
            cpu_model: Some("AMD EPYC Preview".to_string()),
            cpu_core_usage_percents: vec![8.2, 12.4],
            process_count: Some(142),
            running_process_count: Some(3),
            memory_total_bytes: Some(8589934592),
            memory_used_bytes: Some(3221225472),
            memory_available_bytes: Some(5368709120),
            memory_buffers_bytes: Some(268435456),
            memory_cached_bytes: Some(1572864000),
            swap_total_bytes: Some(2147483648),
            swap_used_bytes: Some(0),
            disk_total_bytes: Some(68719476736),
            disk_used_bytes: Some(19327352832),
            disk_available_bytes: Some(49392123904),
            disk_mount: Some("/".to_string()),
            disks: vec![zterm_lib::models::server_info::ServerDiskInfo {
                filesystem: "/dev/vda1".to_string(),
                mount: "/".to_string(),
                total_bytes: Some(68719476736),
                used_bytes: Some(19327352832),
                available_bytes: Some(49392123904),
            }],
            network_rx_bytes: Some(10345678),
            network_tx_bytes: Some(7765432),
            network_interfaces: vec![zterm_lib::models::server_info::ServerNetworkInterfaceInfo {
                name: "eth0".to_string(),
                rx_bytes: Some(10345678),
                tx_bytes: Some(7765432),
            }],
            top_processes: vec![zterm_lib::models::server_info::ServerProcessInfo {
                pid: 4201,
                name: "node".to_string(),
                cpu_usage_percent: Some(8.2),
                memory_percent: Some(1.4),
                memory_bytes: Some(75497472),
            }],
            gpu_probe_status: Some("nvidia_smi".to_string()),
            gpus: vec![zterm_lib::models::server_info::ServerGpuInfo {
                name: "NVIDIA RTX 4090".to_string(),
                vendor: Some("NVIDIA".to_string()),
                driver_version: Some("555.42".to_string()),
                memory_total_bytes: Some(25769803776),
                memory_used_bytes: Some(6442450944),
                utilization_percent: Some(36.5),
                temperature_celsius: Some(54.0),
            }],
            captured_at: "1770000000".to_string(),
        }
    );
}

#[test]
fn parses_gpu_probe_fallback_without_devices() {
    let snapshot = parse_server_info_output(
        &ssh_session("ssh-1", "测试机", "app.example.test", "deploy"),
        "gpu_probe_status=no_probe_command\n",
        "1770000000".to_string(),
    );

    assert_eq!(
        snapshot.gpu_probe_status.as_deref(),
        Some("no_probe_command")
    );
    assert!(snapshot.gpus.is_empty());
    assert!(snapshot.cpu_usage_percent.is_none());
}

#[test]
fn builds_native_ssh_command_execution_with_jump_hosts_and_redacted_debug() {
    let mut target = ssh_session("target", "目标机", "10.0.0.20", "deploy");
    target.credential_ref = Some("credential:target-password".to_string());
    target.ssh_options = Some(SshOptions {
        connect_timeout_ms: Some(15_000),
        keepalive_interval_ms: Some(30_000),
        proxy_command: None,
        identity_file: None,
        jump_hosts: vec!["jump@10.0.0.10".to_string()],
        tunnels: Vec::new(),
        container: None,
    });

    let mut jump = ssh_session("jump", "跳板机", "10.0.0.10", "jump");
    jump.credential_ref = Some("credential:jump-password".to_string());

    let execution = build_ssh_command_execution(
        &target,
        &[target.clone(), jump],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");

    assert_eq!(execution.target.host, "10.0.0.20");
    assert_eq!(execution.target.username, "deploy");
    assert_eq!(execution.jumps.len(), 1);
    assert_eq!(execution.jumps[0].host, "10.0.0.10");
    assert_eq!(execution.jumps[0].username, "jump");
    assert_eq!(execution.script, "printf ok\n");
    assert_eq!(execution.timeout_seconds, 15);

    let debug = format!("{execution:?}");
    assert!(!debug.contains("target-password-secret"));
    assert!(!debug.contains("jump-password-secret"));
}

#[test]
fn rejects_key_auth_without_identity_file() {
    let mut target = ssh_session("target", "目标机", "10.0.0.20", "deploy");
    target.auth_mode = AuthMode::Key;
    target.credential_ref = Some("credential:target-key-passphrase".to_string());

    let error = build_ssh_command_execution(
        &target,
        &[target.clone()],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect_err("key auth without identity file should fail");

    assert!(matches!(error, AppError::Validation(message) if message.contains("identity_file")));
}

#[test]
fn reusable_ssh_command_key_tracks_safe_session_fingerprint_without_secrets() {
    let mut target = ssh_session("target", "目标机", "10.0.0.20", "deploy");
    target.updated_at_ms = 100;
    target.credential_ref = Some("credential:target-password".to_string());
    target.ssh_options = Some(SshOptions {
        connect_timeout_ms: Some(15_000),
        keepalive_interval_ms: Some(30_000),
        proxy_command: None,
        identity_file: None,
        jump_hosts: vec!["jump".to_string()],
        tunnels: Vec::new(),
        container: None,
    });

    let mut jump = ssh_session("jump", "跳板机", "10.0.0.10", "jump");
    jump.updated_at_ms = 200;
    jump.credential_ref = Some("credential:jump-password".to_string());

    let execution = build_ssh_command_execution(
        &target,
        &[target.clone(), jump.clone()],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    let key = reusable_connection_key_for_execution("server_info", &execution);

    let same_execution = build_ssh_command_execution(
        &target,
        &[target.clone(), jump.clone()],
        "printf another script\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    assert_eq!(
        key,
        reusable_connection_key_for_execution("server_info", &same_execution),
        "script body should not fragment the reusable transport cache"
    );

    let mut changed_host = target.clone();
    changed_host.host = "10.0.0.21".to_string();
    let changed_host_execution = build_ssh_command_execution(
        &changed_host,
        &[changed_host.clone(), jump.clone()],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    assert_ne!(
        key,
        reusable_connection_key_for_execution("server_info", &changed_host_execution)
    );

    let mut changed_update = target.clone();
    changed_update.updated_at_ms = 101;
    let changed_update_execution = build_ssh_command_execution(
        &changed_update,
        &[changed_update.clone(), jump.clone()],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    assert_ne!(
        key,
        reusable_connection_key_for_execution("server_info", &changed_update_execution)
    );

    let mut changed_credential = target.clone();
    changed_credential.credential_ref = Some("credential:target-password-2".to_string());
    let changed_credential_execution = build_ssh_command_execution(
        &changed_credential,
        &[changed_credential.clone(), jump.clone()],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    assert_ne!(
        key,
        reusable_connection_key_for_execution("server_info", &changed_credential_execution)
    );

    let no_jump_execution = build_ssh_command_execution(
        &SavedSession {
            ssh_options: Some(SshOptions {
                jump_hosts: Vec::new(),
                ..target.ssh_options.clone().expect("target has ssh options")
            }),
            ..target.clone()
        },
        &[target.clone(), jump],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    assert_ne!(
        key,
        reusable_connection_key_for_execution("server_info", &no_jump_execution)
    );

    let key_text = format!("{key:?} {}", key.as_str());
    assert!(key_text.contains("credential:target-password"));
    assert!(key_text.contains("credential:jump-password"));
    assert!(!key_text.contains("target-password-secret"));
    assert!(!key_text.contains("jump-password-secret"));
}

#[test]
fn reusable_ssh_command_metadata_matches_target_jump_and_credentials() {
    let mut target = ssh_session("target", "目标机", "10.0.0.20", "deploy");
    target.credential_ref = Some("credential:target-password".to_string());
    target.ssh_options = Some(SshOptions {
        connect_timeout_ms: Some(15_000),
        keepalive_interval_ms: Some(30_000),
        proxy_command: None,
        identity_file: None,
        jump_hosts: vec!["jump".to_string()],
        tunnels: Vec::new(),
        container: None,
    });

    let mut jump = ssh_session("jump", "跳板机", "10.0.0.10", "jump");
    jump.credential_ref = Some("credential:jump-password".to_string());

    let execution = build_ssh_command_execution(
        &target,
        &[target.clone(), jump],
        "printf ok\n".to_string(),
        &StaticSecrets,
    )
    .expect("execution should build");
    let metadata = reusable_connection_metadata_for_execution(&execution);

    assert!(metadata.matches_session_id("target"));
    assert!(metadata.matches_session_id("jump"));
    assert!(!metadata.matches_session_id("other"));
    assert!(metadata.matches_credential_ref("credential:target-password"));
    assert!(metadata.matches_credential_ref("credential:jump-password"));
    assert!(!metadata.matches_credential_ref("credential:other"));
}

fn ssh_session(id: &str, name: &str, host: &str, username: &str) -> SavedSession {
    SavedSession {
        id: id.to_string(),
        name: name.to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: host.to_string(),
        port: 22,
        username: username.to_string(),
        auth_mode: AuthMode::Password,
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
