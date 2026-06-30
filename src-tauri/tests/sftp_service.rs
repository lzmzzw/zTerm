// Author: Liz
use zterm_lib::{
    models::session::{AuthMode, SavedSession, SessionType, SshOptions},
    services::sftp_service::{
        build_sftp_cache_key, sftp_uses_cached_session_for, SftpOperationKind,
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
