// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::history::{
        ClearCommandHistoryResult, CommandGroupDeleted, CommandHistoryEntry,
        DeleteCommandHistoryEntriesResult, HistoryScopeKind, HistorySearchOptions,
        SessionCommandGroup, SessionCommandGroupDraft,
    },
    state::AppState,
    storage::history::{
        clear_command_history, delete_command_history_entries, delete_session_command_group,
        list_session_command_groups, save_session_command_group, search_command_history,
    },
};

#[tauri::command]
pub fn history_search(
    state: State<'_, AppState>,
    query: Option<String>,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<String>,
    limit: Option<usize>,
    deduplicate: Option<bool>,
) -> AppResult<Vec<CommandHistoryEntry>> {
    search_command_history(
        state.storage().as_ref(),
        HistorySearchOptions {
            query,
            scope_kind,
            scope_id,
            limit,
            deduplicate,
        },
    )
}

#[tauri::command]
pub fn history_clear(
    state: State<'_, AppState>,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<String>,
) -> AppResult<ClearCommandHistoryResult> {
    clear_command_history(state.storage().as_ref(), scope_kind, scope_id.as_deref())
}

#[tauri::command]
pub fn history_delete_entries(
    state: State<'_, AppState>,
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<String>,
    entry_ids: Vec<String>,
) -> AppResult<DeleteCommandHistoryEntriesResult> {
    delete_command_history_entries(
        state.storage().as_ref(),
        scope_kind,
        scope_id.as_deref(),
        &entry_ids,
    )
}

#[tauri::command]
pub fn history_command_group_list(
    state: State<'_, AppState>,
    scope_kind: HistoryScopeKind,
    scope_id: String,
) -> AppResult<Vec<SessionCommandGroup>> {
    list_session_command_groups(state.storage().as_ref(), scope_kind, &scope_id)
}

#[tauri::command]
pub fn history_command_group_save(
    state: State<'_, AppState>,
    draft: SessionCommandGroupDraft,
) -> AppResult<SessionCommandGroup> {
    save_session_command_group(state.storage().as_ref(), draft)
}

#[tauri::command]
pub fn history_command_group_delete(
    state: State<'_, AppState>,
    group_id: String,
) -> AppResult<CommandGroupDeleted> {
    delete_session_command_group(state.storage().as_ref(), &group_id)
}
