// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, types::Type, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::sftp::{
        TransferConflictPolicy, TransferDirection, TransferEndpoint, TransferEndpointKind,
        TransferKind, TransferStatus, TransferTask, TransferTaskOrigin,
    },
    storage::sqlite::SqliteStore,
};

pub const TRANSFER_TASKS_TABLE: &str = "transfer_tasks";

pub fn insert_transfer_task(
    store: &SqliteStore,
    saved_session_id: &str,
    direction: TransferDirection,
    local_path: &str,
    remote_path: &str,
    kind: Option<TransferKind>,
    conflict_policy: TransferConflictPolicy,
    total_bytes: u64,
) -> AppResult<TransferTask> {
    let source_endpoint = match direction {
        TransferDirection::Upload => TransferEndpoint {
            kind: TransferEndpointKind::Local,
            saved_session_id: None,
            path: local_path.to_string(),
        },
        TransferDirection::Download => TransferEndpoint {
            kind: TransferEndpointKind::Ssh,
            saved_session_id: Some(saved_session_id.to_string()),
            path: remote_path.to_string(),
        },
    };
    let destination_endpoint = match direction {
        TransferDirection::Upload => TransferEndpoint {
            kind: TransferEndpointKind::Ssh,
            saved_session_id: Some(saved_session_id.to_string()),
            path: remote_path.to_string(),
        },
        TransferDirection::Download => TransferEndpoint {
            kind: TransferEndpointKind::Local,
            saved_session_id: None,
            path: local_path.to_string(),
        },
    };
    insert_transfer_task_with_endpoints(
        store,
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
    )
}

