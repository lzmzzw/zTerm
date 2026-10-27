// Author: Liz
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tokio::sync::Notify;
use uuid::Uuid;

use super::transfer_resume::TransferResumeContext;

use crate::{
    error::{AppError, AppResult},
    models::sftp::{
        TransferConflictPolicy, TransferDirection, TransferEndpoint, TransferKind, TransferStatus,
        TransferTask, TransferTaskOrigin,
    },
    storage::{sqlite::SqliteStore, transfers},
    time::now_ms,
};

const MAX_CONCURRENT_TRANSFER_EXECUTIONS: usize = 4;
const MAX_CONCURRENT_HOST_TRANSFERS: usize = 2;

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct TransferHostKey {
    host: String,
    port: u16,
}

impl TransferHostKey {
    fn for_session(session: &crate::models::session::SavedSession) -> Option<Self> {
        use crate::models::session::SessionType;
        matches!(
            session.session_type,
            SessionType::Ssh | SessionType::Sftp | SessionType::Ftp
        )
        .then(|| Self {
            host: session.host.trim().to_ascii_lowercase(),
            port: session.port,
        })
    }
}

#[derive(Default)]
struct TransferExecutionState {
    active: usize,
    hosts: HashMap<TransferHostKey, usize>,
}

#[derive(Default)]
struct TransferExecutionScheduler {
    state: Mutex<TransferExecutionState>,
    changed: Notify,
}

pub(crate) struct TransferExecutionLease {
    scheduler: Arc<TransferExecutionScheduler>,
    hosts: Vec<TransferHostKey>,
}

impl Drop for TransferExecutionLease {
    fn drop(&mut self) {
        let mut state = self
            .scheduler
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.active -= 1;
        for host in &self.hosts {
            if let Some(count) = state.hosts.get_mut(host) {
                *count -= 1;
                if *count == 0 {
                    state.hosts.remove(host);
                }
            }
        }
        drop(state);
        self.scheduler.changed.notify_waiters();
    }
}

impl TransferExecutionScheduler {
    async fn acquire(
        self: &Arc<Self>,
        control: &TransferRunControl,
        mut hosts: Vec<TransferHostKey>,
    ) -> AppResult<TransferExecutionLease> {
        hosts.sort();
        hosts.dedup();
        loop {
            // 在检查状态之前注册两个通知，避免释放名额或取消恰好发生在检查与等待之间。
            let changed = self.changed.notified();
            let controlled = control.inner.notify.notified();
            tokio::pin!(changed, controlled);
            changed.as_mut().enable();
            controlled.as_mut().enable();
            if control.is_cancelled() {
                return Err(AppError::sftp("传输已取消"));
            }
            if !control.is_paused() {
                let mut state = self
                    .state
                    .lock()
                    .map_err(|_| AppError::storage("传输执行队列锁定失败"))?;
                // 两端配额在同一临界区一次性申请，绝不持有一端等待另一端。
                if state.active < MAX_CONCURRENT_TRANSFER_EXECUTIONS
                    && hosts.iter().all(|host| {
                        state.hosts.get(host).copied().unwrap_or(0) < MAX_CONCURRENT_HOST_TRANSFERS
                    })
                {
                    state.active += 1;
                    for host in &hosts {
                        *state.hosts.entry(host.clone()).or_default() += 1;
                    }
                    drop(state);
                    let lease = TransferExecutionLease {
                        scheduler: Arc::clone(self),
                        hosts,
                    };
                    if control.is_cancelled() {
                        return Err(AppError::sftp("传输已取消"));
                    }
                    if control.is_paused() {
                        hosts = lease.hosts.clone();
                        drop(lease);
                        continue;
                    }
                    return Ok(lease);
                }
            }
            tokio::select! {
                _ = &mut changed => {},
                _ = &mut controlled => {},
            }
        }
    }
}

#[derive(Clone)]
pub struct TransferRunControl {
    inner: Arc<TransferRunControlInner>,
}

struct TransferRunControlInner {
    cancelled: AtomicBool,
    notify: Notify,
    paused: AtomicBool,
    resume_context: Mutex<Option<TransferResumeContext>>,
    publishing: Mutex<bool>,
}

pub(crate) struct TransferPublishGuard {
    inner: Arc<TransferRunControlInner>,
}

