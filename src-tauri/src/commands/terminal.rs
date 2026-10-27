// Author: Liz
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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
        external_launch_service::is_external_session_id,
        ssh_command_service::SshCommandSecretResolver, terminal_manager::TerminalManager,
        terminal_output_dispatcher::TerminalOutputDispatcher, terminal_utf8::TerminalUtf8Decoder,
    },
    state::AppState,
    storage::{
        sessions::{get_session, list_sessions},
        sqlite::SqliteStore,
    },
};

const ZMODEM_MAX_SINGLE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const ZMODEM_MAX_UPLOAD_BATCH_BYTES: u64 = 64 * 1024 * 1024;
const ZMODEM_MAX_SINGLE_FILE_LABEL: &str = "32 MiB";
const ZMODEM_MAX_UPLOAD_BATCH_LABEL: &str = "64 MiB";
const TERMINAL_READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const TERMINAL_EXIT_CODE_TIMEOUT: Duration = Duration::from_millis(250);

struct TerminalSecretResolver<'a> {
    inner: &'a dyn SshCommandSecretResolver,
    sessions: Vec<SavedSession>,
}

impl SshCommandSecretResolver for TerminalSecretResolver<'_> {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
        self.inner.secret_for(credential_ref)
    }

    fn saved_ssh_sessions(&self) -> &[SavedSession] {
        &self.sessions
    }
}

#[tauri::command]
pub fn terminal_zmodem_diagnostic(
    app: AppHandle,
    runtime_session_id: String,
    stage: String,
    header: String,
) -> AppResult<()> {
    let diagnostics = crate::services::zmodem_diagnostics::valid_frontend_record(&stage, &header);
    if !diagnostics || uuid::Uuid::parse_str(&runtime_session_id).is_err() {
        return Err(AppError::validation("invalid ZMODEM diagnostic record"));
    }
    crate::services::zmodem_diagnostics::record_session(&app, &runtime_session_id, &stage, &header);
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthPromptSecret {
    target: String,
    secret: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalHistoryChangedEvent {
    runtime_session_id: String,
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
            if opened.shell_history_integration {
                history.enable_shell_integration(&opened.info.runtime_session_id);
            }
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
                None,
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
            let secrets = TerminalSecretResolver {
                inner: &secrets,
                sessions: if is_external {
                    Vec::new()
                } else {
                    list_sessions(storage.as_ref())?.sessions
                },
            };
            let opened = manager.open_ssh_session_with_resolver(
                &session,
                pane_id,
                120,
                32,
                &secrets,
                !is_external,
            )?;
            auth_secrets.clear(); // Native SSH handles each hop authentication directly.
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
                None,
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
    let secrets = TerminalSecretResolver {
        inner: &secrets,
        sessions: if is_external {
            Vec::new()
        } else {
            list_sessions(storage.as_ref())?.sessions
        },
    };
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
    auth_secrets.clear(); // Do not inject saved passwords into an MFA prompt.
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
    if opened.shell_history_integration {
        history.enable_shell_integration(&opened.info.runtime_session_id);
    }
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
        None,
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
    let working_directory = working_directory
        .filter(|value| !value.trim().is_empty())
        .map(Ok)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .ok_or_else(|| AppError::terminal("无法确定当前用户目录"))
        })?;
    let local_options = local_options_with_working_directory(None, Some(working_directory));
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
    if opened.shell_history_integration {
        history.enable_shell_integration(&opened.info.runtime_session_id);
    }
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
        None,
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
    app: AppHandle,
    state: State<'_, AppState>,
    runtime_session_id: String,
    data: String,
) -> AppResult<TerminalAccepted> {
    if data == "\x03" {
        crate::services::zmodem_diagnostics::record_session(
            &app,
            &runtime_session_id,
            "backend-ctrl-c",
            "received",
        );
    }
    let accepted = state.terminal_manager().write(&runtime_session_id, &data)?;
    if data == "\x03" {
        crate::services::zmodem_diagnostics::record_session(
            &app,
            &runtime_session_id,
            "backend-ctrl-c",
            "accepted",
        );
    }
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
    state
        .terminal_output_dispatcher()
        .close_runtime(&runtime_session_id, None);
    let result = match state.terminal_manager().close(&runtime_session_id) {
        Ok(result) => result,
        Err(AppError::NotFound(_)) => TerminalClosed { closed: false },
        Err(error) => return Err(error),
    };
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

    let mut metadata_total_size = 0_u64;
    let files = paths
        .into_iter()
        .map(|path| {
            let path = PathBuf::from(path);
            let metadata = fs::metadata(&path)
                .map_err(|error| AppError::terminal(format!("读取本机文件失败: {error}")))?;
            if !metadata.is_file() {
                return Err(AppError::validation("只能上传本机文件"));
            }
            let name = zmodem_safe_file_name(&path.to_string_lossy())?;
            metadata_total_size =
                zmodem_upload_total_after_file(&name, metadata.len(), metadata_total_size)?;
            Ok((path, name))
        })
        .collect::<AppResult<Vec<_>>>()?;

    let mut actual_total_size = 0_u64;
    files
        .into_iter()
        .map(|(path, name)| {
            let file = fs::File::open(&path)
                .map_err(|error| AppError::terminal(format!("读取本机文件失败: {error}")))?;
            let metadata = file
                .metadata()
                .map_err(|error| AppError::terminal(format!("读取本机文件失败: {error}")))?;
            if !metadata.is_file() {
                return Err(AppError::validation("只能上传本机文件"));
            }
            zmodem_upload_total_after_file(&name, metadata.len(), actual_total_size)?;
            let remaining_batch_bytes =
                ZMODEM_MAX_UPLOAD_BATCH_BYTES.saturating_sub(actual_total_size);
            let (read_limit, limit_scope, limit_label) =
                if remaining_batch_bytes < ZMODEM_MAX_SINGLE_FILE_BYTES {
                    (
                        remaining_batch_bytes,
                        "单批上传",
                        ZMODEM_MAX_UPLOAD_BATCH_LABEL,
                    )
                } else {
                    (
                        ZMODEM_MAX_SINGLE_FILE_BYTES,
                        "单文件",
                        ZMODEM_MAX_SINGLE_FILE_LABEL,
                    )
                };
            let data = read_zmodem_file_bounded(file, &name, read_limit, limit_scope, limit_label)?;
            let actual_size = u64::try_from(data.len()).unwrap_or(u64::MAX);
            actual_total_size =
                zmodem_upload_total_after_file(&name, actual_size, actual_total_size)?;
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
                .unwrap_or_default();
            Ok(TerminalZmodemLocalFile {
                name,
                size: actual_size,
                mtime_ms,
                data,
            })
        })
        .collect()
}

