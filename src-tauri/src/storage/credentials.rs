// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, types::Type, OptionalExtension, Row};

use crate::{
    error::{AppError, AppResult},
    models::{
        credential::{CredentialKind, CredentialRecord},
        session::DeleteResult,
    },
    storage::sqlite::SqliteStore,
};

pub const CREDENTIAL_RECORDS_TABLE: &str = "credential_records";

pub fn list_credentials(store: &SqliteStore) -> AppResult<Vec<CredentialRecord>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select id, name, kind, credential_ref, created_at_ms, updated_at_ms
            from credential_records
            order by kind, name
            ",
        )?;
        let records = statement
            .query_map([], map_credential_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    })
}

pub fn get_credential_record(store: &SqliteStore, id: &str) -> AppResult<CredentialRecord> {
    let id = required_text("凭据 ID", id)?;
    store.with_connection(|connection| {
        connection
            .query_row(
                "
                select id, name, kind, credential_ref, created_at_ms, updated_at_ms
                from credential_records
                where id = ?1
                ",
                [&id],
                map_credential_record,
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("credential not found: {id}")))
    })
}

pub fn upsert_credential_record(
    store: &SqliteStore,
    id: &str,
    name: &str,
    kind: CredentialKind,
    credential_ref: &str,
) -> AppResult<CredentialRecord> {
    let id = required_text("凭据 ID", id)?;
    let name = required_text("凭据名称", name)?;
    let credential_ref = required_text("凭据引用", credential_ref)?;
    let now = now_ms();

    store.write_transaction(|transaction| {
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from credential_records where id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);

        transaction.execute(
            "
            insert into credential_records (id, name, kind, credential_ref, created_at_ms, updated_at_ms)
            values (?1, ?2, ?3, ?4, ?5, ?6)
            on conflict(id) do update set
              name = excluded.name,
              kind = excluded.kind,
              credential_ref = excluded.credential_ref,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![id, name, kind.as_str(), credential_ref, created_at_ms, now],
        )?;

        Ok(CredentialRecord {
            id,
            name,
            kind,
            credential_ref,
            created_at_ms,
            updated_at_ms: now,
        })
    })
}

pub fn delete_credential_record(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("凭据 ID", id)?;
    store.write_transaction(|transaction| {
        let deleted = transaction.execute("delete from credential_records where id = ?1", [&id])?;
        if deleted == 0 {
            return Err(AppError::not_found(format!("credential not found: {id}")));
        }
        Ok(DeleteResult { deleted: true })
    })
}

fn map_credential_record(row: &Row<'_>) -> rusqlite::Result<CredentialRecord> {
    let kind_value: String = row.get(2)?;
    Ok(CredentialRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: CredentialKind::from_db(&kind_value)
            .ok_or_else(|| conversion_error(2, format!("invalid credential kind: {kind_value}")))?,
        credential_ref: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
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
