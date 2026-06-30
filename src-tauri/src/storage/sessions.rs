// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, types::Type, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::session::{
        AuthMode, DeleteResult, LocalOptions, RdpOptions, SavedSession, SavedSessionDraft,
        SessionGroup, SessionGroupDraft, SessionType, SessionsList,
    },
    storage::sqlite::SqliteStore,
};

pub const SESSION_GROUPS_TABLE: &str = "session_groups";
pub const SAVED_SESSIONS_TABLE: &str = "saved_sessions";

pub fn list_sessions(store: &SqliteStore) -> AppResult<SessionsList> {
    store.with_connection(|connection| {
        let mut group_statement = connection.prepare(
            "
            select id, parent_id, name, expanded, sort_order, created_at_ms, updated_at_ms
            from session_groups
            order by parent_id is not null, parent_id, sort_order, name
            ",
        )?;
        let groups = group_statement
            .query_map([], map_group)?
            .collect::<Result<Vec<_>, _>>()?;

        let mut session_statement = connection.prepare(
            "
            select id, name, type, group_id, host, port, username, auth_mode, credential_ref,
                   description, tags_json, sort_order, created_at_ms, updated_at_ms,
                   last_used_at_ms, ssh_options_json, rdp_options_json, local_options_json
            from saved_sessions
            order by group_id is not null desc, group_id, sort_order, name
            ",
        )?;
        let sessions = session_statement
            .query_map([], map_session)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(SessionsList { groups, sessions })
    })
}

pub fn get_session(store: &SqliteStore, id: &str) -> AppResult<SavedSession> {
    let id = required_text("会话 ID", id)?;
    store.with_connection(|connection| {
        connection
            .query_row(
                "
                select id, name, type, group_id, host, port, username, auth_mode, credential_ref,
                       description, tags_json, sort_order, created_at_ms, updated_at_ms,
                       last_used_at_ms, ssh_options_json, rdp_options_json, local_options_json
                from saved_sessions
                where id = ?1
                ",
                [&id],
                map_session,
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("session not found: {id}")))
    })
}

pub fn save_session_group(
    store: &SqliteStore,
    draft: SessionGroupDraft,
) -> AppResult<SessionGroup> {
    let name = required_text("分组名称", draft.name)?;
    let id = normalized_id(draft.id);
    let now = now_ms();

    store.write_transaction(|transaction| {
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from session_groups where id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);

        transaction.execute(
            "
            insert into session_groups (id, parent_id, name, expanded, sort_order, created_at_ms, updated_at_ms)
            values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            on conflict(id) do update set
              parent_id = excluded.parent_id,
              name = excluded.name,
              expanded = excluded.expanded,
              sort_order = excluded.sort_order,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![
                id,
                draft.parent_id,
                name,
                bool_to_i64(draft.expanded),
                draft.sort_order,
                created_at_ms,
                now,
            ],
        )?;

        Ok(SessionGroup {
            id,
            parent_id: draft.parent_id,
            name,
            expanded: draft.expanded,
            sort_order: draft.sort_order,
            created_at_ms,
            updated_at_ms: now,
        })
    })
}

pub fn delete_session_group(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("分组 ID", id)?;

    store.write_transaction(|transaction| {
        let child_group_count: i64 = transaction.query_row(
            "select count(*) from session_groups where parent_id = ?1",
            [&id],
            |row| row.get(0),
        )?;
        let session_count: i64 = transaction.query_row(
            "select count(*) from saved_sessions where group_id = ?1",
            [&id],
            |row| row.get(0),
        )?;

        if child_group_count > 0 || session_count > 0 {
            return Err(AppError::validation("分组下仍有会话或子分组，不能删除"));
        }

        let deleted = transaction.execute("delete from session_groups where id = ?1", [&id])?;
        if deleted == 0 {
            return Err(AppError::not_found(format!(
                "session group not found: {id}"
            )));
        }

        Ok(DeleteResult { deleted: true })
    })
}