fn read_zmodem_file_bounded(
    reader: impl Read,
    name: &str,
    limit: u64,
    limit_scope: &str,
    limit_label: &str,
) -> AppResult<Vec<u8>> {
    let mut data = Vec::new();
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut data)
        .map_err(|error| AppError::terminal(format!("读取本机文件失败: {error}")))?;
    if u64::try_from(data.len()).unwrap_or(u64::MAX) > limit {
        return Err(AppError::validation(format!(
            "ZMODEM {limit_scope}最大支持 {limit_label}，{name} 在读取期间超过限制；请使用 SFTP 文件面板上传大文件"
        )));
    }
    Ok(data)
}

fn zmodem_upload_total_after_file(
    name: &str,
    file_size: u64,
    current_total: u64,
) -> AppResult<u64> {
    if file_size > ZMODEM_MAX_SINGLE_FILE_BYTES {
        return Err(AppError::validation(format!(
            "ZMODEM 单文件最大支持 {ZMODEM_MAX_SINGLE_FILE_LABEL}，{name} 超过限制；请使用 SFTP 文件面板上传大文件"
        )));
    }

    let next_total = current_total.checked_add(file_size).ok_or_else(|| {
        AppError::validation(format!(
            "ZMODEM 单批上传最大支持 {ZMODEM_MAX_UPLOAD_BATCH_LABEL}，本次选择的文件总量超过限制；请使用 SFTP 文件面板上传"
        ))
    })?;
    if next_total > ZMODEM_MAX_UPLOAD_BATCH_BYTES {
        return Err(AppError::validation(format!(
            "ZMODEM 单批上传最大支持 {ZMODEM_MAX_UPLOAD_BATCH_LABEL}，本次选择的文件总量超过限制；请使用 SFTP 文件面板上传"
        )));
    }
    Ok(next_total)
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

#[derive(Default)]
struct TerminalReaderOutput {
    snapshot_decoder: TerminalUtf8Decoder,
    visible_decoder: TerminalUtf8Decoder,
}

struct TerminalReaderChunk {
    text: String,
    bytes: Vec<u8>,
    history_changed: bool,
}

impl TerminalReaderOutput {
    fn consume(
        &mut self,
        runtime_session_id: &str,
        bytes: &[u8],
        history: &CommandHistoryService,
        manager: &TerminalManager,
    ) -> TerminalReaderChunk {
        let (filtered, history_changed) = history
            .consume_output_bytes(runtime_session_id, bytes)
            .unwrap_or_else(|_| (bytes.to_vec(), false));
        let snapshot = self.snapshot_decoder.decode(&filtered);
        if !snapshot.is_empty() {
            let _ = manager.record_output(runtime_session_id, &snapshot);
        }
        let visible = manager
            .visible_output_bytes_after_suppression(runtime_session_id, &filtered)
            .unwrap_or(filtered);
        TerminalReaderChunk {
            text: self.visible_decoder.decode(&visible),
            bytes: visible,
            history_changed,
        }
    }

    fn finish_snapshot(&mut self, runtime_session_id: &str, manager: &TerminalManager) {
        let tail = self.snapshot_decoder.finish();
        if !tail.is_empty() {
            let _ = manager.record_output(runtime_session_id, &tail);
        }
        // 原始字节已发送，前端独立拥有其流式解码状态。不得为 EOF 合成协议字节。
        let _ = self.visible_decoder.finish();
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_terminal_reader(
    app: AppHandle,
    manager: Arc<TerminalManager>,
    output_dispatcher: TerminalOutputDispatcher,
    history: Arc<CommandHistoryService>,
    completion: CommandCompletionService,
    runtime_session_id: String,
    mut reader: Box<dyn Read + Send>,
    auth_secrets: Vec<AuthPromptSecret>,
    exit_cleanup: Option<Arc<dyn Fn() + Send + Sync>>,
) {
    let finalizer = Arc::new(TerminalExitFinalizer::new(
        app.clone(),
        Arc::clone(&manager),
        output_dispatcher.clone(),
        Arc::clone(&history),
        completion,
        runtime_session_id.clone(),
        exit_cleanup,
    ));
    spawn_terminal_exit_watcher(Arc::clone(&finalizer));

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let diagnose = crate::services::zmodem_diagnostics::enabled();
        let mut raw_body = crate::services::zmodem_diagnostics::HexBodyObserver::default();
        let mut dispatch_body = crate::services::zmodem_diagnostics::HexBodyObserver::default();
        let mut read_count = 0u64;
        let mut raw_observer = crate::services::zmodem_diagnostics::StartupObserver::default();
        let mut dispatch_observer = crate::services::zmodem_diagnostics::StartupObserver::default();
        if diagnose {
            crate::services::zmodem_diagnostics::record_session(
                &app,
                &runtime_session_id,
                "reader-ready",
                "",
            );
            crate::services::zmodem_diagnostics::record_session(
                &app,
                &runtime_session_id,
                "transport",
                manager.diagnostic_transport(&runtime_session_id),
            );
        }
        let mut used_auth_secrets = vec![false; auth_secrets.len()];
        let mut output_stop_message = None;
        let mut output = TerminalReaderOutput::default();
        let mut reader_ended = false;
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    reader_ended = true;
                    break;
                }
                Ok(read) => {
                    let Ok(_reader_gate) = finalizer.reader_gate.lock() else {
                        break;
                    };
                    if finalizer.is_finalized() {
                        break;
                    }
                    if diagnose {
                        read_count += 1;
                        if matches!(read_count, 1 | 4 | 16 | 64 | 256) {
                            crate::services::zmodem_diagnostics::record_session(
                                &app,
                                &runtime_session_id,
                                "reader-pulse",
                                &format!("chunk={read_count} length={read}"),
                            );
                        }
                        for header in raw_body.consume(&buffer[..read]) {
                            crate::services::zmodem_diagnostics::record_session(
                                &app,
                                &runtime_session_id,
                                "reader-body",
                                &header,
                            );
                        }
                        for header in raw_observer.consume(&buffer[..read]) {
                            crate::services::zmodem_diagnostics::record_session(
                                &app,
                                &runtime_session_id,
                                "reader-input",
                                &header,
                            );
                        }
                    }
                    if let Some(secret) = select_auth_secret_for_prompt(
                        &String::from_utf8_lossy(&buffer[..read]),
                        &auth_secrets,
                        &mut used_auth_secrets,
                    ) {
                        let _ = manager.write(&runtime_session_id, &format!("{secret}\r"));
                    }
                    let chunk =
                        output.consume(&runtime_session_id, &buffer[..read], &history, &manager);
                    if chunk.history_changed {
                        let _ = app.emit(
                            "terminal:history-changed",
                            TerminalHistoryChangedEvent {
                                runtime_session_id: runtime_session_id.clone(),
                            },
                        );
                    }
                    if !chunk.bytes.is_empty() {
                        if diagnose {
                            for header in dispatch_body.consume(&chunk.bytes) {
                                crate::services::zmodem_diagnostics::record_session(
                                    &app,
                                    &runtime_session_id,
                                    "dispatch-body",
                                    &header,
                                );
                            }
                            for header in dispatch_observer.consume(&chunk.bytes) {
                                crate::services::zmodem_diagnostics::record_session(
                                    &app,
                                    &runtime_session_id,
                                    "dispatch-output",
                                    &header,
                                );
                            }
                        }
                        if !output_dispatcher.push(&runtime_session_id, chunk.text, chunk.bytes) {
                            output_stop_message =
                                output_dispatcher.stop_reason(&runtime_session_id);
                            break;
                        }
                    }
                }
                Err(error) => {
                    reader_ended = true;
                    output_stop_message = Some(error.to_string());
                    break;
                }
            }
        }

        if reader_ended {
            if let Ok(_reader_gate) = finalizer.reader_gate.lock() {
                if !finalizer.is_finalized() {
                    output.finish_snapshot(&runtime_session_id, &manager);
                }
            }
        }
        finalizer.reader_finished.store(true, Ordering::Release);
        finalizer.finalize(finalizer.wait_for_exit_code(), output_stop_message);
    });
}

