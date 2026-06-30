// Author: Liz
use serde_json::Value;
use uuid::Uuid;

use crate::{
    error::AppResult,
    models::{
        ai::{
            AiApprovalMode, AiChatRequest, AiChatResponse, AiConversationCreateRequest,
            AiConversationMessageAppendRequest, AiMessageRole, AiTerminalContextRequest,
            AiToolPrepareRequest,
        },
        credential::AiProviderKind,
    },
    security::redaction::redact_sensitive,
    services::{
        ai_conversation_service::AiConversationService,
        ai_tool_service::AiToolService,
        credential_service::CredentialService,
        llm_provider_service::{
            run_text_generation_sync, run_tool_chat_sync, select_enabled_provider,
            ProviderChatMessage,
        },
    },
    storage::sqlite::SqliteStore,
};

#[derive(Debug, Default, Clone)]
pub struct AiChatService;

impl AiChatService {
    pub fn chat_with_provider(
        &self,
        store: &SqliteStore,
        credentials: &CredentialService,
        tools: &AiToolService,
        request: AiChatRequest,
    ) -> AppResult<AiChatResponse> {
        let message = required_text("AI 消息", &request.message)?;
        let provider = select_enabled_provider(credentials)?;
        let api_key = provider_api_key(credentials, provider.kind, &provider.api_key_ref)?;
        let conversation_service = AiConversationService::default();
        let (conversation_id, approval_mode) =
            ensure_conversation(store, &conversation_service, &request)?;
        conversation_service.append_message(
            store,
            AiConversationMessageAppendRequest {
                conversation_id: conversation_id.clone(),
                role: AiMessageRole::User,
                content: message.clone(),
                metadata_json: None,
            },
        )?;

        let provider_messages =
            build_provider_messages(store, &conversation_service, &request, &conversation_id)?;
        let tool_response = run_tool_chat_sync(
            &provider,
            &api_key,
            &provider_messages,
            &tools.definitions(),
        )?;
        let mut pending_invocations = Vec::new();
        let mut executed_invocations = Vec::new();
        let mut tool_result_summaries = Vec::new();

        for tool_call in tool_response.tool_calls.iter().take(3) {
            let arguments = captured_tool_arguments(
                &tool_call.tool_id,
                tool_call.arguments.clone(),
                request.terminal_context.as_ref(),
            );
            let outcome = tools.execute_if_allowed(
                store,
                AiToolPrepareRequest {
                    tool_id: tool_call.tool_id.clone(),
                    arguments,
                    reason: tool_call
                        .reason
                        .clone()
                        .or_else(|| Some("AI function call".to_string())),
                    requested_by: Some("ai_chat".to_string()),
                    conversation_id: Some(conversation_id.clone()),
                    run_id: None,
                    step_id: Some(tool_call.id.clone()),
                },
                approval_mode,
            )?;
            if let Some(pending) = outcome.pending_invocation {
                pending_invocations.push(pending);
            }
            if let Some(audit) = outcome.audit_record {
                if let Some(summary) = audit.result_summary.as_deref() {
                    tool_result_summaries.push(format!("{}: {}", audit.tool_id, summary));
                }
                executed_invocations.push(audit);
            }
        }

        let response_message = if !pending_invocations.is_empty() {
            if tool_response.message.trim().is_empty() {
                "AI 请求执行工具，等待人工确认。".to_string()
            } else {
                tool_response.message
            }
        } else if !tool_result_summaries.is_empty() {
            summarize_tool_results(&provider, &api_key, &message, &tool_result_summaries)
        } else if tool_response.message.trim().is_empty() {
            "AI 未返回可展示内容。".to_string()
        } else {
            redact_sensitive(&tool_response.message)
        };

        conversation_service.append_message(
            store,
            AiConversationMessageAppendRequest {
                conversation_id: conversation_id.clone(),
                role: AiMessageRole::Assistant,
                content: response_message.clone(),
                metadata_json: None,
            },
        )?;

        Ok(AiChatResponse {
            conversation_id,
            provider_id: provider.id,
            provider_name: provider.name,
            model: provider.model,
            message: response_message,
            pending_invocations,
            executed_invocations,
            response_redacted: false,
            context_used: request.terminal_context.is_some() || !request.history.is_empty(),
            tool_count: tools.definitions().len(),
            generated_at_ms: now_ms(),
        })
    }
}

fn ensure_conversation(
    store: &SqliteStore,
    conversation_service: &AiConversationService,
    request: &AiChatRequest,
) -> AppResult<(String, AiApprovalMode)> {
    if let Some(conversation_id) = request
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let conversation = conversation_service.get(store, conversation_id)?;
        return Ok((conversation.id, conversation.approval_mode));
    }
    let conversation = conversation_service.create(
        store,
        AiConversationCreateRequest {
            title: Some(build_title(&request.message)),
            scope_kind: "follow_focus".to_string(),
            scope_ref_json: Some("{}".to_string()),
            approval_mode: Some(request.approval_mode.unwrap_or(AiApprovalMode::Safe)),
        },
    )?;
    Ok((conversation.id, conversation.approval_mode))
}

