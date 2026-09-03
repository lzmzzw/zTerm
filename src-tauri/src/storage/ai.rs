// Author: Liz
use rusqlite::{params, OptionalExtension, Row};
use serde_json::Value;

use crate::{
    error::{AppError, AppResult},
    models::ai::{
        AiApprovalMode, AiConnectionApprovalPolicy, AiToolAuditRecord, AiToolInvocationStatus,
        AiToolPendingInvocation, RiskLevel,
    },
    storage::sqlite::SqliteStore,
    time::now_ms,
    validation::required_text,
};

pub const AI_CONNECTION_APPROVAL_POLICIES_TABLE: &str = "ai_connection_approval_policies";
pub const AI_TOOL_PENDING_TABLE: &str = "ai_tool_pending";
pub const AI_TOOL_AUDITS_TABLE: &str = "ai_tool_audits";

pub fn get_ai_connection_approval_mode(
    store: &SqliteStore,
    saved_session_id: &str,
) -> AppResult<AiApprovalMode> {
    let saved_session_id = required_text("SSH 连接 ID", saved_session_id)?;
    store.with_connection(|connection| {
        let value = connection
            .query_row(
                "select approval_mode from ai_connection_approval_policies where saved_session_id = ?1",
                [&saved_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value {
            Some(value) => AiApprovalMode::from_db(&value)
                .ok_or_else(|| AppError::storage(format!("invalid MCP approval mode: {value}"))),
            None => Ok(AiApprovalMode::Safe),
        }
    })
}

pub fn get_ai_connection_approval_policy(
    store: &SqliteStore,
    saved_session_id: &str,
) -> AppResult<AiConnectionApprovalPolicy> {
    let saved_session_id = validate_persisted_ssh_session(store, saved_session_id)?;
    let approval_mode = get_ai_connection_approval_mode(store, &saved_session_id)?;
    let updated_at_ms = store.with_connection(|connection| {
        Ok(connection
            .query_row(
                "select updated_at_ms from ai_connection_approval_policies where saved_session_id = ?1",
                [&saved_session_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or_default())
    })?;
    Ok(AiConnectionApprovalPolicy {
        saved_session_id,
        approval_mode,
        updated_at_ms,
    })
}

pub fn upsert_ai_connection_approval_policy(
    store: &SqliteStore,
    saved_session_id: &str,
    approval_mode: AiApprovalMode,
) -> AppResult<AiConnectionApprovalPolicy> {
    let saved_session_id = validate_persisted_ssh_session(store, saved_session_id)?;
    let now = now_ms();
    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into ai_connection_approval_policies (saved_session_id, approval_mode, updated_at_ms)
            values (?1, ?2, ?3)
            on conflict(saved_session_id) do update set
                approval_mode = excluded.approval_mode,
                updated_at_ms = excluded.updated_at_ms
            ",
            params![saved_session_id, approval_mode.as_str(), now],
        )?;
        Ok(())
    })?;
    Ok(AiConnectionApprovalPolicy {
        saved_session_id,
        approval_mode,
        updated_at_ms: now,
    })
}

pub fn upsert_ai_tool_pending(
    store: &SqliteStore,
    pending: &AiToolPendingInvocation,
    arguments: &Value,
) -> AppResult<()> {
    let arguments_json = serde_json::to_string(arguments)
        .map_err(|error| AppError::storage(format!("serialize tool arguments: {error}")))?;
    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into ai_tool_pending (
              id, tool_id, tool_title, risk_level, arguments_summary, arguments_json, target_summary,
              risk_summary, requires_confirmation, requires_secret_input, secret_input_label, status,
              reason, requested_by, run_id, step_id, created_at_ms
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            on conflict(id) do update set
              tool_id = excluded.tool_id,
              tool_title = excluded.tool_title,
              risk_level = excluded.risk_level,
              arguments_summary = excluded.arguments_summary,
              arguments_json = excluded.arguments_json,
              target_summary = excluded.target_summary,
              risk_summary = excluded.risk_summary,
              requires_confirmation = excluded.requires_confirmation,
              requires_secret_input = excluded.requires_secret_input,
              secret_input_label = excluded.secret_input_label,
              status = excluded.status,
              reason = excluded.reason,
              requested_by = excluded.requested_by,
              run_id = excluded.run_id,
              step_id = excluded.step_id
            ",
            params![
                pending.id,
                pending.tool_id,
                pending.tool_title,
                pending.risk_level.as_str(),
                pending.arguments_summary,
                arguments_json,
                pending.target_summary,
                pending.risk_summary,
                bool_to_i64(pending.requires_confirmation),
                bool_to_i64(pending.requires_secret_input),
                pending.secret_input_label,
                pending.status.as_str(),
                pending.reason,
                pending.requested_by,
                pending.run_id,
                pending.step_id,
                pending.created_at_ms,
            ],
        )?;
        Ok(())
    })
}

