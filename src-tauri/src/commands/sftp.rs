// Author: Liz
use tauri::{AppHandle, Emitter, State};

use crate::{
    error::AppResult,
    models::sftp::{
        FileEntry, LocalPathInfo, SftpDeleteResult, SftpMkdirResult, SftpRenameResult,
        TransferConflict, TransferConflictCheckItem, TransferConflictPolicy, TransferDirection,
        TransferEndpoint, TransferEndpointConflict, TransferEndpointConflictCheckItem,
        TransferEndpointKind, TransferKind, TransferTask, TransferTaskOrigin,
    },
    services::{
        external_launch_service::CompositeSshSecretResolver,
        sftp_service::{
            default_local_directory, list_local_directory, local_path_total_bytes,
            local_root_directories, SftpService, TransferProgressUpdate,
        },
        transfer_queue::TransferQueue,
    },
    state::AppState,
    storage::{
        sessions::{get_session, list_sessions},
        transfers::list_transfer_tasks,
    },
};

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    saved_session_id: String,
    path: String,
) -> AppResult<Vec<FileEntry>> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let service = state.sftp_service();
    service.list(&session, &all_sessions, &secrets, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    saved_session_id: String,
    path: String,
) -> AppResult<SftpMkdirResult> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let service = state.sftp_service();
    service
        .create_dir(&session, &all_sessions, &secrets, &path)
        .await?;
    Ok(SftpMkdirResult { created: true })
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    saved_session_id: String,
    path: String,
    recursive: bool,
) -> AppResult<SftpDeleteResult> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let service = state.sftp_service();
    service
        .delete(&session, &all_sessions, &secrets, &path, recursive)
        .await?;
    Ok(SftpDeleteResult { deleted: true })
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    saved_session_id: String,
    from: String,
    to: String,
) -> AppResult<SftpRenameResult> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let service = state.sftp_service();
    service
        .rename(&session, &all_sessions, &secrets, &from, &to)
        .await?;
    Ok(SftpRenameResult { renamed: true })
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    saved_session_id: String,
    local_path: String,
    remote_path: String,
    kind: Option<TransferKind>,
    conflict_policy: Option<TransferConflictPolicy>,
) -> AppResult<TransferTask> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let queue = state.transfer_queue();
    let total_bytes = local_path_total_bytes(&local_path).await?;
    let conflict_policy = conflict_policy.unwrap_or(TransferConflictPolicy::Overwrite);
    let task = queue.enqueue(
        &saved_session_id,
        TransferDirection::Upload,
        &local_path,
        &remote_path,
        kind,
        conflict_policy,
        total_bytes,
    )?;
    spawn_transfer(
        app,
        state.sftp_service(),
        queue,
        session,
        all_sessions,
        state
            .external_launch_service()
            .composite_secret_resolver(state.credential_service()),
        task.clone(),
    );
    Ok(task)
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    saved_session_id: String,
    remote_path: String,
    local_path: String,
    kind: Option<TransferKind>,
    conflict_policy: Option<TransferConflictPolicy>,
) -> AppResult<TransferTask> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let queue = state.transfer_queue();
    let conflict_policy = conflict_policy.unwrap_or(TransferConflictPolicy::Overwrite);
    let task = queue.enqueue(
        &saved_session_id,
        TransferDirection::Download,
        &local_path,
        &remote_path,
        kind,
        conflict_policy,
        0,
    )?;
    spawn_transfer(
        app,
        state.sftp_service(),
        queue,
        session,
        all_sessions,
        state
            .external_launch_service()
            .composite_secret_resolver(state.credential_service()),
        task.clone(),
    );
    Ok(task)
}

#[tauri::command]
pub fn sftp_classify_local_paths(paths: Vec<String>) -> AppResult<Vec<LocalPathInfo>> {
    crate::services::sftp_service::classify_local_paths(paths)
}

