// Author: Liz
use std::sync::Arc;

use zterm_lib::{
    error::AppError,
    models::{
        history::{
            CommandHistoryDraft, HistoryScopeKind, HistorySearchOptions, SessionCommandGroupDraft,
        },
        session::{AuthMode, SavedSessionDraft, SessionType},
    },
    services::command_history_service::CommandHistoryService,
    storage::{
        history::{
            clear_command_history, delete_command_history_entries, delete_session_command_group,
            insert_command_history, list_session_command_groups, save_session_command_group,
            search_command_history,
        },
        sessions::save_session,
        sqlite::SqliteStore,
    },
};

fn ssh_draft(name: &str) -> SavedSessionDraft {
    SavedSessionDraft {
        id: None,
        name: name.to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "example.test".to_string(),
        port: 22,
        username: "ops".to_string(),
        auth_mode: AuthMode::Agent,
        credential_ref: None,
        description: None,
        tags: Vec::new(),
        sort_order: 0,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
        ftp_options: None,
    }
}

#[test]
fn command_history_captures_completed_commands_and_filters_invalid_input() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session = save_session(store.as_ref(), ssh_draft("开发机")).expect("session should save");
    let service = CommandHistoryService::new(Arc::clone(&store));

    service.register_runtime(
        "runtime-1",
        Some(session.id.clone()),
        Some(HistoryScopeKind::SavedSession),
        Some(session.id.clone()),
    );
    service
        .capture_input("runtime-1", "   \r")
        .expect("blank command should be ignored");
    service
        .capture_input("runtime-1", &format!("{}\r", "x".repeat(4097)))
        .expect("overlong command should be ignored");
    service
        .capture_input("runtime-1", "pw")
        .expect("partial input should buffer");
    service
        .capture_input("runtime-1", "d\rwhoami\n")
        .expect("complete commands should save");

    let entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session.id.clone()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("history should search");
    let commands = entries
        .iter()
        .map(|entry| entry.command.as_str())
        .collect::<Vec<_>>();

    assert_eq!(commands.len(), 2);
    assert!(commands.contains(&"pwd"));
    assert!(commands.contains(&"whoami"));
    assert!(entries.iter().all(
        |entry| entry.scope_kind == Some(HistoryScopeKind::SavedSession)
            && entry.scope_id.as_deref() == Some(session.id.as_str())
    ));
}

#[test]
fn command_history_search_filters_limits_and_clears_by_session() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session_a =
        save_session(store.as_ref(), ssh_draft("开发机 A")).expect("session should save");
    let session_b =
        save_session(store.as_ref(), ssh_draft("开发机 B")).expect("session should save");
    let service = CommandHistoryService::new(Arc::clone(&store));
    service.register_runtime(
        "runtime-a",
        Some(session_a.id.clone()),
        Some(HistoryScopeKind::SavedSession),
        Some(session_a.id.clone()),
    );
    service.register_runtime(
        "runtime-b",
        Some(session_b.id.clone()),
        Some(HistoryScopeKind::SavedSession),
        Some(session_b.id.clone()),
    );

    service
        .capture_input("runtime-a", "pwd\r")
        .expect("save pwd");
    service
        .capture_input("runtime-a", "whoami\r")
        .expect("save whoami");
    service
        .capture_input("runtime-b", "whoami\r")
        .expect("save session b");

    let filtered = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: Some("who".to_string()),
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_a.id.clone()),
            limit: Some(5000),
            deduplicate: None,
        },
    )
    .expect("history should search");

    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].command, "whoami");

    let cleared = clear_command_history(
        store.as_ref(),
        Some(HistoryScopeKind::SavedSession),
        Some(session_a.id.as_str()),
    )
    .expect("session history should clear");
    assert!(cleared.cleared);

    let remaining = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_b.id.clone()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("remaining history should search");

    assert_eq!(remaining.len(), 1);
    assert_eq!(
        remaining[0].scope_kind,
        Some(HistoryScopeKind::SavedSession)
    );
    assert_eq!(
        remaining[0].scope_id.as_deref(),
        Some(session_b.id.as_str())
    );
}