impl Drop for TransferPublishGuard {
    fn drop(&mut self) {
        *self
            .inner
            .publishing
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = false;
        self.inner.notify.notify_waiters();
    }
}

impl TransferRunControl {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(TransferRunControlInner {
                cancelled: AtomicBool::new(false),
                notify: Notify::new(),
                paused: AtomicBool::new(false),
                resume_context: Mutex::new(None),
                publishing: Mutex::new(false),
            }),
        }
    }

    pub(crate) fn pause(&self) {
        self.inner.paused.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub(crate) fn resume_context(&self) -> Option<TransferResumeContext> {
        self.inner
            .resume_context
            .lock()
            .ok()
            .and_then(|context| context.clone())
    }

    pub(crate) fn resume(&self) {
        self.inner.paused.store(false, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub(crate) fn cancel(&self) {
        // Shutdown may request cancellation during commit, but callers must
        // await an already-sent publish operation instead of dropping it.
        let _publishing = self
            .inner
            .publishing
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.set_cancelled();
    }

    fn set_cancelled(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.paused.store(false, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    pub(crate) fn request_cancel(&self) -> AppResult<()> {
        let publishing = self
            .inner
            .publishing
            .lock()
            .map_err(|_| AppError::sftp("传输发布状态锁定失败"))?;
        if *publishing {
            return Err(AppError::validation("文件正在发布，请等待结果"));
        }
        self.set_cancelled();
        Ok(())
    }

    pub(crate) fn begin_publish(&self) -> AppResult<TransferPublishGuard> {
        let mut publishing = self
            .inner
            .publishing
            .lock()
            .map_err(|_| AppError::sftp("传输发布状态锁定失败"))?;
        if self.is_cancelled() {
            return Err(AppError::sftp("传输已取消"));
        }
        if *publishing {
            return Err(AppError::validation("文件正在发布，请等待结果"));
        }
        *publishing = true;
        Ok(TransferPublishGuard {
            inner: Arc::clone(&self.inner),
        })
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

    pub(crate) fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    pub(crate) fn wait_for_state_change(
        &self,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        let inner = self.inner.clone();
        Box::pin(async move {
            inner.notify.notified().await;
        })
    }
}

#[derive(Clone)]
pub struct TransferQueue {
    controls: Arc<Mutex<HashMap<String, TransferRunControl>>>,
    execution_slots: Arc<TransferExecutionScheduler>,
    store: Arc<SqliteStore>,
    transient_tasks: Arc<Mutex<HashMap<String, TransferTask>>>,
}

impl TransferQueue {
    pub fn from_storage(store: Arc<SqliteStore>) -> Self {
        Self {
            controls: Arc::new(Mutex::new(HashMap::new())),
            execution_slots: Arc::new(TransferExecutionScheduler::default()),
            store,
            transient_tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn reconcile_interrupted_tasks(&self) -> AppResult<usize> {
        transfers::fail_interrupted_transfer_tasks(self.store.as_ref())
    }

    pub(crate) async fn acquire_execution_slot(
        &self,
        control: &TransferRunControl,
        sessions: &[&crate::models::session::SavedSession],
    ) -> AppResult<TransferExecutionLease> {
        let hosts = sessions
            .iter()
            .filter_map(|session| TransferHostKey::for_session(session))
            .collect();
        self.execution_slots.acquire(control, hosts).await
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
        self.enqueue_grouped(
            saved_session_id,
            direction,
            local_path,
            remote_path,
            kind,
            conflict_policy,
            total_bytes,
            None,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_grouped(
        &self,
        saved_session_id: &str,
        direction: TransferDirection,
        local_path: &str,
        remote_path: &str,
        kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        total_bytes: u64,
        group_id: Option<&str>,
        group_name: Option<&str>,
    ) -> AppResult<TransferTask> {
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
        if is_external_session_id(saved_session_id) {
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
                group_id,
                group_name,
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
            TransferTaskOrigin::SftpPanel,
            &source_endpoint,
            &destination_endpoint,
            group_id,
            group_name,
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
        self.enqueue_with_endpoints_grouped(
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
            None,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn enqueue_with_endpoints_grouped(
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
        group_id: Option<&str>,
        group_name: Option<&str>,
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
                group_id,
                group_name,
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
            group_id,
            group_name,
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
            reject_unknown_publish_retry(task)?;
            task.status = TransferStatus::Queued;
            task.transferred_bytes = 0;
            task.error_message = None;
            Ok(())
        })? {
            return Ok(task);
        }
        reject_unknown_publish_retry(&transfers::get_transfer_task(self.store.as_ref(), task_id)?)?;
        TransferResumeContext::new(Arc::clone(&self.store), task_id).ensure_retryable()?;
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
            if let Some(control) = self.find_control(task_id)? {
                control.request_cancel()?;
            }
            let task = self
                .update_transient_task(task_id, |task| {
                    if !matches!(
                        task.status,
                        TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
                    ) {
                        return Err(AppError::validation("只有运行中的传输任务可以取消"));
                    }
                    task.status = TransferStatus::Cancelled;
                    task.error_message = None;
                    Ok(())
                })?
                .ok_or_else(|| {
                    AppError::not_found(format!("transfer task not found: {task_id}"))
                })?;
            return Ok(task);
        }
        let current = transfers::get_transfer_task(self.store.as_ref(), task_id)?;
        if !matches!(
            current.status,
            TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
        ) {
            return Err(AppError::validation("只有运行中的传输任务可以取消"));
        }
        if let Some(control) = self.find_control(task_id)? {
            control.request_cancel()?;
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
        Ok(task)
    }

    pub fn delete(&self, task_id: &str) -> AppResult<()> {
        if let Some(task) = self.get_transient_task(task_id)? {
            if matches!(
                task.status,
                TransferStatus::Queued | TransferStatus::Running | TransferStatus::Paused
            ) {
                if let Some(control) = self.find_control(task_id)? {
                    control.request_cancel()?;
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
                control.request_cancel()?;
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

    pub fn clear_all(&self) -> AppResult<usize> {
        self.cancel_all_controls()?;
        let transient_count = {
            let mut tasks = self.lock_transient_tasks()?;
            let count = tasks.len();
            tasks.clear();
            count
        };
        let persistent_count = transfers::delete_all_transfer_tasks(self.store.as_ref())?;
        Ok(transient_count + persistent_count)
    }

    pub fn register_control(&self, task_id: &str) -> AppResult<TransferRunControl> {
        // Only persistent tasks own durable checkpoints. Transient/external
        // connections keep their existing lifetime and never create orphan rows.
        let resume_context = if transfers::get_transfer_task(self.store.as_ref(), task_id).is_ok() {
            let context = TransferResumeContext::new(Arc::clone(&self.store), task_id);
            context.ensure_retryable()?;
            Some(context)
        } else {
            None
        };
        let control = self.control_for(task_id)?;
        if let Some(context) = resume_context {
            *control
                .inner
                .resume_context
                .lock()
                .map_err(|_| AppError::storage("传输检查点锁定失败"))? = Some(context);
        }
        Ok(control)
    }

    pub fn unregister_control(&self, task_id: &str) -> AppResult<()> {
        let mut controls = self.lock_controls()?;
        controls.remove(task_id);
        Ok(())
    }

    pub fn cancel_all_controls(&self) -> AppResult<usize> {
        let controls = std::mem::take(&mut *self.lock_controls()?);
        let count = controls.len();
        for (_, control) in controls {
            control.cancel();
        }
        Ok(count)
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
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at_ms));
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
        group_id: Option<&str>,
        group_name: Option<&str>,
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
            group_id: group_id.map(str::to_string),
            group_name: group_name.map(str::to_string),
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

fn reject_unknown_publish_retry(task: &TransferTask) -> AppResult<()> {
    if task
        .error_message
        .as_deref()
        .is_some_and(|message| message.contains("SFTP_PUBLISH_OUTCOME_UNKNOWN"))
    {
        return Err(AppError::validation(
            "目标文件发布结果未知，请先核对目标文件，再决定是否重新传输",
        ));
    }
    Ok(())
}

fn endpoint_uses_external_session(endpoint: &TransferEndpoint) -> bool {
    endpoint
        .saved_session_id
        .as_deref()
        .is_some_and(is_external_session_id)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use super::{TransferQueue, TransferRunControl};
    use crate::models::session::{AuthMode, SavedSessionDraft, SessionType};
    use crate::models::sftp::{
        TransferConflictPolicy, TransferDirection, TransferKind, TransferStatus,
    };
    use crate::storage::{sessions::save_session, sqlite::SqliteStore};

    #[tokio::test]
    async fn limits_parallel_transfer_executions() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
        let queue = TransferQueue::from_storage(store);
        let mut permits = Vec::new();
        for _ in 0..4 {
            permits.push(
                queue
                    .acquire_execution_slot(&TransferRunControl::new(), &[])
                    .await
                    .unwrap(),
            );
        }
        let second_control = TransferRunControl::new();
        let second = queue.acquire_execution_slot(&second_control, &[]);
        tokio::pin!(second);

        assert!(tokio::time::timeout(Duration::from_millis(20), &mut second)
            .await
            .is_err());
        permits.pop();
        let _second = tokio::time::timeout(Duration::from_millis(100), &mut second)
            .await
            .expect("second transfer should start after the slot is released")
            .expect("second transfer slot should be available");
    }

    #[tokio::test]
    async fn shutdown_cancels_and_unregisters_all_transfer_controls() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
        let queue = TransferQueue::from_storage(store);
        let first = queue
            .register_control("transfer-1")
            .expect("first control should register");
        let second = queue
            .register_control("transfer-2")
            .expect("second control should register");

        assert_eq!(
            queue.cancel_all_controls().expect("controls should cancel"),
            2
        );
        assert!(first.checkpoint().await.is_err());
        assert!(second.checkpoint().await.is_err());
        assert_eq!(
            queue
                .cancel_all_controls()
                .expect("repeat cancel should be safe"),
            0
        );
    }

    fn host(name: &str) -> super::TransferHostKey {
        super::TransferHostKey {
            host: name.into(),
            port: 22,
        }
    }

    #[test]
    fn publish_and_user_cancel_are_mutually_exclusive() {
        use std::sync::Barrier;
        for _ in 0..100 {
            let control = TransferRunControl::new();
            let barrier = Arc::new(Barrier::new(2));
            let worker_control = control.clone();
            let worker_barrier = Arc::clone(&barrier);
            let worker = std::thread::spawn(move || {
                worker_barrier.wait();
                worker_control.request_cancel()
            });
            barrier.wait();
            let publishing = control.begin_publish();
            let cancelled = worker.join().unwrap();
            assert_ne!(
                publishing.is_ok(),
                cancelled.is_ok(),
                "exactly one side may win"
            );
            if publishing.is_ok() {
                assert!(!control.is_cancelled());
            } else {
                assert!(control.is_cancelled());
            }
            drop(publishing);
        }
    }

    #[test]
    fn queue_cancel_during_publish_preserves_running_until_guard_drops() {
        let store = Arc::new(SqliteStore::open_in_memory().unwrap());
        let session = test_session(&store);
        let queue = TransferQueue::from_storage(store);
        for session_id in [session.id.as_str(), "external:publish-guard"] {
            let task = queue
                .enqueue(
                    session_id,
                    TransferDirection::Upload,
                    "C:/source",
                    "/target",
                    Some(TransferKind::File),
                    TransferConflictPolicy::Overwrite,
                    1,
                )
                .unwrap();
            let control = queue.register_control(&task.id).unwrap();
            queue.mark_running(&task.id).unwrap();
            let guard = control.begin_publish().unwrap();
            let error = queue.cancel(&task.id).unwrap_err();
            assert!(error.to_string().contains("文件正在发布，请等待结果"));
            assert_eq!(queue.get(&task.id).unwrap().status, TransferStatus::Running);
            assert!(!control.is_cancelled());
            drop(guard);
            assert_eq!(
                queue.cancel(&task.id).unwrap().status,
                TransferStatus::Cancelled
            );
            assert!(control.begin_publish().is_err());
        }
    }

    #[test]
    fn shutdown_cancel_does_not_invalidate_an_existing_publish_guard() {
        let control = TransferRunControl::new();
        let guard = control.begin_publish().unwrap();
        control.cancel();
        assert!(control.is_cancelled());
        assert!(*control.inner.publishing.lock().unwrap());
        drop(guard);
        assert!(!*control.inner.publishing.lock().unwrap());
        assert!(control.begin_publish().is_err());
    }

    #[tokio::test]
    async fn host_quota_and_atomic_cross_host_reservation_release_all_counts() {
        let scheduler = Arc::new(super::TransferExecutionScheduler::default());
        let control = TransferRunControl::new();
        let first = scheduler.acquire(&control, vec![host("a")]).await.unwrap();
        let second = scheduler.acquire(&control, vec![host("a")]).await.unwrap();
        let cross = scheduler.acquire(&control, vec![host("b"), host("a"), host("b")]);
        tokio::pin!(cross);
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut cross)
            .await
            .is_err());
        assert!(
            !scheduler
                .state
                .lock()
                .unwrap()
                .hosts
                .contains_key(&host("b")),
            "waiting for a must not reserve b"
        );
        let other = scheduler.acquire(&control, vec![host("b")]).await.unwrap();
        drop(first);
        let lease = tokio::time::timeout(Duration::from_millis(100), &mut cross)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            scheduler.state.lock().unwrap().hosts[&host("b")],
            2,
            "duplicate endpoint consumes only one quota"
        );
        drop((lease, second, other));
        let state = scheduler.state.lock().unwrap();
        assert_eq!(state.active, 0);
        assert!(state.hosts.is_empty(), "idle hosts must not accumulate");
    }

    #[tokio::test]
    async fn waiting_transfer_can_pause_resume_cancel_and_abort_without_leaking_slots() {
        let scheduler = Arc::new(super::TransferExecutionScheduler::default());
        let control = TransferRunControl::new();
        control.pause();
        let waiting = scheduler.acquire(&control, vec![host("a")]);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut waiting)
                .await
                .is_err()
        );
        assert_eq!(scheduler.state.lock().unwrap().active, 0);
        control.resume();
        let lease = tokio::time::timeout(Duration::from_millis(100), &mut waiting)
            .await
            .unwrap()
            .unwrap();
        drop(lease);

        let mut occupied = Vec::new();
        for _ in 0..4 {
            occupied.push(
                scheduler
                    .acquire(&TransferRunControl::new(), vec![])
                    .await
                    .unwrap(),
            );
        }
        let cancelled = TransferRunControl::new();
        let pending = scheduler.acquire(&cancelled, vec![host("cancelled")]);
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut pending)
                .await
                .is_err()
        );
        cancelled.cancel();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut pending)
                .await
                .unwrap()
                .is_err()
        );
        drop(occupied);
        let spawned_scheduler = Arc::clone(&scheduler);
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _lease = spawned_scheduler
                .acquire(&TransferRunControl::new(), vec![host("abort")])
                .await
                .unwrap();
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        assert_eq!(scheduler.state.lock().unwrap().active, 0);
        assert!(scheduler.state.lock().unwrap().hosts.is_empty());
    }

    fn test_session(store: &SqliteStore) -> crate::models::session::SavedSession {
        save_session(
            store,
            SavedSessionDraft {
                id: None,
                name: "quota-test".into(),
                session_type: SessionType::Ssh,
                group_id: None,
                host: "Example.TEST".into(),
                port: 22,
                username: "ops".into(),
                auth_mode: AuthMode::Agent,
                credential_ref: None,
                description: None,
                tags: Vec::new(),
                sort_order: 0,
                ssh_options: None,
                rdp_options: None,
                local_options: None,
                ftp_options: None,
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn sessions_share_host_port_quota_and_local_endpoints_have_no_host_quota() {
        let store = Arc::new(SqliteStore::open_in_memory().unwrap());
        let session = test_session(&store);
        let mut other = session.clone();
        other.id = "another-session".into();
        other.host = session.host.to_ascii_uppercase();
        other.session_type = SessionType::Ftp;
        assert_eq!(
            super::TransferHostKey::for_session(&session),
            super::TransferHostKey::for_session(&other)
        );
        let queue = TransferQueue::from_storage(store);
        let control = TransferRunControl::new();
        let _first = queue
            .acquire_execution_slot(&control, &[&session])
            .await
            .unwrap();
        let _second = queue
            .acquire_execution_slot(&control, &[&other])
            .await
            .unwrap();
        assert!(tokio::time::timeout(
            Duration::from_millis(20),
            queue.acquire_execution_slot(&control, &[&other])
        )
        .await
        .is_err());
        other.port = 2121;
        let _third = queue
            .acquire_execution_slot(&control, &[&other])
            .await
            .unwrap();
        other.session_type = SessionType::Local;
        assert!(super::TransferHostKey::for_session(&other).is_none());
        let _local = queue
            .acquire_execution_slot(&control, &[&other])
            .await
            .unwrap();
    }

    #[test]
    fn retry_rejects_unknown_publish_for_persisted_and_transient_tasks_only() {
        let store = Arc::new(SqliteStore::open_in_memory().unwrap());
        let session = test_session(&store);
        let queue = TransferQueue::from_storage(store);
        for session_id in [session.id.as_str(), "external:test"] {
            let task = queue
                .enqueue(
                    session_id,
                    TransferDirection::Upload,
                    "C:/source",
                    "/destination",
                    Some(TransferKind::File),
                    TransferConflictPolicy::Overwrite,
                    1,
                )
                .unwrap();
            queue
                .mark_failed(&task.id, "SFTP_PUBLISH_OUTCOME_UNKNOWN: connection closed")
                .unwrap();
            assert!(queue
                .retry_failed(&task.id)
                .unwrap_err()
                .to_string()
                .contains("先核对目标"));
            let unchanged = queue.get(&task.id).unwrap();
            assert_eq!(unchanged.status, TransferStatus::Failed);
            assert!(unchanged
                .error_message
                .unwrap()
                .contains("SFTP_PUBLISH_OUTCOME_UNKNOWN"));
            queue
                .mark_failed(&task.id, "ordinary transfer failure")
                .unwrap();
            assert_eq!(
                queue.retry_failed(&task.id).unwrap().status,
                TransferStatus::Queued
            );
        }
    }

    #[test]
    fn startup_marks_persisted_incomplete_transfers_as_failed() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
        let session = save_session(
            store.as_ref(),
            SavedSessionDraft {
                id: None,
                name: "test".to_string(),
                session_type: SessionType::Ssh,
                group_id: None,
                host: "example.test".to_string(),
                port: 22,
                username: "ops".to_string(),
                auth_mode: AuthMode::Agent,
                credential_ref: None,
                description: None,
                tags: Vec::new(),
                sort_order: 0,
                ssh_options: None,
                rdp_options: None,
                local_options: None,
                ftp_options: None,
            },
        )
        .expect("session should save");
        let queue = TransferQueue::from_storage(store);
        let task = queue
            .enqueue(
                &session.id,
                TransferDirection::Upload,
                "C:/tmp/source.bin",
                "/tmp/source.bin",
                Some(TransferKind::File),
                TransferConflictPolicy::Overwrite,
                1024,
            )
            .expect("transfer should enqueue");
        queue.mark_running(&task.id).expect("transfer should start");

        assert_eq!(
            queue
                .reconcile_interrupted_tasks()
                .expect("startup reconciliation should succeed"),
            1
        );
        let reconciled = queue.get(&task.id).expect("transfer should remain visible");
        assert_eq!(reconciled.status, TransferStatus::Failed);
        assert_eq!(
            reconciled.error_message.as_deref(),
            Some("应用已重启，传输任务已中断")
        );
        assert_eq!(
            queue
                .reconcile_interrupted_tasks()
                .expect("repeat reconciliation should be idempotent"),
            0
        );
    }

    #[test]
    fn clear_all_removes_tasks_beyond_the_list_limit_across_restart() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
        let session = save_session(
            store.as_ref(),
            SavedSessionDraft {
                id: None,
                name: "bulk-clear".to_string(),
                session_type: SessionType::Ssh,
                group_id: None,
                host: "example.test".to_string(),
                port: 22,
                username: "ops".to_string(),
                auth_mode: AuthMode::Agent,
                credential_ref: None,
                description: None,
                tags: Vec::new(),
                sort_order: 0,
                ssh_options: None,
                rdp_options: None,
                local_options: None,
                ftp_options: None,
            },
        )
        .expect("session should save");
        let queue = TransferQueue::from_storage(store.clone());
        for index in 0..1001 {
            queue
                .enqueue(
                    &session.id,
                    TransferDirection::Upload,
                    &format!("C:/tmp/source-{index}.bin"),
                    &format!("/tmp/source-{index}.bin"),
                    Some(TransferKind::File),
                    TransferConflictPolicy::Overwrite,
                    1,
                )
                .expect("transfer should enqueue");
        }

        assert_eq!(
            queue.list(None, 1000).expect("tasks should list").len(),
            1000
        );
        assert_eq!(queue.clear_all().expect("all tasks should clear"), 1001);

        let restarted_queue = TransferQueue::from_storage(store);
        assert!(restarted_queue
            .list(None, 1000)
            .expect("cleared tasks should stay absent after restart")
            .is_empty());
    }
}