pub fn list_ai_tool_pending(store: &SqliteStore) -> AppResult<Vec<AiToolPendingInvocation>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select id, tool_id, tool_title, risk_level, arguments_summary, target_summary, risk_summary,
                   requires_confirmation, requires_secret_input, secret_input_label, status,
                   created_at_ms, run_id, step_id, reason, requested_by
            from ai_tool_pending
            order by created_at_ms desc
            ",
        )?;
        let records = statement
            .query_map([], map_ai_tool_pending)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    })
}

pub fn find_ai_tool_pending_by_request(
    store: &SqliteStore,
    tool_id: &str,
    arguments: &Value,
    requested_by: &str,
) -> AppResult<Option<AiToolPendingInvocation>> {
    let tool_id = required_text("MCP 工具 ID", tool_id)?;
    let requested_by = required_text("MCP 请求主体", requested_by)?;
    let arguments_json = serde_json::to_string(arguments)
        .map_err(|error| AppError::storage(format!("serialize tool arguments: {error}")))?;
    store.with_connection(|connection| {
        let pending = connection
            .query_row(
                "
                select id, tool_id, tool_title, risk_level, arguments_summary, target_summary,
                       risk_summary, requires_confirmation, requires_secret_input,
                       secret_input_label, status, created_at_ms, run_id, step_id, reason,
                       requested_by
                from ai_tool_pending
                where tool_id = ?1 and arguments_json = ?2 and requested_by = ?3
                order by created_at_ms desc
                limit 1
                ",
                params![tool_id, arguments_json, requested_by],
                map_ai_tool_pending,
            )
            .optional()?;
        Ok(pending)
    })
}

pub fn get_ai_tool_pending_state(
    store: &SqliteStore,
    id: &str,
) -> AppResult<(AiToolPendingInvocation, Value)> {
    let id = required_text("MCP 工具调用 ID", id)?;
    store.with_connection(|connection| {
        connection
            .query_row(
                "
                select id, tool_id, tool_title, risk_level, arguments_summary, target_summary, risk_summary,
                       requires_confirmation, requires_secret_input, secret_input_label, status,
                       created_at_ms, run_id, step_id, reason, requested_by, arguments_json
                from ai_tool_pending
                where id = ?1
                ",
                [&id],
                |row| {
                    let pending = map_ai_tool_pending(row)?;
                    let arguments_json: String = row.get(16)?;
                    let arguments = serde_json::from_str::<Value>(&arguments_json).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            16,
                            rusqlite::types::Type::Text,
                            Box::new(AppError::storage(format!("invalid MCP tool arguments json: {error}"))),
                        )
                    })?;
                    Ok((pending, arguments))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("MCP tool pending not found: {id}")))
    })
}

pub fn ai_tool_pending_exists(store: &SqliteStore, id: &str) -> AppResult<bool> {
    let id = required_text("MCP 工具调用 ID", id)?;
    store.with_connection(|connection| {
        let exists = connection
            .query_row(
                "select 1 from ai_tool_pending where id = ?1 limit 1",
                [&id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        Ok(exists)
    })
}

pub fn delete_ai_tool_pending(store: &SqliteStore, id: &str) -> AppResult<()> {
    let id = required_text("MCP 工具调用 ID", id)?;
    store.write_transaction(|transaction| {
        transaction.execute("delete from ai_tool_pending where id = ?1", [&id])?;
        Ok(())
    })
}

pub fn insert_ai_tool_audit(store: &SqliteStore, audit: &AiToolAuditRecord) -> AppResult<()> {
    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into ai_tool_audits (
              id, invocation_id, tool_id, tool_title, risk_level, arguments_summary,
              risk_summary, status, result_summary, error, audit_context_json,
              affected_domains_json, created_at_ms, completed_at_ms
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ",
            params![
                audit.id,
                audit.invocation_id,
                audit.tool_id,
                audit.tool_title,
                audit.risk_level.as_str(),
                audit.arguments_summary,
                audit.risk_summary,
                audit.status.as_str(),
                audit.result_summary,
                audit.error,
                audit.audit_context_json,
                serde_json::to_string(&audit.affected_domains)
                    .map_err(|error| AppError::storage(error.to_string()))?,
                audit.created_at_ms,
                audit.completed_at_ms,
            ],
        )?;
        Ok(())
    })
}

