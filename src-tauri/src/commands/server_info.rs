// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::server_info::{ServerInfoRequest, ServerInfoSnapshot},
    state::AppState,
};

#[tauri::command]
pub async fn server_info_snapshot(
    state: State<'_, AppState>,
    saved_session_id: String,
) -> AppResult<ServerInfoSnapshot> {
    state
        .server_info_service()
        .snapshot(
            state.storage().as_ref(),
            state.ssh_command_service(),
            state.credential_service(),
            ServerInfoRequest { saved_session_id },
        )
        .await
}
