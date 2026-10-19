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
        "terminal_layout",
        "file_transfer_view_state",
        "terminal_profiles",
        "session_groups",
        "saved_sessions",
        "command_history",
        "transfer_tasks",
        "credential_records",
        "ai_connection_approval_policies",
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
                'terminal_layout',
                'file_transfer_view_state',
                'terminal_profiles',
                'session_groups',
                'saved_sessions',
                'command_history',
                'transfer_tasks',
                'credential_records',
                'ai_connection_approval_policies',
                'ai_tool_pending',
                'ai_tool_audits',
                'session_command_groups',
                'session_command_group_items'
            )",
            [],
            |row| row.get(0),
        )
        .expect("table count query should run");

    assert_eq!(table_count, 14);
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
fn migrations_add_history_scope_columns() {
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
}

#[test]
fn transfer_tasks_schema_adds_strategy_and_endpoint_columns() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");

    run_migrations(&mut connection).expect("migrations should run on an empty database");

    assert!(column_exists(&connection, "transfer_tasks", "kind"));
    assert!(column_exists(
        &connection,
        "transfer_tasks",
        "conflict_policy"
    ));
    for column in [
        "task_origin",
        "source_kind",
        "source_session_id",
        "source_path",
        "destination_kind",
        "destination_session_id",
        "destination_path",
        "group_id",
        "group_name",
    ] {
        assert!(
            column_exists(&connection, "transfer_tasks", column),
            "expected transfer_tasks.{column} to exist",
        );
    }
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

    type MigratedTransferEndpoints = (
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        String,
    );
    let row: MigratedTransferEndpoints = connection
        .query_row(
            "
            select kind, conflict_policy, task_origin,
                   source_kind, source_session_id, source_path,
                   destination_kind, destination_session_id, destination_path
            from transfer_tasks
            where id = 'transfer-1'
            ",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .expect("upgraded transfer task should read");
    assert_eq!(
        row,
        (
            None,
            "overwrite".to_string(),
            "sftp_panel".to_string(),
            "ssh".to_string(),
            Some("ssh-1".to_string()),
            "/tmp/a.txt".to_string(),
            "local".to_string(),
            None,
            "C:/tmp/a.txt".to_string(),
        )
    );
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
fn migrations_drop_legacy_agent_runs_without_model_tables() {
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
    assert!(!table_exists(&connection, "ai_provider_profiles"));
    assert!(!table_exists(&connection, "ai_conversations"));
    assert!(!table_exists(&connection, "ai_conversation_messages"));
    assert!(table_exists(&connection, "ai_tool_pending"));
    assert!(table_exists(&connection, "ai_tool_audits"));
}

#[test]
fn migrations_purge_legacy_model_data_and_fields() {
    let mut connection = Connection::open_in_memory().expect("in-memory sqlite should open");
    connection
        .execute_batch(
            "
            create table ai_provider_profiles (id text primary key, name text not null);
            insert into ai_provider_profiles values ('provider-1', 'legacy');
            create table ai_conversations (id text primary key, title text not null);
            insert into ai_conversations values ('conversation-1', 'legacy');
            create table ai_conversation_messages (
                id text primary key,
                conversation_id text not null,
                content text not null
            );
            insert into ai_conversation_messages values ('message-1', 'conversation-1', 'legacy');

            create table credential_records (
                id text primary key,
                name text not null,
                kind text not null check (kind in ('ssh_password', 'ssh_key_passphrase', 'rdp_password', 'ai_api_key')),
                credential_ref text not null unique,
                created_at_ms integer not null,
                updated_at_ms integer not null
            );
            insert into credential_records values ('ai-key', 'legacy', 'ai_api_key', 'keyring:legacy', 1, 1);
            insert into credential_records values ('ssh-key', 'ssh', 'ssh_password', 'keyring:ssh', 1, 1);

            create table ai_tool_pending (
                id text primary key,
                tool_id text not null,
                tool_title text not null,
                risk_level text not null,
                arguments_summary text not null,
                arguments_json text not null,
                target_summary text null,
                risk_summary text null,
                requires_confirmation integer not null,
                requires_secret_input integer not null default 0,
                secret_input_label text null,
                status text not null,
                reason text null,
                requested_by text null,
                conversation_id text null,
                run_id text null,
                step_id text null,
                created_at_ms integer not null
            );
            insert into ai_tool_pending values (
                'chat-pending', 'terminal.read', 'Read', 'low', '{}', '{}', null, null,
                0, 0, null, 'pending', null, null, 'conversation-1', null, null, 1
            );
            insert into ai_tool_pending values (
                'mcp-pending', 'terminal.write', 'Write', 'high', '{}', '{}', null, null,
                1, 0, null, 'pending', null, null, null, null, null, 2
            );
            ",
        )
        .expect("legacy model schema should prepare");

    run_migrations(&mut connection).expect("legacy model data should be purged");

    assert!(!table_exists(&connection, "ai_provider_profiles"));
    assert!(!table_exists(&connection, "ai_conversations"));
    assert!(!table_exists(&connection, "ai_conversation_messages"));
    assert!(!column_exists(
        &connection,
        "ai_tool_pending",
        "conversation_id"
    ));
    let credentials: i64 = connection
        .query_row("select count(*) from credential_records", [], |row| {
            row.get(0)
        })
        .expect("credential count should read");
    let pending: i64 = connection
        .query_row("select count(*) from ai_tool_pending", [], |row| row.get(0))
        .expect("pending count should read");
    assert_eq!(credentials, 1);
    assert_eq!(pending, 1);
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

#[test]
fn saved_sessions_accept_ftp_and_sftp_types_after_migration() {
    let mut connection = rusqlite::Connection::open_in_memory().expect("database should open");
    run_migrations(&mut connection).expect("migrations should run on an empty database");

    for (id, session_type, port) in [("ftp-1", "ftp", 21), ("sftp-1", "sftp", 22)] {
        connection
            .execute(
                "insert into saved_sessions (
                    id, name, type, host, port, username, auth_mode, tags_json,
                    sort_order, created_at_ms, updated_at_ms
                 ) values (?1, ?2, ?3, 'files.example.test', ?4, 'ops', 'password', '[]', 0, 1, 1)",
                rusqlite::params![id, session_type.to_uppercase(), session_type, port],
            )
            .expect("FTP/SFTP session type should satisfy the schema constraint");
    }

    let count: i64 = connection
        .query_row(
            "select count(*) from saved_sessions where type in ('ftp', 'sftp')",
            [],
            |row| row.get(0),
        )
        .expect("new session types should be queryable");
    assert_eq!(count, 2);
}

#[test]
fn migrations_upgrade_existing_saved_sessions_without_losing_data() {
    let mut connection = rusqlite::Connection::open_in_memory().expect("database should open");
    connection.execute_batch(
        "
        create table session_groups (
            id text primary key,
            parent_id text null,
            name text not null,
            expanded integer not null,
            sort_order integer not null,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );
        insert into session_groups values ('group-1', null, 'Existing', 1, 0, 1, 1);
        create table saved_sessions (
            id text primary key,
            name text not null check (length(trim(name)) > 0),
            type text not null check (type in ('ssh', 'local', 'rdp')),
            group_id text null references session_groups(id) on delete set null,
            host text not null check (length(trim(host)) > 0),
            port integer not null check (port between 1 and 65535),
            username text not null,
            auth_mode text not null check (auth_mode in ('password', 'key', 'agent', 'none')),
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
            id, name, type, group_id, host, port, username, auth_mode,
            tags_json, sort_order, created_at_ms, updated_at_ms
        ) values ('ssh-existing', 'Existing SSH', 'ssh', 'group-1', 'host.test', 22, 'ops', 'none', '[]', 0, 1, 1);
        create table saved_session_refs (
            id text primary key,
            saved_session_id text not null references saved_sessions(id) on delete cascade
        );
        insert into saved_session_refs values ('ref-1', 'ssh-existing');
        ",
    ).expect("legacy schema should be created");

    run_migrations(&mut connection).expect("legacy saved sessions should migrate");

    let existing: (String, String, Option<String>) = connection
        .query_row(
            "select type, host, group_id from saved_sessions where id = 'ssh-existing'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("existing session should remain");
    assert_eq!(
        existing,
        (
            "ssh".to_string(),
            "host.test".to_string(),
            Some("group-1".to_string())
        )
    );
    let container_enabled: i64 = connection
        .query_row(
            "select json_extract(ssh_options_json, '$.container.enabled')
             from saved_sessions where id = 'ssh-existing'",
            [],
            |row| row.get(0),
        )
        .expect("existing SSH container option should migrate");
    assert_eq!(container_enabled, 1);

    connection
        .execute(
            "update saved_sessions
             set ssh_options_json = json_set(ssh_options_json, '$.container.enabled', json('false'))
             where id = 'ssh-existing'",
            [],
        )
        .expect("container option should be disabled explicitly");
    run_migrations(&mut connection).expect("completed migration should be idempotent");
    let container_enabled_after_opt_out: i64 = connection
        .query_row(
            "select json_extract(ssh_options_json, '$.container.enabled')
             from saved_sessions where id = 'ssh-existing'",
            [],
            |row| row.get(0),
        )
        .expect("explicit container opt-out should remain");
    assert_eq!(container_enabled_after_opt_out, 0);
    assert!(column_exists(
        &connection,
        "saved_sessions",
        "ftp_options_json"
    ));
    let referenced_session: String = connection
        .query_row(
            "select saved_session_id from saved_session_refs where id = 'ref-1'",
            [],
            |row| row.get(0),
        )
        .expect("dependent foreign-key row should remain");
    assert_eq!(referenced_session, "ssh-existing");
    let foreign_key_errors: i64 = connection
        .query_row("select count(*) from pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .expect("foreign key check should run");
    assert_eq!(foreign_key_errors, 0);
    connection.execute(
        "insert into saved_sessions (
            id, name, type, host, port, username, auth_mode, tags_json,
            sort_order, created_at_ms, updated_at_ms, ftp_options_json
         ) values ('ftp-new', 'FTP', 'ftp', 'ftp.test', 21, 'ops', 'password', '[]', 0, 2, 2, '{}')",
        [],
    ).expect("migrated schema should accept FTP sessions");
}

#[test]
fn migrations_remove_workspace_data_and_preserve_unrelated_data() {
    let mut connection = Connection::open_in_memory().unwrap();
    run_migrations(&mut connection).unwrap();
    connection.execute_batch(r#"
        create table workspaces (id text primary key, name text);
        create table workspace_tabs (id text primary key,
          workspace_id text references workspaces(id), root_json text);
        insert into workspaces values ('legacy', 'Legacy');
        insert into workspace_tabs values ('tab', 'legacy', '{"panes":[]}');
        insert into app_settings values (1,
          '{"theme":"light","workspace_restore_strategy":"connect_all","shortcuts":[{"action_id":"workspace.save","accelerator":"Ctrl+S"},{"action_id":"settings.open","accelerator":"Alt+S"}]}', 1, 2);
        insert into saved_sessions (id, name, type, host, port, username, auth_mode, created_at_ms, updated_at_ms)
          values ('ssh-retained', 'SSH', 'ssh', 'server.test', 22, 'ops', 'agent', 1, 2);
        insert into command_history (id, runtime_session_id, command, started_at_ms)
          values ('history-retained', 'runtime', 'pwd', 1);
    "#).unwrap();
    for (id, tool_id) in [("legacy", "workspace.save"), ("retained", "sessions.list")] {
        connection
            .execute(
                "insert into ai_tool_pending
            (id, tool_id, tool_title, risk_level, arguments_summary, arguments_json,
             requires_confirmation, status, created_at_ms)
            values (?1, ?2, 'Tool', 'low', '{}', '{}', 0, 'pending', 1)",
                [id, tool_id],
            )
            .unwrap();
        connection.execute(r#"insert into ai_tool_audits
            (id, invocation_id, tool_id, tool_title, risk_level, arguments_summary,
             status, affected_domains_json, created_at_ms, completed_at_ms)
            values (?1, ?1, ?2, 'Tool', 'low', '{}', 'succeeded', '["sessions","workspace"]', 1, 2)"#,
            [id, tool_id]).unwrap();
    }
    connection
        .execute(
            "insert into ai_tool_audits
        (id, invocation_id, tool_id, tool_title, risk_level, arguments_summary,
         status, result_summary, created_at_ms, completed_at_ms)
        values ('context-old', 'context-old', 'zterm.context', 'Context', 'low', '{}',
          'succeeded', 'zTerm 上下文：1 个工作区', 1, 2)",
            [],
        )
        .unwrap();
    for _ in 0..2 {
        run_migrations(&mut connection).unwrap();
        assert!(!table_exists(&connection, "workspaces"));
        assert!(!table_exists(&connection, "workspace_tabs"));
        let layout_count: i64 = connection
            .query_row("select count(*) from terminal_layout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(layout_count, 0, "legacy named layouts must not be imported");
        let settings: String = connection
            .query_row(
                "select settings_json from app_settings where id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let settings: serde_json::Value = serde_json::from_str(&settings).unwrap();
        assert!(settings.get("workspace_restore_strategy").is_none());
        assert_eq!(settings["theme"], "light");
        assert_eq!(settings["shortcuts"].as_array().unwrap().len(), 1);
        assert_eq!(settings["shortcuts"][0]["action_id"], "settings.open");
        for table in ["ai_tool_pending", "ai_tool_audits"] {
            let ids: String = connection
                .query_row(
                    &format!("select group_concat(id) from {table}"),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(ids, "retained");
        }
        let domains: String = connection
            .query_row(
                "select affected_domains_json from ai_tool_audits where id = 'retained'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&domains).unwrap(),
            serde_json::json!(["sessions"])
        );
        for (table, id) in [
            ("saved_sessions", "ssh-retained"),
            ("command_history", "history-retained"),
        ] {
            let count: i64 = connection
                .query_row(
                    &format!("select count(*) from {table} where id = ?1"),
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
        }
        let errors: i64 = connection
            .query_row("select count(*) from pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(errors, 0);
    }
}