#[tauri::command]
pub async fn sftp_check_transfer_conflicts(
    state: State<'_, AppState>,
    saved_session_id: String,
    items: Vec<TransferConflictCheckItem>,
) -> AppResult<Vec<TransferConflict>> {
    let (session, all_sessions) = ssh_session_context(&state, &saved_session_id)?;
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let service = state.sftp_service();
    service
        .check_transfer_conflicts(&session, &all_sessions, &secrets, items)
        .await
}

#[tauri::command]
pub fn file_transfer_default_local_path() -> AppResult<String> {
    default_local_directory()
}

#[tauri::command]
pub fn file_transfer_local_roots() -> AppResult<Vec<String>> {
    local_root_directories()
}

#[tauri::command]
pub async fn file_transfer_list_endpoint(
    state: State<'_, AppState>,
    endpoint: TransferEndpoint,
) -> AppResult<Vec<FileEntry>> {
    match endpoint.kind {
        TransferEndpointKind::Local => list_local_directory(&endpoint.path).await,
        TransferEndpointKind::Ssh => {
            let session = session_for_endpoint(&state, &endpoint)?;
            let storage = state.storage();
            let all_sessions = list_sessions(storage.as_ref())?.sessions;
            let secrets = state
                .external_launch_service()
                .composite_secret_resolver(state.credential_service());
            state
                .sftp_service()
                .list(&session, &all_sessions, &secrets, &endpoint.path)
                .await
        }
    }
}

#[tauri::command]
pub async fn file_transfer_check_conflicts(
    state: State<'_, AppState>,
    items: Vec<TransferEndpointConflictCheckItem>,
) -> AppResult<Vec<TransferEndpointConflict>> {
    let mut conflicts = Vec::new();
    for item in items {
        let exists = match item.destination.kind {
            TransferEndpointKind::Local => {
                let path = std::path::PathBuf::from(item.destination.path.trim());
                path.exists()
            }
            TransferEndpointKind::Ssh => {
                let session = session_for_endpoint(&state, &item.destination)?;
                let storage = state.storage();
                let all_sessions = list_sessions(storage.as_ref())?.sessions;
                let secrets = state
                    .external_launch_service()
                    .composite_secret_resolver(state.credential_service());
                state
                    .sftp_service()
                    .exists(&session, &all_sessions, &secrets, &item.destination.path)
                    .await?
            }
        };
        if exists {
            conflicts.push(TransferEndpointConflict {
                path: item.destination.path,
            });
        }
    }
    Ok(conflicts)
}

#[tauri::command]
pub async fn file_transfer_enqueue(
    app: AppHandle,
    state: State<'_, AppState>,
    source: TransferEndpoint,
    destination: TransferEndpoint,
    kind: Option<TransferKind>,
    conflict_policy: Option<TransferConflictPolicy>,
) -> AppResult<TransferTask> {
    if source.kind == TransferEndpointKind::Local && destination.kind == TransferEndpointKind::Local
    {
        return Err(crate::error::AppError::validation(
            "文件传输栏暂不支持本机到本机复制",
        ));
    }
    let source_session = optional_session_for_endpoint(&state, &source)?;
    let destination_session = optional_session_for_endpoint(&state, &destination)?;
    let storage = state.storage();
    let all_sessions = list_sessions(storage.as_ref())?.sessions;
    let secrets = state
        .external_launch_service()
        .composite_secret_resolver(state.credential_service());
    let saved_session_id = source
        .saved_session_id
        .as_deref()
        .or(destination.saved_session_id.as_deref())
        .ok_or_else(|| crate::error::AppError::validation("文件传输任务必须包含 SSH 端点"))?;
    let direction = if destination.kind == TransferEndpointKind::Ssh {
        TransferDirection::Upload
    } else {
        TransferDirection::Download
    };
    let local_path = if source.kind == TransferEndpointKind::Local {
        source.path.as_str()
    } else if destination.kind == TransferEndpointKind::Local {
        destination.path.as_str()
    } else {
        source.path.as_str()
    };
    let remote_path = if destination.kind == TransferEndpointKind::Ssh {
        destination.path.as_str()
    } else {
        source.path.as_str()
    };
    let total_bytes = if source.kind == TransferEndpointKind::Local {
        local_path_total_bytes(&source.path).await?
    } else {
        0
    };
    let conflict_policy = conflict_policy.unwrap_or(TransferConflictPolicy::Overwrite);
    let queue = state.transfer_queue();
    let task = queue.enqueue_with_endpoints(
        saved_session_id,
        direction,
        local_path,
        remote_path,
        kind,
        conflict_policy,
        total_bytes,
        TransferTaskOrigin::FileTransfer,
        &source,
        &destination,
    )?;
    spawn_file_transfer(
        app,
        state.sftp_service(),
        queue,
        source_session,
        destination_session,
        all_sessions,
        secrets,
        task.clone(),
    );
    Ok(task)
}

