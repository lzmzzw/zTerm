// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::ai::{
        AiChatRequest, AiChatResponse, AiConversation, AiConversationApprovalModeUpdateRequest,
        AiConversationCreateRequest, AiConversationListRequest, AiConversationMessage,
        AiConversationMessageAppendRequest, AiConversationSummary, AiTerminalContextRequest,
        AiTerminalContextSnapshot, AiToolAuditListRequest, AiToolAuditRecord, AiToolConfirmRequest,
        AiToolDefinition, AiToolPendingInvocation, AiToolPrepareRequest,
    },
    state::AppState,
};

#[tauri::command]
pub fn ai_chat(state: State<'_, AppState>, request: AiChatRequest) -> AppResult<AiChatResponse> {
    let storage = state.storage();
    state.ai_chat_service().chat_with_provider(
        storage.as_ref(),
        &state.credential_service(),
        &state.ai_tool_service(),
        request,
    )
}

#[tauri::command]
pub fn ai_terminal_context_snapshot(
    state: State<'_, AppState>,
    request: AiTerminalContextRequest,
) -> AppResult<AiTerminalContextSnapshot> {
    let backend_tail = request
        .runtime_session_id
        .as_deref()
        .map(|runtime_session_id| {
            state
                .terminal_manager()
                .output_tail(runtime_session_id, 4000)
        })
        .transpose()?
        .flatten();
    let recent_output_tail = backend_tail
        .or_else(|| request.recent_output_tail.clone())
        .or_else(|| {
            request
                .recent_output
                .clone()
                .map(|value| tail_chars(&value, 4000))
        });
    let target_summary = build_target_summary(&request);
    Ok(AiTerminalContextSnapshot {
        runtime_session_id: request.runtime_session_id,
        saved_session_id: request.saved_session_id,
        pane_id: request.pane_id,
        title: request.title,
        cwd: request.cwd,
        target_summary,
        recent_output_tail,
        selected_text: request.selected_text,
        input_buffer: request.input_buffer,
        active_tool: request.active_tool,
        generated_at_ms: now_ms(),
    })
}

#[tauri::command]
pub fn ai_tool_registry_list(state: State<'_, AppState>) -> AppResult<Vec<AiToolDefinition>> {
    Ok(state.ai_tool_service().definitions())
}

#[tauri::command]
pub fn ai_tool_prepare(
    state: State<'_, AppState>,
    request: AiToolPrepareRequest,
) -> AppResult<AiToolPendingInvocation> {
    let storage = state.storage();
    state.ai_tool_service().prepare(storage.as_ref(), request)
}

#[tauri::command]
pub fn ai_tool_confirm(
    state: State<'_, AppState>,
    request: AiToolConfirmRequest,
) -> AppResult<AiToolAuditRecord> {
    let storage = state.storage();
    state.ai_tool_service().confirm(storage.as_ref(), request)
}

#[tauri::command]
pub fn ai_tool_pending(state: State<'_, AppState>) -> AppResult<Vec<AiToolPendingInvocation>> {
    let storage = state.storage();
    state.ai_tool_service().list_pending(storage.as_ref())
}

#[tauri::command]
pub fn ai_tool_audit(
    state: State<'_, AppState>,
    request: Option<AiToolAuditListRequest>,
) -> AppResult<Vec<AiToolAuditRecord>> {
    let storage = state.storage();
    state
        .ai_tool_service()
        .list_audit_with_request(storage.as_ref(), request)
}

#[tauri::command]
pub fn ai_conversation_create(
    state: State<'_, AppState>,
    request: AiConversationCreateRequest,
) -> AppResult<AiConversation> {
    let storage = state.storage();
    state
        .ai_conversation_service()
        .create(storage.as_ref(), request)
}

#[tauri::command]
pub fn ai_conversation_list(
    state: State<'_, AppState>,
    request: Option<AiConversationListRequest>,
) -> AppResult<Vec<AiConversationSummary>> {
    let storage = state.storage();
    state
        .ai_conversation_service()
        .list_with_request(storage.as_ref(), request.unwrap_or_default())
}

#[tauri::command]
pub fn ai_conversation_get(
    state: State<'_, AppState>,
    conversation_id: String,
) -> AppResult<AiConversation> {
    let storage = state.storage();
    state
        .ai_conversation_service()
        .get(storage.as_ref(), &conversation_id)
}

#[tauri::command]
pub fn ai_conversation_delete(
    state: State<'_, AppState>,
    conversation_id: String,
) -> AppResult<bool> {
    let storage = state.storage();
    state
        .ai_conversation_service()
        .delete(storage.as_ref(), &conversation_id)
}

#[tauri::command]
pub fn ai_set_conversation_approval_mode(
    state: State<'_, AppState>,
    request: AiConversationApprovalModeUpdateRequest,
) -> AppResult<AiConversation> {
    let storage = state.storage();
    state
        .ai_conversation_service()
        .update_approval_mode(storage.as_ref(), request)
}

#[tauri::command]
pub fn ai_conversation_message_append(
    state: State<'_, AppState>,
    request: AiConversationMessageAppendRequest,
) -> AppResult<AiConversationMessage> {
    let storage = state.storage();
    state
        .ai_conversation_service()
        .append_message(storage.as_ref(), request)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn tail_chars(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

fn build_target_summary(request: &AiTerminalContextRequest) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("窗格 {title}"));
    }
    if let Some(pane_id) = request
        .pane_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("pane={pane_id}"));
    }
    if let Some(runtime_session_id) = request
        .runtime_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("runtime={runtime_session_id}"));
    }
    if let Some(cwd) = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("cwd={cwd}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}