#[test]
fn command_history_deletes_only_selected_entries_in_the_active_scope() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session_a =
        save_session(store.as_ref(), ssh_draft("开发机 A")).expect("session should save");
    let session_b =
        save_session(store.as_ref(), ssh_draft("开发机 B")).expect("session should save");
    let first = insert_command_history(
        store.as_ref(),
        CommandHistoryDraft {
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_a.id.clone()),
            runtime_session_id: "runtime-a".to_string(),
            command: "pwd".to_string(),
            cwd: None,
            exit_code: None,
            started_at_ms: 1,
            finished_at_ms: None,
        },
    )
    .expect("first history should save");
    let second = insert_command_history(
        store.as_ref(),
        CommandHistoryDraft {
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_a.id.clone()),
            runtime_session_id: "runtime-a".to_string(),
            command: "whoami".to_string(),
            cwd: None,
            exit_code: None,
            started_at_ms: 2,
            finished_at_ms: None,
        },
    )
    .expect("second history should save");
    let other_scope = insert_command_history(
        store.as_ref(),
        CommandHistoryDraft {
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_b.id.clone()),
            runtime_session_id: "runtime-b".to_string(),
            command: "hostname".to_string(),
            cwd: None,
            exit_code: None,
            started_at_ms: 3,
            finished_at_ms: None,
        },
    )
    .expect("other scope history should save");

    let result = delete_command_history_entries(
        store.as_ref(),
        Some(HistoryScopeKind::SavedSession),
        Some(session_a.id.as_str()),
        &[first.id, other_scope.id],
    )
    .expect("selected entries should delete");
    assert_eq!(result.deleted_count, 1);

    let remaining = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_a.id),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("remaining history should search");
    assert_eq!(
        remaining
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec![second.id.as_str()]
    );
}

#[test]
fn command_history_defaults_to_recent_1000_and_prunes_per_session() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session = save_session(store.as_ref(), ssh_draft("开发机")).expect("session should save");

    for index in 0..1002 {
        insert_command_history(
            store.as_ref(),
            CommandHistoryDraft {
                scope_kind: Some(HistoryScopeKind::SavedSession),
                scope_id: Some(session.id.clone()),
                runtime_session_id: format!("runtime-{index:04}"),
                command: format!("cmd-{index:04}"),
                cwd: None,
                exit_code: None,
                started_at_ms: index,
                finished_at_ms: None,
            },
        )
        .expect("command should save");
    }

    let entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session.id.clone()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("history should search");

    assert_eq!(entries.len(), 1000);
    assert_eq!(
        entries.first().map(|entry| entry.command.as_str()),
        Some("cmd-1001")
    );
    assert_eq!(
        entries.last().map(|entry| entry.command.as_str()),
        Some("cmd-0002")
    );
    assert!(!entries.iter().any(|entry| entry.command == "cmd-0000"));
    assert!(!entries.iter().any(|entry| entry.command == "cmd-0001"));
}

#[test]
fn command_history_deduplicates_by_most_recent_trimmed_command() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session = save_session(store.as_ref(), ssh_draft("开发机")).expect("session should save");

    for (command, started_at_ms) in [("whoami", 10), ("pwd", 20), ("  whoami  ", 30)] {
        insert_command_history(
            store.as_ref(),
            CommandHistoryDraft {
                scope_kind: Some(HistoryScopeKind::SavedSession),
                scope_id: Some(session.id.clone()),
                runtime_session_id: format!("runtime-{started_at_ms}"),
                command: command.to_string(),
                cwd: None,
                exit_code: None,
                started_at_ms,
                finished_at_ms: None,
            },
        )
        .expect("history should insert");
    }

    let entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session.id.clone()),
            limit: None,
            deduplicate: Some(true),
        },
    )
    .expect("deduplicated history should search");

    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].command, "whoami");
    assert_eq!(entries[0].started_at_ms, 30);
    assert_eq!(entries[1].command, "pwd");
}