#[tauri::command]
pub fn transfer_list(
    state: State<'_, AppState>,
    saved_session_id: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<TransferTask>> {
    let storage = state.storage();
    list_transfer_tasks(
        storage.as_ref(),
        saved_session_id.as_deref(),
        limit.unwrap_or(200),
    )
}

#[tauri::command]
pub fn file_transfer_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> AppResult<Vec<TransferTask>> {
    let storage = state.storage();
    list_transfer_tasks(storage.as_ref(), None, limit.unwrap_or(200))
}

#[tauri::command]
pub fn transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<TransferTask> {
    let queue = state.transfer_queue();
    let task = queue.retry_failed(&task_id)?;
    if task.task_origin == TransferTaskOrigin::FileTransfer {
        let source_session = optional_session_for_endpoint(&state, &task.source_endpoint)?;
        let destination_session =
            optional_session_for_endpoint(&state, &task.destination_endpoint)?;
        let storage = state.storage();
        let all_sessions = list_sessions(storage.as_ref())?.sessions;
        let secrets = state
            .external_launch_service()
            .composite_secret_resolver(state.credential_service());
        spawn_file_transfer(
            app,
            state.sftp_service(),
            queue,
            source_session,
            destination_session,
            all_sessions,
            secrets,
            task.clone(),
        );
    } else {
        let (session, all_sessions) = ssh_session_context(&state, &task.saved_session_id)?;
        let secrets = state
            .external_launch_service()
            .composite_secret_resolver(state.credential_service());
        spawn_transfer(
            app,
            state.sftp_service(),
            queue,
            session,
            all_sessions,
            secrets,
            task.clone(),
        );
    }
    Ok(task)
}

#[tauri::command]
pub fn transfer_pause(state: State<'_, AppState>, task_id: String) -> AppResult<TransferTask> {
    state.transfer_queue().pause(&task_id)
}

#[tauri::command]
pub fn transfer_resume(state: State<'_, AppState>, task_id: String) -> AppResult<TransferTask> {
    state.transfer_queue().resume(&task_id)
}

#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, task_id: String) -> AppResult<TransferTask> {
    state.transfer_queue().cancel(&task_id)
}

#[tauri::command]
pub fn transfer_delete(state: State<'_, AppState>, task_id: String) -> AppResult<SftpDeleteResult> {
    state.transfer_queue().delete(&task_id)?;
    Ok(SftpDeleteResult { deleted: true })
}

