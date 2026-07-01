// Author: Liz
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, types::Type, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        session::DeleteResult,
        workspace::{
            PaneNode, WorkspaceDefinition, WorkspaceDefinitionDraft, WorkspaceStatus,
            WorkspaceSummary, WorkspaceTab, WorkspaceTabDraft, WorkspaceTerminalTab,
        },
    },
    storage::sqlite::SqliteStore,
};

pub const WORKSPACES_TABLE: &str = "workspaces";
pub const WORKSPACE_TABS_TABLE: &str = "workspace_tabs";
const DEFAULT_WORKSPACE_ID: &str = "default-workspace";

pub fn list_workspaces(store: &SqliteStore) -> AppResult<Vec<WorkspaceSummary>> {
    store.with_connection(|connection| {
        let mut statement = connection.prepare(
            "
            select w.id, w.name, w.status, w.active_tab_id, count(t.id) as tab_count,
                   w.sort_order, w.created_at_ms, w.updated_at_ms
            from workspaces w
            left join workspace_tabs t on t.workspace_id = w.id
            group by w.id
            order by w.sort_order, w.updated_at_ms desc, w.name
            ",
        )?;
        let summaries = statement
            .query_map([], map_workspace_summary)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(AppError::from)?;
        Ok(summaries)
    })
}

pub fn get_workspace(store: &SqliteStore, id: &str) -> AppResult<WorkspaceDefinition> {
    let id = required_text("工作区 ID", id)?;
    store.with_connection(|connection| {
        let mut workspace = connection
            .query_row(
                "
                select id, name, status, active_tab_id, sort_order, created_at_ms, updated_at_ms
                from workspaces
                where id = ?1
                ",
                [&id],
                map_workspace_without_tabs,
            )
            .optional()?
            .ok_or_else(|| AppError::not_found(format!("workspace not found: {id}")))?;

        let mut statement = connection.prepare(
            "
            select id, title, active_pane_id, root_json, sort_order, created_at_ms, updated_at_ms
            from workspace_tabs
            where workspace_id = ?1
            order by sort_order, updated_at_ms desc, title
            ",
        )?;
        let mut tabs = statement
            .query_map([workspace.id.as_str()], map_workspace_tab)?
            .collect::<Result<Vec<_>, _>>()?;
        let valid_session_ids = valid_saved_session_ids(connection)?;
        for tab in &mut tabs {
            sanitize_missing_sessions(&mut tab.root, &valid_session_ids);
        }
        workspace.tabs = tabs;
        Ok(workspace)
    })
}

pub fn save_workspace(
    store: &SqliteStore,
    draft: WorkspaceDefinitionDraft,
) -> AppResult<WorkspaceDefinition> {
    let name = required_text("工作区名称", draft.name)?;
    let active_tab_id = required_text("活动标签 ID", draft.active_tab_id)?;
    if draft.tabs.is_empty() {
        return Err(AppError::validation("工作区至少需要一个标签页"));
    }
    if !draft.tabs.iter().any(|tab| tab.id == active_tab_id) {
        return Err(AppError::validation("活动标签不属于工作区"));
    }
    let id = normalized_id(draft.id);
    if id.as_deref() == Some(DEFAULT_WORKSPACE_ID) {
        return Err(AppError::validation("默认工作区不能保存布局快照"));
    }
    let now = now_ms();

    store.write_transaction(|transaction| {
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from workspaces where id = ?1",
                [&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);

        transaction.execute(
            "
            insert into workspaces (
              id, name, active_tab_id, status, sort_order, created_at_ms, updated_at_ms
            )
            values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            on conflict(id) do update set
              name = excluded.name,
              active_tab_id = excluded.active_tab_id,
              status = excluded.status,
              sort_order = excluded.sort_order,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![
                id,
                name,
                active_tab_id,
                WorkspaceStatus::Closed.as_str(),
                draft.sort_order,
                created_at_ms,
                now,
            ],
        )?;

        transaction.execute("delete from workspace_tabs where workspace_id = ?1", [&id])?;
        let mut tabs = Vec::with_capacity(draft.tabs.len());
        for tab in draft.tabs {
            let tab = save_workspace_tab(transaction, &id, tab, now)?;
            tabs.push(tab);
        }

        Ok(WorkspaceDefinition {
            id,
            name,
            status: WorkspaceStatus::Closed,
            active_tab_id,
            tabs,
            sort_order: draft.sort_order,
            created_at_ms,
            updated_at_ms: now,
        })
    })
}

