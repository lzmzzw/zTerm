// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::settings::McpSettings,
    services::mcp_service::McpServerStatus,
    state::AppState,
    storage::settings::{get_app_settings, save_app_settings},
};

#[tauri::command]
pub async fn mcp_server_status(state: State<'_, AppState>) -> AppResult<McpServerStatus> {
    if let Some(status) = state.mcp_service().status() {
        return Ok(status);
    }
    let settings = get_app_settings(state.storage().as_ref())?;
    if settings.mcp.enabled {
        return state
            .mcp_service()
            .start(state.storage(), state.ai_tool_service(), settings.mcp.port)
            .await;
    }
    Ok(McpServerStatus {
        enabled: false,
        endpoint: None,
        token: None,
    })
}

#[tauri::command]
pub async fn mcp_server_set_enabled(
    state: State<'_, AppState>,
    enabled: bool,
    port: Option<u16>,
) -> AppResult<McpServerStatus> {
    let storage = state.storage();
    let mut settings = get_app_settings(storage.as_ref())?;
    settings.mcp = McpSettings {
        enabled,
        port: port.filter(|value| *value != 0),
    };
    save_app_settings(storage.as_ref(), settings)?;
    if enabled {
        state
            .mcp_service()
            .start(storage, state.ai_tool_service(), port)
            .await
    } else {
        state.mcp_service().stop()
    }
}

#[tauri::command]
pub fn mcp_server_rotate_token(state: State<'_, AppState>) -> AppResult<McpServerStatus> {
    state.mcp_service().rotate_token()
}
