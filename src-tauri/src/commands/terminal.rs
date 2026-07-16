// Author: Liz
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::{
    error::{AppError, AppResult},
    models::{
        session::{AuthMode, SavedSession, SessionType},
        terminal::{
            RuntimeSessionInfo, TerminalAccepted, TerminalClosed, TerminalExitEvent,
            TerminalResized,
        },
    },
    services::{
        command_completion_service::CommandCompletionService,
        command_history_service::CommandHistoryService, credential_service::read_system_secret,
        external_launch_service::is_external_session_id, terminal_manager::TerminalManager,
        terminal_output_dispatcher::TerminalOutputDispatcher,
    },
    state::AppState,
    storage::{
        sessions::{get_session, list_sessions},
        sqlite::SqliteStore,
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthPromptSecret {
    target: String,
    secret: String,
}

impl AuthPromptSecret {
    fn new(target: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            target: target.into(),
            secret: secret.into(),
        }
    }
}

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, AppState>,
    saved_session_id: String,
    pane_id: String,
    working_directory: Option<String>,
) -> AppResult<RuntimeSessionInfo> {
    let storage = state.storage();
    let session = session_for_terminal(&state, &saved_session_id)?;
    let manager = state.terminal_manager();

    match session.session_type {
        SessionType::Local => {
            let local_options = local_options_with_working_directory(
                session.local_options.clone(),
                working_directory,
            );
            let profile =
                terminal_profile_for_session(state.storage().as_ref(), local_options.as_ref())?;
            let opened = manager.open_local_session(
                &profile,
                local_options.as_ref(),
                pane_id,
                Some(session.id.clone()),
                session.name.clone(),
                120,
                32,
            )?;
            let history = state.command_history_service();
            history.register_runtime(
                &opened.info.runtime_session_id,
                opened.info.saved_session_id.clone(),
                opened.info.history_scope_kind,
                opened.info.history_scope_id.clone(),
            );
            let completion = state.command_completion_service();
            completion.register_runtime(
                &opened.info.runtime_session_id,
                opened.info.kind,
                opened.info.saved_session_id.clone(),
                opened.info.history_scope_kind,
                opened.info.history_scope_id.clone(),
            );
            spawn_terminal_reader(
                app,
                manager,
                state.terminal_output_dispatcher(),
                history,
                completion,
                opened.info.runtime_session_id.clone(),
                opened.reader,
                Vec::new(),
            );
            Ok(opened.info)
        }
        SessionType::Rdp => {
            let process = crate::services::rdp_service::launch_mstsc(&session)?;
            manager.open_rdp_session(
                session.id,
                pane_id,
                session.name,
                process.child,
                Some(process.file_path),
            )
        }
        SessionType::Ssh => {
            let is_external = is_external_session_id(&session.id);
            let (session, mut auth_secrets) = if is_external {
                (session, Vec::new())
            } else {
                resolve_ssh_jump_context(storage.as_ref(), &session)?
            };
            let secrets = state
                .external_launch_service()
                .composite_secret_resolver(state.credential_service());
            let opened = manager.open_ssh_session_with_resolver(
                &session,
                pane_id,
                120,
                32,
                &secrets,
                !is_external,
            )?;
            if let Some(secret) = opened.auth_secret {
                auth_secrets.push(AuthPromptSecret::new(ssh_prompt_target(&session), secret));
            }
            let history = state.command_history_service();
            history.register_runtime(
                &opened.info.runtime_session_id,
                opened.info.saved_session_id.clone(),
                opened.info.history_scope_kind,
                opened.info.history_scope_id.clone(),
            );
            let completion = state.command_completion_service();
            completion.register_runtime(
                &opened.info.runtime_session_id,
                opened.info.kind,
                opened.info.saved_session_id.clone(),
                opened.info.history_scope_kind,
                opened.info.history_scope_id.clone(),
            );
            spawn_terminal_reader(
                app,
                manager,
                state.terminal_output_dispatcher(),
                history,
                completion,
                opened.info.runtime_session_id.clone(),
                opened.reader,
                auth_secrets,
            );
            Ok(opened.info)
        }
        SessionType::Ftp | SessionType::Sftp => {
            Err(AppError::unsupported("FTP/SFTP 会话请通过文件传输窗口打开"))
        }
    }
}

