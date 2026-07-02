// Author: Liz
use tauri::State;

use crate::{
    error::AppResult, models::session::SshOptions,
    services::external_launch_service::ExternalSshLaunchEvent, state::AppState,
};

#[tauri::command]
pub fn external_launch_take_pending(
    state: State<'_, AppState>,
) -> AppResult<Vec<ExternalSshLaunchEvent>> {
    state.external_launch_service().take_pending_launches()
}

#[tauri::command]
pub fn external_launch_get_ssh_options(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<SshOptions> {
    state.external_launch_service().get_ssh_options(&session_id)
}

#[tauri::command]
pub fn external_launch_update_ssh_options(
    state: State<'_, AppState>,
    session_id: String,
    ssh_options: SshOptions,
) -> AppResult<SshOptions> {
    state
        .external_launch_service()
        .update_ssh_options(&session_id, ssh_options)
}
