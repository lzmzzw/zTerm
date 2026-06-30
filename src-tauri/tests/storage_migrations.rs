// Author: Liz
use rusqlite::Connection;
use zterm_lib::storage::migrations::run_migrations;

fn table_exists(connection: &Connection, table_name: &str) -> bool {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = ?1)",
            [table_name],
            |row| row.get::<_, bool>(0),
        )
        .expect("table existence query should run")
}

fn index_exists(connection: &Connection, index_name: &str) -> bool {
    connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'index' and name = ?1)",
            [index_name],
            |row| row.get::<_, bool>(0),
        )
        .expect("index existence query should run")
}

fn column_exists(connection: &Connection, table_name: &str, column_name: &str) -> bool {
    let mut statement = connection
        .prepare(&format!("pragma table_info({table_name})"))
        .expect("table info query should prepare");
    let mut rows = statement.query([]).expect("table info query should run");
    while let Some(row) = rows.next().expect("table info row should read") {
        let name: String = row.get(1).expect("column name should read");
        if name == column_name {
            return true;
        }
    }
    false
}

#[test]
fn migrations_create_all_phase_two_tables() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");

    for table_name in [
        "app_settings",
        "terminal_profiles",
        "session_groups",
        "saved_sessions",
        "workspaces",
        "workspace_tabs",
        "command_history",
        "transfer_tasks",
        "credential_records",
        "ai_provider_profiles",
        "ai_conversations",
        "ai_conversation_messages",
        "ai_tool_pending",
        "ai_tool_audits",
        "session_command_groups",
        "session_command_group_items",
    ] {
        assert!(
            table_exists(&connection, table_name),
            "expected table {table_name} to exist after migrations"
        );
    }
    assert!(!table_exists(&connection, "source_reuse_records"));
}

#[test]
fn migrations_are_idempotent() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("first migration run should succeed");
    run_migrations(&mut connection).expect("second migration run should succeed");

    let table_count: i64 = connection
        .query_row(
            "select count(*) from sqlite_master where type = 'table' and name in (
                'app_settings',
                'terminal_profiles',
                'session_groups',
                'saved_sessions',
                'workspaces',
                'workspace_tabs',
                'command_history',
                'transfer_tasks',
                'credential_records',
                'ai_provider_profiles',
                'ai_conversations',
                'ai_conversation_messages',
                'ai_tool_pending',
                'ai_tool_audits',
                'session_command_groups',
                'session_command_group_items'
            )",
            [],
            |row| row.get(0),
        )
        .expect("table count query should run");

    assert_eq!(table_count, 16);
    assert!(index_exists(&connection, "idx_workspaces_sort"));
    assert!(index_exists(
        &connection,
        "idx_workspace_tabs_workspace_sort"
    ));
    assert!(index_exists(
        &connection,
        "idx_session_command_groups_session_sort"
    ));
    assert!(index_exists(&connection, "idx_command_history_scope_time"));
    assert!(index_exists(
        &connection,
        "idx_session_command_groups_scope_sort"
    ));
    assert!(index_exists(
        &connection,
        "idx_session_command_group_items_group_sort"
    ));
}

#[test]
fn migrations_add_history_scope_columns_and_reset_workspace_status() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");

    assert!(column_exists(&connection, "command_history", "scope_kind"));
    assert!(column_exists(&connection, "command_history", "scope_id"));
    assert!(column_exists(
        &connection,
        "session_command_groups",
        "scope_kind"
    ));
    assert!(column_exists(
        &connection,
        "session_command_groups",
        "scope_id"
    ));
    let default_status: String = connection
        .query_row(
            "select status from workspaces where id = 'default-workspace'",
            [],
            |row| row.get(0),
        )
        .expect("default workspace status should read");
    assert_eq!(default_status, "closed");
}

#[test]
fn transfer_tasks_schema_adds_kind_and_conflict_policy_columns() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");

    assert!(column_exists(&connection, "transfer_tasks", "kind"));
    assert!(column_exists(
        &connection,
        "transfer_tasks",
        "conflict_policy"
    ));
}