fn session_for_terminal(state: &State<'_, AppState>, session_id: &str) -> AppResult<SavedSession> {
    if let Some(session) = state.external_launch_service().get_session(session_id)? {
        return Ok(session);
    }
    get_session(state.storage().as_ref(), session_id)
}

#[tauri::command]
pub fn terminal_open_ssh_container(
    app: AppHandle,
    state: State<'_, AppState>,
    saved_session_id: String,
    pane_id: String,
    container_id: String,
    container_name: Option<String>,
) -> AppResult<RuntimeSessionInfo> {
    let storage = state.storage();
    let is_external = is_external_session_id(&saved_session_id);
    let session = session_for_terminal(&state, &saved_session_id)?;
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported("进入容器只支持 SSH 会话"));
    }
    let (session, mut auth_secrets) = if is_external {
        (session, Vec::new())
    } else {
        resolve_ssh_jump_context(storage.as_ref(), &session)?
    };
    let manager = state.terminal_manager();
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let opened = manager.open_ssh_container_session_with_resolver(
        &session,
        pane_id,
        container_id,
        container_name,
        120,
        32,
        &secrets,
        !is_external,
    )?;
    if let Some(secret) = opened.auth_secret {
        auth_secrets.push(AuthPromptSecret::new(ssh_prompt_target(&session), secret));
    }
    let history = state.command_history_service();
    history.register_runtime(
        &opened.info.runtime_session_id,
        opened.info.saved_session_id.clone(),
        opened.info.history_scope_kind,
        opened.info.history_scope_id.clone(),
    );
    let completion = state.command_completion_service();
    completion.register_runtime(
        &opened.info.runtime_session_id,
        opened.info.kind,
        opened.info.saved_session_id.clone(),
        opened.info.history_scope_kind,
        opened.info.history_scope_id.clone(),
    );
    spawn_terminal_reader(
        app,
        manager,
        state.terminal_output_dispatcher(),
        history,
        completion,
        opened.info.runtime_session_id.clone(),
        opened.reader,
        auth_secrets,
    );
    Ok(opened.info)
}

#[tauri::command]
pub fn terminal_open_default_local(
    app: AppHandle,
    state: State<'_, AppState>,
    pane_id: String,
    working_directory: Option<String>,
) -> AppResult<RuntimeSessionInfo> {
    let storage = state.storage();
    let profile = crate::services::terminal_profile_service::default_profile(storage.as_ref())?
        .ok_or_else(|| crate::error::AppError::validation("未检测到可用终端工具"))?;
    let manager = state.terminal_manager();
    let local_options = local_options_with_working_directory(None, working_directory);
    let opened = manager.open_local_session(
        &profile,
        local_options.as_ref(),
        pane_id,
        None,
        profile.name.clone(),
        120,
        32,
    )?;
    let history = state.command_history_service();
    history.register_runtime(
        &opened.info.runtime_session_id,
        None,
        opened.info.history_scope_kind,
        opened.info.history_scope_id.clone(),
    );
    let completion = state.command_completion_service();
    completion.register_runtime(
        &opened.info.runtime_session_id,
        opened.info.kind,
        opened.info.saved_session_id.clone(),
        opened.info.history_scope_kind,
        opened.info.history_scope_id.clone(),
    );
    spawn_terminal_reader(
        app,
        manager,
        state.terminal_output_dispatcher(),
        history,
        completion,
        opened.info.runtime_session_id.clone(),
        opened.reader,
        Vec::new(),
    );
    Ok(opened.info)
}

fn local_options_with_working_directory(
    options: Option<crate::models::session::LocalOptions>,
    working_directory: Option<String>,
) -> Option<crate::models::session::LocalOptions> {
    let working_directory = working_directory
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let Some(working_directory) = working_directory else {
        return options;
    };

    let mut options = options.unwrap_or(crate::models::session::LocalOptions {
        profile_id: None,
        working_directory: None,
        environment: Vec::new(),
    });
    options.working_directory = Some(working_directory);
    Some(options)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, AppState>,
    runtime_session_id: String,
    data: String,
) -> AppResult<TerminalAccepted> {
    let accepted = state.terminal_manager().write(&runtime_session_id, &data)?;
    state
        .command_history_service()
        .capture_input(&runtime_session_id, &data)?;
    Ok(accepted)
}