fn build_provider_messages(
    store: &SqliteStore,
    conversation_service: &AiConversationService,
    request: &AiChatRequest,
    conversation_id: &str,
) -> AppResult<Vec<ProviderChatMessage>> {
    let mut messages = vec![ProviderChatMessage {
        role: "system".to_string(),
        content: system_prompt(request.terminal_context.as_ref()),
    }];
    if let Ok(conversation) = conversation_service.get(store, conversation_id) {
        for message in conversation.messages.iter().rev().take(12).rev() {
            let (role, content) = if message.role == AiMessageRole::Tool {
                ("user".to_string(), format!("工具结果：{}", message.content))
            } else {
                (message.role.as_str().to_string(), message.content.clone())
            };
            messages.push(ProviderChatMessage { role, content });
        }
    }
    if messages
        .last()
        .map(|message| message.role != "user" || message.content != request.message)
        .unwrap_or(true)
    {
        messages.push(ProviderChatMessage {
            role: "user".to_string(),
            content: request.message.clone(),
        });
    }
    Ok(messages)
}

fn system_prompt(context: Option<&AiTerminalContextRequest>) -> String {
    let mut prompt = String::from(
        "你是 zTerm 的终端 AI 助手。需要操作终端时只能调用提供的工具；不要编造已执行的命令。回答使用简洁中文。",
    );
    if let Some(context) = context {
        prompt.push_str("\n当前绑定窗格上下文：");
        if let Some(title) = non_empty(context.title.as_deref()) {
            prompt.push_str(&format!("\n- title: {title}"));
        }
        if let Some(pane_id) = non_empty(context.pane_id.as_deref()) {
            prompt.push_str(&format!("\n- pane_id: {pane_id}"));
        }
        if let Some(runtime_session_id) = non_empty(context.runtime_session_id.as_deref()) {
            prompt.push_str(&format!("\n- runtime_session_id: {runtime_session_id}"));
        }
        if let Some(saved_session_id) = non_empty(context.saved_session_id.as_deref()) {
            prompt.push_str(&format!("\n- saved_session_id: {saved_session_id}"));
        }
        if let Some(cwd) = non_empty(context.cwd.as_deref()) {
            prompt.push_str(&format!("\n- cwd: {cwd}"));
        }
        let recent = context
            .recent_output_tail
            .as_deref()
            .or(context.recent_output.as_deref())
            .and_then(|value| non_empty(Some(value)));
        if let Some(recent) = recent {
            prompt.push_str("\n最近终端输出：\n");
            prompt.push_str(&tail_chars(&redact_sensitive(recent), 2000));
        }
    }
    prompt
}

fn captured_tool_arguments(
    tool_id: &str,
    arguments: Value,
    context: Option<&AiTerminalContextRequest>,
) -> Value {
    let mut object = match arguments {
        Value::Object(object) => object,
        Value::Null => serde_json::Map::new(),
        other => {
            let mut object = serde_json::Map::new();
            object.insert("value".to_string(), other);
            object
        }
    };

    if tool_id == "terminal.write" {
        if !object.contains_key("data") {
            if let Some(command) = object
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                object.insert("data".to_string(), Value::String(command.to_string()));
            }
        }
        if let Some(data) = object.get("data").and_then(Value::as_str) {
            let mut normalized = data.to_string();
            if !normalized.ends_with('\r') && !normalized.ends_with('\n') {
                normalized.push('\r');
            }
            object.insert("data".to_string(), Value::String(normalized));
        }
    }

    if let Some(context) = context {
        insert_context_value(
            &mut object,
            "runtime_session_id",
            context.runtime_session_id.as_deref(),
        );
        insert_context_value(
            &mut object,
            "saved_session_id",
            context.saved_session_id.as_deref(),
        );
        insert_context_value(&mut object, "pane_id", context.pane_id.as_deref());
        insert_context_value(&mut object, "target_title", context.title.as_deref());
        insert_context_value(&mut object, "cwd", context.cwd.as_deref());
    }
    Value::Object(object)
}

fn insert_context_value(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&str>,
) {
    if object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return;
    }
    if let Some(value) = non_empty(value) {
        object.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn summarize_tool_results(
    provider: &crate::models::credential::AiProviderProfile,
    api_key: &str,
    user_message: &str,
    tool_result_summaries: &[String],
) -> String {
    let prompt = format!(
        "用户请求：{}\n\n工具执行结果：\n{}\n\n请基于工具结果给出简洁中文回复。",
        user_message,
        tool_result_summaries.join("\n")
    );
    run_text_generation_sync(provider, api_key, &prompt)
        .map(|value| redact_sensitive(&value))
        .unwrap_or_else(|_| {
            format!(
                "已执行工具：{}",
                redact_sensitive(&tool_result_summaries.join("；"))
            )
        })
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn tail_chars(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

fn provider_api_key(
    credentials: &CredentialService,
    kind: AiProviderKind,
    api_key_ref: &str,
) -> AppResult<String> {
    if api_key_ref.trim().is_empty() {
        if matches!(
            kind,
            AiProviderKind::OpenAiChat | AiProviderKind::OpenAiResponses
        ) {
            return Ok(String::new());
        }
        return Err(crate::error::AppError::validation(
            "该 Provider 需要 API Key",
        ));
    }
    credentials.read_secret(api_key_ref)
}

fn build_title(message: &str) -> String {
    let title: String = message.trim().chars().take(28).collect();
    if title.is_empty() {
        format!("AI 会话 {}", Uuid::new_v4())
    } else {
        title
    }
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(crate::error::AppError::validation(format!(
            "{label}不能为空"
        )));
    }
    Ok(value.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
