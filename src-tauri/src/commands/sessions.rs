// Author: Liz
use std::{collections::HashMap, fs, path::Path, time::Duration};

use serde::Serialize;
use tauri::State;
use tokio::net::TcpStream;

use crate::{
    error::{AppError, AppResult},
    models::session::{
        AuthMode, DeleteResult, SavedSession, SavedSessionDraft, SessionGroup, SessionGroupDraft,
        SessionTestResult, SessionType, SessionsList,
    },
    services::{
        credential_service::CredentialService,
        ftp_service,
        ssh_command_service::{SshCommandSecretResolver, SshCommandService},
    },
    state::AppState,
    storage::sessions::{
        delete_session, delete_session_group, list_sessions, save_session, save_session_group,
    },
};

const SESSION_TEST_SCRIPT: &str = "printf zterm-session-test";
const SESSION_TEST_EXPECTED_OUTPUT: &str = "zterm-session-test";
const TRANSIENT_SESSION_TEST_CREDENTIAL_REF: &str = "__zterm_session_test_secret__";
const RDP_TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize)]
pub struct SessionsExportResult {
    pub path: String,
    pub exported_records: usize,
}

#[tauri::command]
pub fn sessions_list(state: State<'_, AppState>) -> AppResult<SessionsList> {
    let storage = state.storage();
    list_sessions(storage.as_ref())
}

#[tauri::command]
pub fn sessions_save_group(
    state: State<'_, AppState>,
    draft: SessionGroupDraft,
) -> AppResult<SessionGroup> {
    let storage = state.storage();
    save_session_group(storage.as_ref(), draft)
}

#[tauri::command]
pub fn sessions_delete_group(state: State<'_, AppState>, id: String) -> AppResult<DeleteResult> {
    let storage = state.storage();
    delete_session_group(storage.as_ref(), &id)
}

#[tauri::command]
pub fn sessions_save_session(
    state: State<'_, AppState>,
    draft: SavedSessionDraft,
) -> AppResult<SavedSession> {
    let storage = state.storage();
    let session = save_session(storage.as_ref(), draft)?;
    state
        .ssh_command_service()
        .evict_reusable_connections_for_session(&session.id);
    state
        .sftp_service()
        .evict_cached_sessions_for_session(&session.id);
    Ok(session)
}

#[tauri::command]
pub fn sessions_delete_session(state: State<'_, AppState>, id: String) -> AppResult<DeleteResult> {
    let storage = state.storage();
    let result = delete_session(storage.as_ref(), &id)?;
    state
        .ssh_command_service()
        .evict_reusable_connections_for_session(&id);
    state.sftp_service().evict_cached_sessions_for_session(&id);
    Ok(result)
}

/// Reads secrets only while writing the selected CSV. They never cross IPC or enter logs.
#[tauri::command]
pub fn sessions_export_csv(
    state: State<'_, AppState>,
    target_path: String,
) -> AppResult<SessionsExportResult> {
    let path = Path::new(target_path.trim());
    if path
        .extension()
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("csv"))
    {
        return Err(AppError::validation("导出文件必须使用 .csv 扩展名"));
    }
    let parent = path
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| AppError::validation("导出目录不存在"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| AppError::terminal(format!("无法访问导出目录: {error}")))?;
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::validation("导出文件名不能为空"))?;
    let output_path = canonical_parent.join(file_name);
    let snapshot = list_sessions(state.storage().as_ref())?;
    let credential_service = state.credential_service();
    let csv = build_sessions_csv(&snapshot, |credential_ref| {
        credential_service.read_secret(credential_ref)
    })?;
    fs::write(&output_path, csv)
        .map_err(|error| AppError::terminal(format!("写入 CSV 导出文件失败: {error}")))?;
    Ok(SessionsExportResult {
        path: output_path.to_string_lossy().to_string(),
        exported_records: snapshot.groups.len() + snapshot.sessions.len(),
    })
}