fn spawn_terminal_exit_watcher(finalizer: Arc<TerminalExitFinalizer>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(200));
        if finalizer.is_finalized() {
            return;
        }
        match finalizer
            .manager
            .try_wait_exit_code(&finalizer.runtime_session_id)
        {
            Ok(Some(exit_code)) => {
                finalizer.record_exit_code(exit_code);
                let deadline = std::time::Instant::now() + TERMINAL_READER_DRAIN_TIMEOUT;
                while !finalizer.reader_finished.load(Ordering::Acquire)
                    && !finalizer.is_finalized()
                    && std::time::Instant::now() < deadline
                {
                    thread::sleep(Duration::from_millis(20));
                }
                finalizer.finalize(finalizer.observed_exit_code(), None);
                return;
            }
            Ok(None) => {}
            Err(_) => return,
        }
    });
}

struct TerminalExitFinalizer {
    app: AppHandle,
    manager: Arc<TerminalManager>,
    output_dispatcher: TerminalOutputDispatcher,
    history: Arc<CommandHistoryService>,
    completion: CommandCompletionService,
    runtime_session_id: String,
    exit_cleanup: Option<Arc<dyn Fn() + Send + Sync>>,
    finalized: AtomicBool,
    reader_finished: AtomicBool,
    reader_gate: Mutex<()>,
    observed_exit_code: Mutex<Option<i32>>,
}

