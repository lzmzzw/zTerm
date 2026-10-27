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

/// Completion uses an exact, case-sensitive prefix. Keep the history panel's
/// contains search separate so its existing matching behavior stays unchanged.
pub(crate) fn search_command_history_prefix(
    store: &SqliteStore,
    prefix: &str,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<&str>,
    limit: Option<usize>,
) -> AppResult<Vec<CommandHistoryEntry>> {
    let scope = history_scope_option_from_parts(scope_kind, scope_id)?;
    if prefix.is_empty() {
        return Ok(Vec::new());
    }
    let limit = clamp_history_limit(limit) as usize;
    store.with_connection(|connection| {
        let mut filters = history_filters(scope, None);
        filters.clauses.push("command collate binary >= ?");
        filters.params.push(Value::Text(prefix.to_string()));
        if let Some(upper_bound) = prefix_upper_bound(prefix) {
            filters.clauses.push("command collate binary < ?");
            filters.params.push(Value::Text(upper_bound));
        }
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
        // Apply the limit after deduplication, retaining the latest record for
        // each command and the existing timestamp/id tie-break order.
        let entries = collect_deduplicated_history(
            statement.query_map(params_from_iter(filters.into_params()), map_entry)?,
            limit,
        );
        entries
    })
}

// UTF-8 BINARY order follows Unicode scalar order. Increment the rightmost
// scalar with a successor, then truncate, without producing invalid UTF-8 or
// a surrogate. An all-MAX prefix needs only the inclusive lower bound.
fn prefix_upper_bound(prefix: &str) -> Option<String> {
    for (index, character) in prefix.char_indices().rev() {
        let next = match character {
            char::MAX => continue,
            '\u{d7ff}' => '\u{e000}',
            value => char::from_u32(value as u32 + 1)?,
        };
        let mut upper_bound = prefix[..index].to_string();
        upper_bound.push(next);
        return Some(upper_bound);
    }
    None
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

#[cfg(test)]
mod prefix_tests {
    use super::*;

    #[test]
    #[ignore = "manual 100k-row history query measurement"]
    fn history_prefix_large_fixture_benchmark() {
        let store = SqliteStore::open_in_memory().unwrap();
        store.write_transaction(|tx| {
            let mut statement = tx.prepare("insert into command_history(id, scope_kind, scope_id, runtime_session_id, command, started_at_ms) values (?1, 'saved_session', ?2, 'benchmark', ?3, ?4)")?;
            for index in 0..100_000i64 {
                let command = if index % 1000 == 0 {
                    format!("rare-prefix command-{index}")
                } else {
                    format!("echo rare-prefix command-{index}")
                };
                statement.execute(params![format!("bench-{index:06}"), format!("scope-{}", index / 1000), command, index])?;
            }
            Ok(())
        }).unwrap();
        let started = std::time::Instant::now();
        let mut legacy_matches = 0;
        for _ in 0..20 {
            legacy_matches = search_global_command_history(
                &store,
                Some("rare-prefix".into()),
                Some(500),
                Some(true),
            )
            .unwrap()
            .iter()
            .filter(|entry| entry.command.starts_with("rare-prefix"))
            .count();
        }
        let contains_elapsed = started.elapsed();
        let started = std::time::Instant::now();
        let mut prefix_matches = 0;
        for _ in 0..20 {
            prefix_matches =
                search_command_history_prefix(&store, "rare-prefix", None, None, Some(500))
                    .unwrap()
                    .len();
        }
        eprintln!("100000 rows / 20 queries: contains={contains_elapsed:?} ({legacy_matches} valid candidates); indexed_prefix={:?} ({prefix_matches} valid candidates)", started.elapsed());
        assert_eq!(legacy_matches, 0);
        assert_eq!(prefix_matches, 100);
    }

    fn insert(
        store: &SqliteStore,
        kind: HistoryScopeKind,
        scope_id: &str,
        command: &str,
        started_at_ms: i64,
    ) -> CommandHistoryEntry {
        insert_command_history(
            store,
            CommandHistoryDraft {
                scope_kind: Some(kind),
                scope_id: Some(scope_id.to_string()),
                runtime_session_id: "prefix-test".to_string(),
                command: command.to_string(),
                cwd: None,
                exit_code: None,
                started_at_ms,
                finished_at_ms: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn history_prefix_filters_before_limit_and_preserves_latest_deduplication() {
        let store = SqliteStore::open_in_memory().unwrap();
        let kind = HistoryScopeKind::SavedSession;
        insert(&store, kind, "scope", "git status", 0);
        insert(&store, kind, "scope", "git stash", 1);
        let latest = insert(&store, kind, "scope", "git status", 2);
        for index in 0..550 {
            insert(
                &store,
                kind,
                "scope",
                &format!("echo git status {index}"),
                index + 100,
            );
        }
        insert(&store, kind, "scope", "GIT STATUS", 1000);
        let entries =
            search_command_history_prefix(&store, "git s", Some(kind), Some("scope"), Some(2))
                .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, latest.id);
        assert_eq!(entries[1].command, "git stash");

        // The ordinary history panel continues to use its contains search.
        let contains = search_command_history(
            &store,
            HistorySearchOptions {
                query: Some("git s".to_string()),
                scope_kind: Some(kind),
                scope_id: Some("scope".to_string()),
                limit: Some(2),
                deduplicate: Some(true),
            },
        )
        .unwrap();
        assert_eq!(contains[0].command, "GIT STATUS");
        assert!(contains[1].command.starts_with("echo git status"));
    }

    #[test]
    fn history_prefix_is_literal_case_sensitive_and_unicode_safe() {
        let store = SqliteStore::open_in_memory().unwrap();
        let commands = [
            "部署😀 --dry-run",
            "部署😁 --dry-run",
            "écho one",
            "e\u{301}cho two",
            "Git status",
            "git status",
            "echo %_literal",
            "echo XXliteral",
            "\u{d7ff}end",
            "\u{e000}start",
            "x\u{10ffff}end",
            "y start",
            "\u{10ffff}end",
            "\u{10ffff}\u{10ffff}end",
        ];
        let inserted: Vec<_> = commands
            .iter()
            .enumerate()
            .map(|(index, command)| {
                insert(
                    &store,
                    HistoryScopeKind::LocalProfile,
                    "profile",
                    command,
                    index as i64,
                )
            })
            .collect();
        for prefix in [
            "部署😀",
            "é",
            "e\u{301}",
            "Git",
            "git",
            "echo %_",
            "\u{d7ff}",
            "x\u{10ffff}",
            "\u{10ffff}",
            "\u{10ffff}\u{10ffff}",
        ] {
            let entries = search_command_history_prefix(&store, prefix, None, None, None).unwrap();
            let expected: Vec<_> = inserted
                .iter()
                .rev()
                .filter(|entry| entry.command.starts_with(prefix))
                .cloned()
                .collect();
            assert_eq!(entries, expected, "prefix: {prefix:?}");
        }
    }

    #[test]
    fn history_prefix_scopes_and_timestamp_ties_keep_existing_order() {
        let store = SqliteStore::open_in_memory().unwrap();
        let saved = HistoryScopeKind::SavedSession;
        let local = HistoryScopeKind::LocalProfile;
        let first = insert(&store, saved, "shared-id", "git first", 10);
        let second = insert(&store, saved, "shared-id", "git second", 10);
        insert(&store, local, "shared-id", "git local", 20);
        insert(&store, saved, "other-id", "git other", 30);
        let mut expected = vec![first, second];
        expected.sort_by(|left, right| right.id.cmp(&left.id));
        assert_eq!(
            search_command_history_prefix(&store, "git ", Some(saved), Some("shared-id"), None)
                .unwrap(),
            expected
        );
        let global = search_command_history_prefix(&store, "git ", None, None, None).unwrap();
        assert_eq!(global.len(), 4);
        assert_eq!(global[0].command, "git other");
        assert_eq!(global[1].command, "git local");
        assert_eq!(&global[2..], expected);
        assert!(search_command_history_prefix(&store, "git", Some(saved), None, None).is_err());
        assert!(
            search_command_history_prefix(&store, "git", None, Some("shared-id"), None).is_err()
        );
    }

    #[test]
    fn history_prefix_range_queries_use_migrated_indexes() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        crate::storage::migrations::run_migrations(&mut connection).unwrap();
        crate::storage::migrations::run_migrations(&mut connection).unwrap();
        for (filter, parameters, expected_index) in [
            (
                "command collate binary >= ? and command collate binary < ?",
                vec!["git", "giu"],
                "idx_command_history_command_prefix",
            ),
            (
                "scope_kind = ? and scope_id = ? and command collate binary >= ? and command collate binary < ?",
                vec!["saved_session", "scope", "git", "giu"],
                "idx_command_history_scope_command_prefix",
            ),
        ] {
            let mut statement = connection
                .prepare(&format!(
                    "explain query plan
                     select id, scope_kind, scope_id, runtime_session_id, command, cwd, exit_code,
                            started_at_ms, finished_at_ms
                     from command_history where {filter}
                     order by started_at_ms desc, id desc"
                ))
                .unwrap();
            let plan: Vec<String> = statement
                .query_map(params_from_iter(parameters), |row| row.get(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert!(
                plan.iter().any(|step| step.contains(expected_index) && step.contains("SEARCH")),
                "expected range search using {expected_index}: {plan:?}"
            );
        }
    }
}