fn build_sessions_csv(
    snapshot: &SessionsList,
    mut read_secret: impl FnMut(&str) -> AppResult<String>,
) -> AppResult<String> {
    let groups = snapshot
        .groups
        .iter()
        .map(|group| {
            (
                group.id.as_str(),
                (group.name.as_str(), group.parent_id.as_deref()),
            )
        })
        .collect::<HashMap<_, _>>();
    let mut csv =
        String::from("\u{feff}记录类型,分组,连接,操作系统,账户,密码,主机,端口,认证方式\r\n");
    for group in &snapshot.groups {
        write_csv_row(
            &mut csv,
            [
                "分组".to_string(),
                group_path(&group.id, &groups),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ],
        );
    }
    for session in &snapshot.sessions {
        let password = match session
            .credential_ref
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            Some(credential_ref) => read_secret(credential_ref).map_err(|error| {
                AppError::credential(format!("无法导出连接“{}”的密码: {error}", session.name))
            })?,
            None => String::new(),
        };
        write_csv_row(
            &mut csv,
            [
                "连接".to_string(),
                session
                    .group_id
                    .as_deref()
                    .map(|id| group_path(id, &groups))
                    .unwrap_or_default(),
                session.name.clone(),
                session.session_type.as_str().to_ascii_uppercase(),
                session.username.clone(),
                password,
                session.host.clone(),
                session.port.to_string(),
                session.auth_mode.as_str().to_string(),
            ],
        );
    }
    Ok(csv)
}

fn group_path(group_id: &str, groups: &HashMap<&str, (&str, Option<&str>)>) -> String {
    let mut names = Vec::new();
    let mut current = Some(group_id);
    let mut visited = std::collections::HashSet::new();
    while let Some(id) = current {
        if !visited.insert(id) {
            break;
        }
        let Some((name, parent_id)) = groups.get(id) else {
            break;
        };
        names.push(*name);
        current = *parent_id;
    }
    names.reverse();
    names.join("/")
}

