use serde_json::{json, Value};
use zterm_lib::{
    models::terminal_layout::TerminalLayoutSnapshot,
    storage::{
        sqlite::SqliteStore,
        terminal_layout::{get_terminal_layout, save_terminal_layout},
    },
};

fn snapshot(title: &str) -> TerminalLayoutSnapshot {
    serde_json::from_value(json!({
        "active_tab_id": "tab-1", "name": "must not persist", "secret": "must not persist",
        "tabs": [{ "id": "tab-1", "title": title, "sort_order": 0, "active_pane_id": "pane-1",
            "root": { "kind": "leaf", "id": "pane-1", "title": title,
                "runtime_session_id": "runtime-old", "saved_session_id": "external:old",
                "active_terminal_tab_id": "transient",
                "terminal_tabs": [
                    {"id":"transient", "title":"Transient", "connection_source":"external_ssh", "saved_session_id":"external:old"},
                    {"id":"retained", "title":"Local", "connection_source":"default_local", "path":"C:/projects",
                     "runtime_session_id":"runtime-old", "restore_error":"private error", "restore_status":"connected",
                     "password":"private password", "startup_command":"secret command"}
                ]
            }
        }]
    })).unwrap()
}

#[test]
fn current_layout_is_singleton_and_strips_transient_and_unknown_fields() {
    let store = SqliteStore::open_in_memory().unwrap();
    assert!(get_terminal_layout(&store).unwrap().is_none());
    save_terminal_layout(&store, snapshot("First")).unwrap();
    save_terminal_layout(&store, snapshot("Second")).unwrap();
    let restored = get_terminal_layout(&store).unwrap().unwrap();
    assert_eq!(restored.tabs[0].title, "Second");
    let value = serde_json::to_value(restored).unwrap();
    let pane = &value["tabs"][0]["root"];
    assert_eq!(pane["terminal_tabs"].as_array().unwrap().len(), 1);
    assert_eq!(pane["active_terminal_tab_id"], "retained");
    assert_eq!(pane["terminal_tabs"][0]["path"], "C:/projects");
    assert_eq!(
        pane["terminal_tabs"][0]["connection_source"],
        "default_local"
    );
    store
        .with_connection(|connection| {
            let count: i64 =
                connection
                    .query_row("select count(*) from terminal_layout", [], |row| row.get(0))?;
            assert_eq!(count, 1);
            assert!(connection
                .execute("insert into terminal_layout values (2, '{}', 0)", [])
                .is_err());
            let stored: String =
                connection.query_row("select snapshot_json from terminal_layout", [], |row| {
                    row.get(0)
                })?;
            for removed in [
                "must not persist",
                "private",
                "secret",
                "runtime-old",
                "external:",
                "startup_command",
                "restore_status",
                "restore_error",
            ] {
                assert!(
                    !stored.contains(removed),
                    "unexpected persisted field {removed}"
                );
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn missing_saved_connections_are_marked_missing_on_read() {
    let store = SqliteStore::open_in_memory().unwrap();
    store
        .with_connection(|connection| {
            connection.execute(
                "insert into saved_sessions
            (id,name,type,host,port,username,auth_mode,created_at_ms,updated_at_ms)
            values ('saved', 'SSH', 'ssh', 'host.test', 22, 'ops', 'agent', 0, 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let mut value = serde_json::to_value(snapshot("Current")).unwrap();
    let tab = &mut value["tabs"][0]["root"]["terminal_tabs"][1];
    tab["saved_session_id"] = json!("saved");
    tab["connection_source"] = json!("saved_session");
    tab["container_target"] = json!({"id":"container", "name":"app"});
    save_terminal_layout(&store, serde_json::from_value(value).unwrap()).unwrap();
    store
        .with_connection(|connection| {
            connection.execute("delete from saved_sessions where id = 'saved'", [])?;
            Ok(())
        })
        .unwrap();
    let value: Value = serde_json::to_value(get_terminal_layout(&store).unwrap().unwrap()).unwrap();
    let tab = &value["tabs"][0]["root"]["terminal_tabs"][0];
    assert_eq!(tab["saved_session_id"], Value::Null);
    assert_eq!(tab["connection_source"], "missing");
    assert_eq!(tab["container_target"], Value::Null);
}

#[test]
fn empty_panes_and_transient_only_panes_restore_as_empty_placeholders() {
    let store = SqliteStore::open_in_memory().unwrap();
    for connections in [
        json!([]),
        json!([{"id":"external", "title":"Transient", "connection_source":"external_ssh"}]),
        json!([{"id":"empty", "title":"New terminal", "connection_source":"empty"}]),
    ] {
        let mut value = serde_json::to_value(snapshot("Empty")).unwrap();
        value["tabs"][0]["root"]["terminal_tabs"] = connections;
        save_terminal_layout(&store, serde_json::from_value(value).unwrap()).unwrap();
        let restored = serde_json::to_value(get_terminal_layout(&store).unwrap().unwrap()).unwrap();
        let pane = &restored["tabs"][0]["root"];
        assert_eq!(pane["terminal_tabs"].as_array().unwrap().len(), 1);
        assert_eq!(pane["terminal_tabs"][0]["connection_source"], "empty");
        assert_eq!(pane["terminal_tabs"][0]["saved_session_id"], Value::Null);
        assert_eq!(pane["saved_session_id"], Value::Null);
    }
}

#[test]
fn only_current_outer_layout_is_retained_and_missing_active_id_uses_first() {
    let store = SqliteStore::open_in_memory().unwrap();
    for (requested, expected) in [("tab-2", "tab-2"), ("unknown", "tab-1")] {
        let mut input = snapshot("First");
        let mut second = input.tabs[0].clone();
        second.id = "tab-2".into();
        second.title = "Second".into();
        input.tabs.push(second);
        input.active_tab_id = requested.into();
        let saved = save_terminal_layout(&store, input).unwrap();
        assert_eq!(saved.tabs.len(), 1);
        assert_eq!(saved.active_tab_id, expected);
        assert_eq!(saved.tabs[0].id, expected);
        let restored = get_terminal_layout(&store).unwrap().unwrap();
        assert_eq!(restored, saved);
    }
    let mut empty = snapshot("Empty");
    empty.tabs.clear();
    assert!(save_terminal_layout(&store, empty).is_err());
}
