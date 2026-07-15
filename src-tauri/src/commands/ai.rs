// Author: Liz
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    error::AppResult,
    models::ai::{
        AiChatRequest, AiChatResponse, AiChatStreamCancelResult, AiChatStreamCancelledEvent,
        AiChatStreamChunkEvent, AiChatStreamDoneEvent, AiChatStreamErrorEvent,
        AiChatStreamStartResult, AiConversation, AiConversationApprovalModeUpdateRequest,
        AiConversationCreateRequest, AiConversationListRequest, AiConversationMessage,
        AiConversationMessageAppendRequest, AiConversationSummary, AiTerminalContextRequest,
        AiTerminalContextSnapshot, AiToolAuditListRequest, AiToolAuditRecord, AiToolConfirmRequest,
        AiToolDefinition, AiToolPendingInvocation, AiToolPrepareRequest,
    },
    services::ai_chat_service::AiChatStreamRunResult,
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
pub fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AiChatRequest,
) -> AppResult<AiChatStreamStartResult> {
    let storage = state.storage();
    let work = state.ai_chat_service().start_stream_work(
        storage.as_ref(),
        &state.credential_service(),
        request,
    )?;
    let chat_id = Uuid::new_v4().to_string();
    let conversation_id = work.conversation_id.clone();
    let stream_service = state.ai_chat_stream_service();
    let cancel = stream_service.register(&chat_id)?;
    let chat_service = state.ai_chat_service();
    let tools = state.ai_tool_service();
    let app_for_task = app.clone();
    let stream_service_for_task = stream_service.clone();
    let chat_id_for_task = chat_id.clone();
    let conversation_id_for_task = conversation_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit_chat_id = chat_id_for_task.clone();
        let emit_conversation_id = conversation_id_for_task.clone();
        let result = chat_service
            .run_stream_work(storage, tools, work, cancel, move |delta| {
                let _ = app_for_task.emit(
                    "ai-chat:chunk",
                    AiChatStreamChunkEvent {
                        chat_id: emit_chat_id.clone(),
                        conversation_id: emit_conversation_id.clone(),
                        delta,
                    },
                );
                Ok(())
            })
            .await;
        match result {
            Ok(AiChatStreamRunResult::Complete(response)) => {
                let _ = app.emit(
                    "ai-chat:done",
                    AiChatStreamDoneEvent {
                        chat_id: chat_id_for_task.clone(),
                        conversation_id: conversation_id_for_task.clone(),
                        message: response.message,
                        pending_invocations: response.pending_invocations,
                        executed_invocations: response.executed_invocations,
                        context_used: response.context_used,
                        generated_at_ms: response.generated_at_ms,
                    },
                );
            }
            Ok(AiChatStreamRunResult::Cancelled) => {
                let _ = app.emit(
                    "ai-chat:cancelled",
                    AiChatStreamCancelledEvent {
                        chat_id: chat_id_for_task.clone(),
                        conversation_id: conversation_id_for_task.clone(),
                    },
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "ai-chat:error",
                    AiChatStreamErrorEvent {
                        chat_id: chat_id_for_task.clone(),
                        message: app_error_message(error),
                    },
                );
            }
        }
        stream_service_for_task.finish(&chat_id_for_task);
    });
    Ok(AiChatStreamStartResult {
        chat_id,
        conversation_id,
    })
}

#[tauri::command]
pub fn ai_chat_cancel(
    state: State<'_, AppState>,
    chat_id: String,
) -> AppResult<AiChatStreamCancelResult> {
    let cancelled = state.ai_chat_stream_service().cancel(&chat_id)?;
    Ok(AiChatStreamCancelResult { cancelled })
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

fn app_error_message(error: crate::error::AppError) -> String {
    match error {
        crate::error::AppError::Validation(message)
        | crate::error::AppError::NotFound(message)
        | crate::error::AppError::Storage(message)
        | crate::error::AppError::Credential(message)
        | crate::error::AppError::Terminal(message)
        | crate::error::AppError::Ssh(message)
        | crate::error::AppError::Sftp(message)
        | crate::error::AppError::Ftp(message)
        | crate::error::AppError::Ai(message)
        | crate::error::AppError::Unsupported(message) => message,
    }
}
