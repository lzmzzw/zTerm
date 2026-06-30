// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, types::Type, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::sftp::{TransferDirection, TransferStatus, TransferTask},
    storage::sqlite::SqliteStore,
};

pub const TRANSFER_TASKS_TABLE: &str = "transfer_tasks";

pub fn insert_transfer_task(
    store: &SqliteStore,
    saved_session_id: &str,
    direction: TransferDirection,
    local_path: &str,
    remote_path: &str,
    total_bytes: u64,
) -> AppResult<TransferTask> {
    let saved_session_id = required_text("会话 ID", saved_session_id)?;
    let local_path = required_text("本地路径", local_path)?;
    let remote_path = required_text("远程路径", remote_path)?;
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let total_bytes = u64_to_i64(total_bytes)?;

    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into transfer_tasks (
              id, saved_session_id, direction, local_path, remote_path,
              total_bytes, transferred_bytes, status, error_message, created_at_ms, updated_at_ms
            )
            values (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, null, ?8, ?9)
            ",
            params![
                id,
                saved_session_id,
                direction.as_str(),
                local_path,
                remote_path,
                total_bytes,
                TransferStatus::Queued.as_str(),
                now,
                now,
            ],
        )?;
        get_transfer_task_in_transaction(transaction, &id)
    })
}

pub fn get_transfer_task(store: &SqliteStore, id: &str) -> AppResult<TransferTask> {
    let id = required_text("传输任务 ID", id)?;
    store.with_connection(|connection| {
        connection
            .query_row(
                "
                select id, saved_session_id, direction, local_path, remote_path,
                       total_bytes, transferred_bytes, status, error_message,
                       created_at_ms, updated_at_ms
                from transfer_tasks
                where id = ?1
                ",
                [&id],
                map_transfer_task,
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("transfer task not found: {id}")))
    })
}

pub fn list_transfer_tasks(
    store: &SqliteStore,
    saved_session_id: Option<&str>,
    limit: u32,
) -> AppResult<Vec<TransferTask>> {
    let limit = i64::from(limit.clamp(1, 1000));
    store.with_connection(|connection| {
        if let Some(saved_session_id) = saved_session_id {
            let saved_session_id = required_text("会话 ID", saved_session_id)?;
            let mut statement = connection.prepare(
                "
                select id, saved_session_id, direction, local_path, remote_path,
                       total_bytes, transferred_bytes, status, error_message,
                       created_at_ms, updated_at_ms
                from transfer_tasks
                where saved_session_id = ?1
                order by created_at_ms desc
                limit ?2
                ",
            )?;
            let tasks = statement
                .query_map(params![saved_session_id, limit], map_transfer_task)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(tasks)
        } else {
            let mut statement = connection.prepare(
                "
                select id, saved_session_id, direction, local_path, remote_path,
                       total_bytes, transferred_bytes, status, error_message,
                       created_at_ms, updated_at_ms
                from transfer_tasks
                order by created_at_ms desc
                limit ?1
                ",
            )?;
            let tasks = statement
                .query_map([limit], map_transfer_task)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(tasks)
        }
    })
}

pub fn update_transfer_task(
    store: &SqliteStore,
    id: &str,
    status: TransferStatus,
    transferred_bytes: Option<u64>,
    error_message: Option<&str>,
) -> AppResult<TransferTask> {
    let id = required_text("传输任务 ID", id)?;
    let transferred_bytes = transferred_bytes.map(u64_to_i64).transpose()?;
    let now = now_ms();

    store.write_transaction(|transaction| {
        let changed = transaction.execute(
            "
            update transfer_tasks
            set status = ?2,
                transferred_bytes = coalesce(?3, transferred_bytes),
                error_message = ?4,
                updated_at_ms = ?5
            where id = ?1
            ",
            params![id, status.as_str(), transferred_bytes, error_message, now,],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!(
                "transfer task not found: {id}"
            )));
        }
        get_transfer_task_in_transaction(transaction, &id)
    })
}

pub fn retry_transfer_task(store: &SqliteStore, id: &str) -> AppResult<TransferTask> {
    let id = required_text("传输任务 ID", id)?;
    let now = now_ms();

    store.write_transaction(|transaction| {
        let status: String = transaction
            .query_row(
                "select status from transfer_tasks where id = ?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("transfer task not found: {id}")))?;
        if TransferStatus::from_db(&status) != Some(TransferStatus::Failed) {
            return Err(AppError::validation("只有失败的传输任务可以重试"));
        }

        transaction.execute(
            "
            update transfer_tasks
            set status = ?2,
                transferred_bytes = 0,
                error_message = null,
                updated_at_ms = ?3
            where id = ?1
            ",
            params![id, TransferStatus::Queued.as_str(), now],
        )?;
        get_transfer_task_in_transaction(transaction, &id)
    })
}

fn get_transfer_task_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    id: &str,
) -> AppResult<TransferTask> {
    transaction
        .query_row(
            "
            select id, saved_session_id, direction, local_path, remote_path,
                   total_bytes, transferred_bytes, status, error_message,
                   created_at_ms, updated_at_ms
            from transfer_tasks
            where id = ?1
            ",
            [id],
            map_transfer_task,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found(format!("transfer task not found: {id}")))
}

fn map_transfer_task(row: &Row<'_>) -> rusqlite::Result<TransferTask> {
    let direction_value: String = row.get(2)?;
    let status_value: String = row.get(7)?;
    Ok(TransferTask {
        id: row.get(0)?,
        saved_session_id: row.get(1)?,
        direction: TransferDirection::from_db(&direction_value)
            .ok_or_else(|| conversion_error(2, format!("invalid direction: {direction_value}")))?,
        local_path: row.get(3)?,
        remote_path: row.get(4)?,
        total_bytes: i64_to_u64(5, row.get(5)?)?,
        transferred_bytes: i64_to_u64(6, row.get(6)?)?,
        status: TransferStatus::from_db(&status_value)
            .ok_or_else(|| conversion_error(7, format!("invalid status: {status_value}")))?,
        error_message: row.get(8)?,
        created_at_ms: row.get(9)?,
        updated_at_ms: row.get(10)?,
    })
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn u64_to_i64(value: u64) -> AppResult<i64> {
    i64::try_from(value).map_err(|_| AppError::validation("传输字节数超出支持范围"))
}

fn i64_to_u64(column: usize, value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| conversion_error(column, error.to_string()))
}

fn conversion_error(column: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        Box::new(AppError::storage(message)),
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