impl TerminalExitFinalizer {
    #[allow(clippy::too_many_arguments)]
    fn new(
        app: AppHandle,
        manager: Arc<TerminalManager>,
        output_dispatcher: TerminalOutputDispatcher,
        history: Arc<CommandHistoryService>,
        completion: CommandCompletionService,
        runtime_session_id: String,
        exit_cleanup: Option<Arc<dyn Fn() + Send + Sync>>,
    ) -> Self {
        Self {
            app,
            manager,
            output_dispatcher,
            history,
            completion,
            runtime_session_id,
            exit_cleanup,
            finalized: AtomicBool::new(false),
            reader_finished: AtomicBool::new(false),
            reader_gate: Mutex::new(()),
            observed_exit_code: Mutex::new(None),
        }
    }

    fn is_finalized(&self) -> bool {
        self.finalized.load(Ordering::Acquire)
    }

    fn record_exit_code(&self, exit_code: i32) {
        if let Ok(mut observed_exit_code) = self.observed_exit_code.lock() {
            *observed_exit_code = Some(exit_code);
        }
    }

    fn observed_exit_code(&self) -> Option<i32> {
        self.observed_exit_code.lock().ok().and_then(|value| *value)
    }

    fn wait_for_exit_code(&self) -> Option<i32> {
        if let Some(exit_code) = self.observed_exit_code() {
            return Some(exit_code);
        }
        let deadline = std::time::Instant::now() + TERMINAL_EXIT_CODE_TIMEOUT;
        while std::time::Instant::now() < deadline {
            match self.manager.try_wait_exit_code(&self.runtime_session_id) {
                Ok(Some(exit_code)) => {
                    self.record_exit_code(exit_code);
                    return Some(exit_code);
                }
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => return self.observed_exit_code(),
            }
        }
        self.observed_exit_code()
    }

