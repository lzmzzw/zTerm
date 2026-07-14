// Author: Liz
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, params_from_iter, types::Value, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::history::{
        ClearCommandHistoryResult, CommandGroupDeleted, CommandHistoryDraft, CommandHistoryEntry,
        DeleteCommandHistoryEntriesResult, HistoryScopeKind, HistorySearchOptions,
        SessionCommandGroup, SessionCommandGroupDraft, SessionCommandGroupItem,
    },
    storage::sqlite::SqliteStore,
};

pub const COMMAND_HISTORY_TABLE: &str = "command_history";
const DEFAULT_HISTORY_LIMIT: usize = 1000;
const MAX_HISTORY_LIMIT: usize = 1000;
const MAX_COMMAND_LENGTH: usize = 4096;
const STORED_HISTORY_LIMIT_PER_SESSION: i64 = 1000;

pub fn insert_command_history(
    store: &SqliteStore,
    draft: CommandHistoryDraft,
) -> AppResult<CommandHistoryEntry> {
    let command = draft.command.trim().to_string();
    if command.is_empty() {
        return Err(AppError::validation("命令不能为空"));
    }
    if command.chars().count() > MAX_COMMAND_LENGTH {
        return Err(AppError::validation("命令长度不能超过 4096 字符"));
    }
    if draft.runtime_session_id.trim().is_empty() {
        return Err(AppError::validation("运行会话 ID 不能为空"));
    }
    let scope = history_scope_from_parts(draft.scope_kind, draft.scope_id.as_deref())?;

    let entry = CommandHistoryEntry {
        id: Uuid::new_v4().to_string(),
        scope_kind: Some(scope.kind),
        scope_id: Some(scope.id.clone()),
        runtime_session_id: draft.runtime_session_id,
        command,
        cwd: draft.cwd,
        exit_code: draft.exit_code,
        started_at_ms: draft.started_at_ms,
        finished_at_ms: draft.finished_at_ms,
    };

    store.write_transaction(|transaction| {
        transaction.execute(
            "
            insert into command_history (
                id, scope_kind, scope_id, runtime_session_id, command, cwd, exit_code,
                started_at_ms, finished_at_ms
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ",
            params![
                entry.id,
                scope.kind.as_str(),
                scope.id,
                entry.runtime_session_id,
                entry.command,
                entry.cwd,
                entry.exit_code,
                entry.started_at_ms,
                entry.finished_at_ms
            ],
        )?;
        prune_history_for_scope(transaction, entry.scope_kind, entry.scope_id.as_deref())?;
        Ok(entry)
    })
}

pub fn search_command_history(
    store: &SqliteStore,
    options: HistorySearchOptions,
) -> AppResult<Vec<CommandHistoryEntry>> {
    let query = normalize_history_query(options.query);
    let scope = history_scope_from_parts(options.scope_kind, options.scope_id.as_deref())?;
    let limit = clamp_history_limit(options.limit);

    if options.deduplicate.unwrap_or(false) {
        return search_deduplicated_command_history(store, query, Some(scope), limit as usize);
    }

    search_command_history_for_scope(store, query, Some(scope), limit)
}

pub fn search_global_command_history(
    store: &SqliteStore,
    query: Option<String>,
    limit: Option<usize>,
    deduplicate: Option<bool>,
) -> AppResult<Vec<CommandHistoryEntry>> {
    let query = normalize_history_query(query);
    let limit = clamp_history_limit(limit);

    if deduplicate.unwrap_or(false) {
        return search_deduplicated_command_history(store, query, None, limit as usize);
    }

    search_command_history_for_scope(store, query, None, limit)
}

fn search_command_history_for_scope(
    store: &SqliteStore,
    query: Option<String>,
    scope: Option<ResolvedHistoryScope>,
    limit: i64,
) -> AppResult<Vec<CommandHistoryEntry>> {
    store.with_connection(|connection| {
        let filters = history_filters(scope, query);
        let where_clause = filters.where_clause();
        let sql = format!(
            "
            select id, scope_kind, scope_id, runtime_session_id, command, cwd, exit_code,
                   started_at_ms, finished_at_ms
            from command_history
            {where_clause}
            order by started_at_ms desc, id desc
            limit ?
            "
        );
        let mut params = filters.into_params();
        params.push(Value::Integer(limit));
        let mut statement = connection.prepare(&sql)?;
        let entries = collect_history(statement.query_map(params_from_iter(params), map_entry)?);
        entries
    })
}

fn search_deduplicated_command_history(
    store: &SqliteStore,
    query: Option<String>,
    scope: Option<ResolvedHistoryScope>,
    limit: usize,
) -> AppResult<Vec<CommandHistoryEntry>> {
    store.with_connection(|connection| {
        let filters = history_filters(scope, query);
        let where_clause = filters.where_clause();
        let sql = format!(
            "
            select id, scope_kind, scope_id, runtime_session_id, command, cwd, exit_code,
                   started_at_ms, finished_at_ms
            from command_history
            {where_clause}
            order by started_at_ms desc, id desc
            "
        );
        let mut statement = connection.prepare(&sql)?;
        let entries = collect_deduplicated_history(
            statement.query_map(params_from_iter(filters.into_params()), map_entry)?,
            limit,
        );
        entries
    })
}

pub fn clear_command_history(
    store: &SqliteStore,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<&str>,
) -> AppResult<ClearCommandHistoryResult> {
    store.write_transaction(|transaction| {
        let scope = history_scope_from_parts(scope_kind, scope_id)?;
        transaction.execute(
            "delete from command_history where scope_kind = ?1 and scope_id = ?2",
            params![scope.kind.as_str(), scope.id],
        )?;
        Ok(ClearCommandHistoryResult { cleared: true })
    })
}

pub fn delete_command_history_entries(
    store: &SqliteStore,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<&str>,
    entry_ids: &[String],
) -> AppResult<DeleteCommandHistoryEntriesResult> {
    let scope = history_scope_from_parts(scope_kind, scope_id)?;
    let entry_ids = entry_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();
    if entry_ids.is_empty() {
        return Err(AppError::validation("至少选择一条历史命令"));
    }

    store.write_transaction(|transaction| {
        let placeholders = vec!["?"; entry_ids.len()].join(", ");
        let sql = format!(
            "delete from command_history where scope_kind = ? and scope_id = ? and id in ({placeholders})"
        );
        let mut params = vec![
            Value::Text(scope.kind.as_str().to_string()),
            Value::Text(scope.id.clone()),
        ];
        params.extend(entry_ids.iter().map(|id| Value::Text((*id).to_string())));
        let deleted_count = transaction.execute(&sql, params_from_iter(params))?;
        Ok(DeleteCommandHistoryEntriesResult { deleted_count })
    })
}

#[derive(Clone)]
struct ResolvedHistoryScope {
    kind: HistoryScopeKind,
    id: String,
}

fn history_scope_from_parts(
    kind: Option<HistoryScopeKind>,
    id: Option<&str>,
) -> AppResult<ResolvedHistoryScope> {
    history_scope_option_from_parts(kind, id)?
        .ok_or_else(|| AppError::validation("历史作用域不能为空"))
}

fn history_scope_option_from_parts(
    kind: Option<HistoryScopeKind>,
    id: Option<&str>,
) -> AppResult<Option<ResolvedHistoryScope>> {
    match (kind, id.map(str::trim).filter(|value| !value.is_empty())) {
        (Some(kind), Some(id)) => Ok(Some(ResolvedHistoryScope {
            kind,
            id: id.to_string(),
        })),
        (None, None) => Ok(None),
        _ => Err(AppError::validation("历史作用域类型和 ID 必须同时提供")),
    }
}

struct HistoryFilters {
    clauses: Vec<&'static str>,
    params: Vec<Value>,
}

fn history_filters(scope: Option<ResolvedHistoryScope>, query: Option<String>) -> HistoryFilters {
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    if let Some(scope) = scope {
        clauses.push("scope_kind = ? and scope_id = ?");
        params.push(Value::Text(scope.kind.as_str().to_string()));
        params.push(Value::Text(scope.id));
    }
    if let Some(query) = query {
        clauses.push("lower(command) like ?");
        params.push(Value::Text(format!("%{query}%")));
    }
    HistoryFilters { clauses, params }
}

impl HistoryFilters {
    fn where_clause(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!("where {}", self.clauses.join(" and "))
        }
    }

    fn into_params(self) -> Vec<Value> {
        self.params
    }
}

