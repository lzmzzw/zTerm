// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Row};

use crate::{
    error::{AppError, AppResult},
    models::terminal_profile::{TerminalProfile, TerminalProfileDraft},
    storage::sqlite::SqliteStore,
};

pub const TERMINAL_PROFILES_TABLE: &str = "terminal_profiles";

pub fn list_terminal_profiles(store: &SqliteStore) -> AppResult<Vec<TerminalProfile>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select id, name, path, args_json, detected, is_default, created_at_ms, updated_at_ms
            from terminal_profiles
            order by is_default desc, name
            ",
        )?;
        let profiles = statement
            .query_map([], map_terminal_profile)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(profiles)
    })
}

pub fn set_default_terminal_profile(
    store: &SqliteStore,
    draft: TerminalProfileDraft,
) -> AppResult<TerminalProfile> {
    let id = required_text("终端 Profile ID", draft.id)?;
    let name = required_text("终端名称", draft.name)?;
    let path = required_text("终端路径", draft.path)?;
    let args_json =
        serde_json::to_string(&draft.args).map_err(|error| AppError::storage(error.to_string()))?;
    let now = now_ms();

    store.write_transaction(|transaction| {
        transaction.execute("update terminal_profiles set is_default = 0", [])?;
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from terminal_profiles where id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);
        transaction.execute(
            "
            insert into terminal_profiles (
              id, name, path, args_json, detected, is_default, created_at_ms, updated_at_ms
            ) values (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
            on conflict(id) do update set
              name = excluded.name,
              path = excluded.path,
              args_json = excluded.args_json,
              detected = excluded.detected,
              is_default = 1,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![
                id,
                name,
                path,
                args_json,
                bool_to_i64(draft.detected),
                created_at_ms,
                now,
            ],
        )?;
        Ok(TerminalProfile {
            id,
            name,
            path,
            args: draft.args,
            detected: draft.detected,
            is_default: true,
            created_at_ms,
            updated_at_ms: now,
        })
    })
}

pub fn upsert_detected_terminal_profiles(
    store: &SqliteStore,
    drafts: Vec<TerminalProfileDraft>,
) -> AppResult<Vec<TerminalProfile>> {
    let now = now_ms();
    store.write_transaction(|transaction| {
        let mut saved = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let id = required_text("终端 Profile ID", draft.id)?;
            let name = required_text("终端名称", draft.name)?;
            let path = required_text("终端路径", draft.path)?;
            let args_json = serde_json::to_string(&draft.args)
                .map_err(|error| AppError::storage(error.to_string()))?;
            let created_at_ms = transaction
                .query_row(
                    "select created_at_ms from terminal_profiles where id = ?1",
                    [&id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .unwrap_or(now);
            transaction.execute(
                "
                insert into terminal_profiles (
                  id, name, path, args_json, detected, is_default, created_at_ms, updated_at_ms
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                on conflict(id) do update set
                  name = excluded.name,
                  path = excluded.path,
                  args_json = excluded.args_json,
                  detected = excluded.detected,
                  updated_at_ms = excluded.updated_at_ms
                ",
                params![
                    id,
                    name,
                    path,
                    args_json,
                    bool_to_i64(draft.detected),
                    bool_to_i64(draft.is_default),
                    created_at_ms,
                    now,
                ],
            )?;
            saved.push(TerminalProfile {
                id,
                name,
                path,
                args: draft.args,
                detected: draft.detected,
                is_default: draft.is_default,
                created_at_ms,
                updated_at_ms: now,
            });
        }
        if saved.iter().any(|profile| profile.is_default) {
            if let Some(default_profile) = saved.iter().find(|profile| profile.is_default) {
                transaction.execute(
                    "update terminal_profiles set is_default = case when id = ?1 then 1 else 0 end",
                    [&default_profile.id],
                )?;
            }
        }
        Ok(saved)
    })
}

fn map_terminal_profile(row: &Row<'_>) -> rusqlite::Result<TerminalProfile> {
    let args_json: String = row.get(3)?;
    let args = serde_json::from_str(&args_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            Box::new(AppError::storage(error.to_string())),
        )
    })?;
    Ok(TerminalProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        args,
        detected: row.get::<_, i64>(4)? != 0,
        is_default: row.get::<_, i64>(5)? != 0,
        created_at_ms: row.get(6)?,
        updated_at_ms: row.get(7)?,
    })
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
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