    fn finalize(&self, exit_code: Option<i32>, message: Option<String>) {
        if self.finalized.swap(true, Ordering::AcqRel) {
            return;
        }
        self.output_dispatcher
            .close_runtime(&self.runtime_session_id, None);
        let _reader_gate = self.reader_gate.lock().ok();
        let exit_code = exit_code.or_else(|| self.observed_exit_code());
        self.output_dispatcher
            .flush_runtime(&self.runtime_session_id);
        let close_error = self
            .manager
            .close(&self.runtime_session_id)
            .err()
            .filter(|error| !matches!(error, AppError::NotFound(_)));
        self.output_dispatcher
            .remove_runtime(&self.runtime_session_id);
        if let Some(cleanup) = &self.exit_cleanup {
            cleanup();
        }
        self.history.unregister_runtime(&self.runtime_session_id);
        self.completion.unregister_runtime(&self.runtime_session_id);
        let _ = self.app.emit(
            "terminal:exit",
            TerminalExitEvent {
                runtime_session_id: self.runtime_session_id.clone(),
                exit_code,
                message: close_error.map(|error| error.to_string()).or(message),
            },
        );
    }
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
    use std::{fs, io::Cursor};

    use super::{
        local_options_with_working_directory, read_zmodem_file_bounded,
        select_auth_secret_for_prompt, should_answer_auth_prompt, terminal_zmodem_read_files,
        zmodem_safe_file_name, zmodem_upload_total_after_file, AuthPromptSecret,
        ZMODEM_MAX_SINGLE_FILE_BYTES, ZMODEM_MAX_UPLOAD_BATCH_BYTES,
    };
    use crate::models::session::{LocalEnvironmentVariable, LocalOptions};

    fn reader_output_fixture() -> (super::CommandHistoryService, super::TerminalManager) {
        let store = std::sync::Arc::new(
            crate::storage::sqlite::SqliteStore::open_in_memory().expect("store should open"),
        );
        (
            super::CommandHistoryService::new(store),
            super::TerminalManager::default(),
        )
    }

