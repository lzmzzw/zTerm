// Author: Liz
use rusqlite::Connection;

use crate::error::AppResult;

pub fn run_migrations(connection: &mut Connection) -> AppResult<()> {
    connection.execute_batch("pragma foreign_keys = on;")?;

    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "
        create table if not exists app_settings (
            id integer primary key check (id = 1),
            settings_json text not null,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists terminal_profiles (
            id text primary key,
            name text not null check (length(trim(name)) > 0),
            path text not null check (length(trim(path)) > 0),
            args_json text not null default '[]',
            detected integer not null default 0 check (detected in (0, 1)),
            is_default integer not null default 0 check (is_default in (0, 1)),
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists session_groups (
            id text primary key,
            parent_id text null references session_groups(id) on delete restrict,
            name text not null check (length(trim(name)) > 0),
            expanded integer not null default 1 check (expanded in (0, 1)),
            sort_order integer not null default 0,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists saved_sessions (
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

        create table if not exists workspaces (
            id text primary key,
            name text not null check (length(trim(name)) > 0),
            active_tab_id text not null,
            status text not null default 'closed' check (status in ('running', 'closed')),
            sort_order integer not null default 0,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        insert or ignore into workspaces (
            id, name, active_tab_id, status, sort_order, created_at_ms, updated_at_ms
        ) values (
            'default-workspace', '默认工作区', 'tab-1', 'closed', 0, 0, 0
        );

        create table if not exists workspace_tabs (
            id text not null,
            workspace_id text not null references workspaces(id) on delete cascade,
            title text not null check (length(trim(title)) > 0),
            active_pane_id text not null,
            root_json text not null,
            sort_order integer not null default 0,
            created_at_ms integer not null,
            updated_at_ms integer not null,
            primary key (workspace_id, id)
        );

        create table if not exists command_history (
            id text primary key,
            scope_kind text null check (scope_kind in ('saved_session', 'local_profile')),
            scope_id text null,
            runtime_session_id text not null,
            command text not null check (length(trim(command)) > 0),
            cwd text null,
            exit_code integer null,
            started_at_ms integer not null,
            finished_at_ms integer null
        );

        create table if not exists transfer_tasks (
            id text primary key,
            saved_session_id text not null references saved_sessions(id) on delete cascade,
            direction text not null check (direction in ('upload', 'download')),
            local_path text not null,
            remote_path text not null,
            kind text null check (kind in ('file', 'directory')),
            conflict_policy text not null default 'overwrite' check (conflict_policy in ('overwrite', 'skip', 'rename')),
            total_bytes integer not null default 0 check (total_bytes >= 0),
            transferred_bytes integer not null default 0 check (transferred_bytes >= 0),
            status text not null check (status in ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
            error_message text null,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists credential_records (
            id text primary key,
            name text not null check (length(trim(name)) > 0),
            kind text not null check (kind in ('ssh_password', 'ssh_key_passphrase', 'rdp_password', 'ai_api_key')),
            credential_ref text not null unique check (length(trim(credential_ref)) > 0),
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists ai_provider_profiles (
            id text primary key,
            name text not null check (length(trim(name)) > 0),
            kind text not null default 'openai_chat' check (kind in ('openai_chat', 'openai_responses', 'anthropic')),
            base_url text not null check (length(trim(base_url)) > 0),
            model text not null check (length(trim(model)) > 0),
            api_key_ref text not null default '',
            enabled integer not null default 1 check (enabled in (0, 1)),
            is_default integer not null default 0 check (is_default in (0, 1)),
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists ai_conversations (
            id text primary key,
            title text not null check (length(trim(title)) > 0),
            scope_kind text not null check (length(trim(scope_kind)) > 0),
            scope_ref_json text not null default '{}',
            approval_mode text not null default 'safe' check (approval_mode in ('request_approval', 'safe', 'full_access')),
            status text not null default 'idle' check (status in ('idle', 'running', 'archived')),
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists ai_conversation_messages (
            id text primary key,
            conversation_id text not null references ai_conversations(id) on delete cascade,
            role text not null check (role in ('user', 'assistant', 'system', 'tool')),
            content text not null,
            status text not null default 'complete' check (status in ('draft', 'streaming', 'complete', 'error')),
            metadata_json text null,
            created_at_ms integer not null
        );

        create table if not exists ai_tool_pending (
            id text primary key,
            tool_id text not null check (length(trim(tool_id)) > 0),
            tool_title text not null check (length(trim(tool_title)) > 0),
            risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
            arguments_summary text not null,
            arguments_json text not null,
            target_summary text null,
            risk_summary text null,
            requires_confirmation integer not null check (requires_confirmation in (0, 1)),
            status text not null check (status in ('pending', 'rejected', 'succeeded', 'failed')),
            reason text null,
            requested_by text null,
            conversation_id text null,
            run_id text null,
            step_id text null,
            created_at_ms integer not null
        );

        create table if not exists ai_tool_audits (
            id text primary key,
            invocation_id text not null,
            tool_id text not null,
            tool_title text not null,
            risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
            arguments_summary text not null,
            risk_summary text null,
            status text not null check (status in ('pending', 'rejected', 'succeeded', 'failed')),
            result_summary text null,
            error text null,
            audit_context_json text null,
            created_at_ms integer not null,
            completed_at_ms integer not null
        );

        create table if not exists session_command_groups (
            id text primary key,
            saved_session_id text null references saved_sessions(id) on delete cascade,
            scope_kind text not null check (scope_kind in ('saved_session', 'local_profile')),
            scope_id text not null check (length(trim(scope_id)) > 0),
            name text not null check (length(trim(name)) > 0),
            sort_order integer not null default 0,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create table if not exists session_command_group_items (
            id text primary key,
            group_id text not null references session_command_groups(id) on delete cascade,
            command text not null check (length(trim(command)) > 0),
            sort_order integer not null default 0,
            created_at_ms integer not null,
            updated_at_ms integer not null
        );

        create index if not exists idx_session_groups_parent_sort on session_groups(parent_id, sort_order);
        create index if not exists idx_terminal_profiles_default on terminal_profiles(is_default desc, name);
        create index if not exists idx_saved_sessions_group_sort on saved_sessions(group_id, sort_order);
        create index if not exists idx_saved_sessions_type on saved_sessions(type);
        create index if not exists idx_workspaces_sort on workspaces(sort_order, updated_at_ms desc);
        create index if not exists idx_workspace_tabs_sort on workspace_tabs(sort_order);
        create index if not exists idx_workspace_tabs_workspace_sort on workspace_tabs(workspace_id, sort_order);
        create index if not exists idx_command_history_runtime_time on command_history(runtime_session_id, started_at_ms desc);
        create index if not exists idx_command_history_scope_time on command_history(scope_kind, scope_id, started_at_ms desc);
        create index if not exists idx_transfer_tasks_session_status on transfer_tasks(saved_session_id, status);
        create index if not exists idx_credential_records_kind_name on credential_records(kind, name);
        create index if not exists idx_ai_conversations_updated on ai_conversations(updated_at_ms desc);
        create index if not exists idx_ai_conversation_messages_conversation on ai_conversation_messages(conversation_id, created_at_ms);
        create index if not exists idx_ai_tool_pending_created on ai_tool_pending(created_at_ms desc);
        create index if not exists idx_ai_tool_audits_completed on ai_tool_audits(completed_at_ms desc);
        create index if not exists idx_session_command_groups_session_sort on session_command_groups(saved_session_id, sort_order, updated_at_ms desc);
        create index if not exists idx_session_command_groups_scope_sort on session_command_groups(scope_kind, scope_id, sort_order, updated_at_ms desc);
        create index if not exists idx_session_command_group_items_group_sort on session_command_group_items(group_id, sort_order);
        ",
    )?;
    ensure_transfer_task_strategy_columns(&transaction)?;
    reset_workspace_runtime_status(&transaction)?;
    drop_legacy_agent_runs(&transaction)?;
    drop_source_reuse_records(&transaction)?;
    transaction.commit()?;
    Ok(())
}

fn ensure_transfer_task_strategy_columns(transaction: &rusqlite::Transaction<'_>) -> AppResult<()> {
    if !sqlite_column_exists(transaction, "transfer_tasks", "kind")? {
        transaction.execute("alter table transfer_tasks add column kind text null", [])?;
    }
    if !sqlite_column_exists(transaction, "transfer_tasks", "conflict_policy")? {
        transaction.execute(
            "alter table transfer_tasks add column conflict_policy text not null default 'overwrite'",
            [],
        )?;
    }
    transaction.execute(
        "update transfer_tasks set conflict_policy = 'overwrite' where conflict_policy is null or trim(conflict_policy) = ''",
        [],
    )?;
    Ok(())
}

fn sqlite_column_exists(
    transaction: &rusqlite::Transaction<'_>,
    table_name: &str,
    column_name: &str,
) -> AppResult<bool> {
    let mut statement = transaction.prepare(&format!("pragma table_info({table_name})"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column_name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn reset_workspace_runtime_status(transaction: &rusqlite::Transaction<'_>) -> AppResult<()> {
    transaction.execute(
        "update workspaces set status = 'closed' where status = 'running'",
        [],
    )?;
    Ok(())
}

fn drop_legacy_agent_runs(transaction: &rusqlite::Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(
        "
        drop index if exists idx_agent_runs_runtime_time;
        drop table if exists agent_runs;
        ",
    )?;
    Ok(())
}

fn drop_source_reuse_records(transaction: &rusqlite::Transaction<'_>) -> AppResult<()> {
    transaction.execute_batch(
        "
        drop index if exists idx_source_reuse_target_path;
        drop table if exists source_reuse_records;
        ",
    )?;
    Ok(())
}
