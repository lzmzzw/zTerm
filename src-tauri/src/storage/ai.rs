// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension, Row};
use serde_json::Value;

use crate::{
    error::{AppError, AppResult},
    models::{
        ai::{
            AiApprovalMode, AiConversation, AiConversationMessage, AiConversationSummary,
            AiMessageRole, AiToolAuditRecord, AiToolInvocationStatus, AiToolPendingInvocation,
            RiskLevel,
        },
        credential::{AiProviderKind, AiProviderProfile},
        session::DeleteResult,
    },
    storage::sqlite::SqliteStore,
};

pub const AI_PROVIDER_PROFILES_TABLE: &str = "ai_provider_profiles";
pub const AI_CONVERSATIONS_TABLE: &str = "ai_conversations";
pub const AI_CONVERSATION_MESSAGES_TABLE: &str = "ai_conversation_messages";
pub const AI_TOOL_PENDING_TABLE: &str = "ai_tool_pending";
pub const AI_TOOL_AUDITS_TABLE: &str = "ai_tool_audits";

pub fn list_ai_provider_profiles(store: &SqliteStore) -> AppResult<Vec<AiProviderProfile>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select id, name, kind, base_url, model, api_key_ref, enabled, is_default, created_at_ms, updated_at_ms
            from ai_provider_profiles
            order by is_default desc, enabled desc, name
            ",
        )?;
        let profiles = statement
            .query_map([], map_ai_provider_profile)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(profiles)
    })
}

pub fn get_ai_provider_profile(store: &SqliteStore, id: &str) -> AppResult<AiProviderProfile> {
    let id = required_text("Provider ID", id)?;
    store.with_connection(|connection| {
        connection
            .query_row(
                "
                select id, name, kind, base_url, model, api_key_ref, enabled, is_default, created_at_ms, updated_at_ms
                from ai_provider_profiles
                where id = ?1
                ",
                [&id],
                map_ai_provider_profile,
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("ai provider not found: {id}")))
    })
}

pub fn upsert_ai_provider_profile(
    store: &SqliteStore,
    id: &str,
    name: &str,
    kind: AiProviderKind,
    base_url: &str,
    model: &str,
    api_key_ref: &str,
    enabled: bool,
    is_default: bool,
) -> AppResult<AiProviderProfile> {
    let id = required_text("Provider ID", id)?;
    let name = required_text("Provider 名称", name)?;
    let base_url = required_text("Base URL", base_url)?;
    let model = required_text("模型", model)?;
    let api_key_ref = api_key_ref.trim().to_string();
    let now = now_ms();

    store.write_transaction(|transaction| {
        if is_default {
            transaction.execute("update ai_provider_profiles set is_default = 0", [])?;
        }
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from ai_provider_profiles where id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);

        transaction.execute(
            "
            insert into ai_provider_profiles (
              id, name, kind, base_url, model, api_key_ref, enabled, is_default, created_at_ms, updated_at_ms
            )
            values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            on conflict(id) do update set
              name = excluded.name,
              kind = excluded.kind,
              base_url = excluded.base_url,
              model = excluded.model,
              api_key_ref = excluded.api_key_ref,
              enabled = excluded.enabled,
              is_default = excluded.is_default,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![
                id,
                name,
                kind.as_str(),
                base_url,
                model,
                api_key_ref,
                bool_to_i64(enabled),
                bool_to_i64(is_default),
                created_at_ms,
                now,
            ],
        )?;

        Ok(AiProviderProfile {
            id,
            name,
            kind,
            base_url,
            model,
            api_key_ref,
            enabled,
            is_default,
            created_at_ms,
            updated_at_ms: now,
        })
    })
}