    #[test]
    fn terminal_reader_streams_raw_bytes_without_waiting_for_utf8() {
        let (history, manager) = reader_output_fixture();
        let mut output = super::TerminalReaderOutput::default();
        let input = "提示> 中文🚀\r\n";
        let mut text = String::new();
        for byte in input.as_bytes() {
            let chunk = output.consume("utf8", &[*byte], &history, &manager);
            assert_eq!(chunk.bytes, vec![*byte]);
            text.push_str(&chunk.text);
        }
        output.finish_snapshot("utf8", &manager);
        assert_eq!(text, input);
        assert_eq!(
            manager.output_tail("utf8", 1024).unwrap().as_deref(),
            Some(input)
        );

        // A binary protocol's final byte may resemble a UTF-8 prefix. It must
        // arrive immediately even when no subsequent read will complete it.
        let raw = b"**\x18B\xff\xe4";
        let chunk = output.consume("utf8", raw, &history, &manager);
        assert_eq!(chunk.bytes, raw);
        assert_eq!(chunk.text, "**\x18B\u{fffd}");
        output.finish_snapshot("utf8", &manager);
        let expected = format!("{input}{}", String::from_utf8_lossy(raw));
        assert_eq!(manager.output_tail("utf8", 1024).unwrap(), Some(expected));
    }