pub fn list_ai_tool_audits(store: &SqliteStore, limit: usize) -> AppResult<Vec<AiToolAuditRecord>> {
    let limit = limit.clamp(1, 100);
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select id, invocation_id, tool_id, tool_title, risk_level, arguments_summary,
                   risk_summary, status, result_summary, error, audit_context_json,
                   affected_domains_json, created_at_ms, completed_at_ms
            from ai_tool_audits
            order by completed_at_ms desc
            limit ?1
            ",
        )?;
        let records = statement
            .query_map([limit as i64], map_ai_tool_audit)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(records)
    })
}

pub fn get_ai_tool_audit_by_invocation_id(
    store: &SqliteStore,
    invocation_id: &str,
) -> AppResult<Option<AiToolAuditRecord>> {
    let invocation_id = required_text("MCP 工具调用 ID", invocation_id)?;
    store.with_connection(|connection| {
        let audit = connection
            .query_row(
                "
                select id, invocation_id, tool_id, tool_title, risk_level, arguments_summary,
                       risk_summary, status, result_summary, error, audit_context_json,
                       affected_domains_json, created_at_ms, completed_at_ms
                from ai_tool_audits
                where invocation_id = ?1
                order by completed_at_ms desc
                limit 1
                ",
                [&invocation_id],
                map_ai_tool_audit,
            )
            .optional()?;
        Ok(audit)
    })
}

fn validate_persisted_ssh_session(
    store: &SqliteStore,
    saved_session_id: &str,
) -> AppResult<String> {
    let saved_session_id = required_text("SSH 连接 ID", saved_session_id)?;
    let session_type = store.with_connection(|connection| {
        Ok(connection
            .query_row(
                "select type from saved_sessions where id = ?1",
                [&saved_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })?;
    match session_type.as_deref() {
        Some("ssh") => Ok(saved_session_id),
        Some(_) => Err(AppError::validation(
            "MCP 审批策略只能绑定已保存的 SSH 连接",
        )),
        None => Err(AppError::not_found(format!(
            "saved ssh session not found: {saved_session_id}"
        ))),
    }
}

fn map_ai_tool_pending(row: &Row<'_>) -> rusqlite::Result<AiToolPendingInvocation> {
    let risk_value: String = row.get(3)?;
    let status_value: String = row.get(10)?;
    Ok(AiToolPendingInvocation {
        id: row.get(0)?,
        tool_id: row.get(1)?,
        tool_title: row.get(2)?,
        risk_level: RiskLevel::from_db(&risk_value)
            .ok_or_else(|| conversion_error(3, format!("invalid MCP tool risk: {risk_value}")))?,
        arguments_summary: row.get(4)?,
        target_summary: row.get(5)?,
        risk_summary: row.get(6)?,
        requires_confirmation: row.get::<_, i64>(7)? != 0,
        requires_secret_input: row.get::<_, i64>(8)? != 0,
        secret_input_label: row.get(9)?,
        status: AiToolInvocationStatus::from_db(&status_value).ok_or_else(|| {
            conversion_error(10, format!("invalid MCP tool status: {status_value}"))
        })?,
        created_at_ms: row.get(11)?,
        run_id: row.get(12)?,
        step_id: row.get(13)?,
        reason: row.get(14)?,
        requested_by: row.get(15)?,
    })
}

fn map_ai_tool_audit(row: &Row<'_>) -> rusqlite::Result<AiToolAuditRecord> {
    let risk_value: String = row.get(4)?;
    let status_value: String = row.get(7)?;
    Ok(AiToolAuditRecord {
        id: row.get(0)?,
        invocation_id: row.get(1)?,
        tool_id: row.get(2)?,
        tool_title: row.get(3)?,
        risk_level: RiskLevel::from_db(&risk_value)
            .ok_or_else(|| conversion_error(4, format!("invalid MCP tool risk: {risk_value}")))?,
        arguments_summary: row.get(5)?,
        risk_summary: row.get(6)?,
        status: AiToolInvocationStatus::from_db(&status_value).ok_or_else(|| {
            conversion_error(7, format!("invalid MCP tool status: {status_value}"))
        })?,
        result_summary: row.get(8)?,
        error: row.get(9)?,
        audit_context_json: row.get(10)?,
        affected_domains: serde_json::from_str::<Vec<String>>(row.get::<_, String>(11)?.as_str())
            .map_err(|error| {
            conversion_error(11, format!("invalid string array json: {error}"))
        })?,
        created_at_ms: row.get(12)?,
        completed_at_ms: row.get(13)?,
    })
}

fn conversion_error(column: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        column,
        rusqlite::types::Type::Text,
        Box::new(AppError::storage(message)),
    )
}

fn bool_to_i64(value: bool) -> i64 {
    i64::from(value)
}
