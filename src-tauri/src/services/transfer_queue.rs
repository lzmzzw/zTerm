// Author: Liz
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tokio::sync::Notify;

use crate::{
    error::{AppError, AppResult},
    models::sftp::{
        TransferConflictPolicy, TransferDirection, TransferKind, TransferStatus, TransferTask,
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
}

impl TransferQueue {
    pub fn from_storage(store: Arc<SqliteStore>) -> Self {
        Self {
            controls: Arc::new(Mutex::new(HashMap::new())),
            store,
        }
    }

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

    pub fn mark_running(&self, task_id: &str) -> AppResult<TransferTask> {
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
        transfers::update_transfer_task_progress(
            self.store.as_ref(),
            task_id,
            transferred_bytes,
            None,
        )
    }

    pub fn mark_progress_with_total(
        &self,
        task_id: &str,
        transferred_bytes: u64,
        total_bytes: Option<u64>,
    ) -> AppResult<TransferTask> {
        transfers::update_transfer_task_progress(
            self.store.as_ref(),
            task_id,
            transferred_bytes,
            total_bytes,
        )
    }

    pub fn mark_done(&self, task_id: &str) -> AppResult<TransferTask> {
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
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Failed,
            None,
            Some(message),
        )
    }

    pub fn retry_failed(&self, task_id: &str) -> AppResult<TransferTask> {
        transfers::retry_transfer_task(self.store.as_ref(), task_id)
    }

    pub fn pause(&self, task_id: &str) -> AppResult<TransferTask> {
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
        transfers::get_transfer_task(self.store.as_ref(), task_id)
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
}