#[test]
fn migrations_upgrade_legacy_transfer_tasks_with_default_conflict_policy() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");
    connection
        .execute_batch(
            "
            create table saved_sessions (
                id text primary key,
                name text not null,
                type text not null,
                group_id text null,
                host text not null,
                port integer not null,
                username text not null,
                auth_mode text not null,
                credential_ref text null,
                description text null,
                tags_json text not null default '[]',
                sort_order integer not null default 0,
                created_at_ms integer not null,
                updated_at_ms integer not null,
                last_used_at_ms integer null,
                ssh_options_json text null,
                rdp_options_json text null,
                local_options_json text null
            );
            insert into saved_sessions (
              id, name, type, group_id, host, port, username, auth_mode, credential_ref,
              description, tags_json, sort_order, created_at_ms, updated_at_ms,
              last_used_at_ms, ssh_options_json, rdp_options_json, local_options_json
            ) values (
              'ssh-1', 'SSH', 'ssh', null, 'example.test', 22, 'ops', 'password', 'cred',
              null, '[]', 0, 1, 1, null, null, null, null
            );
            create table transfer_tasks (
                id text primary key,
                saved_session_id text not null references saved_sessions(id) on delete cascade,
                direction text not null,
                local_path text not null,
                remote_path text not null,
                total_bytes integer not null default 0,
                transferred_bytes integer not null default 0,
                status text not null,
                error_message text null,
                created_at_ms integer not null,
                updated_at_ms integer not null
            );
            insert into transfer_tasks (
              id, saved_session_id, direction, local_path, remote_path, total_bytes,
              transferred_bytes, status, error_message, created_at_ms, updated_at_ms
            ) values (
              'transfer-1', 'ssh-1', 'download', 'C:/tmp/a.txt', '/tmp/a.txt', 0,
              4, 'failed', 'old failure', 1, 2
            );
            ",
        )
        .expect("legacy transfer schema should prepare");

    run_migrations(&mut connection).expect("migrations should upgrade legacy transfer tasks");

    let row: (Option<String>, String) = connection
        .query_row(
            "select kind, conflict_policy from transfer_tasks where id = 'transfer-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("upgraded transfer task should read");
    assert_eq!(row, (None, "overwrite".to_string()));
}

#[test]
fn command_history_schema_uses_scope_without_saved_session_column() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");

    assert!(column_exists(&connection, "command_history", "scope_kind"));
    assert!(column_exists(&connection, "command_history", "scope_id"));
    assert!(!column_exists(
        &connection,
        "command_history",
        "saved_session_id"
    ));
    assert!(index_exists(&connection, "idx_command_history_scope_time"));
    assert!(index_exists(
        &connection,
        "idx_command_history_runtime_time"
    ));
    assert!(!index_exists(
        &connection,
        "idx_command_history_session_time"
    ));
}

#[test]
fn migrations_reset_existing_running_workspaces_to_closed() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");
    connection
        .execute(
            "
            insert into workspaces (
              id, name, active_tab_id, status, sort_order, created_at_ms, updated_at_ms
            ) values (
              'running-workspace', '运行中工作区', 'tab-1', 'running', 1, 1, 2
            )
            ",
            [],
        )
        .expect("running workspace fixture should insert");

    run_migrations(&mut connection).expect("migrations should reset runtime-only state");

    let status: String = connection
        .query_row(
            "select status from workspaces where id = 'running-workspace'",
            [],
            |row| row.get(0),
        )
        .expect("workspace status should read");
    assert_eq!(status, "closed");
}

#[test]
fn migrations_drop_legacy_agent_runs_without_ai_chat_tables() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");
    connection
        .execute_batch(
            "
            create table agent_runs (
                id text primary key,
                runtime_session_id text not null,
                user_prompt text not null,
                status text not null,
                created_at_ms integer not null,
                updated_at_ms integer not null
            );
            create index idx_agent_runs_runtime_time on agent_runs(runtime_session_id, created_at_ms desc);
            ",
        )
        .expect("legacy agent_runs schema should prepare");

    run_migrations(&mut connection).expect("migrations should clean legacy agent_runs");

    assert!(!table_exists(&connection, "agent_runs"));
    assert!(!index_exists(&connection, "idx_agent_runs_runtime_time"));
    assert!(table_exists(&connection, "ai_conversations"));
    assert!(table_exists(&connection, "ai_tool_pending"));
    assert!(table_exists(&connection, "ai_tool_audits"));
}

