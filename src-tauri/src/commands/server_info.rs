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
    saved_session_id: Option<String>,
) -> AppResult<ServerInfoSnapshot> {
    match saved_session_id {
        Some(saved_session_id) => {
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
        None => state.server_info_service().local_snapshot().await,
    }
}