pub fn insert_ai_conversation(
    store: &SqliteStore,
    id: &str,
    title: &str,
    scope_kind: &str,
    scope_ref_json: &str,
    approval_mode: AiApprovalMode,
) -> AppResult<AiConversation> {
    let id = required_text("AI 会话 ID", id)?;
    let title = required_text("AI 会话标题", title)?;
    let scope_kind = required_text("AI 会话 scope", scope_kind)?;
    validate_json("AI 会话 scope 引用", scope_ref_json)?;
    let now = now_ms();
    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into ai_conversations (
              id, title, scope_kind, scope_ref_json, approval_mode, status, created_at_ms, updated_at_ms
            ) values (?1, ?2, ?3, ?4, ?5, 'idle', ?6, ?6)
            ",
            params![id, title, scope_kind, scope_ref_json, approval_mode.as_str(), now],
        )?;
        Ok(AiConversation {
            id,
            title,
            scope_kind,
            scope_ref_json: scope_ref_json.to_string(),
            approval_mode,
            status: "idle".to_string(),
            created_at_ms: now,
            updated_at_ms: now,
            messages: Vec::new(),
        })
    })
}

pub fn list_ai_conversations(
    store: &SqliteStore,
    query: Option<&str>,
    limit: usize,
) -> AppResult<Vec<AiConversationSummary>> {
    let limit = limit.clamp(1, 200);
    let query = query
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", value.to_ascii_lowercase()));
    store.with_connection(|connection| {
        let mut statement = if query.is_some() {
            connection.prepare(
                "
                select id, title, scope_kind, scope_ref_json, approval_mode, status, created_at_ms, updated_at_ms
                from ai_conversations
                where lower(title) like ?1
                order by updated_at_ms desc
                limit ?2
                ",
            )?
        } else {
            connection.prepare(
                "
                select id, title, scope_kind, scope_ref_json, approval_mode, status, created_at_ms, updated_at_ms
                from ai_conversations
                order by updated_at_ms desc
                limit ?1
                ",
            )?
        };
        let summaries = if let Some(query) = query {
            statement
                .query_map(params![query, limit as i64], map_ai_conversation_summary)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            statement
                .query_map(params![limit as i64], map_ai_conversation_summary)?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(summaries)
    })
}

pub fn get_ai_conversation(store: &SqliteStore, id: &str) -> AppResult<AiConversation> {
    let id = required_text("AI 会话 ID", id)?;
    store.with_connection(|connection| {
        let summary = connection
            .query_row(
                "
                select id, title, scope_kind, scope_ref_json, approval_mode, status, created_at_ms, updated_at_ms
                from ai_conversations
                where id = ?1
                ",
                [&id],
                map_ai_conversation_summary,
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("ai conversation not found: {id}")))?;
        let mut statement = connection.prepare(
            "
            select id, conversation_id, role, content, status, metadata_json, created_at_ms
            from ai_conversation_messages
            where conversation_id = ?1
            order by created_at_ms asc
            ",
        )?;
        let messages = statement
            .query_map([&id], map_ai_conversation_message)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(AiConversation {
            id: summary.id,
            title: summary.title,
            scope_kind: summary.scope_kind,
            scope_ref_json: summary.scope_ref_json,
            approval_mode: summary.approval_mode,
            status: summary.status,
            created_at_ms: summary.created_at_ms,
            updated_at_ms: summary.updated_at_ms,
            messages,
        })
    })
}

pub fn update_ai_conversation_approval_mode(
    store: &SqliteStore,
    id: &str,
    approval_mode: AiApprovalMode,
) -> AppResult<AiConversation> {
    let id = required_text("AI 会话 ID", id)?;
    let now = now_ms();
    store.write_transaction(|transaction| {
        let updated = transaction.execute(
            "
            update ai_conversations
            set approval_mode = ?2, updated_at_ms = ?3
            where id = ?1
            ",
            params![id, approval_mode.as_str(), now],
        )?;
        if updated == 0 {
            return Err(AppError::not_found(format!(
                "ai conversation not found: {id}"
            )));
        }
        Ok(())
    })?;
    get_ai_conversation(store, &id)
}

