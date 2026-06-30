// Author: Liz
use zterm_lib::{
    models::session::{
        AuthMode, RdpOptions, SavedSession, SessionType, SshContainerOptions, SshOptions,
        SshTunnel, SshTunnelKind,
    },
    services::{
        rdp_service::{
            build_mstsc_arguments, build_rdp_file_content, rdp_password_credential_target,
        },
        ssh_terminal_service::build_ssh_arguments,
    },
};

#[test]
fn ssh_arguments_include_tunnels_proxy_and_jump_hosts() {
    let session = SavedSession {
        id: "ssh-1".to_string(),
        name: "SSH".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "app.example.test".to_string(),
        port: 2222,
        username: "deploy".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("credential:ssh".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: Some(SshOptions {
            connect_timeout_ms: Some(15_000),
            keepalive_interval_ms: Some(30_000),
            proxy_command: Some("nc proxy 22".to_string()),
            identity_file: None,
            jump_hosts: vec!["jump-1".to_string(), "jump-2".to_string()],
            tunnels: vec![
                SshTunnel {
                    mode: Some("host_service".to_string()),
                    name: Some("PostgreSQL".to_string()),
                    kind: SshTunnelKind::Local,
                    auto_open: true,
                    bind_address: Some("127.0.0.1".to_string()),
                    local_port: Some(15432),
                    remote_host: Some("db.internal".to_string()),
                    remote_port: Some(5432),
                },
                SshTunnel {
                    mode: Some("local_service".to_string()),
                    name: Some("Web".to_string()),
                    kind: SshTunnelKind::Remote,
                    auto_open: true,
                    bind_address: Some("0.0.0.0".to_string()),
                    local_port: Some(18080),
                    remote_host: Some("127.0.0.1".to_string()),
                    remote_port: Some(8080),
                },
                SshTunnel {
                    mode: Some("socks".to_string()),
                    name: Some("Local SOCKS".to_string()),
                    kind: SshTunnelKind::Dynamic,
                    auto_open: true,
                    bind_address: Some("127.0.0.1".to_string()),
                    local_port: Some(1080),
                    remote_host: None,
                    remote_port: None,
                },
            ],
            container: None,
        }),
        rdp_options: None,
        local_options: None,
    };

    let args = build_ssh_arguments(&session).expect("ssh args should build");

    assert!(args.iter().any(|arg| arg == "-tt"));
    assert!(has_arg_pair(&args, "-p", "2222"));
    assert!(has_arg_pair(&args, "-J", "jump-1,jump-2"));
    assert!(has_arg_pair(&args, "-o", "ProxyCommand=nc proxy 22"));
    assert!(has_arg_pair(
        &args,
        "-L",
        "127.0.0.1:15432:db.internal:5432"
    ));
    assert!(has_arg_pair(&args, "-R", "0.0.0.0:18080:127.0.0.1:8080"));
    assert!(has_arg_pair(&args, "-D", "127.0.0.1:1080"));
    assert_eq!(
        args.last().map(String::as_str),
        Some("deploy@app.example.test")
    );
}

#[test]
fn ssh_key_auth_uses_selected_identity_file() {
    let session = SavedSession {
        id: "ssh-key".to_string(),
        name: "SSH Key".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "app.example.test".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_mode: AuthMode::Key,
        credential_ref: Some("credential:ssh-key-passphrase".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: Some(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: Some("C:\\Users\\ops\\.ssh\\id_ed25519".to_string()),
            jump_hosts: vec![],
            tunnels: vec![],
            container: None,
        }),
        rdp_options: None,
        local_options: None,
    };

    let args = build_ssh_arguments(&session).expect("ssh args should build");

    assert!(has_arg_pair(
        &args,
        "-i",
        "C:\\Users\\ops\\.ssh\\id_ed25519"
    ));
    assert!(has_arg_pair(
        &args,
        "-o",
        "PreferredAuthentications=publickey"
    ));
}

#[test]
fn ssh_arguments_include_remote_dynamic_socks_tunnel() {
    let session = SavedSession {
        id: "ssh-remote-socks".to_string(),
        name: "SSH Remote SOCKS".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "app.example.test".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("credential:ssh".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: Some(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: vec![],
            tunnels: vec![SshTunnel {
                mode: Some("socks".to_string()),
                name: Some("主机 SOCKS".to_string()),
                kind: SshTunnelKind::RemoteDynamic,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(11080),
                remote_host: None,
                remote_port: None,
            }],
            container: None,
        }),
        rdp_options: None,
        local_options: None,
    };

    let args = build_ssh_arguments(&session).expect("ssh args should build");

    assert!(has_arg_pair(&args, "-R", "127.0.0.1:11080"));
    assert!(!has_arg_pair(&args, "-D", "127.0.0.1:11080"));
}

#[test]
fn ssh_arguments_skip_tunnels_not_marked_auto_open_and_enter_container() {
    let session = SavedSession {
        id: "ssh-container".to_string(),
        name: "SSH Container".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "app.example.test".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_mode: AuthMode::Agent,
        credential_ref: None,
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: Some(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: vec![],
            tunnels: vec![
                SshTunnel {
                    mode: Some("host_service".to_string()),
                    name: Some("Disabled DB".to_string()),
                    kind: SshTunnelKind::Local,
                    auto_open: false,
                    bind_address: Some("127.0.0.1".to_string()),
                    local_port: Some(15432),
                    remote_host: Some("db.internal".to_string()),
                    remote_port: Some(5432),
                },
                SshTunnel {
                    mode: Some("socks".to_string()),
                    name: Some("Local SOCKS".to_string()),
                    kind: SshTunnelKind::Dynamic,
                    auto_open: true,
                    bind_address: Some("127.0.0.1".to_string()),
                    local_port: Some(1080),
                    remote_host: None,
                    remote_port: None,
                },
            ],
            container: Some(SshContainerOptions {
                enabled: true,
                runtime: "podman".to_string(),
                container: "api".to_string(),
                shell: Some("/bin/bash".to_string()),
                user: Some("app".to_string()),
                workdir: Some("/srv/app".to_string()),
            }),
        }),
        rdp_options: None,
        local_options: None,
    };

    let args = build_ssh_arguments(&session).expect("ssh args should build");

    assert!(!has_arg_pair(
        &args,
        "-L",
        "127.0.0.1:15432:db.internal:5432"
    ));
    assert!(has_arg_pair(&args, "-D", "127.0.0.1:1080"));
    assert_eq!(args[args.len() - 2], "deploy@app.example.test");
    assert_eq!(
        args.last().map(String::as_str),
        Some("podman exec -it --user app --workdir /srv/app api /bin/bash")
    );
}