fn write_csv_row<const N: usize>(output: &mut String, values: [String; N]) {
    output.push_str(
        &values
            .into_iter()
            .map(|value| format!("\"{}\"", value.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(","),
    );
    output.push_str("\r\n");
}

#[tauri::command]
pub async fn sessions_test_connection(
    state: State<'_, AppState>,
    draft: SavedSessionDraft,
    secret: Option<String>,
) -> AppResult<SessionTestResult> {
    let storage = state.storage();
    let credential_service = state.credential_service();
    let ssh_command_service = state.ssh_command_service();
    match draft.session_type {
        SessionType::Ssh | SessionType::Sftp => {
            let mut session = save_preview_session(draft)?;
            apply_transient_test_secret(&mut session, secret.as_deref());
            let all_sessions = list_sessions(storage.as_ref())?.sessions;
            test_ssh_connection(
                &ssh_command_service,
                &credential_service,
                &session,
                &all_sessions,
                secret,
            )
            .await
        }
        SessionType::Rdp => {
            let mut session = save_preview_session(draft)?;
            apply_transient_test_secret(&mut session, secret.as_deref());
            test_rdp_connection(&session, credential_service, secret).await
        }
        SessionType::Local => {
            let profiles =
                crate::services::terminal_profile_service::list_or_detect_terminal_profiles(
                    storage.as_ref(),
                )?;
            test_local_connection(&save_preview_session(draft)?, profiles)
        }
        SessionType::Ftp => {
            test_ftp_connection(&save_preview_session(draft)?, credential_service, secret).await
        }
    }
}

async fn test_ssh_connection(
    ssh_command_service: &SshCommandService,
    credential_service: &CredentialService,
    session: &SavedSession,
    all_sessions: &[SavedSession],
    secret: Option<String>,
) -> AppResult<SessionTestResult> {
    let resolver = SessionTestSecretResolver::new(Some(credential_service.clone()), secret);
    match ssh_command_service
        .execute(
            session,
            all_sessions,
            SESSION_TEST_SCRIPT.to_string(),
            &resolver,
        )
        .await
    {
        Ok(output)
            if output.success
                && output
                    .stdout
                    .trim_end()
                    .ends_with(SESSION_TEST_EXPECTED_OUTPUT) =>
        {
            let protocol = if session.session_type == SessionType::Sftp {
                "SFTP"
            } else {
                "SSH"
            };
            Ok(SessionTestResult {
                ok: true,
                message: format!("{protocol} 真实连接测试通过"),
            })
        }
        Ok(output) => Ok(SessionTestResult {
            ok: false,
            message: format!(
                "{} 已连接但测试命令返回异常，退出码 {}",
                if session.session_type == SessionType::Sftp {
                    "SFTP"
                } else {
                    "SSH"
                },
                output
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "未知".to_string())
            ),
        }),
        Err(error) => Ok(SessionTestResult {
            ok: false,
            message: format!(
                "{} 真实连接测试失败：{error}",
                if session.session_type == SessionType::Sftp {
                    "SFTP"
                } else {
                    "SSH"
                }
            ),
        }),
    }
}

async fn test_ftp_connection(
    session: &SavedSession,
    credential_service: CredentialService,
    secret: Option<String>,
) -> AppResult<SessionTestResult> {
    ftp_service::test_connection(session, &credential_service, secret.as_deref()).await?;
    Ok(SessionTestResult {
        ok: true,
        message: "FTP 连接测试通过".to_string(),
    })
}

async fn test_rdp_connection(
    session: &SavedSession,
    credential_service: CredentialService,
    secret: Option<String>,
) -> AppResult<SessionTestResult> {
    crate::services::rdp_service::build_mstsc_arguments(session)?;
    if session.auth_mode == AuthMode::Password {
        validate_test_secret(session, &credential_service, secret.as_deref())?;
    }

    let host = required_text("RDP 主机", &session.host)?;
    if session.port == 0 {
        return Err(AppError::validation("RDP 端口必须大于 0"));
    }
    match tokio::time::timeout(
        RDP_TEST_TIMEOUT,
        TcpStream::connect((host.as_str(), session.port)),
    )
    .await
    {
        Ok(Ok(_stream)) => Ok(SessionTestResult {
            ok: true,
            message: "RDP 端口连通，凭据可读取；未启动 mstsc，登录有效性需由系统客户端确认"
                .to_string(),
        }),
        Ok(Err(error)) => Ok(SessionTestResult {
            ok: false,
            message: format!("RDP 端口连接失败：{error}"),
        }),
        Err(_) => Ok(SessionTestResult {
            ok: false,
            message: "RDP 端口连接超时".to_string(),
        }),
    }
}

fn test_local_connection(
    session: &SavedSession,
    profiles: Vec<crate::models::terminal_profile::TerminalProfile>,
) -> AppResult<SessionTestResult> {
    let Some(profile) = select_test_terminal_profile(session, profiles) else {
        return Ok(SessionTestResult {
            ok: false,
            message: "未检测到可用本机终端".to_string(),
        });
    };
    if !Path::new(&profile.path).is_file() {
        return Ok(SessionTestResult {
            ok: false,
            message: format!("本机终端可执行文件不存在：{}", profile.path),
        });
    }
    if let Some(working_directory) = session
        .local_options
        .as_ref()
        .and_then(|options| options.working_directory.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !Path::new(working_directory).is_dir() {
            return Ok(SessionTestResult {
                ok: false,
                message: format!("本机工作目录不存在：{working_directory}"),
            });
        }
    }
    Ok(SessionTestResult {
        ok: true,
        message: format!("本机终端可执行文件可用：{}", profile.name),
    })
}

fn select_test_terminal_profile(
    session: &SavedSession,
    profiles: Vec<crate::models::terminal_profile::TerminalProfile>,
) -> Option<crate::models::terminal_profile::TerminalProfile> {
    let requested_profile_id = session
        .local_options
        .as_ref()
        .and_then(|options| options.profile_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(profile_id) = requested_profile_id {
        return profiles
            .into_iter()
            .find(|profile| profile.id == profile_id);
    }
    profiles
        .iter()
        .find(|profile| profile.is_default)
        .cloned()
        .or_else(|| profiles.into_iter().next())
}

fn apply_transient_test_secret(session: &mut SavedSession, secret: Option<&str>) {
    let Some(secret) = secret.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let _ = secret;
    if matches!(session.auth_mode, AuthMode::Password | AuthMode::Key) {
        session.credential_ref = Some(TRANSIENT_SESSION_TEST_CREDENTIAL_REF.to_string());
    }
}

fn validate_test_secret(
    session: &SavedSession,
    credential_service: &CredentialService,
    secret: Option<&str>,
) -> AppResult<()> {
    if secret.map(str::trim).is_some_and(|value| !value.is_empty()) {
        return Ok(());
    }
    let credential_ref = session
        .credential_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("密码认证需要凭据引用或本次测试密码"))?;
    credential_service.read_secret(credential_ref).map(|_| ())
}

struct SessionTestSecretResolver {
    credential_service: Option<CredentialService>,
    transient_secret: Option<String>,
}

impl SessionTestSecretResolver {
    fn new(
        credential_service: Option<CredentialService>,
        transient_secret: Option<String>,
    ) -> Self {
        Self {
            credential_service,
            transient_secret,
        }
    }
}

impl SshCommandSecretResolver for SessionTestSecretResolver {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
        if credential_ref == TRANSIENT_SESSION_TEST_CREDENTIAL_REF {
            return self
                .transient_secret
                .as_ref()
                .map(|secret| secret.to_string())
                .ok_or_else(|| AppError::credential("本次测试密码为空"));
        }
        self.credential_service
            .as_ref()
            .ok_or_else(|| AppError::credential("当前无法读取凭据"))?
            .read_secret(credential_ref)
    }
}