pub fn delete_ai_conversation(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("AI 会话 ID", id)?;
    store.write_transaction(|transaction| {
        let deleted = transaction.execute("delete from ai_conversations where id = ?1", [&id])?;
        if deleted == 0 {
            return Err(AppError::not_found(format!(
                "ai conversation not found: {id}"
            )));
        }
        Ok(DeleteResult { deleted: true })
    })
}

pub fn insert_ai_conversation_message(
    store: &SqliteStore,
    id: &str,
    conversation_id: &str,
    role: AiMessageRole,
    content: &str,
    metadata_json: Option<&str>,
) -> AppResult<AiConversationMessage> {
    let id = required_text("AI 消息 ID", id)?;
    let conversation_id = required_text("AI 会话 ID", conversation_id)?;
    let content = required_text("AI 消息内容", content)?;
    if let Some(metadata_json) = metadata_json {
        validate_json("AI 消息 metadata", metadata_json)?;
    }
    let now = now_ms();
    store.write_transaction(|transaction| {
        let exists = transaction.query_row(
            "select exists(select 1 from ai_conversations where id = ?1)",
            [&conversation_id],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(AppError::not_found(format!(
                "ai conversation not found: {conversation_id}"
            )));
        }
        transaction.execute(
            "
            insert into ai_conversation_messages (
              id, conversation_id, role, content, status, metadata_json, created_at_ms
            ) values (?1, ?2, ?3, ?4, 'complete', ?5, ?6)
            ",
            params![
                id,
                conversation_id,
                role.as_str(),
                content,
                metadata_json,
                now
            ],
        )?;
        transaction.execute(
            "update ai_conversations set updated_at_ms = ?2 where id = ?1",
            params![conversation_id, now],
        )?;
        Ok(AiConversationMessage {
            id,
            conversation_id,
            role,
            content,
            status: "complete".to_string(),
            metadata_json: metadata_json.map(ToOwned::to_owned),
            created_at_ms: now,
        })
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
              reason, requested_by, conversation_id, run_id, step_id, created_at_ms
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
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
              conversation_id = excluded.conversation_id,
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
                pending.conversation_id,
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
                   created_at_ms, conversation_id, run_id, step_id, reason, requested_by
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

pub fn get_ai_tool_pending_state(
    store: &SqliteStore,
    id: &str,
) -> AppResult<(AiToolPendingInvocation, Value)> {
    let id = required_text("AI 工具调用 ID", id)?;
    store.with_connection(|connection| {
        connection
            .query_row(
                "
                select id, tool_id, tool_title, risk_level, arguments_summary, target_summary, risk_summary,
                       requires_confirmation, requires_secret_input, secret_input_label, status,
                       created_at_ms, conversation_id, run_id, step_id, reason, requested_by,
                       arguments_json
                from ai_tool_pending
                where id = ?1
                ",
                [&id],
                |row| {
                    let pending = map_ai_tool_pending(row)?;
                    let arguments_json: String = row.get(17)?;
                    let arguments =
                        serde_json::from_str::<Value>(&arguments_json).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                17,
                                rusqlite::types::Type::Text,
                                Box::new(AppError::storage(format!(
                                    "invalid ai tool arguments json: {error}"
                                ))),
                            )
                        })?;
                    Ok((pending, arguments))
                },
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("ai tool pending not found: {id}")))
    })
}