fn spawn_transfer(
    app: AppHandle,
    service: SftpService,
    queue: TransferQueue,
    session: crate::models::session::SavedSession,
    all_sessions: Vec<crate::models::session::SavedSession>,
    credential_service: CompositeSshSecretResolver,
    task: TransferTask,
) {
    let control = match queue.register_control(&task.id) {
        Ok(control) => control,
        Err(error) => {
            let _ = app.emit("transfer:done", error.to_string());
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let running = match queue.mark_running(&task.id) {
            Ok(task) => task,
            Err(error) => {
                let _ = app.emit("transfer:done", error.to_string());
                return;
            }
        };
        let _ = app.emit("transfer:progress", running.clone());

        let progress_queue = queue.clone();
        let progress_app = app.clone();
        let progress_task_id = task.id.clone();
        let mut progress = move |update: TransferProgressUpdate| -> AppResult<()> {
            let updated = progress_queue.mark_progress_with_total(
                &progress_task_id,
                update.transferred_bytes,
                update.total_bytes,
            )?;
            let _ = progress_app.emit("transfer:progress", updated);
            Ok(())
        };

        let result = match task.direction {
            TransferDirection::Upload => {
                service
                    .upload_path(
                        &session,
                        &all_sessions,
                        &credential_service,
                        &task.local_path,
                        &task.remote_path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
            TransferDirection::Download => {
                service
                    .download_path(
                        &session,
                        &all_sessions,
                        &credential_service,
                        &task.remote_path,
                        &task.local_path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
        };

        let done = match result {
            Ok(()) => match queue.get(&task.id) {
                Ok(current) if current.status == crate::models::sftp::TransferStatus::Cancelled => {
                    Ok(current)
                }
                Ok(_) => queue.mark_done(&task.id),
                Err(crate::error::AppError::NotFound(_)) => {
                    let _ = queue.unregister_control(&task.id);
                    return;
                }
                Err(error) => Err(error),
            },
            Err(error) => match queue.get(&task.id) {
                Ok(current) if current.status == crate::models::sftp::TransferStatus::Cancelled => {
                    Ok(current)
                }
                Ok(_) => queue.mark_failed(&task.id, &error.to_string()),
                Err(crate::error::AppError::NotFound(_)) => {
                    let _ = queue.unregister_control(&task.id);
                    return;
                }
                Err(error) => Err(error),
            },
        };
        match done {
            Ok(task) => {
                let _ = app.emit("transfer:done", task);
            }
            Err(error) => {
                let _ = app.emit("transfer:done", error.to_string());
            }
        }
        let _ = queue.unregister_control(&task.id);
    });
}

fn spawn_file_transfer(
    app: AppHandle,
    service: SftpService,
    queue: TransferQueue,
    source_session: Option<crate::models::session::SavedSession>,
    destination_session: Option<crate::models::session::SavedSession>,
    all_sessions: Vec<crate::models::session::SavedSession>,
    credential_service: CompositeSshSecretResolver,
    task: TransferTask,
) {
    let control = match queue.register_control(&task.id) {
        Ok(control) => control,
        Err(error) => {
            let _ = app.emit("transfer:done", error.to_string());
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        let running = match queue.mark_running(&task.id) {
            Ok(task) => task,
            Err(error) => {
                let _ = app.emit("transfer:done", error.to_string());
                return;
            }
        };
        let _ = app.emit("transfer:progress", running.clone());

        let progress_queue = queue.clone();
        let progress_app = app.clone();
        let progress_task_id = task.id.clone();
        let mut progress = move |update: TransferProgressUpdate| -> AppResult<()> {
            let updated = progress_queue.mark_progress_with_total(
                &progress_task_id,
                update.transferred_bytes,
                update.total_bytes,
            )?;
            let _ = progress_app.emit("transfer:progress", updated);
            Ok(())
        };

        let result = match (task.source_endpoint.kind, task.destination_endpoint.kind) {
            (TransferEndpointKind::Local, TransferEndpointKind::Ssh) => {
                let Some(destination_session) = destination_session.as_ref() else {
                    return finish_missing_endpoint(app, queue, &task.id, "目标 SSH 会话不存在");
                };
                service
                    .upload_path(
                        destination_session,
                        &all_sessions,
                        &credential_service,
                        &task.source_endpoint.path,
                        &task.destination_endpoint.path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
            (TransferEndpointKind::Ssh, TransferEndpointKind::Local) => {
                let Some(source_session) = source_session.as_ref() else {
                    return finish_missing_endpoint(app, queue, &task.id, "来源 SSH 会话不存在");
                };
                service
                    .download_path(
                        source_session,
                        &all_sessions,
                        &credential_service,
                        &task.source_endpoint.path,
                        &task.destination_endpoint.path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
            (TransferEndpointKind::Ssh, TransferEndpointKind::Ssh) => {
                let Some(source_session) = source_session.as_ref() else {
                    return finish_missing_endpoint(app, queue, &task.id, "来源 SSH 会话不存在");
                };
                let Some(destination_session) = destination_session.as_ref() else {
                    return finish_missing_endpoint(app, queue, &task.id, "目标 SSH 会话不存在");
                };
                service
                    .copy_remote_to_remote_path(
                        source_session,
                        &all_sessions,
                        &task.source_endpoint.path,
                        destination_session,
                        &all_sessions,
                        &credential_service,
                        &task.destination_endpoint.path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
            (TransferEndpointKind::Local, TransferEndpointKind::Local) => Err(
                crate::error::AppError::validation("文件传输栏暂不支持本机到本机复制"),
            ),
        };

        let done = match result {
            Ok(()) => match queue.get(&task.id) {
                Ok(current) if current.status == crate::models::sftp::TransferStatus::Cancelled => {
                    Ok(current)
                }
                Ok(_) => queue.mark_done(&task.id),
                Err(crate::error::AppError::NotFound(_)) => {
                    let _ = queue.unregister_control(&task.id);
                    return;
                }
                Err(error) => Err(error),
            },
            Err(error) => match queue.get(&task.id) {
                Ok(current) if current.status == crate::models::sftp::TransferStatus::Cancelled => {
                    Ok(current)
                }
                Ok(_) => queue.mark_failed(&task.id, &error.to_string()),
                Err(crate::error::AppError::NotFound(_)) => {
                    let _ = queue.unregister_control(&task.id);
                    return;
                }
                Err(error) => Err(error),
            },
        };
        match done {
            Ok(task) => {
                let _ = app.emit("transfer:done", task);
            }
            Err(error) => {
                let _ = app.emit("transfer:done", error.to_string());
            }
        }
        let _ = queue.unregister_control(&task.id);
    });
}

fn finish_missing_endpoint(app: AppHandle, queue: TransferQueue, task_id: &str, message: &str) {
    let done = queue.mark_failed(task_id, message);
    match done {
        Ok(task) => {
            let _ = app.emit("transfer:done", task);
        }
        Err(error) => {
            let _ = app.emit("transfer:done", error.to_string());
        }
    }
    let _ = queue.unregister_control(task_id);
}

fn session_for_endpoint(
    state: &State<'_, AppState>,
    endpoint: &TransferEndpoint,
) -> AppResult<crate::models::session::SavedSession> {
    optional_session_for_endpoint(state, endpoint)?
        .ok_or_else(|| crate::error::AppError::validation("SSH 端点必须选择已保存会话"))
}

fn optional_session_for_endpoint(
    state: &State<'_, AppState>,
    endpoint: &TransferEndpoint,
) -> AppResult<Option<crate::models::session::SavedSession>> {
    match endpoint.kind {
        TransferEndpointKind::Local => Ok(None),
        TransferEndpointKind::Ssh => {
            let Some(saved_session_id) = endpoint.saved_session_id.as_deref() else {
                return Err(crate::error::AppError::validation(
                    "SSH 端点必须选择已保存会话",
                ));
            };
            ssh_session_context(state, saved_session_id).map(|(session, _)| Some(session))
        }
    }
}

fn ssh_session_context(
    state: &State<'_, AppState>,
    saved_session_id: &str,
) -> AppResult<(
    crate::models::session::SavedSession,
    Vec<crate::models::session::SavedSession>,
)> {
    let storage = state.storage();
    let all_sessions = list_sessions(storage.as_ref())?.sessions;
    if let Some(session) = state
        .external_launch_service()
        .get_session(saved_session_id)?
    {
        return Ok((session, all_sessions));
    }
    let session = get_session(storage.as_ref(), saved_session_id)?;
    Ok((session, all_sessions))
}
