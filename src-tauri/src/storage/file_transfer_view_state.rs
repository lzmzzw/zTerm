// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};

use crate::{
    error::{AppError, AppResult},
    models::sftp::{FileTransferViewState, TransferEndpoint, TransferEndpointKind},
    storage::sqlite::SqliteStore,
};

pub fn get_file_transfer_view_state(
    store: &SqliteStore,
) -> AppResult<Option<FileTransferViewState>> {
    store.with_connection(|connection| {
        let state_json = connection
            .query_row(
                "select state_json from file_transfer_view_state where id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        state_json
            .map(|value| {
                serde_json::from_str::<FileTransferViewState>(&value)
                    .map_err(|error| AppError::storage(error.to_string()))
            })
            .transpose()
    })
}

pub fn save_file_transfer_view_state(
    store: &SqliteStore,
    state: FileTransferViewState,
) -> AppResult<FileTransferViewState> {
    validate_endpoint(&state.left)?;
    validate_endpoint(&state.right)?;
    let now = now_ms();
    let state_json =
        serde_json::to_string(&state).map_err(|error| AppError::storage(error.to_string()))?;

    store.write_transaction(|transaction| {
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from file_transfer_view_state where id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);
        transaction.execute(
            "
            insert into file_transfer_view_state (id, state_json, created_at_ms, updated_at_ms)
            values (1, ?1, ?2, ?3)
            on conflict(id) do update set
              state_json = excluded.state_json,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![state_json, created_at_ms, now],
        )?;
        Ok(state)
    })
}

fn validate_endpoint(endpoint: &TransferEndpoint) -> AppResult<()> {
    if endpoint.path.trim().is_empty() {
        return Err(AppError::validation("文件传输端点路径不能为空"));
    }
    match endpoint.kind {
        TransferEndpointKind::Local if endpoint.saved_session_id.is_some() => {
            Err(AppError::validation("本机文件传输端点不能引用远程连接"))
        }
        TransferEndpointKind::SavedSession
            if endpoint
                .saved_session_id
                .as_deref()
                .is_none_or(|session_id| session_id.trim().is_empty()) =>
        {
            Err(AppError::validation("远程文件传输端点必须引用已保存连接"))
        }
        _ => Ok(()),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