fn required_text(label: &str, value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn save_preview_session(draft: SavedSessionDraft) -> AppResult<SavedSession> {
    Ok(SavedSession {
        id: draft.id.unwrap_or_else(|| "preview".to_string()),
        name: draft.name,
        session_type: draft.session_type,
        group_id: draft.group_id,
        host: if draft.host.trim().is_empty() {
            "localhost".to_string()
        } else {
            draft.host
        },
        port: draft.port,
        username: draft.username,
        auth_mode: draft.auth_mode,
        credential_ref: draft.credential_ref,
        description: draft.description,
        tags: draft.tags,
        sort_order: draft.sort_order,
        created_at_ms: 0,
        updated_at_ms: 0,
        last_used_at_ms: None,
        ssh_options: draft.ssh_options,
        rdp_options: draft.rdp_options,
        local_options: draft.local_options,
        ftp_options: draft.ftp_options,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::{
        error::AppError,
        models::session::{
            AuthMode, RdpOptions, SavedSessionDraft, SessionGroup, SessionType, SessionsList,
            SshOptions,
        },
        services::{
            credential_service::CredentialService, ssh_command_service::SshCommandSecretResolver,
        },
        storage::sqlite::SqliteStore,
    };

    #[test]
    fn session_test_secret_resolver_prefers_transient_secret() {
        let resolver = SessionTestSecretResolver::new(None, Some("transient-password".to_string()));

        assert_eq!(
            resolver
                .secret_for(TRANSIENT_SESSION_TEST_CREDENTIAL_REF)
                .expect("transient secret should resolve"),
            "transient-password"
        );
    }

    #[test]
    fn session_test_secret_resolver_rejects_missing_transient_secret() {
        let resolver = SessionTestSecretResolver::new(None, None);

        let error = resolver
            .secret_for(TRANSIENT_SESSION_TEST_CREDENTIAL_REF)
            .expect_err("missing transient secret should fail");
        assert!(matches!(error, AppError::Credential(_)));
    }

    #[test]
    fn csv_export_includes_groups_connections_and_keyring_secrets() {
        let session = save_preview_session(SavedSessionDraft {
            id: Some("session-1".to_string()),
            name: "主机,一".to_string(),
            session_type: SessionType::Ssh,
            group_id: Some("child".to_string()),
            host: "host.example.test".to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_mode: AuthMode::Password,
            credential_ref: Some("credential:session-1".to_string()),
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        })
        .expect("session should build");
        let snapshot = SessionsList {
            groups: vec![
                SessionGroup {
                    id: "root".to_string(),
                    parent_id: None,
                    name: "生产".to_string(),
                    expanded: true,
                    sort_order: 0,
                    created_at_ms: 0,
                    updated_at_ms: 0,
                },
                SessionGroup {
                    id: "child".to_string(),
                    parent_id: Some("root".to_string()),
                    name: "数据库".to_string(),
                    expanded: true,
                    sort_order: 1,
                    created_at_ms: 0,
                    updated_at_ms: 0,
                },
            ],
            sessions: vec![session],
        };

        let csv = build_sessions_csv(&snapshot, |credential_ref| {
            assert_eq!(credential_ref, "credential:session-1");
            Ok("p@ss\"word".to_string())
        })
        .expect("CSV should build");

        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("\"生产/数据库\""));
        assert!(csv.contains("\"主机,一\""));
        assert!(csv.contains("\"p@ss\"\"word\""));
    }

    #[tokio::test]
    async fn rdp_connection_test_uses_real_tcp_endpoint() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let port = listener
            .local_addr()
            .expect("test listener should have local addr")
            .port();
        let accept = tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let mut draft = SavedSessionDraft {
            id: None,
            name: "RDP".to_string(),
            session_type: SessionType::Rdp,
            group_id: None,
            host: "127.0.0.1".to_string(),
            port,
            username: "ops".to_string(),
            auth_mode: AuthMode::Password,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: Some(RdpOptions {
                domain: None,
                width: 1280,
                height: 720,
                color_depth: 24,
                redirect_clipboard: true,
                fullscreen: false,
            }),
            local_options: None,
            ftp_options: None,
        };
        draft.ssh_options = Some(SshOptions {
            connect_timeout_ms: Some(100),
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: Vec::new(),
            container: None,
        });
        let session = save_preview_session(draft).expect("preview session should build");
        let credential_service = CredentialService::new(Arc::new(
            SqliteStore::open_in_memory().expect("sqlite store should open"),
        ));

        let result = test_rdp_connection(
            &session,
            credential_service,
            Some("rdp-password".to_string()),
        )
        .await;
        accept.await.expect("accept task should finish");

        assert!(result.expect("rdp test should return result").ok);
    }
}