#[test]
fn command_history_search_and_clear_scope_to_local_profile() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    for (profile_id, runtime_session_id, command, started_at_ms) in [
        ("pwsh", "runtime-a", "pwd", 10),
        ("pwsh", "runtime-b", "whoami", 20),
        ("git-bash", "runtime-c", "hostname", 30),
    ] {
        insert_command_history(
            store.as_ref(),
            CommandHistoryDraft {
                scope_kind: Some(HistoryScopeKind::LocalProfile),
                scope_id: Some(profile_id.to_string()),
                runtime_session_id: runtime_session_id.to_string(),
                command: command.to_string(),
                cwd: None,
                exit_code: None,
                started_at_ms,
                finished_at_ms: None,
            },
        )
        .expect("history should insert");
    }

    let runtime_entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::LocalProfile),
            scope_id: Some("pwsh".to_string()),
            limit: None,
            deduplicate: Some(true),
        },
    )
    .expect("runtime history should search");

    assert_eq!(
        runtime_entries
            .iter()
            .map(|entry| entry.command.as_str())
            .collect::<Vec<_>>(),
        vec!["whoami", "pwd"]
    );

    let cleared = clear_command_history(
        store.as_ref(),
        Some(HistoryScopeKind::LocalProfile),
        Some("pwsh"),
    )
    .expect("local profile history should clear");
    assert!(cleared.cleared);

    let remaining = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::LocalProfile),
            scope_id: Some("git-bash".to_string()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("remaining history should search");

    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].runtime_session_id, "runtime-c");
}

#[test]
fn command_history_search_for_saved_session_uses_connection_scope_only() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session_a =
        save_session(store.as_ref(), ssh_draft("开发机 A")).expect("session should save");
    let session_b =
        save_session(store.as_ref(), ssh_draft("开发机 B")).expect("session should save");

    for (scope_kind, scope_id, runtime_session_id, command, started_at_ms) in [
        (
            HistoryScopeKind::SavedSession,
            session_a.id.clone(),
            "runtime-old-a".to_string(),
            "uptime".to_string(),
            10,
        ),
        (
            HistoryScopeKind::SavedSession,
            session_a.id.clone(),
            "runtime-current".to_string(),
            "df -h".to_string(),
            30,
        ),
        (
            HistoryScopeKind::SavedSession,
            session_b.id.clone(),
            "runtime-b".to_string(),
            "hostname".to_string(),
            20,
        ),
        (
            HistoryScopeKind::LocalProfile,
            "pwsh".to_string(),
            "runtime-local".to_string(),
            "whoami".to_string(),
            40,
        ),
    ] {
        insert_command_history(
            store.as_ref(),
            CommandHistoryDraft {
                scope_kind: Some(scope_kind),
                scope_id: Some(scope_id),
                runtime_session_id,
                command,
                cwd: None,
                exit_code: None,
                started_at_ms,
                finished_at_ms: None,
            },
        )
        .expect("history should insert");
    }

    let entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_a.id.clone()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("history should search");

    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.command.as_str())
            .collect::<Vec<_>>(),
        vec!["df -h", "uptime"]
    );

    let cleared = clear_command_history(
        store.as_ref(),
        Some(HistoryScopeKind::SavedSession),
        Some(session_a.id.as_str()),
    )
    .expect("active tab history should clear");
    assert!(cleared.cleared);

    let remaining = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session_b.id.clone()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("remaining history should search");

    assert_eq!(
        remaining
            .iter()
            .map(|entry| entry.command.as_str())
            .collect::<Vec<_>>(),
        vec!["hostname"]
    );

    let local_entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::LocalProfile),
            scope_id: Some("pwsh".to_string()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("local profile history should remain");
    assert_eq!(
        local_entries
            .iter()
            .map(|entry| entry.command.as_str())
            .collect::<Vec<_>>(),
        vec!["whoami"]
    );
}