    #[test]
    fn terminal_reader_filters_split_markers_without_corrupting_raw_output() {
        use crate::{
            models::history::{HistoryScopeKind, HistorySearchOptions},
            storage::{history::search_command_history, sqlite::SqliteStore},
        };
        use base64::Engine as _;
        let command = "echo 中文";
        let marker = format!(
            "\x1b]633;ZTermCommand;{}\x07",
            base64::engine::general_purpose::STANDARD.encode(command.as_bytes())
        );
        let mut input = "前🚀".as_bytes().to_vec();
        input.extend_from_slice(marker.as_bytes());
        input.extend_from_slice("后".as_bytes());
        input.extend_from_slice(&[0xff, 0xe4]);
        let mut expected_raw = "前🚀后".as_bytes().to_vec();
        expected_raw.extend_from_slice(&[0xff, 0xe4]);
        for split in 0..=input.len() {
            let store = std::sync::Arc::new(SqliteStore::open_in_memory().unwrap());
            let history = super::CommandHistoryService::new(std::sync::Arc::clone(&store));
            history.register_runtime(
                "marker",
                None,
                Some(HistoryScopeKind::LocalProfile),
                Some("test".into()),
            );
            history.enable_shell_integration("marker");
            let manager = super::TerminalManager::default();
            let mut output = super::TerminalReaderOutput::default();
            let mut raw = Vec::new();
            let mut changes = 0;
            for bytes in [&input[..split], &input[split..]] {
                let chunk = output.consume("marker", bytes, &history, &manager);
                raw.extend(chunk.bytes);
                changes += usize::from(chunk.history_changed);
            }
            output.finish_snapshot("marker", &manager);
            assert_eq!(raw, expected_raw, "split {split}");
            assert_eq!(changes, 1);
            assert_eq!(
                manager.output_tail("marker", 1024).unwrap(),
                Some(String::from_utf8_lossy(&expected_raw).into_owned())
            );
            let entries = search_command_history(
                store.as_ref(),
                HistorySearchOptions {
                    query: None,
                    scope_kind: Some(HistoryScopeKind::LocalProfile),
                    scope_id: Some("test".into()),
                    limit: None,
                    deduplicate: None,
                },
            )
            .unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].command, command);
        }
    }

    #[test]
    fn terminal_reader_suppression_preserves_binary_tail_and_full_snapshot() {
        let (history, manager) = reader_output_fixture();
        manager.begin_output_suppression("probe", "__END:").unwrap();
        let mut output = super::TerminalReaderOutput::default();
        let first = output.consume("probe", b"probe\r\n__EN", &history, &manager);
        assert!(first.bytes.is_empty());
        let second = output.consume("probe", b"D:0\r\n\xe4", &history, &manager);
        assert_eq!(second.bytes, vec![0xe4]);
        assert!(second.text.is_empty());
        let third = output.consume("probe", b"\xb8\xad\xff", &history, &manager);
        assert_eq!(third.bytes, vec![0xb8, 0xad, 0xff]);
        assert_eq!(third.text, "中\u{fffd}");
        output.finish_snapshot("probe", &manager);
        assert_eq!(
            manager.output_tail("probe", 1024).unwrap().as_deref(),
            Some("probe\r\n__END:0\r\n中\u{fffd}")
        );
    }

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

    #[test]
    fn zmodem_upload_size_accepts_exact_single_and_batch_limits() {
        let total = zmodem_upload_total_after_file("first.bin", ZMODEM_MAX_SINGLE_FILE_BYTES, 0)
            .expect("single-file boundary should be accepted");
        let total =
            zmodem_upload_total_after_file("second.bin", ZMODEM_MAX_SINGLE_FILE_BYTES, total)
                .expect("batch boundary should be accepted");

        assert_eq!(total, ZMODEM_MAX_UPLOAD_BATCH_BYTES);
    }

    #[test]
    fn zmodem_upload_size_rejects_single_file_over_limit_with_sftp_guidance() {
        let error =
            zmodem_upload_total_after_file("oversized.bin", ZMODEM_MAX_SINGLE_FILE_BYTES + 1, 0)
                .expect_err("oversized file should be rejected");
        let message = error.to_string();

        assert!(message.contains("32 MiB"));
        assert!(message.contains("oversized.bin"));
        assert!(message.contains("SFTP"));
    }

    #[test]
    fn zmodem_upload_size_rejects_batch_over_limit_with_sftp_guidance() {
        let error = zmodem_upload_total_after_file("next.bin", 1, ZMODEM_MAX_UPLOAD_BATCH_BYTES)
            .expect_err("oversized batch should be rejected");
        let message = error.to_string();

        assert!(message.contains("64 MiB"));
        assert!(message.contains("SFTP"));
    }

    #[test]
    fn zmodem_read_files_keeps_small_file_behavior() {
        let path =
            std::env::temp_dir().join(format!("zterm-zmodem-small-{}.bin", uuid::Uuid::new_v4()));
        fs::write(&path, [1_u8, 2, 3]).expect("small fixture should be written");

        let result = terminal_zmodem_read_files(vec![path.to_string_lossy().to_string()]);
        let _ = fs::remove_file(&path);
        let files = result.expect("small file should be read");

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].size, 3);
        assert_eq!(files[0].data, vec![1, 2, 3]);
    }

    #[test]
    fn zmodem_read_files_rejects_oversized_sparse_file_from_metadata() {
        let path = std::env::temp_dir().join(format!(
            "zterm-zmodem-oversized-{}.bin",
            uuid::Uuid::new_v4()
        ));
        let file = fs::File::create(&path).expect("sparse fixture should be created");
        file.set_len(ZMODEM_MAX_SINGLE_FILE_BYTES + 1)
            .expect("sparse fixture should be sized");
        drop(file);

        let result = terminal_zmodem_read_files(vec![path.to_string_lossy().to_string()]);
        let _ = fs::remove_file(&path);
        let message = result
            .expect_err("oversized sparse file should be rejected")
            .to_string();

        assert!(message.contains("32 MiB"));
        assert!(message.contains("SFTP"));
    }

    #[test]
    fn zmodem_bounded_read_rejects_growth_past_the_metadata_size() {
        let reader = Cursor::new(vec![1_u8, 2, 3, 4]);
        let error = read_zmodem_file_bounded(reader, "growing.bin", 3, "单文件", "3 B")
            .expect_err("data beyond the read limit should be rejected");
        let message = error.to_string();

        assert!(message.contains("growing.bin"));
        assert!(message.contains("3 B"));
        assert!(message.contains("SFTP"));
    }

    #[test]
    fn zmodem_bounded_read_can_enforce_remaining_batch_capacity() {
        let reader = Cursor::new(vec![1_u8, 2]);
        let error = read_zmodem_file_bounded(reader, "next.bin", 1, "单批上传", "64 MiB")
            .expect_err("data beyond the remaining batch capacity should be rejected");
        let message = error.to_string();

        assert!(message.contains("单批上传"));
        assert!(message.contains("64 MiB"));
        assert!(message.contains("SFTP"));
    }
}
