// Author: Liz
use std::sync::Arc;

use crate::{
    error::AppResult,
    models::sftp::{TransferDirection, TransferStatus, TransferTask},
    storage::{sqlite::SqliteStore, transfers},
};

#[derive(Clone)]
pub struct TransferQueue {
    store: Arc<SqliteStore>,
}

impl TransferQueue {
    pub fn from_storage(store: Arc<SqliteStore>) -> Self {
        Self { store }
    }

    pub fn enqueue(
        &self,
        saved_session_id: &str,
        direction: TransferDirection,
        local_path: &str,
        remote_path: &str,
        total_bytes: u64,
    ) -> AppResult<TransferTask> {
        transfers::insert_transfer_task(
            self.store.as_ref(),
            saved_session_id,
            direction,
            local_path,
            remote_path,
            total_bytes,
        )
    }

    pub fn mark_running(&self, task_id: &str) -> AppResult<TransferTask> {
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Running,
            None,
            None,
        )
    }

    pub fn mark_progress(&self, task_id: &str, transferred_bytes: u64) -> AppResult<TransferTask> {
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Running,
            Some(transferred_bytes),
            None,
        )
    }

    pub fn mark_done(&self, task_id: &str) -> AppResult<TransferTask> {
        let task = transfers::get_transfer_task(self.store.as_ref(), task_id)?;
        transfers::update_transfer_task(
            self.store.as_ref(),
            task_id,
            TransferStatus::Done,
            Some(task.total_bytes),
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
}