#[allow(clippy::too_many_arguments)]
pub fn insert_transfer_task_with_endpoints(
    store: &SqliteStore,
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
    let saved_session_id = required_text("会话 ID", saved_session_id)?;
    let local_path = required_text("本地路径", local_path)?;
    let remote_path = required_text("远程路径", remote_path)?;
    validate_endpoint(source_endpoint, "来源端点")?;
    validate_endpoint(destination_endpoint, "目标端点")?;
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let total_bytes = u64_to_i64(total_bytes)?;

    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into transfer_tasks (
              id, saved_session_id, direction, local_path, remote_path,
              kind, conflict_policy, total_bytes, transferred_bytes, status,
              error_message, created_at_ms, updated_at_ms,
              task_origin, source_kind, source_session_id, source_path,
              destination_kind, destination_session_id, destination_path
            )
            values (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, null, ?10, ?11,
              ?12, ?13, ?14, ?15, ?16, ?17, ?18
            )
            ",
            params![
                id,
                saved_session_id,
                direction.as_str(),
                local_path,
                remote_path,
                kind.map(TransferKind::as_str),
                conflict_policy.as_str(),
                total_bytes,
                TransferStatus::Queued.as_str(),
                now,
                now,
                task_origin.as_str(),
                source_endpoint.kind.as_str(),
                source_endpoint.saved_session_id.as_deref(),
                source_endpoint.path,
                destination_endpoint.kind.as_str(),
                destination_endpoint.saved_session_id.as_deref(),
                destination_endpoint.path,
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
                       kind, conflict_policy, total_bytes, transferred_bytes, status, error_message,
                       created_at_ms, updated_at_ms,
                       task_origin, source_kind, source_session_id, source_path,
                       destination_kind, destination_session_id, destination_path
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
                       kind, conflict_policy, total_bytes, transferred_bytes, status, error_message,
                       created_at_ms, updated_at_ms,
                       task_origin, source_kind, source_session_id, source_path,
                       destination_kind, destination_session_id, destination_path
                from transfer_tasks
                where saved_session_id = ?1
                  and task_origin = 'sftp_panel'
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
                       kind, conflict_policy, total_bytes, transferred_bytes, status, error_message,
                       created_at_ms, updated_at_ms,
                       task_origin, source_kind, source_session_id, source_path,
                       destination_kind, destination_session_id, destination_path
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

pub fn update_transfer_task_status_checked(
    store: &SqliteStore,
    id: &str,
    next_status: TransferStatus,
    allowed_statuses: &[TransferStatus],
    validation_message: &str,
) -> AppResult<TransferTask> {
    let id = required_text("传输任务 ID", id)?;
    let now = now_ms();

    store.write_transaction(|transaction| {
        let status_value: String = transaction
            .query_row(
                "select status from transfer_tasks where id = ?1",
                [&id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("transfer task not found: {id}")))?;
        let status = TransferStatus::from_db(&status_value)
            .ok_or_else(|| AppError::storage(format!("invalid transfer status: {status_value}")))?;
        if !allowed_statuses.contains(&status) {
            return Err(AppError::validation(validation_message));
        }

        transaction.execute(
            "
            update transfer_tasks
            set status = ?2,
                error_message = null,
                updated_at_ms = ?3
            where id = ?1
            ",
            params![id, next_status.as_str(), now],
        )?;
        get_transfer_task_in_transaction(transaction, &id)
    })
}

pub fn update_transfer_task_progress(
    store: &SqliteStore,
    id: &str,
    transferred_bytes: u64,
    total_bytes: Option<u64>,
) -> AppResult<TransferTask> {
    let id = required_text("传输任务 ID", id)?;
    let transferred_bytes = u64_to_i64(transferred_bytes)?;
    let total_bytes = total_bytes.map(u64_to_i64).transpose()?;
    let now = now_ms();

    store.write_transaction(|transaction| {
        let changed = transaction.execute(
            "
            update transfer_tasks
            set status = case
                    when status in ('paused', 'cancelled') then status
                    else ?2
                end,
                transferred_bytes = ?3,
                total_bytes = case
                    when ?4 is null then total_bytes
                    else max(total_bytes, ?4)
                end,
                error_message = null,
                updated_at_ms = ?5
            where id = ?1
            ",
            params![
                id,
                TransferStatus::Running.as_str(),
                transferred_bytes,
                total_bytes,
                now,
            ],
        )?;
        if changed == 0 {
            return Err(AppError::not_found(format!(
                "transfer task not found: {id}"
            )));
        }
        get_transfer_task_in_transaction(transaction, &id)
    })
}

pub fn delete_transfer_task(store: &SqliteStore, id: &str) -> AppResult<()> {
    let id = required_text("传输任务 ID", id)?;
    store.write_transaction(|transaction| {
        let changed = transaction.execute("delete from transfer_tasks where id = ?1", [&id])?;
        if changed == 0 {
            return Err(AppError::not_found(format!(
                "transfer task not found: {id}"
            )));
        }
        Ok(())
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
                   kind, conflict_policy, total_bytes, transferred_bytes, status, error_message,
                   created_at_ms, updated_at_ms,
                   task_origin, source_kind, source_session_id, source_path,
                   destination_kind, destination_session_id, destination_path
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
    let kind_value: Option<String> = row.get(5)?;
    let conflict_policy_value: String = row.get(6)?;
    let status_value: String = row.get(9)?;
    let task_origin_value: String = row.get(13)?;
    let source_kind_value: String = row.get(14)?;
    let destination_kind_value: String = row.get(17)?;
    Ok(TransferTask {
        id: row.get(0)?,
        saved_session_id: row.get(1)?,
        direction: TransferDirection::from_db(&direction_value)
            .ok_or_else(|| conversion_error(2, format!("invalid direction: {direction_value}")))?,
        local_path: row.get(3)?,
        remote_path: row.get(4)?,
        kind: kind_value
            .as_deref()
            .map(|value| {
                TransferKind::from_db(value)
                    .ok_or_else(|| conversion_error(5, format!("invalid transfer kind: {value}")))
            })
            .transpose()?,
        conflict_policy: TransferConflictPolicy::from_db(&conflict_policy_value).ok_or_else(
            || {
                conversion_error(
                    6,
                    format!("invalid conflict policy: {conflict_policy_value}"),
                )
            },
        )?,
        total_bytes: i64_to_u64(7, row.get(7)?)?,
        transferred_bytes: i64_to_u64(8, row.get(8)?)?,
        status: TransferStatus::from_db(&status_value)
            .ok_or_else(|| conversion_error(9, format!("invalid status: {status_value}")))?,
        error_message: row.get(10)?,
        created_at_ms: row.get(11)?,
        updated_at_ms: row.get(12)?,
        task_origin: TransferTaskOrigin::from_db(&task_origin_value).ok_or_else(|| {
            conversion_error(13, format!("invalid task origin: {task_origin_value}"))
        })?,
        source_endpoint: TransferEndpoint {
            kind: TransferEndpointKind::from_db(&source_kind_value).ok_or_else(|| {
                conversion_error(14, format!("invalid source kind: {source_kind_value}"))
            })?,
            saved_session_id: row.get(15)?,
            path: row.get(16)?,
        },
        destination_endpoint: TransferEndpoint {
            kind: TransferEndpointKind::from_db(&destination_kind_value).ok_or_else(|| {
                conversion_error(
                    17,
                    format!("invalid destination kind: {destination_kind_value}"),
                )
            })?,
            saved_session_id: row.get(18)?,
            path: row.get(19)?,
        },
    })
}

fn validate_endpoint(endpoint: &TransferEndpoint, label: &str) -> AppResult<()> {
    required_text(&format!("{label}路径"), &endpoint.path)?;
    match endpoint.kind {
        TransferEndpointKind::Local => {
            if endpoint.saved_session_id.is_some() {
                return Err(AppError::validation(format!(
                    "{label}本机端点不能带会话 ID"
                )));
            }
        }
        TransferEndpointKind::Ssh => {
            let Some(saved_session_id) = endpoint.saved_session_id.as_deref() else {
                return Err(AppError::validation(format!("{label}SSH 端点必须选择会话")));
            };
            required_text(&format!("{label}会话 ID"), saved_session_id)?;
        }
    }
    Ok(())
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
