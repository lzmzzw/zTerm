// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::{
        session::DeleteResult,
        workspace::{WorkspaceDefinition, WorkspaceDefinitionDraft, WorkspaceSummary},
    },
    state::AppState,
    storage::workspace::{
        close_workspace, get_workspace, list_workspaces, remove_workspace,
        save_default_workspace_snapshot, save_workspace,
    },
};

#[tauri::command]
pub fn workspace_list(state: State<'_, AppState>) -> AppResult<Vec<WorkspaceSummary>> {
    list_workspaces(state.storage().as_ref())
}

#[tauri::command]
pub fn workspace_get(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<WorkspaceDefinition> {
    get_workspace(state.storage().as_ref(), &workspace_id)
}

#[tauri::command]
pub fn workspace_save(
    state: State<'_, AppState>,
    draft: WorkspaceDefinitionDraft,
) -> AppResult<WorkspaceDefinition> {
    save_workspace(state.storage().as_ref(), draft)
}

#[tauri::command]
pub fn workspace_save_default_snapshot(
    state: State<'_, AppState>,
    draft: WorkspaceDefinitionDraft,
) -> AppResult<WorkspaceDefinition> {
    save_default_workspace_snapshot(state.storage().as_ref(), draft)
}

#[tauri::command]
pub fn workspace_delete(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<DeleteResult> {
    close_workspace(state.storage().as_ref(), &workspace_id)
}

#[tauri::command]
pub fn workspace_remove(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<DeleteResult> {
    remove_workspace(state.storage().as_ref(), &workspace_id)
}
