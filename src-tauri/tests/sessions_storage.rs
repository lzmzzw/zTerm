// Author: Liz
use zterm_lib::{
    error::AppError,
    models::session::{
        AuthMode, LocalEnvironmentVariable, LocalOptions, RdpOptions, SavedSessionDraft,
        SessionGroupDraft, SessionType, SshContainerOptions, SshOptions, SshTunnel, SshTunnelKind,
    },
    storage::{
        sessions::{delete_session_group, list_sessions, save_session, save_session_group},
        sqlite::SqliteStore,
    },
};

fn group_draft(name: &str) -> SessionGroupDraft {
    SessionGroupDraft {
        id: None,
        parent_id: None,
        name: name.to_string(),
        expanded: true,
        sort_order: 0,
    }
}

fn ssh_draft(group_id: Option<String>) -> SavedSessionDraft {
    SavedSessionDraft {
        id: None,
        name: "生产跳板机".to_string(),
        session_type: SessionType::Ssh,
        group_id,
        host: "10.0.0.10".to_string(),
        port: 22,
        username: "deploy".to_string(),
        auth_mode: AuthMode::Key,
        credential_ref: Some("cred-prod".to_string()),
        description: None,
        tags: vec!["prod".to_string(), "ops".to_string()],
        sort_order: 0,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
    }
}

fn rdp_draft() -> SavedSessionDraft {
    SavedSessionDraft {
        id: None,
        name: "办公 RDP".to_string(),
        session_type: SessionType::Rdp,
        group_id: None,
        host: "rdp.example.test".to_string(),
        port: 3389,
        username: "ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("cred-rdp".to_string()),
        description: None,
        tags: vec!["windows".to_string()],
        sort_order: 1,
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
    }
}

fn local_draft() -> SavedSessionDraft {
    SavedSessionDraft {
        id: None,
        name: "本机 PowerShell".to_string(),
        session_type: SessionType::Local,
        group_id: None,
        host: "localhost".to_string(),
        port: 1,
        username: String::new(),
        auth_mode: AuthMode::None,
        credential_ref: None,
        description: None,
        tags: vec!["local".to_string()],
        sort_order: 2,
        ssh_options: None,
        rdp_options: None,
        local_options: Some(LocalOptions {
            profile_id: Some("pwsh".to_string()),
            working_directory: Some("C:\\Users\\ops".to_string()),
            environment: vec![LocalEnvironmentVariable {
                name: "ZTERM_ENV".to_string(),
                value: "enabled".to_string(),
            }],
        }),
    }
}

#[test]
fn sessions_can_save_and_list_ssh_and_rdp_entries() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let group = save_session_group(&store, group_draft("生产环境")).expect("group should save");

    let ssh =
        save_session(&store, ssh_draft(Some(group.id.clone()))).expect("ssh session should save");
    let rdp = save_session(&store, rdp_draft()).expect("rdp session should save");
    let list = list_sessions(&store).expect("sessions should list");

    assert_eq!(list.groups, vec![group]);
    assert_eq!(list.sessions.len(), 2);
    assert!(list.sessions.iter().any(|session| {
        session.id == ssh.id
            && session.name == "生产跳板机"
            && session.session_type == SessionType::Ssh
            && session.tags == ["prod", "ops"]
    }));
    assert!(list.sessions.iter().any(|session| {
        session.id == rdp.id
            && session.session_type == SessionType::Rdp
            && session.rdp_options.as_ref().is_some_and(|options| {
                options.domain.as_deref() == Some("CORP") && options.redirect_clipboard
            })
    }));
}

#[test]
fn sessions_can_save_local_entries_and_ssh_tunnels() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let mut ssh_draft = ssh_draft(None);
    ssh_draft.ssh_options = Some(SshOptions {
        connect_timeout_ms: Some(10_000),
        keepalive_interval_ms: Some(30_000),
        proxy_command: Some("nc jump 22".to_string()),
        identity_file: None,
        jump_hosts: vec!["jump-1".to_string(), "jump-2".to_string()],
        tunnels: vec![
            SshTunnel {
                mode: Some("host_service".to_string()),
                name: Some("PostgreSQL 隧道".to_string()),
                kind: SshTunnelKind::Local,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(15432),
                remote_host: Some("db.internal".to_string()),
                remote_port: Some(5432),
            },
            SshTunnel {
                mode: Some("socks".to_string()),
                name: Some("本机 SOCKS".to_string()),
                kind: SshTunnelKind::Dynamic,
                auto_open: false,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(1080),
                remote_host: None,
                remote_port: None,
            },
        ],
        container: Some(SshContainerOptions {
            enabled: true,
            runtime: "docker".to_string(),
            container: "api".to_string(),
            shell: Some("/bin/sh".to_string()),
            user: Some("app".to_string()),
            workdir: Some("/srv/app".to_string()),
        }),
    });

    let ssh = save_session(&store, ssh_draft).expect("ssh session with tunnels should save");
    let local = save_session(&store, local_draft()).expect("local session should save");
    let list = list_sessions(&store).expect("sessions should list");

    let listed_ssh = list
        .sessions
        .iter()
        .find(|session| session.id == ssh.id)
        .expect("ssh session should list");
    assert_eq!(
        listed_ssh
            .ssh_options
            .as_ref()
            .expect("ssh options should persist")
            .tunnels
            .len(),
        2
    );
    assert_eq!(
        listed_ssh
            .ssh_options
            .as_ref()
            .expect("ssh options should persist")
            .tunnels[0]
            .name
            .as_deref(),
        Some("PostgreSQL 隧道")
    );
    assert_eq!(
        listed_ssh
            .ssh_options
            .as_ref()
            .expect("ssh options should persist")
            .tunnels[0]
            .mode
            .as_deref(),
        Some("host_service")
    );
    assert_eq!(
        listed_ssh
            .ssh_options
            .as_ref()
            .expect("ssh options should persist")
            .jump_hosts,
        ["jump-1", "jump-2"]
    );

    let listed_local = list
        .sessions
        .iter()
        .find(|session| session.id == local.id)
        .expect("local session should list");
    assert_eq!(listed_local.session_type, SessionType::Local);
    assert_eq!(
        listed_local
            .local_options
            .as_ref()
            .and_then(|options| options.profile_id.as_deref()),
        Some("pwsh")
    );
    assert_eq!(
        listed_local
            .local_options
            .as_ref()
            .expect("local options should persist")
            .environment,
        [LocalEnvironmentVariable {
            name: "ZTERM_ENV".to_string(),
            value: "enabled".to_string()
        }]
    );
    assert_eq!(
        listed_ssh
            .ssh_options
            .as_ref()
            .and_then(|options| options.container.as_ref())
            .map(|container| container.container.as_str()),
        Some("api")
    );
}

#[test]
fn non_empty_group_delete_returns_validation_error() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let group = save_session_group(&store, group_draft("生产环境")).expect("group should save");
    save_session(&store, ssh_draft(Some(group.id.clone()))).expect("ssh session should save");

    let error =
        delete_session_group(&store, &group.id).expect_err("non-empty group should not delete");

    assert!(matches!(error, AppError::Validation(message) if message.contains("分组下仍有会话")));
}