pub fn delete_ai_tool_pending(store: &SqliteStore, id: &str) -> AppResult<()> {
    let id = required_text("AI 工具调用 ID", id)?;
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

pub fn delete_ai_provider_profile(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("Provider ID", id)?;
    store.write_transaction(|transaction| {
        let deleted =
            transaction.execute("delete from ai_provider_profiles where id = ?1", [&id])?;
        if deleted == 0 {
            return Err(AppError::not_found(format!("ai provider not found: {id}")));
        }
        Ok(DeleteResult { deleted: true })
    })
}

fn map_ai_provider_profile(row: &Row<'_>) -> rusqlite::Result<AiProviderProfile> {
    let kind_value: String = row.get(2)?;
    Ok(AiProviderProfile {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: AiProviderKind::from_db(&kind_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai provider kind: {kind_value}"
                ))),
            )
        })?,
        base_url: row.get(3)?,
        model: row.get(4)?,
        api_key_ref: row.get(5)?,
        enabled: row.get::<_, i64>(6)? != 0,
        is_default: row.get::<_, i64>(7)? != 0,
        created_at_ms: row.get(8)?,
        updated_at_ms: row.get(9)?,
    })
}

fn map_ai_conversation_summary(row: &Row<'_>) -> rusqlite::Result<AiConversationSummary> {
    let approval_mode_value: String = row.get(4)?;
    Ok(AiConversationSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        scope_kind: row.get(2)?,
        scope_ref_json: row.get(3)?,
        approval_mode: AiApprovalMode::from_db(&approval_mode_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai approval mode: {approval_mode_value}"
                ))),
            )
        })?,
        status: row.get(5)?,
        created_at_ms: row.get(6)?,
        updated_at_ms: row.get(7)?,
    })
}

fn map_ai_conversation_message(row: &Row<'_>) -> rusqlite::Result<AiConversationMessage> {
    let role_value: String = row.get(2)?;
    Ok(AiConversationMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: AiMessageRole::from_db(&role_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai message role: {role_value}"
                ))),
            )
        })?,
        content: row.get(3)?,
        status: row.get(4)?,
        metadata_json: row.get(5)?,
        created_at_ms: row.get(6)?,
    })
}

fn map_ai_tool_pending(row: &Row<'_>) -> rusqlite::Result<AiToolPendingInvocation> {
    let risk_value: String = row.get(3)?;
    let status_value: String = row.get(10)?;
    Ok(AiToolPendingInvocation {
        id: row.get(0)?,
        tool_id: row.get(1)?,
        tool_title: row.get(2)?,
        risk_level: RiskLevel::from_db(&risk_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai tool risk: {risk_value}"
                ))),
            )
        })?,
        arguments_summary: row.get(4)?,
        target_summary: row.get(5)?,
        risk_summary: row.get(6)?,
        requires_confirmation: row.get::<_, i64>(7)? != 0,
        requires_secret_input: row.get::<_, i64>(8)? != 0,
        secret_input_label: row.get(9)?,
        status: AiToolInvocationStatus::from_db(&status_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                10,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai tool status: {status_value}"
                ))),
            )
        })?,
        created_at_ms: row.get(11)?,
        conversation_id: row.get(12)?,
        run_id: row.get(13)?,
        step_id: row.get(14)?,
        reason: row.get(15)?,
        requested_by: row.get(16)?,
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
        risk_level: RiskLevel::from_db(&risk_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai tool risk: {risk_value}"
                ))),
            )
        })?,
        arguments_summary: row.get(5)?,
        risk_summary: row.get(6)?,
        status: AiToolInvocationStatus::from_db(&status_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid ai tool status: {status_value}"
                ))),
            )
        })?,
        result_summary: row.get(8)?,
        error: row.get(9)?,
        audit_context_json: row.get(10)?,
        affected_domains: parse_string_array(row.get::<_, String>(11)?.as_str(), 11)?,
        created_at_ms: row.get(12)?,
        completed_at_ms: row.get(13)?,
    })
}

fn parse_string_array(value: &str, column: usize) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str::<Vec<String>>(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(AppError::storage(format!(
                "invalid string array json: {error}"
            ))),
        )
    })
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn validate_json(label: &str, value: &str) -> AppResult<()> {
    serde_json::from_str::<Value>(value)
        .map(|_| ())
        .map_err(|error| AppError::validation(format!("{label}不是有效 JSON: {error}")))
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