#[test]
fn command_history_ignores_terminal_control_responses() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session = save_session(store.as_ref(), ssh_draft("开发机")).expect("session should save");
    let service = CommandHistoryService::new(Arc::clone(&store));

    service.register_runtime(
        "runtime-1",
        Some(session.id.clone()),
        Some(HistoryScopeKind::SavedSession),
        Some(session.id.clone()),
    );
    service
        .capture_input("runtime-1", "\u{1b}[1;1R\u{1b}[I\u{1b}[O\r")
        .expect("pure control input should be ignored");
    service
        .capture_input("runtime-1", "\u{1b}[1;1R\u{1b}[Ill\u{1b}[O\r")
        .expect("command mixed with control input should save only command text");

    let entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::SavedSession),
            scope_id: Some(session.id),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("history should search");

    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.command.as_str())
            .collect::<Vec<_>>(),
        vec!["ll"]
    );
}

#[test]
fn command_history_skips_runtime_without_history_scope() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let service = CommandHistoryService::new(Arc::clone(&store));

    service.register_runtime("runtime-legacy", None, None, None);
    service
        .capture_input("runtime-legacy", "pwd\r")
        .expect("missing history scope should not break terminal input");

    let entries = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::LocalProfile),
            scope_id: Some("pwsh".to_string()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("history should search");

    assert!(entries.is_empty());

    let search_error = search_command_history(
        store.as_ref(),
        HistorySearchOptions {
            query: None,
            scope_kind: None,
            scope_id: None,
            limit: None,
            deduplicate: None,
        },
    )
    .expect_err("history search without scope should fail");
    assert!(matches!(search_error, AppError::Validation(_)));

    let clear_error = clear_command_history(store.as_ref(), None, None)
        .expect_err("history clear without scope should fail");
    assert!(matches!(clear_error, AppError::Validation(_)));
}

#[test]
fn session_command_groups_round_trip_and_stay_scoped_to_saved_session() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let session_a =
        save_session(store.as_ref(), ssh_draft("开发机 A")).expect("session should save");
    let session_b =
        save_session(store.as_ref(), ssh_draft("开发机 B")).expect("session should save");

    let saved = save_session_command_group(
        store.as_ref(),
        SessionCommandGroupDraft {
            id: None,
            saved_session_id: Some(session_a.id.clone()),
            scope_kind: HistoryScopeKind::SavedSession,
            scope_id: session_a.id.clone(),
            name: "巡检".to_string(),
            commands: vec![
                " uptime ".to_string(),
                "".to_string(),
                "df -h".to_string(),
                "   ".to_string(),
            ],
        },
    )
    .expect("command group should save");

    assert_eq!(saved.name, "巡检");
    assert_eq!(
        saved
            .items
            .iter()
            .map(|item| item.command.as_str())
            .collect::<Vec<_>>(),
        vec!["uptime", "df -h"]
    );

    let session_a_groups = list_session_command_groups(
        store.as_ref(),
        HistoryScopeKind::SavedSession,
        &session_a.id,
    )
    .expect("groups should list");
    let session_b_groups = list_session_command_groups(
        store.as_ref(),
        HistoryScopeKind::SavedSession,
        &session_b.id,
    )
    .expect("groups should list");
    assert_eq!(session_a_groups.len(), 1);
    assert_eq!(session_b_groups.len(), 0);

    let updated = save_session_command_group(
        store.as_ref(),
        SessionCommandGroupDraft {
            id: Some(saved.id.clone()),
            saved_session_id: Some(session_a.id.clone()),
            scope_kind: HistoryScopeKind::SavedSession,
            scope_id: session_a.id.clone(),
            name: "快速巡检".to_string(),
            commands: vec!["whoami".to_string()],
        },
    )
    .expect("command group should update");

    assert_eq!(updated.id, saved.id);
    assert_eq!(updated.name, "快速巡检");
    assert_eq!(updated.items.len(), 1);
    assert_eq!(updated.items[0].command, "whoami");

    let deleted = delete_session_command_group(store.as_ref(), &updated.id)
        .expect("command group should delete");
    assert!(deleted.deleted);
    assert!(list_session_command_groups(
        store.as_ref(),
        HistoryScopeKind::SavedSession,
        &session_a.id,
    )
    .expect("groups should list")
    .is_empty());
}
