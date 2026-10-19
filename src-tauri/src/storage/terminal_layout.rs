use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    error::{AppError, AppResult},
    models::terminal_layout::{PaneNode, TerminalLayoutConnection, TerminalLayoutSnapshot},
    storage::sqlite::SqliteStore,
    time::now_ms,
};

pub fn get_terminal_layout(store: &SqliteStore) -> AppResult<Option<TerminalLayoutSnapshot>> {
    store.with_connection(|connection| {
        let json: Option<String> = connection
            .query_row(
                "select snapshot_json from terminal_layout where id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| {
            let snapshot = serde_json::from_str(&json)
                .map_err(|error| AppError::storage(error.to_string()))?;
            sanitize(snapshot, connection)
        })
        .transpose()
    })
}

pub fn save_terminal_layout(
    store: &SqliteStore,
    snapshot: TerminalLayoutSnapshot,
) -> AppResult<TerminalLayoutSnapshot> {
    store.write_transaction(|transaction| {
        let snapshot = sanitize(snapshot, transaction)?;
        let json = serde_json::to_string(&snapshot)
            .map_err(|error| AppError::storage(error.to_string()))?;
        if json.len() > 1_048_576 {
            return Err(AppError::validation("终端布局不能超过 1 MiB"));
        }
        transaction.execute(
            "insert into terminal_layout (id, snapshot_json, updated_at_ms) values (1, ?1, ?2)
             on conflict(id) do update set snapshot_json = excluded.snapshot_json,
               updated_at_ms = excluded.updated_at_ms",
            params![json, now_ms()],
        )?;
        Ok(snapshot)
    })
}

fn sanitize(
    mut snapshot: TerminalLayoutSnapshot,
    connection: &Connection,
) -> AppResult<TerminalLayoutSnapshot> {
    let active_index = snapshot
        .tabs
        .iter()
        .position(|tab| tab.id == snapshot.active_tab_id)
        .unwrap_or(0);
    if snapshot.tabs.is_empty() {
        return Err(AppError::validation("当前终端布局不能为空"));
    }
    let active = snapshot.tabs.remove(active_index);
    snapshot.active_tab_id = active.id.clone();
    snapshot.tabs = vec![active];
    let mut statement = connection.prepare("select id from saved_sessions")?;
    let valid_ids = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    for tab in &mut snapshot.tabs {
        sanitize_pane(&mut tab.root, &valid_ids, 0)?;
    }
    Ok(snapshot)
}

fn sanitize_pane(node: &mut PaneNode, valid_ids: &HashSet<String>, depth: usize) -> AppResult<()> {
    if depth > 16 {
        return Err(AppError::validation("终端分栏层级过深"));
    }
    match node {
        PaneNode::Leaf {
            id,
            saved_session_id,
            title,
            active_terminal_tab_id,
            terminal_tabs,
        } => {
            terminal_tabs.retain(|tab| {
                tab.connection_source.as_deref() != Some("external_ssh")
                    && !tab
                        .saved_session_id
                        .as_deref()
                        .is_some_and(|id| id.starts_with("external:"))
            });
            for tab in terminal_tabs.iter_mut() {
                if tab
                    .saved_session_id
                    .as_ref()
                    .is_some_and(|id| !valid_ids.contains(id))
                {
                    tab.saved_session_id = None;
                    tab.connection_source = Some("missing".into());
                    tab.container_target = None;
                }
            }
            if terminal_tabs.is_empty() {
                terminal_tabs.push(TerminalLayoutConnection {
                    id: format!("{id}-tab-1"),
                    title: "新建终端".into(),
                    saved_session_id: None,
                    connection_source: Some("empty".into()),
                    container_target: None,
                    path: None,
                });
            }
            let active = terminal_tabs
                .iter()
                .find(|tab| Some(tab.id.as_str()) == active_terminal_tab_id.as_deref())
                .unwrap_or(&terminal_tabs[0]);
            *saved_session_id = active.saved_session_id.clone();
            *title = active.title.clone();
            *active_terminal_tab_id = Some(active.id.clone());
        }
        PaneNode::Split {
            direction,
            ratio,
            first,
            second,
            ..
        } => {
            if !matches!(direction.as_str(), "horizontal" | "vertical")
                || !ratio.is_finite()
                || !(0.0..1.0).contains(ratio)
                || *ratio == 0.0
            {
                return Err(AppError::validation("终端分栏方向或比例无效"));
            }
            sanitize_pane(first, valid_ids, depth + 1)?;
            sanitize_pane(second, valid_ids, depth + 1)?;
        }
    }
    Ok(())
}
