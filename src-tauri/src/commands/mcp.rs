// Author: Liz
use std::sync::Arc;

use tauri::State;

use crate::{
    error::{AppError, AppResult},
    models::{
        ai::{
            AiConnectionApprovalPolicy, AiConnectionApprovalPolicyUpdateRequest,
            AiToolAuditListRequest, AiToolAuditRecord, AiToolConfirmRequest,
            AiToolPendingInvocation,
        },
        settings::McpSettings,
    },
    services::{
        ai_tool_service::AiToolService,
        mcp_service::{mcp_tool_catalog, McpServerStatus, McpService, McpToolDefinition},
    },
    state::AppState,
    storage::sqlite::SqliteStore,
    storage::{
        ai::{get_ai_connection_approval_policy, upsert_ai_connection_approval_policy},
        settings::{get_app_settings, save_app_settings},
    },
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
        return service
            .ensure_running(storage, tools, settings.mcp.port)
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
            .ensure_running(storage, state.ai_tool_service(), port)
            .await
    } else {
        state.mcp_service().stop_and_wait().await
    }
}

#[tauri::command]
pub async fn mcp_tool_confirm(
    state: State<'_, AppState>,
    request: AiToolConfirmRequest,
) -> AppResult<AiToolAuditRecord> {
    let storage = state.storage();
    let tools = state.ai_tool_service();
    // Confirmation may perform blocking SSH/SFTP work; keep it off the WebView thread.
    tauri::async_runtime::spawn_blocking(move || tools.confirm(storage.as_ref(), request))
        .await
        .map_err(|_| AppError::ai("MCP 工具确认任务异常结束"))?
}

#[tauri::command]
pub async fn mcp_tool_pending(
    state: State<'_, AppState>,
) -> AppResult<Vec<AiToolPendingInvocation>> {
    let storage = state.storage();
    let tools = state.ai_tool_service();
    tauri::async_runtime::spawn_blocking(move || tools.list_pending(storage.as_ref()))
        .await
        .map_err(|_| AppError::ai("MCP 工具状态查询任务异常结束"))?
}

#[tauri::command]
pub fn mcp_tool_audit(
    state: State<'_, AppState>,
    request: Option<AiToolAuditListRequest>,
) -> AppResult<Vec<AiToolAuditRecord>> {
    let storage = state.storage();
    state
        .ai_tool_service()
        .list_audit_with_request(storage.as_ref(), request)
}

#[tauri::command]
pub fn mcp_connection_approval_mode_get(
    state: State<'_, AppState>,
    saved_session_id: String,
) -> AppResult<AiConnectionApprovalPolicy> {
    let storage = state.storage();
    get_ai_connection_approval_policy(storage.as_ref(), &saved_session_id)
}

#[tauri::command]
pub fn mcp_connection_approval_mode_set(
    state: State<'_, AppState>,
    request: AiConnectionApprovalPolicyUpdateRequest,
) -> AppResult<AiConnectionApprovalPolicy> {
    let storage = state.storage();
    upsert_ai_connection_approval_policy(
        storage.as_ref(),
        &request.saved_session_id,
        request.approval_mode,
    )
}

#[tauri::command]
pub fn mcp_server_rotate_token(state: State<'_, AppState>) -> AppResult<McpServerStatus> {
    state.mcp_service().rotate_token()
}