pub fn list_session_command_groups(
    store: &SqliteStore,
    scope_kind: HistoryScopeKind,
    scope_id: &str,
) -> AppResult<Vec<SessionCommandGroup>> {
    let scope = history_scope_from_parts(Some(scope_kind), Some(scope_id))?;

    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select id, saved_session_id, scope_kind, scope_id, name, created_at_ms, updated_at_ms
            from session_command_groups
            where scope_kind = ?1 and scope_id = ?2
            order by sort_order, updated_at_ms desc, id
            ",
        )?;
        let mut groups = statement
            .query_map(
                params![scope.kind.as_str(), scope.id.as_str()],
                map_command_group_without_items,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        for group in &mut groups {
            group.items = list_command_group_items(connection, &group.id)?;
        }

        Ok(groups)
    })
}

pub fn save_session_command_group(
    store: &SqliteStore,
    draft: SessionCommandGroupDraft,
) -> AppResult<SessionCommandGroup> {
    let scope = history_scope_from_parts(Some(draft.scope_kind), Some(draft.scope_id.as_str()))?;
    let saved_session_id = match scope.kind {
        HistoryScopeKind::SavedSession => Some(scope.id.clone()),
        HistoryScopeKind::LocalProfile => None,
    };
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("指令组名称不能为空"));
    }
    let commands = normalize_group_commands(draft.commands)?;
    let now = now_ms()?;
    let requested_group_id = draft.id.is_some();
    let group_id = draft
        .id
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    store.write_transaction(|transaction| {
        let existing_created_at = transaction
            .query_row(
                "
                select created_at_ms
                from session_command_groups
                where id = ?1 and scope_kind = ?2 and scope_id = ?3
                ",
                params![group_id.as_str(), scope.kind.as_str(), scope.id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        if existing_created_at.is_some() {
            transaction.execute(
                "
                update session_command_groups
                set name = ?1, updated_at_ms = ?2
                where id = ?3 and scope_kind = ?4 and scope_id = ?5
                ",
                params![
                    name.as_str(),
                    now,
                    group_id.as_str(),
                    scope.kind.as_str(),
                    scope.id.as_str()
                ],
            )?;
            transaction.execute(
                "delete from session_command_group_items where group_id = ?1",
                [group_id.as_str()],
            )?;
        } else if requested_group_id {
            return Err(AppError::validation("指令组不存在"));
        } else {
            let next_sort_order: i64 = transaction.query_row(
                "
                select coalesce(max(sort_order), -10) + 10
                from session_command_groups
                where scope_kind = ?1 and scope_id = ?2
                ",
                params![scope.kind.as_str(), scope.id.as_str()],
                |row| row.get(0),
            )?;
            transaction.execute(
                "
                insert into session_command_groups (
                    id, saved_session_id, scope_kind, scope_id, name, sort_order, created_at_ms, updated_at_ms
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ",
                params![
                    group_id.as_str(),
                    saved_session_id.as_deref(),
                    scope.kind.as_str(),
                    scope.id.as_str(),
                    name.as_str(),
                    next_sort_order,
                    now,
                    now
                ],
            )?;
        }

        let mut items = Vec::with_capacity(commands.len());
        for (index, command) in commands.into_iter().enumerate() {
            let item = SessionCommandGroupItem {
                id: Uuid::new_v4().to_string(),
                group_id: group_id.clone(),
                command,
                sort_order: (index as i64) * 10,
                created_at_ms: now,
                updated_at_ms: now,
            };
            transaction.execute(
                "
                insert into session_command_group_items (
                    id, group_id, command, sort_order, created_at_ms, updated_at_ms
                ) values (?1, ?2, ?3, ?4, ?5, ?6)
                ",
                params![
                    item.id,
                    item.group_id,
                    item.command,
                    item.sort_order,
                    item.created_at_ms,
                    item.updated_at_ms
                ],
            )?;
            items.push(item);
        }

        Ok(SessionCommandGroup {
            id: group_id,
            saved_session_id,
            scope_kind: scope.kind,
            scope_id: scope.id,
            name,
            items,
            created_at_ms: existing_created_at.unwrap_or(now),
            updated_at_ms: now,
        })
    })
}

pub fn delete_session_command_group(
    store: &SqliteStore,
    group_id: &str,
) -> AppResult<CommandGroupDeleted> {
    let group_id = group_id.trim();
    if group_id.is_empty() {
        return Err(AppError::validation("指令组 ID 不能为空"));
    }

    store.write_transaction(|transaction| {
        transaction.execute(
            "delete from session_command_groups where id = ?1",
            [group_id],
        )?;
        Ok(CommandGroupDeleted { deleted: true })
    })
}

fn clamp_history_limit(limit: Option<usize>) -> i64 {
    limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT) as i64
}

fn normalize_history_query(query: Option<String>) -> Option<String> {
    query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
}

fn collect_deduplicated_history(
    rows: impl Iterator<Item = rusqlite::Result<CommandHistoryEntry>>,
    limit: usize,
) -> AppResult<Vec<CommandHistoryEntry>> {
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for row in rows {
        let entry = row?;
        let key = entry.command.trim().to_string();
        if seen.insert(key) {
            entries.push(entry);
        }
        if entries.len() >= limit {
            break;
        }
    }
    Ok(entries)
}

fn collect_history(
    rows: impl Iterator<Item = rusqlite::Result<CommandHistoryEntry>>,
) -> AppResult<Vec<CommandHistoryEntry>> {
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

fn map_entry(row: &Row<'_>) -> rusqlite::Result<CommandHistoryEntry> {
    let scope_kind_value: Option<String> = row.get(1)?;
    Ok(CommandHistoryEntry {
        id: row.get(0)?,
        scope_kind: scope_kind_value
            .as_deref()
            .and_then(HistoryScopeKind::from_db),
        scope_id: row.get(2)?,
        runtime_session_id: row.get(3)?,
        command: row.get(4)?,
        cwd: row.get(5)?,
        exit_code: row.get(6)?,
        started_at_ms: row.get(7)?,
        finished_at_ms: row.get(8)?,
    })
}

fn map_command_group_without_items(row: &Row<'_>) -> rusqlite::Result<SessionCommandGroup> {
    let scope_kind_value: String = row.get(2)?;
    Ok(SessionCommandGroup {
        id: row.get(0)?,
        saved_session_id: row.get(1)?,
        scope_kind: HistoryScopeKind::from_db(&scope_kind_value).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                Box::new(AppError::storage(format!(
                    "invalid history scope kind: {scope_kind_value}"
                ))),
            )
        })?,
        scope_id: row.get(3)?,
        name: row.get(4)?,
        items: Vec::new(),
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn map_command_group_item(row: &Row<'_>) -> rusqlite::Result<SessionCommandGroupItem> {
    Ok(SessionCommandGroupItem {
        id: row.get(0)?,
        group_id: row.get(1)?,
        command: row.get(2)?,
        sort_order: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

fn list_command_group_items(
    connection: &rusqlite::Connection,
    group_id: &str,
) -> AppResult<Vec<SessionCommandGroupItem>> {
    let mut statement = connection.prepare(
        "
        select id, group_id, command, sort_order, created_at_ms, updated_at_ms
        from session_command_group_items
        where group_id = ?1
        order by sort_order, id
        ",
    )?;
    let result = statement
        .query_map([group_id], map_command_group_item)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into);
    result
}

fn normalize_group_commands(commands: Vec<String>) -> AppResult<Vec<String>> {
    let normalized = commands
        .into_iter()
        .map(|command| command.trim().to_string())
        .filter(|command| !command.is_empty())
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        return Err(AppError::validation("指令组至少需要一条命令"));
    }
    if normalized
        .iter()
        .any(|command| command.chars().count() > MAX_COMMAND_LENGTH)
    {
        return Err(AppError::validation("命令长度不能超过 4096 字符"));
    }
    Ok(normalized)
}

fn prune_history_for_scope(
    transaction: &rusqlite::Transaction<'_>,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<&str>,
) -> AppResult<()> {
    let Some(scope_kind) = scope_kind else {
        return Ok(());
    };
    let Some(scope_id) = scope_id else {
        return Ok(());
    };
    transaction.execute(
        "
        delete from command_history
        where scope_kind = ?1
          and scope_id = ?2
          and id not in (
            select id
            from command_history
            where scope_kind = ?1
              and scope_id = ?2
            order by started_at_ms desc, id desc
            limit ?3
          )
        ",
        params![
            scope_kind.as_str(),
            scope_id,
            STORED_HISTORY_LIMIT_PER_SESSION
        ],
    )?;
    Ok(())
}

fn now_ms() -> AppResult<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::storage(error.to_string()))?;
    Ok(duration.as_millis() as i64)
}
