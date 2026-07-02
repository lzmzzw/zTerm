// Author: Liz
use tauri::State;

use crate::{
    error::AppResult, services::external_launch_service::ExternalSshLaunchEvent, state::AppState,
};

#[tauri::command]
pub fn external_launch_take_pending(
    state: State<'_, AppState>,
) -> AppResult<Vec<ExternalSshLaunchEvent>> {
    state.external_launch_service().take_pending_launches()
}