pub fn close_workspace(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("工作区 ID", id)?;
    let now = now_ms();
    store.write_transaction(|transaction| {
        let updated = transaction.execute(
            "
            update workspaces
            set status = 'closed', updated_at_ms = ?2
            where id = ?1
            ",
            params![id, now],
        )?;
        if updated == 0 {
            return Err(AppError::not_found(format!("workspace not found: {id}")));
        }
        Ok(DeleteResult { deleted: true })
    })
}

pub fn remove_workspace(store: &SqliteStore, id: &str) -> AppResult<DeleteResult> {
    let id = required_text("工作区 ID", id)?;
    if id == DEFAULT_WORKSPACE_ID {
        return Err(AppError::validation("默认工作区不能删除"));
    }

    store.write_transaction(|transaction| {
        transaction.execute("delete from workspace_tabs where workspace_id = ?1", [&id])?;
        let deleted = transaction.execute("delete from workspaces where id = ?1", [&id])?;
        if deleted == 0 {
            return Err(AppError::not_found(format!("workspace not found: {id}")));
        }
        Ok(DeleteResult { deleted: true })
    })
}

fn save_workspace_tab(
    transaction: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    draft: WorkspaceTabDraft,
    now: i64,
) -> AppResult<WorkspaceTab> {
    let id = required_text("工作区标签 ID", draft.id)?;
    let title = required_text("工作区标签标题", draft.title)?;
    let active_pane_id = required_text("活动分栏 ID", draft.active_pane_id)?;
    let root = strip_runtime_state(draft.root);
    let root_json =
        serde_json::to_string(&root).map_err(|error| AppError::storage(error.to_string()))?;

    transaction.execute(
        "
        insert into workspace_tabs (
          id, workspace_id, title, active_pane_id, root_json,
          sort_order, created_at_ms, updated_at_ms
        )
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ",
        params![
            id,
            workspace_id,
            title,
            active_pane_id,
            root_json,
            draft.sort_order,
            now,
            now,
        ],
    )?;

    Ok(WorkspaceTab {
        id,
        title,
        active_pane_id,
        root,
        sort_order: draft.sort_order,
        created_at_ms: now,
        updated_at_ms: now,
    })
}

fn strip_runtime_state(root: PaneNode) -> PaneNode {
    match root {
        PaneNode::Leaf {
            id,
            saved_session_id,
            title,
            active_terminal_tab_id,
            terminal_tabs,
            ..
        } => {
            let terminal_tabs = normalize_terminal_tabs(
                id.as_str(),
                title.as_str(),
                saved_session_id.clone(),
                terminal_tabs,
            );
            let active_terminal_tab = terminal_tabs
                .iter()
                .find(|tab| Some(tab.id.as_str()) == active_terminal_tab_id.as_deref())
                .or_else(|| terminal_tabs.first());
            PaneNode::Leaf {
                id,
                runtime_session_id: None,
                saved_session_id: active_terminal_tab
                    .and_then(|tab| tab.saved_session_id.clone())
                    .or(saved_session_id),
                title: active_terminal_tab
                    .map(|tab| tab.title.clone())
                    .unwrap_or(title),
                active_terminal_tab_id: active_terminal_tab.map(|tab| tab.id.clone()),
                terminal_tabs,
            }
        }
        PaneNode::Split {
            id,
            direction,
            ratio,
            first,
            second,
        } => PaneNode::Split {
            id,
            direction,
            ratio,
            first: Box::new(strip_runtime_state(*first)),
            second: Box::new(strip_runtime_state(*second)),
        },
    }
}

