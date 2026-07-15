// Author: Liz
use serde_json::{json, Value};
use std::sync::Arc;

use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{
    error::AppResult,
    models::{
        ai::{
            AiApprovalMode, AiChatRequest, AiChatResponse, AiConversationCreateRequest,
            AiConversationMessageAppendRequest, AiMessageRole, AiTerminalContextRequest,
            AiToolAuditRecord, AiToolPendingInvocation, AiToolPrepareRequest,
        },
        credential::{AiProviderKind, AiProviderProfile},
    },
    security::redaction::redact_sensitive,
    services::{
        ai_conversation_service::AiConversationService,
        ai_tool_service::AiToolService,
        credential_service::CredentialService,
        llm_provider_service::{
            generate_text_stream, generate_tool_chat, run_text_generation_sync, run_tool_chat_sync,
            select_enabled_provider, ProviderChatMessage, ProviderTextStreamResult,
            ProviderToolChatResponse,
        },
    },
    storage::sqlite::SqliteStore,
};

const MAX_TOOL_ROUNDS: usize = 5;
const MAX_TOOL_CALLS_PER_ROUND: usize = 3;

#[derive(Debug, Default, Clone)]
pub struct AiChatService;

#[derive(Debug, Clone)]
pub struct AiChatStreamWork {
    pub conversation_id: String,
    pub provider: AiProviderProfile,
    pub api_key: String,
    pub user_message: String,
    pub approval_mode: AiApprovalMode,
    pub provider_messages: Vec<ProviderChatMessage>,
    pub terminal_context: Option<AiTerminalContextRequest>,
    pub context_used: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiChatStreamComplete {
    pub message: String,
    pub pending_invocations: Vec<AiToolPendingInvocation>,
    pub executed_invocations: Vec<AiToolAuditRecord>,
    pub context_used: bool,
    pub tool_count: usize,
    pub generated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiChatStreamRunResult {
    Complete(AiChatStreamComplete),
    Cancelled,
}

enum AiChatResponseSource {
    Immediate(String),
    StreamPrompt(String),
}

#[derive(Default)]
struct ToolLoopResult {
    last_message: String,
    pending_invocations: Vec<AiToolPendingInvocation>,
    executed_invocations: Vec<AiToolAuditRecord>,
    tool_result_summaries: Vec<String>,
    final_message_from_model: bool,
}

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
        let conversation_service = AiConversationService;
        let (conversation_id, approval_mode) =
            ensure_conversation(store, &conversation_service, &request)?;
        let provider_messages =
            build_provider_messages(store, &conversation_service, &request, &conversation_id)?;
        conversation_service.append_message(
            store,
            AiConversationMessageAppendRequest {
                conversation_id: conversation_id.clone(),
                role: AiMessageRole::User,
                content: message.clone(),
                metadata_json: None,
            },
        )?;

        let tool_definitions = tools.definitions();
        let loop_result = match run_direct_provider_create_from_curl(
            store,
            tools,
            &message,
            &conversation_id,
            approval_mode,
        )? {
            Some(result) => result,
            None => run_tool_rounds_sync(
                store,
                tools,
                provider_messages,
                request.terminal_context.as_ref(),
                &conversation_id,
                approval_mode,
                |messages| run_tool_chat_sync(&provider, &api_key, messages, &tool_definitions),
            )?,
        };

        let response_message = if !loop_result.pending_invocations.is_empty() {
            if loop_result.last_message.trim().is_empty() {
                "AI 请求执行工具，等待人工确认。".to_string()
            } else {
                redact_sensitive(&loop_result.last_message)
            }
        } else if loop_result.final_message_from_model
            && !loop_result.last_message.trim().is_empty()
        {
            redact_sensitive(&loop_result.last_message)
        } else if !loop_result.tool_result_summaries.is_empty() {
            summarize_tool_results(
                &provider,
                &api_key,
                &message,
                &loop_result.tool_result_summaries,
            )
        } else if loop_result.last_message.trim().is_empty() {
            "AI 未返回可展示内容。".to_string()
        } else {
            redact_sensitive(&loop_result.last_message)
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
            pending_invocations: loop_result.pending_invocations,
            executed_invocations: loop_result.executed_invocations,
            response_redacted: false,
            context_used: request.terminal_context.is_some() || !request.history.is_empty(),
            tool_count: tool_definitions.len(),
            generated_at_ms: now_ms(),
        })
    }

    pub fn start_stream_work(
        &self,
        store: &SqliteStore,
        credentials: &CredentialService,
        request: AiChatRequest,
    ) -> AppResult<AiChatStreamWork> {
        let message = required_text("AI 消息", &request.message)?;
        let provider = select_enabled_provider(credentials)?;
        let api_key = provider_api_key(credentials, provider.kind, &provider.api_key_ref)?;
        let conversation_service = AiConversationService;
        let (conversation_id, approval_mode) =
            ensure_conversation(store, &conversation_service, &request)?;
        let provider_messages =
            build_provider_messages(store, &conversation_service, &request, &conversation_id)?;
        conversation_service.append_message(
            store,
            AiConversationMessageAppendRequest {
                conversation_id: conversation_id.clone(),
                role: AiMessageRole::User,
                content: message.clone(),
                metadata_json: None,
            },
        )?;

        Ok(AiChatStreamWork {
            conversation_id,
            provider,
            api_key,
            user_message: message,
            approval_mode,
            provider_messages,
            terminal_context: request.terminal_context.clone(),
            context_used: request.terminal_context.is_some() || !request.history.is_empty(),
        })
    }

    pub async fn run_stream_work(
        &self,
        store: Arc<SqliteStore>,
        tools: AiToolService,
        work: AiChatStreamWork,
        mut cancel: oneshot::Receiver<()>,
        mut on_delta: impl FnMut(String) -> AppResult<()> + Send,
    ) -> AppResult<AiChatStreamRunResult> {
        let tool_definitions = tools.definitions();
        let mut provider_messages = work.provider_messages.clone();
        let mut loop_result = run_direct_provider_create_from_curl(
            store.as_ref(),
            &tools,
            &work.user_message,
            &work.conversation_id,
            work.approval_mode,
        )?
        .unwrap_or_default();

        if loop_result.pending_invocations.is_empty()
            && loop_result.executed_invocations.is_empty()
            && loop_result.last_message.is_empty()
        {
            for _ in 0..MAX_TOOL_ROUNDS {
                let tool_response = tokio::select! {
                    _ = &mut cancel => return Ok(AiChatStreamRunResult::Cancelled),
                    response = generate_tool_chat(
                        &work.provider,
                        &work.api_key,
                        &provider_messages,
                        &tool_definitions,
                    ) => response?,
                };

                let should_continue = handle_tool_round(
                    store.as_ref(),
                    &tools,
                    &mut provider_messages,
                    &mut loop_result,
                    tool_response,
                    work.terminal_context.as_ref(),
                    &work.conversation_id,
                    work.approval_mode,
                )?;
                if !should_continue {
                    break;
                }
            }
        }

        if cancel.try_recv().is_ok() {
            return Ok(AiChatStreamRunResult::Cancelled);
        }

        let response_source = stream_response_source(
            &work,
            &loop_result.last_message,
            &loop_result.pending_invocations,
            &loop_result.tool_result_summaries,
            loop_result.final_message_from_model,
        );
        let response_message = match response_source {
            AiChatResponseSource::Immediate(message) => {
                on_delta(message.clone())?;
                if cancel.try_recv().is_ok() {
                    return Ok(AiChatStreamRunResult::Cancelled);
                }
                message
            }
            AiChatResponseSource::StreamPrompt(prompt) => {
                match generate_text_stream(
                    &work.provider,
                    &work.api_key,
                    &prompt,
                    cancel,
                    move |delta| on_delta(redact_sensitive(&delta)),
                )
                .await?
                {
                    ProviderTextStreamResult::Complete(output) => redact_sensitive(&output),
                    ProviderTextStreamResult::Cancelled(_) => {
                        return Ok(AiChatStreamRunResult::Cancelled);
                    }
                }
            }
        };

        AiConversationService.append_message(
            store.as_ref(),
            AiConversationMessageAppendRequest {
                conversation_id: work.conversation_id,
                role: AiMessageRole::Assistant,
                content: response_message.clone(),
                metadata_json: None,
            },
        )?;

        Ok(AiChatStreamRunResult::Complete(AiChatStreamComplete {
            message: response_message,
            pending_invocations: loop_result.pending_invocations,
            executed_invocations: loop_result.executed_invocations,
            context_used: work.context_used,
            tool_count: tool_definitions.len(),
            generated_at_ms: now_ms(),
        }))
    }
}