#[test]
fn migrations_drop_source_reuse_records() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");
    connection
        .execute_batch(
            "
            create table source_reuse_records (
                id text primary key,
                source_project text not null,
                source_path text not null,
                target_path text not null,
                license text not null,
                modified integer not null default 0,
                modification_summary text null,
                created_at_ms integer not null
            );
            create unique index idx_source_reuse_target_path on source_reuse_records(target_path);
            insert into source_reuse_records (
                id, source_project, source_path, target_path, license, modified, created_at_ms
            ) values (
                'legacy-row', 'legacy', 'src/file.rs', 'src/file.rs', 'user-authorized', 0, 1
            );
            ",
        )
        .expect("legacy source reuse schema should prepare");

    run_migrations(&mut connection).expect("migrations should drop unused source reuse table");

    assert!(!table_exists(&connection, "source_reuse_records"));
    assert!(!index_exists(&connection, "idx_source_reuse_target_path"));
}

#[test]
fn workspace_tabs_belong_to_a_workspace_after_migration() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");

    let workspace_id: String = connection
        .query_row(
            "select id from workspaces order by sort_order limit 1",
            [],
            |row| row.get(0),
        )
        .expect("default workspace should exist");
    connection
        .execute(
            "
            insert into workspace_tabs (
              id, workspace_id, title, active_pane_id, root_json,
              sort_order, created_at_ms, updated_at_ms
            ) values (
              'tab-1', ?1, '主工作台', 'pane-1',
              '{\"kind\":\"leaf\",\"id\":\"pane-1\",\"title\":\"PowerShell\",\"runtime_session_id\":\"runtime-should-not-persist\",\"saved_session_id\":null}',
              0, 1, 1
            )
            ",
            [&workspace_id],
        )
        .expect("workspace tab should require and accept workspace_id");

    let tab_count: i64 = connection
        .query_row(
            "select count(*) from workspace_tabs where workspace_id = ?1",
            [&workspace_id],
            |row| row.get(0),
        )
        .expect("workspace tab count should query");

    assert_eq!(tab_count, 1);
}

#[test]
fn workspace_tabs_allow_same_tab_id_in_different_workspaces() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");
    connection
        .execute(
            "
            insert into workspaces (
              id, name, active_tab_id, status, sort_order, created_at_ms, updated_at_ms
            ) values (
              'workspace-2', '第二工作区', 'tab-1', 'running', 1, 1, 1
            )
            ",
            [],
        )
        .expect("second workspace should insert");
    for workspace_id in ["default-workspace", "workspace-2"] {
        connection
            .execute(
                "
                insert into workspace_tabs (
                  id, workspace_id, title, active_pane_id, root_json,
                  sort_order, created_at_ms, updated_at_ms
                ) values (
                  'tab-1', ?1, '主工作台', 'pane-1',
                  '{\"kind\":\"leaf\",\"id\":\"pane-1\",\"title\":\"PowerShell\",\"runtime_session_id\":null,\"saved_session_id\":null}',
                  0, 1, 1
                )
                ",
                [workspace_id],
            )
            .expect("same tab id should be allowed per workspace");
    }

    let tab_count: i64 = connection
        .query_row(
            "select count(*) from workspace_tabs where id = 'tab-1'",
            [],
            |row| row.get(0),
        )
        .expect("tab count should read");
    assert_eq!(tab_count, 2);
}

#[test]
fn saved_sessions_accept_local_type_after_migration() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");
    connection
        .execute(
            "
            insert into saved_sessions (
              id, name, type, group_id, host, port, username, auth_mode, credential_ref,
              description, tags_json, sort_order, created_at_ms, updated_at_ms,
              last_used_at_ms, ssh_options_json, rdp_options_json, local_options_json
            ) values (
              'local-1', 'Local PowerShell', 'local', null, 'localhost', 1, '', 'none', null,
              null, '[]', 0, 1, 1, null, null, null, '{\"profile_id\":\"pwsh\"}'
            )
            ",
            [],
        )
        .expect("local saved session should satisfy schema constraints");
}