#[test]
fn rdp_arguments_target_mstsc_with_saved_options() {
    let session = SavedSession {
        id: "rdp-1".to_string(),
        name: "Office".to_string(),
        session_type: SessionType::Rdp,
        group_id: None,
        host: "rdp.example.test".to_string(),
        port: 3390,
        username: "ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("credential:rdp".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: None,
        rdp_options: Some(RdpOptions {
            domain: Some("CORP".to_string()),
            width: 1440,
            height: 900,
            color_depth: 24,
            redirect_clipboard: true,
            fullscreen: false,
        }),
        local_options: None,
    };

    let args = build_mstsc_arguments(&session).expect("rdp args should build");

    assert_eq!(args.program, "mstsc.exe");
    assert_eq!(args.args[0], "/v:rdp.example.test:3390");
    assert!(args.args.contains(&"/w:1440".to_string()));
    assert!(args.args.contains(&"/h:900".to_string()));
    assert!(args.args.contains(&"/bpp:24".to_string()));
}

#[test]
fn rdp_file_content_includes_connection_display_and_password_fields() {
    let session = SavedSession {
        id: "rdp-1".to_string(),
        name: "Office".to_string(),
        session_type: SessionType::Rdp,
        group_id: None,
        host: "rdp.example.test".to_string(),
        port: 3390,
        username: "CORP\\ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("credential:rdp".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: None,
        rdp_options: Some(RdpOptions {
            domain: Some("CORP".to_string()),
            width: 1440,
            height: 900,
            color_depth: 24,
            redirect_clipboard: true,
            fullscreen: false,
        }),
        local_options: None,
    };

    let content = build_rdp_file_content(&session).expect("rdp content should build");

    assert!(content.contains("full address:s:rdp.example.test:3390"));
    assert!(content.contains("username:s:CORP\\ops"));
    assert!(content.contains("prompt for credentials:i:0"));
    assert!(content.contains("promptcredentialonce:i:1"));
    assert!(content.contains("desktopwidth:i:1440"));
    assert!(content.contains("desktopheight:i:900"));
    assert!(content.contains("session bpp:i:24"));
    assert!(content.contains("redirectclipboard:i:1"));
    assert!(!content.contains("password 51:b:"));
    assert!(!content.contains("encrypted-password"));
}

#[test]
fn rdp_file_content_prompts_when_no_password_credential_exists() {
    let session = SavedSession {
        id: "rdp-no-password".to_string(),
        name: "Office".to_string(),
        session_type: SessionType::Rdp,
        group_id: None,
        host: "rdp.example.test".to_string(),
        port: 3389,
        username: "ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: None,
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: None,
        rdp_options: Some(RdpOptions {
            domain: None,
            width: 1440,
            height: 900,
            color_depth: 24,
            redirect_clipboard: true,
            fullscreen: false,
        }),
        local_options: None,
    };

    let content = build_rdp_file_content(&session).expect("rdp content should build");

    assert!(content.contains("prompt for credentials:i:1"));
    assert!(!content.contains("password 51:b:"));
}

#[test]
fn rdp_password_credential_target_matches_rdp_full_address() {
    let session = SavedSession {
        id: "rdp-credential".to_string(),
        name: "Office".to_string(),
        session_type: SessionType::Rdp,
        group_id: None,
        host: "2001:db8::1".to_string(),
        port: 3390,
        username: "ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("credential:rdp".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        last_used_at_ms: None,
        ssh_options: None,
        rdp_options: Some(RdpOptions {
            domain: None,
            width: 1440,
            height: 900,
            color_depth: 24,
            redirect_clipboard: true,
            fullscreen: false,
        }),
        local_options: None,
    };

    assert_eq!(
        rdp_password_credential_target(&session).expect("target should build"),
        "TERMSRV/[2001:db8::1]:3390"
    );
}

fn has_arg_pair(args: &[String], key: &str, value: &str) -> bool {
    args.windows(2)
        .any(|window| window[0] == key && window[1] == value)
}