fn normalize_terminal_tabs(
    pane_id: &str,
    pane_title: &str,
    pane_saved_session_id: Option<String>,
    terminal_tabs: Vec<WorkspaceTerminalTab>,
) -> Vec<WorkspaceTerminalTab> {
    let terminal_tabs = if terminal_tabs.is_empty() {
        vec![WorkspaceTerminalTab {
            id: format!("{pane_id}-tab-1"),
            title: pane_title.to_string(),
            runtime_session_id: None,
            saved_session_id: pane_saved_session_id,
            connection_source: None,
            path: None,
            container_target: None,
            startup_command: None,
            restore_status: None,
            restore_error: None,
        }]
    } else {
        terminal_tabs
    };

    terminal_tabs
        .into_iter()
        .map(|tab| WorkspaceTerminalTab {
            connection_source: tab
                .connection_source
                .or_else(|| connection_source_for_session(tab.saved_session_id.as_deref())),
            runtime_session_id: None,
            restore_status: None,
            restore_error: None,
            ..tab
        })
        .collect()
}

fn connection_source_for_session(saved_session_id: Option<&str>) -> Option<String> {
    Some(
        if saved_session_id.is_some() {
            "saved_session"
        } else {
            "default_local"
        }
        .to_string(),
    )
}

fn sanitize_missing_sessions(root: &mut PaneNode, valid_session_ids: &HashSet<String>) {
    match root {
        PaneNode::Leaf {
            saved_session_id,
            terminal_tabs,
            ..
        } => {
            if saved_session_id
                .as_ref()
                .is_some_and(|id| !valid_session_ids.contains(id))
            {
                *saved_session_id = None;
            }
            for tab in terminal_tabs {
                if tab
                    .saved_session_id
                    .as_ref()
                    .is_some_and(|id| !valid_session_ids.contains(id))
                {
                    tab.saved_session_id = None;
                    tab.connection_source = Some("missing".to_string());
                }
            }
        }
        PaneNode::Split { first, second, .. } => {
            sanitize_missing_sessions(first, valid_session_ids);
            sanitize_missing_sessions(second, valid_session_ids);
        }
    }
}

fn valid_saved_session_ids(connection: &rusqlite::Connection) -> AppResult<HashSet<String>> {
    let mut statement = connection.prepare("select id from saved_sessions")?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(AppError::from)?;
    Ok(ids)
}

fn map_workspace_summary(row: &Row<'_>) -> rusqlite::Result<WorkspaceSummary> {
    let status_value: String = row.get(2)?;
    Ok(WorkspaceSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        status: WorkspaceStatus::from_db(&status_value).ok_or_else(|| {
            conversion_error(2, format!("invalid workspace status: {status_value}"))
        })?,
        active_tab_id: row.get(3)?,
        tab_count: row.get(4)?,
        sort_order: row.get(5)?,
        created_at_ms: row.get(6)?,
        updated_at_ms: row.get(7)?,
    })
}

fn map_workspace_without_tabs(row: &Row<'_>) -> rusqlite::Result<WorkspaceDefinition> {
    let status_value: String = row.get(2)?;
    Ok(WorkspaceDefinition {
        id: row.get(0)?,
        name: row.get(1)?,
        status: WorkspaceStatus::from_db(&status_value).ok_or_else(|| {
            conversion_error(2, format!("invalid workspace status: {status_value}"))
        })?,
        active_tab_id: row.get(3)?,
        tabs: Vec::new(),
        sort_order: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn map_workspace_tab(row: &Row<'_>) -> rusqlite::Result<WorkspaceTab> {
    let root_json: String = row.get(3)?;
    Ok(WorkspaceTab {
        id: row.get(0)?,
        title: row.get(1)?,
        active_pane_id: row.get(2)?,
        root: serde_json::from_str(&root_json)
            .map_err(|error| conversion_error(3, error.to_string()))?,
        sort_order: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
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