pub fn save_session(store: &SqliteStore, draft: SavedSessionDraft) -> AppResult<SavedSession> {
    let name = required_text("会话名称", draft.name)?;
    let host = normalize_host(draft.session_type, draft.host)?;
    let username = normalize_username(draft.session_type, draft.username)?;
    if draft.port == 0 {
        return Err(AppError::validation("端口必须在 1 到 65535 之间"));
    }
    if draft.session_type == SessionType::Rdp {
        validate_rdp_options(draft.rdp_options.as_ref())?;
    }
    if draft.session_type == SessionType::Local {
        validate_local_options(draft.local_options.as_ref())?;
    }

    let id = normalized_id(draft.id);
    let now = now_ms();
    let tags_json =
        serde_json::to_string(&draft.tags).map_err(|error| AppError::storage(error.to_string()))?;
    let ssh_options_json = optional_json(&draft.ssh_options)?;
    let rdp_options_json = optional_json(&draft.rdp_options)?;
    let local_options_json = optional_json(&draft.local_options)?;

    store.write_transaction(|transaction| {
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from saved_sessions where id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);

        transaction.execute(
            "
            insert into saved_sessions (
              id, name, type, group_id, host, port, username, auth_mode, credential_ref,
              description, tags_json, sort_order, created_at_ms, updated_at_ms,
              last_used_at_ms, ssh_options_json, rdp_options_json, local_options_json
            )
            values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
            on conflict(id) do update set
              name = excluded.name,
              type = excluded.type,
              group_id = excluded.group_id,
              host = excluded.host,
              port = excluded.port,
              username = excluded.username,
              auth_mode = excluded.auth_mode,
              credential_ref = excluded.credential_ref,
              description = excluded.description,
              tags_json = excluded.tags_json,
              sort_order = excluded.sort_order,
              updated_at_ms = excluded.updated_at_ms,
              ssh_options_json = excluded.ssh_options_json,
              rdp_options_json = excluded.rdp_options_json,
              local_options_json = excluded.local_options_json
            ",
            params![
                id,
                name,
                draft.session_type.as_str(),
                draft.group_id,
                host,
                i64::from(draft.port),
                username,
                draft.auth_mode.as_str(),
                draft.credential_ref,
                draft.description,
                tags_json,
                draft.sort_order,
                created_at_ms,
                now,
                Option::<i64>::None,
                ssh_options_json,
                rdp_options_json,
                local_options_json,
            ],
        )?;

        Ok(SavedSession {
            id,
            name,
            session_type: draft.session_type,
            group_id: draft.group_id,
            host,
            port: draft.port,
            username,
            auth_mode: draft.auth_mode,
            credential_ref: draft.credential_ref,
            description: draft.description,
            tags: draft.tags,
            sort_order: draft.sort_order,
            created_at_ms,
            updated_at_ms: now,
            last_used_at_ms: None,
            ssh_options: draft.ssh_options,
            rdp_options: draft.rdp_options,
            local_options: draft.local_options,
        })
    })
}

pub fn delete_session(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("会话 ID", id)?;

    store.write_transaction(|transaction| {
        let deleted = transaction.execute("delete from saved_sessions where id = ?1", [&id])?;
        if deleted == 0 {
            return Err(AppError::not_found(format!("session not found: {id}")));
        }

        Ok(DeleteResult { deleted: true })
    })
}

fn map_group(row: &Row<'_>) -> rusqlite::Result<SessionGroup> {
    Ok(SessionGroup {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        expanded: row.get::<_, i64>(3)? != 0,
        sort_order: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn map_session(row: &Row<'_>) -> rusqlite::Result<SavedSession> {
    let session_type_value: String = row.get(2)?;
    let auth_mode_value: String = row.get(7)?;
    let tags_json: String = row.get(10)?;
    let ssh_options_json: Option<String> = row.get(15)?;
    let rdp_options_json: Option<String> = row.get(16)?;
    let local_options_json: Option<String> = row.get(17)?;

    Ok(SavedSession {
        id: row.get(0)?,
        name: row.get(1)?,
        session_type: SessionType::from_db(&session_type_value).ok_or_else(|| {
            conversion_error(2, format!("invalid session type: {session_type_value}"))
        })?,
        group_id: row.get(3)?,
        host: row.get(4)?,
        port: row.get::<_, u16>(5)?,
        username: row.get(6)?,
        auth_mode: AuthMode::from_db(&auth_mode_value)
            .ok_or_else(|| conversion_error(7, format!("invalid auth mode: {auth_mode_value}")))?,
        credential_ref: row.get(8)?,
        description: row.get(9)?,
        tags: json_from_column(10, &tags_json)?,
        sort_order: row.get(11)?,
        created_at_ms: row.get(12)?,
        updated_at_ms: row.get(13)?,
        last_used_at_ms: row.get(14)?,
        ssh_options: optional_json_from_column(15, ssh_options_json)?,
        rdp_options: optional_json_from_column(16, rdp_options_json)?,
        local_options: optional_json_from_column(17, local_options_json)?,
    })
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn normalized_id(id: Option<String>) -> Option<String> {
    id.and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

fn validate_rdp_options(options: Option<&RdpOptions>) -> AppResult<()> {
    let Some(options) = options else {
        return Err(AppError::validation("RDP 会话必须包含 RDP 选项"));
    };
    if options.width == 0 || options.height == 0 {
        return Err(AppError::validation("RDP 分辨率必须大于 0"));
    }
    if !matches!(options.color_depth, 16 | 24 | 32) {
        return Err(AppError::validation("RDP 色深只能是 16、24 或 32"));
    }
    Ok(())
}

fn validate_local_options(_options: Option<&LocalOptions>) -> AppResult<()> {
    Ok(())
}

fn normalize_host(session_type: SessionType, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() && session_type == SessionType::Local {
        return Ok("localhost".to_string());
    }
    required_text("主机", value)
}

fn normalize_username(session_type: SessionType, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if session_type == SessionType::Local {
        return Ok(value.to_string());
    }
    required_text("用户名", value)
}

fn optional_json<T: serde::Serialize>(value: &Option<T>) -> AppResult<Option<String>> {
    value
        .as_ref()
        .map(|inner| {
            serde_json::to_string(inner).map_err(|error| AppError::storage(error.to_string()))
        })
        .transpose()
}

fn json_from_column<T: serde::de::DeserializeOwned>(
    column: usize,
    value: &str,
) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|error| conversion_error(column, error.to_string()))
}

fn optional_json_from_column<T: serde::de::DeserializeOwned>(
    column: usize,
    value: Option<String>,
) -> rusqlite::Result<Option<T>> {
    value
        .as_deref()
        .map(|json| json_from_column(column, json))
        .transpose()
}

fn conversion_error(column: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        Type::Text,
        Box::new(AppError::storage(message)),
    )
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
