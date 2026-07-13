// Author: Liz
use zterm_lib::{
    models::session::{AuthMode, SavedSession, SessionType, SshOptions},
    services::sftp_service::{
        build_sftp_auth_material, build_sftp_cache_key, local_root_directories,
        numbered_conflict_candidate_name, sftp_uses_cached_session_for, SftpAuthMaterial,
        SftpOperationKind,
    },
};

#[test]
fn sftp_cache_key_tracks_safe_session_fingerprint_without_secrets() {
    let mut session = ssh_session("sftp-1", "files.example.test", "ops");
    session.updated_at_ms = 100;
    session.credential_ref = Some("credential:sftp-password".to_string());
    session.ssh_options = Some(SshOptions {
        connect_timeout_ms: Some(15_000),
        keepalive_interval_ms: Some(30_000),
        proxy_command: None,
        identity_file: Some("C:/Users/Ops/.ssh/id_ed25519".to_string()),
        jump_hosts: vec!["jump".to_string()],
        tunnels: Vec::new(),
        container: None,
    });

    let key = build_sftp_cache_key(&session).expect("sftp cache key should build");
    assert_eq!(
        key,
        build_sftp_cache_key(&session).expect("same session should build the same key")
    );

    let mut changed_host = session.clone();
    changed_host.host = "files-2.example.test".to_string();
    assert_ne!(
        key,
        build_sftp_cache_key(&changed_host).expect("changed host should build")
    );

    let mut changed_update = session.clone();
    changed_update.updated_at_ms = 101;
    assert_ne!(
        key,
        build_sftp_cache_key(&changed_update).expect("changed update should build")
    );

    let mut changed_credential = session.clone();
    changed_credential.credential_ref = Some("credential:sftp-password-2".to_string());
    assert_ne!(
        key,
        build_sftp_cache_key(&changed_credential).expect("changed credential should build")
    );

    let key_text = format!("{key:?} {}", key.as_str());
    assert!(key_text.contains("credential:sftp-password"));
    assert!(!key_text.contains("sftp-password-secret"));
}

#[test]
fn sftp_short_operations_use_cache_but_transfers_use_dedicated_sessions() {
    assert!(sftp_uses_cached_session_for(SftpOperationKind::List));
    assert!(sftp_uses_cached_session_for(SftpOperationKind::CreateDir));
    assert!(sftp_uses_cached_session_for(SftpOperationKind::Rename));
    assert!(sftp_uses_cached_session_for(SftpOperationKind::Delete));
    assert!(!sftp_uses_cached_session_for(SftpOperationKind::Upload));
    assert!(!sftp_uses_cached_session_for(SftpOperationKind::Download));
}

#[test]
fn sftp_key_auth_material_requires_identity_file_and_accepts_agent() {
    let mut key_session = ssh_session("sftp-key", "files.example.test", "ops");
    key_session.auth_mode = AuthMode::Key;
    let missing_identity = build_sftp_auth_material(&key_session)
        .expect_err("key auth without identity_file should fail before connecting");
    assert!(missing_identity.to_string().contains("identity_file"));

    key_session.ssh_options = Some(SshOptions {
        connect_timeout_ms: None,
        keepalive_interval_ms: None,
        proxy_command: None,
        identity_file: Some("C:/Users/Ops/.ssh/id_ed25519".to_string()),
        jump_hosts: Vec::new(),
        tunnels: Vec::new(),
        container: None,
    });
    assert_eq!(
        build_sftp_auth_material(&key_session).expect("key auth material should build"),
        SftpAuthMaterial::PrivateKey {
            identity_file: "C:/Users/Ops/.ssh/id_ed25519".into(),
            passphrase: None,
        },
    );

    let mut agent_session = key_session;
    agent_session.auth_mode = AuthMode::Agent;
    assert_eq!(
        build_sftp_auth_material(&agent_session).expect("agent auth material should build"),
        SftpAuthMaterial::Agent,
    );
}

#[test]
fn sftp_auth_material_does_not_reject_jump_or_proxy_options() {
    let mut session = ssh_session("sftp-jump", "files.example.test", "ops");
    session.auth_mode = AuthMode::None;
    session.ssh_options = Some(SshOptions {
        connect_timeout_ms: None,
        keepalive_interval_ms: None,
        proxy_command: Some("ssh -W %h:%p jump".to_string()),
        identity_file: None,
        jump_hosts: Vec::new(),
        tunnels: Vec::new(),
        container: None,
    });
    assert_eq!(
        build_sftp_auth_material(&session).expect("proxy command should not be rejected here"),
        SftpAuthMaterial::None,
    );

    let mut jump_session = session;
    jump_session
        .ssh_options
        .as_mut()
        .expect("options")
        .proxy_command = None;
    jump_session
        .ssh_options
        .as_mut()
        .expect("options")
        .jump_hosts
        .push("jump".to_string());
    assert_eq!(
        build_sftp_auth_material(&jump_session).expect("jump host should not be rejected here"),
        SftpAuthMaterial::None,
    );
}

#[test]
fn conflict_candidate_names_preserve_file_extensions() {
    assert_eq!(
        numbered_conflict_candidate_name("deploy.tar.gz", 1),
        "deploy.tar (1).gz"
    );
    assert_eq!(numbered_conflict_candidate_name("logs", 2), "logs (2)");
    assert_eq!(numbered_conflict_candidate_name(".env", 3), ".env (3)");
}

#[test]
fn local_root_directories_only_returns_accessible_platform_roots() {
    let roots = local_root_directories().expect("local roots should resolve");

    #[cfg(windows)]
    {
        assert!(!roots.is_empty());
        assert!(roots.iter().all(|root| {
            root.len() == 3
                && root.ends_with("\\")
                && root.as_bytes()[0].is_ascii_alphabetic()
                && std::path::Path::new(root).is_dir()
        }));
    }

    #[cfg(not(windows))]
    assert_eq!(roots, vec!["/"]);
}

fn ssh_session(id: &str, host: &str, username: &str) -> SavedSession {
    SavedSession {
        id: id.to_string(),
        name: "SFTP".to_string(),
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
    }
}
