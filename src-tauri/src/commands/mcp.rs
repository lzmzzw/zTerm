// Author: Liz
use std::sync::Arc;

use tauri::State;

use crate::{
    error::AppResult,
    models::settings::McpSettings,
    services::{
        ai_tool_service::AiToolService,
        mcp_service::{mcp_tool_catalog, McpServerStatus, McpService, McpToolDefinition},
    },
    state::AppState,
    storage::settings::{get_app_settings, save_app_settings},
    storage::sqlite::SqliteStore,
};

#[tauri::command]
pub fn mcp_tool_catalog_list() -> AppResult<Vec<McpToolDefinition>> {
    Ok(mcp_tool_catalog())
}

#[tauri::command]
pub async fn mcp_server_status(state: State<'_, AppState>) -> AppResult<McpServerStatus> {
    start_mcp_if_enabled(
        state.storage(),
        state.ai_tool_service(),
        state.mcp_service(),
    )
    .await
}

pub async fn start_mcp_if_enabled(
    storage: Arc<SqliteStore>,
    tools: AiToolService,
    service: Arc<McpService>,
) -> AppResult<McpServerStatus> {
    if let Some(status) = service.status() {
        return Ok(status);
    }
    let settings = get_app_settings(storage.as_ref())?;
    if settings.mcp.enabled {
        return service.start(storage, tools, settings.mcp.port).await;
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