fn run_tool_rounds_sync(
    store: &SqliteStore,
    tools: &AiToolService,
    provider_messages: Vec<ProviderChatMessage>,
    terminal_context: Option<&AiTerminalContextRequest>,
    conversation_id: &str,
    approval_mode: AiApprovalMode,
    mut run_tool_chat: impl FnMut(&[ProviderChatMessage]) -> AppResult<ProviderToolChatResponse>,
) -> AppResult<ToolLoopResult> {
    let mut provider_messages = provider_messages;
    let mut result = ToolLoopResult::default();
    for _ in 0..MAX_TOOL_ROUNDS {
        let tool_response = run_tool_chat(&provider_messages)?;
        let should_continue = handle_tool_round(
            store,
            tools,
            &mut provider_messages,
            &mut result,
            tool_response,
            terminal_context,
            conversation_id,
            approval_mode,
        )?;
        if !should_continue {
            break;
        }
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn handle_tool_round(
    store: &SqliteStore,
    tools: &AiToolService,
    provider_messages: &mut Vec<ProviderChatMessage>,
    result: &mut ToolLoopResult,
    tool_response: ProviderToolChatResponse,
    terminal_context: Option<&AiTerminalContextRequest>,
    conversation_id: &str,
    approval_mode: AiApprovalMode,
) -> AppResult<bool> {
    result.last_message = tool_response.message.clone();
    result.final_message_from_model = tool_response.tool_calls.is_empty();
    if tool_response.tool_calls.is_empty() {
        return Ok(false);
    }

    let mut round_summaries = Vec::new();
    for tool_call in tool_response
        .tool_calls
        .iter()
        .take(MAX_TOOL_CALLS_PER_ROUND)
    {
        let arguments = captured_tool_arguments(
            &tool_call.tool_id,
            tool_call.arguments.clone(),
            terminal_context,
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
                conversation_id: Some(conversation_id.to_string()),
                run_id: None,
                step_id: Some(tool_call.id.clone()),
            },
            approval_mode,
        )?;
        if let Some(pending) = outcome.pending_invocation {
            result.pending_invocations.push(pending);
        }
        if let Some(audit) = outcome.audit_record {
            let summary = tool_observation_summary(&audit);
            round_summaries.push(summary.clone());
            result.tool_result_summaries.push(summary);
            result.executed_invocations.push(audit);
        }
    }

    if !result.pending_invocations.is_empty() {
        return Ok(false);
    }
    if round_summaries.is_empty() {
        return Ok(false);
    }

    provider_messages.push(ProviderChatMessage {
        role: "assistant".to_string(),
        content: if tool_response.message.trim().is_empty() {
            "我将根据工具结果继续。".to_string()
        } else {
            redact_sensitive(&tool_response.message)
        },
    });
    provider_messages.push(ProviderChatMessage {
        role: "user".to_string(),
        content: tool_observation_prompt(&round_summaries),
    });
    result.final_message_from_model = false;
    Ok(true)
}

fn run_direct_provider_create_from_curl(
    store: &SqliteStore,
    tools: &AiToolService,
    user_message: &str,
    conversation_id: &str,
    approval_mode: AiApprovalMode,
) -> AppResult<Option<ToolLoopResult>> {
    if !looks_like_provider_create_from_curl(user_message) {
        return Ok(None);
    }
    let outcome = tools.execute_if_allowed(
        store,
        AiToolPrepareRequest {
            tool_id: "llm_provider.create".to_string(),
            arguments: json!({ "curl": user_message }),
            reason: Some("用户提供 curl 请求并要求添加模型".to_string()),
            requested_by: Some("ai_chat".to_string()),
            conversation_id: Some(conversation_id.to_string()),
            run_id: None,
            step_id: Some("direct-llm-provider-create".to_string()),
        },
        approval_mode,
    )?;

    let mut result = ToolLoopResult::default();
    if let Some(pending) = outcome.pending_invocation {
        result.last_message = "AI 请求创建 LLM Provider，等待人工确认。".to_string();
        result.pending_invocations.push(pending);
    }
    if let Some(audit) = outcome.audit_record {
        let summary = tool_observation_summary(&audit);
        result.last_message = audit
            .result_summary
            .clone()
            .unwrap_or_else(|| "LLM Provider 创建工具已执行。".to_string());
        result.final_message_from_model = true;
        result.tool_result_summaries.push(summary);
        result.executed_invocations.push(audit);
    }
    Ok(Some(result))
}

fn looks_like_provider_create_from_curl(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    let has_curl_request = normalized.contains("curl")
        && (normalized.contains("http://") || normalized.contains("https://"));
    if !has_curl_request {
        return false;
    }
    let has_resource = message.contains("模型")
        || message.contains("大模型")
        || normalized.contains("llm")
        || normalized.contains("provider")
        || normalized.contains("model");
    let has_create_intent = message.contains("添加")
        || message.contains("新增")
        || message.contains("创建")
        || message.contains("保存")
        || message.contains("配置")
        || normalized.contains("add")
        || normalized.contains("create")
        || normalized.contains("save")
        || normalized.contains("configure");
    has_resource && has_create_intent
}

fn tool_observation_summary(audit: &AiToolAuditRecord) -> String {
    let detail = audit
        .result_summary
        .as_deref()
        .or(audit.error.as_deref())
        .unwrap_or("工具未返回结果摘要。");
    format!(
        "{} [{}]: {}",
        audit.tool_id,
        audit.status.as_str(),
        redact_sensitive(detail)
    )
}

fn tool_observation_prompt(round_summaries: &[String]) -> String {
    format!(
        "工具执行结果（Observation）：\n{}\n\n如果用户请求尚未完成，请继续调用下一步工具；如果已完成，请给出最终答复。不要声称未执行的操作已完成。",
        redact_sensitive(&round_summaries.join("\n"))
    )
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
        "你是 zTerm 的终端 AI 助手。需要操作终端或创建、修改、删除 zTerm 资源时只能调用提供的工具；只读取列表或上下文不等于完成变更，不要声称已完成未通过工具执行的操作。回答使用简洁中文。",
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
    let prompt = tool_result_summary_prompt(user_message, tool_result_summaries);
    run_text_generation_sync(provider, api_key, &prompt)
        .map(|value| redact_sensitive(&value))
        .unwrap_or_else(|_| {
            format!(
                "已执行工具：{}",
                redact_sensitive(&tool_result_summaries.join("；"))
            )
        })
}

fn stream_response_source(
    work: &AiChatStreamWork,
    tool_response_message: &str,
    pending_invocations: &[AiToolPendingInvocation],
    tool_result_summaries: &[String],
    final_message_from_model: bool,
) -> AiChatResponseSource {
    if !pending_invocations.is_empty() {
        let message = if tool_response_message.trim().is_empty() {
            "AI 请求执行工具，等待人工确认。".to_string()
        } else {
            redact_sensitive(tool_response_message)
        };
        return AiChatResponseSource::Immediate(message);
    }
    if final_message_from_model && !tool_response_message.trim().is_empty() {
        return AiChatResponseSource::Immediate(redact_sensitive(tool_response_message));
    }
    if !tool_result_summaries.is_empty() {
        return AiChatResponseSource::StreamPrompt(tool_result_summary_prompt(
            &work.user_message,
            tool_result_summaries,
        ));
    }
    AiChatResponseSource::StreamPrompt(direct_chat_stream_prompt(&work.provider_messages))
}

fn tool_result_summary_prompt(user_message: &str, tool_result_summaries: &[String]) -> String {
    format!(
        "用户请求：{}\n\n工具执行结果：\n{}\n\n请基于工具结果给出简洁中文回复。",
        redact_sensitive(user_message),
        redact_sensitive(&tool_result_summaries.join("\n"))
    )
}

fn direct_chat_stream_prompt(messages: &[ProviderChatMessage]) -> String {
    let mut prompt = String::from(
        "下面是 zTerm AI 会话上下文。请回答最后一条用户消息，使用简洁中文；不要声称已经执行未通过工具完成的终端操作。\n\n",
    );
    for message in messages {
        prompt.push_str(match message.role.as_str() {
            "system" => "System",
            "assistant" => "Assistant",
            "tool" => "Tool",
            _ => "User",
        });
        prompt.push_str(":\n");
        prompt.push_str(&tail_chars(&redact_sensitive(&message.content), 2500));
        prompt.push_str("\n\n");
    }
    prompt
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::{
        error::AppResult,
        models::{
            ai::AiChatRequest,
            credential::{AiProviderKind, AiProviderProfileDraft},
            session::SessionGroupDraft,
        },
        services::{
            ai_tool_service::AiToolCommandWriter,
            credential_service::{CredentialService, MemorySecretStore},
            llm_provider_service::ProviderToolCall,
        },
        storage::{
            ai::list_ai_provider_profiles,
            sessions::{list_sessions, save_session_group},
        },
    };

    struct FakeToolWriter;

    impl AiToolCommandWriter for FakeToolWriter {
        fn write_terminal(&self, _runtime_session_id: &str, _data: &str) -> AppResult<()> {
            Ok(())
        }
    }

    #[test]
    fn system_prompt_requires_tools_for_resource_mutations() {
        let prompt = super::system_prompt(None);

        assert!(prompt.contains("创建、修改、删除 zTerm 资源时只能调用提供的工具"));
        assert!(prompt.contains("只读取列表或上下文不等于完成变更"));
    }

    #[test]
    fn tool_rounds_continue_after_observation_to_create_session() {
        let store = SqliteStore::open_in_memory().expect("store should open");
        let credential_service = CredentialService::with_secret_store(
            Arc::new(SqliteStore::open_in_memory().expect("credential store should open")),
            Arc::new(MemorySecretStore::default()),
        );
        let tools =
            AiToolService::with_credential_service(Arc::new(FakeToolWriter), credential_service);
        let group = save_session_group(
            &store,
            SessionGroupDraft {
                id: Some("group-mobile-room".to_string()),
                parent_id: None,
                name: "移动机房".to_string(),
                expanded: true,
                sort_order: 0,
            },
        )
        .expect("group should save");
        let initial_messages = vec![ProviderChatMessage {
            role: "user".to_string(),
            content: "在移动机房分组下创建 172.16.41.181 连接".to_string(),
        }];
        let mut rounds = 0;

        let result = run_tool_rounds_sync(
            &store,
            &tools,
            initial_messages,
            None,
            "conversation-1",
            AiApprovalMode::Safe,
            |messages| {
                rounds += 1;
                match rounds {
                    1 => Ok(ProviderToolChatResponse {
                        message: "我先查看现有分组。".to_string(),
                        tool_calls: vec![ProviderToolCall {
                            id: "call-list".to_string(),
                            tool_id: "sessions.list".to_string(),
                            arguments: json!({}),
                            reason: None,
                        }],
                    }),
                    2 => {
                        assert!(messages.iter().any(|message| {
                            message.content.contains("工具执行结果（Observation）")
                                && message.content.contains("sessions.list")
                        }));
                        Ok(ProviderToolChatResponse {
                            message: "找到分组后创建连接。".to_string(),
                            tool_calls: vec![ProviderToolCall {
                                id: "call-save".to_string(),
                                tool_id: "sessions.save".to_string(),
                                arguments: json!({
                                    "draft": {
                                        "name": "172.16.41.181",
                                        "type": "ssh",
                                        "group_name": "移动机房",
                                        "host": "172.16.41.181",
                                        "username": "ubuntu",
                                        "password": "ai-created-password"
                                    }
                                }),
                                reason: None,
                            }],
                        })
                    }
                    3 => {
                        assert!(messages.iter().any(|message| {
                            message.content.contains("工具执行结果（Observation）")
                                && message.content.contains("sessions.save")
                        }));
                        Ok(ProviderToolChatResponse {
                            message: "已在移动机房分组下创建连接 172.16.41.181。".to_string(),
                            tool_calls: Vec::new(),
                        })
                    }
                    _ => panic!("tool loop should stop after final model message"),
                }
            },
        )
        .expect("tool loop should run");

        assert_eq!(rounds, 3);
        assert!(result.pending_invocations.is_empty());
        assert!(result.final_message_from_model);
        assert_eq!(
            result.last_message,
            "已在移动机房分组下创建连接 172.16.41.181。"
        );
        assert_eq!(result.executed_invocations.len(), 2);

        let sessions = list_sessions(&store).expect("sessions should list");
        assert_eq!(
            sessions
                .groups
                .iter()
                .filter(|item| item.name == "移动机房")
                .count(),
            1
        );
        let session = sessions
            .sessions
            .iter()
            .find(|item| item.name == "172.16.41.181")
            .expect("session should be created after second tool round");
        assert_eq!(session.group_id.as_deref(), Some(group.id.as_str()));
        assert_eq!(session.host, "172.16.41.181");
        assert_eq!(session.username, "ubuntu");
        assert!(session.credential_ref.is_some());
    }

    #[test]
    fn tool_rounds_stop_after_five_model_tool_rounds() {
        let store = SqliteStore::open_in_memory().expect("store should open");
        let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
        let mut rounds = 0;

        let result = run_tool_rounds_sync(
            &store,
            &tools,
            vec![ProviderChatMessage {
                role: "user".to_string(),
                content: "持续读取会话列表".to_string(),
            }],
            None,
            "conversation-1",
            AiApprovalMode::Safe,
            |_| {
                rounds += 1;
                Ok(ProviderToolChatResponse {
                    message: format!("第 {rounds} 轮读取。"),
                    tool_calls: vec![ProviderToolCall {
                        id: format!("call-list-{rounds}"),
                        tool_id: "sessions.list".to_string(),
                        arguments: json!({}),
                        reason: None,
                    }],
                })
            },
        )
        .expect("tool loop should stop at max rounds");

        assert_eq!(rounds, MAX_TOOL_ROUNDS);
        assert_eq!(result.executed_invocations.len(), MAX_TOOL_ROUNDS);
        assert!(result.pending_invocations.is_empty());
        assert!(!result.final_message_from_model);
    }

    #[test]
    fn chat_with_provider_adds_llm_provider_from_user_curl_without_listing_only() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let credentials = CredentialService::with_secret_store(
            store.clone(),
            Arc::new(MemorySecretStore::default()),
        );
        credentials
            .save_ai_provider(AiProviderProfileDraft {
                id: Some("assistant-provider".to_string()),
                name: "Assistant Provider".to_string(),
                kind: AiProviderKind::OpenAiResponses,
                base_url: "http://assistant.test/v1".to_string(),
                model: "assistant-model".to_string(),
                api_key: None,
                api_key_ref: None,
                enabled: true,
                is_default: true,
            })
            .expect("assistant provider should save");
        let tools =
            AiToolService::with_credential_service(Arc::new(FakeToolWriter), credentials.clone());
        let message = r#"我有大模型，请求方式如下，将该大模型添加到应用里：
curl --request POST \
  --url http://172.16.41.254:30086/v1/chat/completions \
  --header 'Content-Type: application/json' \
  --data '{
    "model": "Qwen3.5-35B-A3B",
    "messages": [{"role": "user", "content": "你好"}],
    "chat_template_kwargs": {"enable_thinking": false}
  }'"#;

        let response = AiChatService
            .chat_with_provider(
                store.as_ref(),
                &credentials,
                &tools,
                AiChatRequest {
                    conversation_id: None,
                    message: message.to_string(),
                    approval_mode: Some(AiApprovalMode::Safe),
                    history: Vec::new(),
                    terminal_context: None,
                },
            )
            .expect("provider curl should be saved through direct tool path");

        assert_eq!(response.executed_invocations.len(), 1);
        assert_eq!(
            response.executed_invocations[0].tool_id,
            "llm_provider.create"
        );
        assert!(response.message.contains("LLM Provider 已保存"));
        let providers = list_ai_provider_profiles(store.as_ref()).expect("providers should list");
        let created = providers
            .iter()
            .find(|provider| provider.model == "Qwen3.5-35B-A3B")
            .expect("curl model should be added");
        assert_eq!(created.kind, AiProviderKind::OpenAiChat);
        assert_eq!(created.base_url, "http://172.16.41.254:30086/v1");
        assert!(created.enabled);
        assert!(!created.is_default);
    }
}
