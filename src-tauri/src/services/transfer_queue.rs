// Author: Liz
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::sync::Notify;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::sftp::{
        TransferConflictPolicy, TransferDirection, TransferEndpoint, TransferKind, TransferStatus,
        TransferTask, TransferTaskOrigin,
    },
    storage::{sqlite::SqliteStore, transfers},
};

#[derive(Clone)]
pub struct TransferRunControl {
    inner: Arc<TransferRunControlInner>,
}

struct TransferRunControlInner {
    cancelled: AtomicBool,
    notify: Notify,
    paused: AtomicBool,
}

impl TransferRunControl {
    fn new() -> Self {
        Self {
            inner: Arc::new(TransferRunControlInner {
                cancelled: AtomicBool::new(false),
                notify: Notify::new(),
                paused: AtomicBool::new(false),
            }),
        }
    }

    fn pause(&self) {
        self.inner.paused.store(true, Ordering::SeqCst);
    }

    fn resume(&self) {
        self.inner.paused.store(false, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.paused.store(false, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub async fn checkpoint(&self) -> AppResult<()> {
        loop {
            let notified = self.inner.notify.notified();
            if self.inner.cancelled.load(Ordering::SeqCst) {
                return Err(AppError::sftp("传输已取消"));
            }
            if !self.inner.paused.load(Ordering::SeqCst) {
                return Ok(());
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
pub struct TransferQueue {
    controls: Arc<Mutex<HashMap<String, TransferRunControl>>>,
    store: Arc<SqliteStore>,
    transient_tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
}

impl TransferQueue {
    pub fn from_storage(store: Arc<SqliteStore>) -> Self {
        Self {
            controls: Arc::new(Mutex::new(HashMap::new())),
            store,
            transient_tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue(
        &self,
        saved_session_id: &str,
        direction: TransferDirection,
        local_path: &str,
        remote_path: &str,
        kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        total_bytes: u64,
    ) -> AppResult<TransferTask> {
        if is_external_session_id(saved_session_id) {
            let source_endpoint = match direction {
                TransferDirection::Upload => TransferEndpoint {
                    kind: crate::models::sftp::TransferEndpointKind::Local,
                    saved_session_id: None,
                    path: local_path.to_string(),
                },
                TransferDirection::Download => TransferEndpoint {
                    kind: crate::models::sftp::TransferEndpointKind::SavedSession,
                    saved_session_id: Some(saved_session_id.to_string()),
                    path: remote_path.to_string(),
                },
            };
            let destination_endpoint = match direction {
                TransferDirection::Upload => TransferEndpoint {
                    kind: crate::models::sftp::TransferEndpointKind::SavedSession,
                    saved_session_id: Some(saved_session_id.to_string()),
                    path: remote_path.to_string(),
                },
                TransferDirection::Download => TransferEndpoint {
                    kind: crate::models::sftp::TransferEndpointKind::Local,
                    saved_session_id: None,
                    path: local_path.to_string(),
                },
            };
            return self.enqueue_transient(
                saved_session_id,
                direction,
                local_path,
                remote_path,
                kind,
                conflict_policy,
                total_bytes,
                TransferTaskOrigin::SftpPanel,
                &source_endpoint,
                &destination_endpoint,
            );
        }
        transfers::insert_transfer_task(
            self.store.as_ref(),
            saved_session_id,
            direction,
            local_path,
            remote_path,
            kind,
            conflict_policy,
            total_bytes,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_with_endpoints(
        &self,
        saved_session_id: &str,
        direction: TransferDirection,
        local_path: &str,
        remote_path: &str,
        kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        total_bytes: u64,
        task_origin: TransferTaskOrigin,
        source_endpoint: &TransferEndpoint,
        destination_endpoint: &TransferEndpoint,
    ) -> AppResult<TransferTask> {
        if is_external_session_id(saved_session_id)
            || endpoint_uses_external_session(source_endpoint)
            || endpoint_uses_external_session(destination_endpoint)
        {
            return self.enqueue_transient(
                saved_session_id,
                direction,
                local_path,
                remote_path,
                kind,
                conflict_policy,
                total_bytes,
                task_origin,
                source_endpoint,
                destination_endpoint,
            );
        }
        transfers::insert_transfer_task_with_endpoints(
            self.store.as_ref(),
            saved_session_id,
            direction,
            local_path,
            remote_path,
            kind,
            conflict_policy,
            total_bytes,
            task_origin,
            source_endpoint,
            destination_endpoint,
        )
    }

    pub fn mark_running(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(task) = self.update_transient_task(task_id, |task| {
            if !matches!(
                task.status,
                TransferStatus::Paused | TransferStatus::Cancelled
            ) {
                task.status = TransferStatus::Running;
                task.error_message = None;
            }
            Ok(())
        })? {
            return Ok(task);
        }
        let task = transfers::get_transfer_task(self.store.as_ref(), task_id)?;
        if matches!(
            task.status,
            TransferStatus::Paused | TransferStatus::Cancelled
        ) {
            return Ok(task);
        }
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Running,
            None,
            None,
        )
    }

    pub fn mark_progress(&self, task_id: &str, transferred_bytes: u64) -> AppResult<TransferTask> {
        self.mark_progress_with_total(task_id, transferred_bytes, None)
    }

    pub fn mark_progress_with_total(
        &self,
        task_id: &str,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    ) -> AppResult<TransferTask> {
        if let Some(task) = self.update_transient_task(task_id, |task| {
            if !matches!(
                task.status,
                TransferStatus::Paused | TransferStatus::Cancelled
            ) {
                task.status = TransferStatus::Running;
            }
            task.transferred_bytes = transferred_bytes;
            if let Some(total_bytes) = total_bytes {
                task.total_bytes = task.total_bytes.max(total_bytes);
            }
            task.error_message = None;
            Ok(())
        })? {
            return Ok(task);
        }
        transfers::update_transfer_task_progress(
            self.store.as_ref(),
            task_id,
            transferred_bytes,
            total_bytes,
        )
    }

    pub fn mark_done(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(task) = self.update_transient_task(task_id, |task| {
            task.transferred_bytes = if task.total_bytes > 0 {
                task.total_bytes.max(task.transferred_bytes)
            } else {
                task.transferred_bytes
            };
            task.status = TransferStatus::Done;
            task.error_message = None;
            Ok(())
        })? {
            return Ok(task);
        }
        let task = transfers::get_transfer_task(self.store.as_ref(), task_id)?;
        let final_bytes = if task.total_bytes > 0 {
            task.total_bytes.max(task.transferred_bytes)
        } else {
            task.transferred_bytes
        };
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Done,
            Some(final_bytes),
            None,
        )
    }

    pub fn mark_failed(&self, task_id: &str, message: &str) -> AppResult<TransferTask> {
        if let Some(task) = self.update_transient_task(task_id, |task| {
            task.status = TransferStatus::Failed;
            task.error_message = Some(message.to_string());
            Ok(())
        })? {
            return Ok(task);
        }
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Failed,
            None,
            Some(message),
        )
    }

    pub fn retry_failed(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(task) = self.update_transient_task(task_id, |task| {
            if task.status != TransferStatus::Failed {
                return Err(AppError::validation("只有失败的传输任务可以重试"));
            }
            task.status = TransferStatus::Queued;
            task.transferred_bytes = 0;
            task.error_message = None;
            Ok(())
        })? {
            return Ok(task);
        }
        transfers::retry_transfer_task(self.store.as_ref(), task_id)
    }

    pub fn pause(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(current) = self.get_transient_task(task_id)? {
            if !matches!(
                current.status,
                TransferStatus::Queued | TransferStatus::Running
            ) {
                return Err(AppError::validation("只有运行中的传输任务可以暂停"));
            }
            let control = self.active_control(task_id, "只能暂停当前运行期的传输任务")?;
            let task = self
                .update_transient_task(task_id, |task| {
                    task.status = TransferStatus::Paused;
                    task.error_message = None;
                    Ok(())
                })?
                .ok_or_else(|| {
                    AppError::not_found(format!("transfer task not found: {task_id}"))
                })?;
            control.pause();
            return Ok(task);
        }
        let current = transfers::get_transfer_task(self.store.as_ref(), task_id)?;
        if !matches!(
            current.status,
            TransferStatus::Queued | TransferStatus::Running
        ) {
            return Err(AppError::validation("只有运行中的传输任务可以暂停"));
        }
        let control = self.active_control(task_id, "只能暂停当前运行期的传输任务")?;
        let task = transfers::update_transfer_task_status_checked(
            self.store.as_ref(),
            task_id,
            TransferStatus::Paused,
            &[TransferStatus::Queued, TransferStatus::Running],
            "只有运行中的传输任务可以暂停",
        )?;
        control.pause();
        Ok(task)
    }

    pub fn resume(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(current) = self.get_transient_task(task_id)? {
            if current.status != TransferStatus::Paused {
                return Err(AppError::validation("只有暂停的传输任务可以恢复"));
            }
            let control = self.active_control(task_id, "只能恢复当前运行期暂停的传输任务")?;
            let task = self
                .update_transient_task(task_id, |task| {
                    task.status = TransferStatus::Running;
                    task.error_message = None;
                    Ok(())
                })?
                .ok_or_else(|| {
                    AppError::not_found(format!("transfer task not found: {task_id}"))
                })?;
            control.resume();
            return Ok(task);
        }
        let control = self.active_control(task_id, "只能恢复当前运行期暂停的传输任务")?;
        let task = transfers::update_transfer_task_status_checked(
            self.store.as_ref(),
            task_id,
            TransferStatus::Running,
            &[TransferStatus::Paused],
            "只有暂停的传输任务可以恢复",
        )?;
        control.resume();
        Ok(task)
    }

    pub fn cancel(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(current) = self.get_transient_task(task_id)? {
            if !matches!(
                current.status,
                TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
            ) {
                return Err(AppError::validation("只有运行中的传输任务可以取消"));
            }
            let task = self
                .update_transient_task(task_id, |task| {
                    task.status = TransferStatus::Cancelled;
                    task.error_message = None;
                    Ok(())
                })?
                .ok_or_else(|| {
                    AppError::not_found(format!("transfer task not found: {task_id}"))
                })?;
            if let Some(control) = self.find_control(task_id)? {
                control.cancel();
            }
            return Ok(task);
        }
        let task = transfers::update_transfer_task_status_checked(
            self.store.as_ref(),
            task_id,
            TransferStatus::Cancelled,
            &[
                TransferStatus::Queued,
                TransferStatus::Running,
                TransferStatus::Paused,
            ],
            "只有运行中的传输任务可以取消",
        )?;
        if let Some(control) = self.find_control(task_id)? {
            control.cancel();
        }
        Ok(task)
    }

    pub fn delete(&self, task_id: &str) -> AppResult<()> {
        if let Some(task) = self.get_transient_task(task_id)? {
            if matches!(
                task.status,
                TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
            ) {
                if let Some(control) = self.find_control(task_id)? {
                    control.cancel();
                }
            }
            self.lock_transient_tasks()?.remove(task_id);
            self.unregister_control(task_id)?;
            return Ok(());
        }
        let task = transfers::get_transfer_task(self.store.as_ref(), task_id)?;
        if matches!(
            task.status,
            TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
        ) {
            if let Some(control) = self.find_control(task_id)? {
                control.cancel();
            }
            let _ = transfers::update_transfer_task_status_checked(
                self.store.as_ref(),
                task_id,
                TransferStatus::Cancelled,
                &[
                    TransferStatus::Queued,
                    TransferStatus::Running,
                    TransferStatus::Paused,
                ],
                "只有运行中的传输任务可以取消",
            )?;
        }
        transfers::delete_transfer_task(self.store.as_ref(), task_id)?;
        self.unregister_control(task_id)?;
        Ok(())
    }

    pub fn register_control(&self, task_id: &str) -> AppResult<TransferRunControl> {
        self.control_for(task_id)
    }

    pub fn unregister_control(&self, task_id: &str) -> AppResult<()> {
        let mut controls = self.lock_controls()?;
        controls.remove(task_id);
        Ok(())
    }

    pub fn get(&self, task_id: &str) -> AppResult<TransferTask> {
        if let Some(task) = self.get_transient_task(task_id)? {
            return Ok(task);
        }
        transfers::get_transfer_task(self.store.as_ref(), task_id)
    }

    pub fn list(&self, saved_session_id: Option<&str>, limit: u32) -> AppResult<Vec<TransferTask>> {
        let limit = limit.clamp(1, 1000) as usize;
        let mut tasks =
            transfers::list_transfer_tasks(self.store.as_ref(), saved_session_id, limit as u32)?;
        tasks.extend(
            self.lock_transient_tasks()?
                .values()
                .filter(|task| match saved_session_id {
                    Some(session_id) => {
                        task.saved_session_id == session_id
                            && task.task_origin == TransferTaskOrigin::SftpPanel
                    }
                    None => true,
                })
                .cloned(),
        );
        tasks.sort_by(|left, right| right.created_at_ms.cmp(&left.created_at_ms));
        tasks.truncate(limit);
        Ok(tasks)
    }

    #[allow(clippy::too_many_arguments)]
    fn enqueue_transient(
        &self,
        saved_session_id: &str,
        direction: TransferDirection,
        local_path: &str,
        remote_path: &str,
        kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        total_bytes: u64,
        task_origin: TransferTaskOrigin,
        source_endpoint: &TransferEndpoint,
        destination_endpoint: &TransferEndpoint,
    ) -> AppResult<TransferTask> {
        if saved_session_id.trim().is_empty()
            || local_path.trim().is_empty()
            || remote_path.trim().is_empty()
        {
            return Err(AppError::validation("临时传输任务的会话和路径不能为空"));
        }
        let now = now_ms();
        let task = TransferTask {
            id: Uuid::new_v4().to_string(),
            saved_session_id: saved_session_id.to_string(),
            direction,
            local_path: local_path.to_string(),
            remote_path: remote_path.to_string(),
            kind,
            conflict_policy,
            total_bytes,
            transferred_bytes: 0,
            status: TransferStatus::Queued,
            error_message: None,
            created_at_ms: now,
            updated_at_ms: now,
            task_origin,
            source_endpoint: source_endpoint.clone(),
            destination_endpoint: destination_endpoint.clone(),
        };
        self.lock_transient_tasks()?
            .insert(task.id.clone(), task.clone());
        Ok(task)
    }

    fn get_transient_task(&self, task_id: &str) -> AppResult<Option<TransferTask>> {
        Ok(self.lock_transient_tasks()?.get(task_id).cloned())
    }

    fn update_transient_task(
        &self,
        task_id: &str,
        update: impl FnOnce(&mut TransferTask) -> AppResult<()>,
    ) -> AppResult<Option<TransferTask>> {
        let mut tasks = self.lock_transient_tasks()?;
        let Some(task) = tasks.get_mut(task_id) else {
            return Ok(None);
        };
        update(task)?;
        task.updated_at_ms = now_ms();
        Ok(Some(task.clone()))
    }

    fn control_for(&self, task_id: &str) -> AppResult<TransferRunControl> {
        let mut controls = self.lock_controls()?;
        Ok(controls
            .entry(task_id.to_string())
            .or_insert_with(TransferRunControl::new)
            .clone())
    }

    fn active_control(
        &self,
        task_id: &str,
        validation_message: &str,
    ) -> AppResult<TransferRunControl> {
        self.find_control(task_id)?
            .ok_or_else(|| AppError::validation(validation_message))
    }

    fn find_control(&self, task_id: &str) -> AppResult<Option<TransferRunControl>> {
        let controls = self.lock_controls()?;
        Ok(controls.get(task_id).cloned())
    }

    fn lock_controls(
        &self,
    ) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, TransferRunControl>>> {
        self.controls
            .lock()
            .map_err(|_| AppError::storage("传输控制状态锁定失败"))
    }

    fn lock_transient_tasks(
        &self,
    ) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, TransferTask>>> {
        self.transient_tasks
            .lock()
            .map_err(|_| AppError::storage("临时传输任务状态锁定失败"))
    }
}

fn is_external_session_id(value: &str) -> bool {
    value.starts_with("external:")
}

fn endpoint_uses_external_session(endpoint: &TransferEndpoint) -> bool {
    endpoint
        .saved_session_id
        .as_deref()
        .is_some_and(is_external_session_id)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
