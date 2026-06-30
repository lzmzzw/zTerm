// Author: Liz
use tauri::{AppHandle, Emitter, State};

use crate::{
    error::AppResult,
    models::sftp::{
        FileEntry, SftpDeleteResult, SftpMkdirResult, SftpRenameResult, TransferDirection,
        TransferTask,
    },
    services::{
        sftp_service::local_path_total_bytes, sftp_service::SftpService,
        transfer_queue::TransferQueue,
    },
    state::AppState,
    storage::{sessions::get_session, transfers::list_transfer_tasks},
};

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    saved_session_id: String,
    path: String,
) -> AppResult<Vec<FileEntry>> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let service = state.sftp_service();
    service.list(&session, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    saved_session_id: String,
    path: String,
) -> AppResult<SftpMkdirResult> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let service = state.sftp_service();
    service.create_dir(&session, &path).await?;
    Ok(SftpMkdirResult { created: true })
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, AppState>,
    saved_session_id: String,
    path: String,
    recursive: bool,
) -> AppResult<SftpDeleteResult> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let service = state.sftp_service();
    service.delete(&session, &path, recursive).await?;
    Ok(SftpDeleteResult { deleted: true })
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    saved_session_id: String,
    from: String,
    to: String,
) -> AppResult<SftpRenameResult> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let service = state.sftp_service();
    service.rename(&session, &from, &to).await?;
    Ok(SftpRenameResult { renamed: true })
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    saved_session_id: String,
    local_path: String,
    remote_path: String,
) -> AppResult<TransferTask> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let queue = state.transfer_queue();
    let total_bytes = local_path_total_bytes(&local_path).await?;
    let task = queue.enqueue(
        &saved_session_id,
        TransferDirection::Upload,
        &local_path,
        &remote_path,
        total_bytes,
    )?;
    spawn_transfer(app, state.sftp_service(), queue, session, task.clone());
    Ok(task)
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    saved_session_id: String,
    remote_path: String,
    local_path: String,
) -> AppResult<TransferTask> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let queue = state.transfer_queue();
    let task = queue.enqueue(
        &saved_session_id,
        TransferDirection::Download,
        &local_path,
        &remote_path,
        0,
    )?;
    spawn_transfer(app, state.sftp_service(), queue, session, task.clone());
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
pub fn transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> AppResult<TransferTask> {
    let queue = state.transfer_queue();
    let task = queue.retry_failed(&task_id)?;
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &task.saved_session_id)?;
    spawn_transfer(app, state.sftp_service(), queue, session, task.clone());
    Ok(task)
}

fn spawn_transfer(
    app: AppHandle,
    service: SftpService,
    queue: TransferQueue,
    session: crate::models::session::SavedSession,
    task: TransferTask,
) {
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
        let mut progress = move |transferred_bytes: u64| -> AppResult<()> {
            let updated = progress_queue.mark_progress(&progress_task_id, transferred_bytes)?;
            let _ = progress_app.emit("transfer:progress", updated);
            Ok(())
        };

        let result = match task.direction {
            TransferDirection::Upload => {
                service
                    .upload_path(&session, &task.local_path, &task.remote_path, &mut progress)
                    .await
            }
            TransferDirection::Download => {
                service
                    .download_path(&session, &task.remote_path, &task.local_path, &mut progress)
                    .await
            }
        };

        let done = match result {
            Ok(()) => queue.mark_done(&task.id),
            Err(error) => queue.mark_failed(&task.id, &error.to_string()),
        };
        match done {
            Ok(task) => {
                let _ = app.emit("transfer:done", task);
            }
            Err(error) => {
                let _ = app.emit("transfer:done", error.to_string());
            }
        }
    });
}