#[tauri::command]
pub fn terminal_write_bytes(
    state: State<'_, AppState>,
    runtime_session_id: String,
    data: Vec<u8>,
) -> AppResult<TerminalAccepted> {
    state
        .terminal_manager()
        .write_bytes(&runtime_session_id, &data)
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, AppState>,
    runtime_session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<TerminalResized> {
    state
        .terminal_manager()
        .resize(&runtime_session_id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(
    state: State<'_, AppState>,
    runtime_session_id: String,
    release_external_session: Option<bool>,
) -> AppResult<TerminalClosed> {
    let runtime_info = state
        .terminal_manager()
        .runtime_info(&runtime_session_id)
        .ok();
    let result = state.terminal_manager().close(&runtime_session_id)?;
    state
        .command_history_service()
        .unregister_runtime(&runtime_session_id);
    state
        .command_completion_service()
        .unregister_runtime(&runtime_session_id);
    if let Some(saved_session_id) = runtime_info.and_then(|info| info.saved_session_id) {
        if is_external_session_id(&saved_session_id) && release_external_session.unwrap_or(true) {
            state
                .external_launch_service()
                .remove_session(&saved_session_id);
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalZmodemLocalFile {
    pub name: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalZmodemSavedFile {
    pub path: String,
    pub bytes: u64,
}

#[tauri::command]
pub fn terminal_zmodem_read_files(paths: Vec<String>) -> AppResult<Vec<TerminalZmodemLocalFile>> {
    if paths.is_empty() {
        return Err(AppError::validation("未选择要上传的文件"));
    }

    paths
        .into_iter()
        .map(|path| {
            let path = PathBuf::from(path);
            let metadata = fs::metadata(&path)
                .map_err(|error| AppError::terminal(format!("读取本机文件失败: {error}")))?;
            if !metadata.is_file() {
                return Err(AppError::validation("只能上传本机文件"));
            }
            let name = zmodem_safe_file_name(&path.to_string_lossy())?;
            let data = fs::read(&path)
                .map_err(|error| AppError::terminal(format!("读取本机文件失败: {error}")))?;
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
                .unwrap_or_default();
            Ok(TerminalZmodemLocalFile {
                name,
                size: metadata.len(),
                mtime_ms,
                data,
            })
        })
        .collect()
}

#[tauri::command]
pub fn terminal_zmodem_save_file(
    directory: String,
    file_name: String,
    data: Vec<u8>,
) -> AppResult<TerminalZmodemSavedFile> {
    let directory = PathBuf::from(directory);
    let directory = fs::canonicalize(&directory)
        .map_err(|error| AppError::terminal(format!("读取下载目录失败: {error}")))?;
    if !directory.is_dir() {
        return Err(AppError::validation("下载目标必须是本机目录"));
    }

    let file_name = zmodem_safe_file_name(&file_name)?;
    let path = available_zmodem_output_path(&directory, &file_name);
    fs::write(&path, &data)
        .map_err(|error| AppError::terminal(format!("保存 ZMODEM 文件失败: {error}")))?;

    Ok(TerminalZmodemSavedFile {
        path: path.to_string_lossy().to_string(),
        bytes: u64::try_from(data.len()).unwrap_or(u64::MAX),
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_terminal_reader(
    app: AppHandle,
    manager: Arc<TerminalManager>,
    output_dispatcher: TerminalOutputDispatcher,
    history: Arc<CommandHistoryService>,
    completion: CommandCompletionService,
    runtime_session_id: String,
    mut reader: Box<dyn Read + Send>,
    auth_secrets: Vec<AuthPromptSecret>,
) {
    spawn_terminal_exit_watcher(
        app.clone(),
        Arc::clone(&manager),
        Arc::clone(&history),
        completion.clone(),
        runtime_session_id.clone(),
    );

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut used_auth_secrets = vec![false; auth_secrets.len()];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                    if let Some(secret) =
                        select_auth_secret_for_prompt(&data, &auth_secrets, &mut used_auth_secrets)
                    {
                        let _ = manager.write(&runtime_session_id, &format!("{secret}\r"));
                    }
                    let _ = manager.record_output(&runtime_session_id, &data);
                    let visible_data = manager
                        .visible_output_after_suppression(&runtime_session_id, &data)
                        .unwrap_or_else(|_| data.clone());
                    if !visible_data.is_empty() {
                        let raw_bytes = if visible_data == data {
                            buffer[..read].to_vec()
                        } else {
                            visible_data.as_bytes().to_vec()
                        };
                        output_dispatcher.push(&runtime_session_id, visible_data, raw_bytes);
                    }
                }
                Err(error) => {
                    output_dispatcher.flush_runtime(&runtime_session_id);
                    if manager.close(&runtime_session_id).is_ok() {
                        history.unregister_runtime(&runtime_session_id);
                        completion.unregister_runtime(&runtime_session_id);
                        let _ = app.emit(
                            "terminal:exit",
                            TerminalExitEvent {
                                runtime_session_id: runtime_session_id.clone(),
                                exit_code: None,
                                message: Some(error.to_string()),
                            },
                        );
                    }
                    return;
                }
            }
        }

        output_dispatcher.flush_runtime(&runtime_session_id);
        if manager.close(&runtime_session_id).is_ok() {
            history.unregister_runtime(&runtime_session_id);
            completion.unregister_runtime(&runtime_session_id);
            let _ = app.emit(
                "terminal:exit",
                TerminalExitEvent {
                    runtime_session_id,
                    exit_code: None,
                    message: None,
                },
            );
        }
    });
}

fn spawn_terminal_exit_watcher(
    app: AppHandle,
    manager: Arc<TerminalManager>,
    history: Arc<CommandHistoryService>,
    completion: CommandCompletionService,
    runtime_session_id: String,
) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(200));
        match manager.try_wait_exit_code(&runtime_session_id) {
            Ok(Some(exit_code)) => {
                if manager.close(&runtime_session_id).is_ok() {
                    history.unregister_runtime(&runtime_session_id);
                    completion.unregister_runtime(&runtime_session_id);
                    let _ = app.emit(
                        "terminal:exit",
                        TerminalExitEvent {
                            runtime_session_id,
                            exit_code: Some(exit_code),
                            message: None,
                        },
                    );
                }
                return;
            }
            Ok(None) => {}
            Err(_) => return,
        }
    });
}

fn zmodem_safe_file_name(value: &str) -> AppResult<String> {
    let value = value.trim();
    let file_name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(value);
    let sanitized = file_name
        .chars()
        .map(|character| match character {
            '\0' | '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        return Err(AppError::validation("ZMODEM 文件名无效"));
    }
    Ok(sanitized)
}

fn available_zmodem_output_path(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 1..1000 {
        let candidate = directory.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    directory
        .join(format!("{stem}-{}", uuid::Uuid::new_v4()))
        .with_extension(
            path.extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default(),
        )
}

fn should_answer_auth_prompt(data: &str) -> bool {
    let normalized = data.to_ascii_lowercase();
    normalized.contains("password:") || normalized.contains("passphrase for key")
}

fn select_auth_secret_for_prompt<'a>(
    data: &str,
    auth_secrets: &'a [AuthPromptSecret],
    used_auth_secrets: &mut [bool],
) -> Option<&'a str> {
    let index = matching_auth_secret_index(data, auth_secrets, used_auth_secrets)?;
    used_auth_secrets[index] = true;
    Some(auth_secrets[index].secret.as_str())
}

fn matching_auth_secret_index(
    data: &str,
    auth_secrets: &[AuthPromptSecret],
    used_auth_secrets: &[bool],
) -> Option<usize> {
    if !should_answer_auth_prompt(data) {
        return None;
    }

    let normalized_data = data.to_ascii_lowercase();
    for (index, auth_secret) in auth_secrets.iter().enumerate() {
        if used_auth_secrets.get(index).copied().unwrap_or(true) {
            continue;
        }
        let target = auth_secret.target.to_ascii_lowercase();
        if !target.is_empty() && normalized_data.contains(&target) {
            return Some(index);
        }
    }

    let host_matches = auth_secrets
        .iter()
        .enumerate()
        .filter(|(index, _)| !used_auth_secrets.get(*index).copied().unwrap_or(true))
        .filter(|(_, auth_secret)| {
            target_host(&auth_secret.target)
                .map(|host| normalized_data.contains(&host.to_ascii_lowercase()))
                .unwrap_or(false)
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if host_matches.len() == 1 {
        return host_matches.first().copied();
    }
    if prompt_has_target_hint(&normalized_data) {
        return None;
    }

    let unused = auth_secrets
        .iter()
        .enumerate()
        .filter(|(index, _)| !used_auth_secrets.get(*index).copied().unwrap_or(true))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if unused.len() == 1 {
        return unused.first().copied();
    }

    None
}

fn prompt_has_target_hint(normalized_data: &str) -> bool {
    normalized_data.contains('@') || normalized_data.contains("'s password:")
}

fn resolve_ssh_jump_context(
    store: &SqliteStore,
    session: &SavedSession,
) -> AppResult<(SavedSession, Vec<AuthPromptSecret>)> {
    let Some(options) = session.ssh_options.as_ref() else {
        return Ok((session.clone(), Vec::new()));
    };
    if options.jump_hosts.is_empty() {
        return Ok((session.clone(), Vec::new()));
    }

    let saved_sessions = list_sessions(store)?.sessions;
    let mut resolved_session = session.clone();
    let mut resolved_jump_hosts = Vec::with_capacity(options.jump_hosts.len());
    let mut auth_secrets = Vec::new();

    for jump_host in &options.jump_hosts {
        let Some(jump_session) = saved_sessions
            .iter()
            .find(|candidate| jump_host_matches_session(jump_host, candidate, &session.id))
        else {
            let normalized = jump_host.trim();
            if !normalized.is_empty() {
                resolved_jump_hosts.push(normalized.to_string());
            }
            continue;
        };

        resolved_jump_hosts.push(ssh_jump_target(jump_session));
        if let Some(auth_secret) = auth_prompt_secret_for_session(jump_session)? {
            auth_secrets.push(auth_secret);
        }
    }

    if let Some(options) = resolved_session.ssh_options.as_mut() {
        options.jump_hosts = resolved_jump_hosts;
    }

    Ok((resolved_session, auth_secrets))
}

fn jump_host_matches_session(
    jump_host: &str,
    candidate: &SavedSession,
    current_session_id: &str,
) -> bool {
    if candidate.session_type != SessionType::Ssh || candidate.id == current_session_id {
        return false;
    }

    let normalized_jump_host = normalize_auth_target(jump_host);
    if normalized_jump_host.is_empty() {
        return false;
    }

    normalized_jump_host == normalize_auth_target(&ssh_prompt_target(candidate))
        || normalized_jump_host == normalize_auth_target(&ssh_jump_target(candidate))
}

fn auth_prompt_secret_for_session(session: &SavedSession) -> AppResult<Option<AuthPromptSecret>> {
    match session.auth_mode {
        AuthMode::Password | AuthMode::Key => session
            .credential_ref
            .as_deref()
            .map(read_system_secret)
            .transpose()
            .map(|secret| {
                secret.map(|value| AuthPromptSecret::new(ssh_prompt_target(session), value))
            }),
        AuthMode::Agent | AuthMode::None => Ok(None),
    }
}

fn ssh_prompt_target(session: &SavedSession) -> String {
    let host = session.host.trim();
    let username = session.username.trim();
    if username.is_empty() {
        host.to_string()
    } else {
        format!("{username}@{host}")
    }
}

fn ssh_jump_target(session: &SavedSession) -> String {
    let target = ssh_prompt_target(session);
    if session.port == 22 {
        target
    } else {
        format!("{target}:{}", session.port)
    }
}

fn normalize_auth_target(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn target_host(target: &str) -> Option<&str> {
    let host = target
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(target);
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.split_once(':').map(|(host, _)| host).unwrap_or(host))
}

fn terminal_profile_for_session(
    store: &crate::storage::sqlite::SqliteStore,
    local_options: Option<&crate::models::session::LocalOptions>,
) -> AppResult<crate::models::terminal_profile::TerminalProfile> {
    let profiles =
        crate::services::terminal_profile_service::list_or_detect_terminal_profiles(store)?;
    if let Some(profile_id) = local_options
        .and_then(|options| options.profile_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return profiles
            .into_iter()
            .find(|profile| profile.id == profile_id)
            .ok_or_else(|| crate::error::AppError::validation("指定的终端 Profile 不存在"));
    }
    profiles
        .into_iter()
        .find(|profile| profile.is_default)
        .or_else(|| {
            crate::services::terminal_profile_service::default_profile(store)
                .ok()
                .flatten()
        })
        .ok_or_else(|| crate::error::AppError::validation("未检测到可用终端工具"))
}

#[cfg(test)]
mod tests {
    use super::{
        local_options_with_working_directory, select_auth_secret_for_prompt,
        should_answer_auth_prompt, zmodem_safe_file_name, AuthPromptSecret,
    };
    use crate::models::session::{LocalEnvironmentVariable, LocalOptions};

    #[test]
    fn detects_ssh_password_and_key_prompts() {
        assert!(should_answer_auth_prompt("ubuntu@host's password:"));
        assert!(should_answer_auth_prompt(
            "Enter passphrase for key '/home/me/.ssh/id_rsa':"
        ));
        assert!(!should_answer_auth_prompt("Welcome to Ubuntu"));
    }

    #[test]
    fn terminal_auth_selects_jump_and_target_secrets_by_prompt_target_once() {
        let auth_secrets = vec![
            AuthPromptSecret::new("ubuntu@172.16.41.180", "jump-password"),
            AuthPromptSecret::new("ubuntu@172.16.41.181", "target-password"),
        ];
        let mut used = vec![false; auth_secrets.len()];

        assert_eq!(
            select_auth_secret_for_prompt(
                "ubuntu@172.16.41.180's password:",
                &auth_secrets,
                &mut used,
            ),
            Some("jump-password")
        );
        assert_eq!(
            select_auth_secret_for_prompt(
                "ubuntu@172.16.41.180's password:",
                &auth_secrets,
                &mut used,
            ),
            None
        );
        assert_eq!(
            select_auth_secret_for_prompt(
                "ubuntu@172.16.41.181's password:",
                &auth_secrets,
                &mut used,
            ),
            Some("target-password")
        );
        assert_eq!(
            select_auth_secret_for_prompt(
                "ubuntu@172.16.41.180's password:",
                &auth_secrets,
                &mut used,
            ),
            None
        );
    }

    #[test]
    fn terminal_auth_does_not_send_unmatched_target_secret_to_jump_prompt() {
        let auth_secrets = vec![AuthPromptSecret::new(
            "ubuntu@172.16.41.181",
            "target-password",
        )];
        let mut used = vec![false; auth_secrets.len()];

        assert_eq!(
            select_auth_secret_for_prompt(
                "ubuntu@172.16.41.180's password:",
                &auth_secrets,
                &mut used,
            ),
            None
        );
        assert_eq!(used, vec![false]);
    }

    #[test]
    fn working_directory_override_updates_existing_local_options() {
        let options = LocalOptions {
            profile_id: Some("pwsh".to_string()),
            working_directory: Some("C:\\old".to_string()),
            environment: vec![LocalEnvironmentVariable {
                name: "ZTERM_ENV".to_string(),
                value: "enabled".to_string(),
            }],
        };

        let next = local_options_with_working_directory(
            Some(options),
            Some(" C:\\workspace ".to_string()),
        )
        .expect("override should produce local options");

        assert_eq!(next.profile_id.as_deref(), Some("pwsh"));
        assert_eq!(next.working_directory.as_deref(), Some("C:\\workspace"));
        assert_eq!(next.environment.len(), 1);
    }

    #[test]
    fn empty_working_directory_override_keeps_existing_local_options() {
        let options = LocalOptions {
            profile_id: Some("cmd".to_string()),
            working_directory: Some("C:\\existing".to_string()),
            environment: Vec::new(),
        };

        let next = local_options_with_working_directory(Some(options), Some("  ".to_string()))
            .expect("existing local options should remain");

        assert_eq!(next.profile_id.as_deref(), Some("cmd"));
        assert_eq!(next.working_directory.as_deref(), Some("C:\\existing"));
    }

    #[test]
    fn zmodem_file_name_uses_basename_and_replaces_unsafe_characters() {
        assert_eq!(
            zmodem_safe_file_name("../logs/app:latest?.txt").expect("name should sanitize"),
            "app_latest_.txt"
        );
        assert_eq!(
            zmodem_safe_file_name(r"C:\temp\report.txt").expect("windows path should sanitize"),
            "report.txt"
        );
    }

    #[test]
    fn zmodem_file_name_rejects_empty_or_parent_names() {
        assert!(zmodem_safe_file_name("   ").is_err());
        assert!(zmodem_safe_file_name("..").is_err());
    }
}
