// Author: Liz
use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::{
    error::{AppError, AppResult},
    models::{
        ai::AiToolDefinition,
        credential::{
            AiProviderDraftTestResult, AiProviderKind, AiProviderProfile, AiProviderTestResult,
        },
    },
    security::redaction::redact_sensitive,
    services::credential_service::CredentialService,
};

const RESPONSE_ERROR_EXCERPT_CHARS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderToolCall {
    pub id: String,
    pub tool_id: String,
    pub arguments: Value,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderToolChatResponse {
    pub message: String,
    pub tool_calls: Vec<ProviderToolCall>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderTextStreamResult {
    Complete(String),
    Cancelled(String),
}

pub fn select_enabled_provider(credentials: &CredentialService) -> AppResult<AiProviderProfile> {
    credentials
        .list_ai_providers()?
        .into_iter()
        .find(|profile| profile.enabled && profile.is_default)
        .or_else(|| {
            credentials
                .list_ai_providers()
                .ok()
                .and_then(|profiles| profiles.into_iter().find(|profile| profile.enabled))
        })
        .ok_or_else(|| AppError::validation("请先配置并启用 AI Provider"))
}

pub fn test_provider_sync(
    provider: &AiProviderProfile,
    api_key: &str,
) -> AppResult<AiProviderTestResult> {
    run_async(test_provider(provider, api_key))
}

pub fn test_provider_draft_sync(
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
) -> AppResult<AiProviderDraftTestResult> {
    run_async(test_provider_draft(provider, api_key, prompt))
}

pub fn run_tool_chat_sync(
    provider: &AiProviderProfile,
    api_key: &str,
    messages: &[ProviderChatMessage],
    tools: &[AiToolDefinition],
) -> AppResult<ProviderToolChatResponse> {
    run_async(generate_tool_chat(provider, api_key, messages, tools))
}

pub fn run_text_generation_sync(
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
) -> AppResult<String> {
    run_async(generate_text(provider, api_key, prompt))
}

pub async fn test_provider(
    provider: &AiProviderProfile,
    api_key: &str,
) -> AppResult<AiProviderTestResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| AppError::ai(error.to_string()))?;
    let response = send_provider_request(
        &client,
        provider,
        api_key,
        "ping",
        ProviderRequestMode::Text,
    )
    .await?;
    if response.status.is_success() {
        return Ok(AiProviderTestResult {
            ok: true,
            message: format!("Provider 测试通过：{}", provider.kind.as_str()),
        });
    }
    Ok(AiProviderTestResult {
        ok: false,
        message: format!(
            "Provider 返回 {}：{}",
            response.status,
            redact_sensitive(&response_error_excerpt(&response.body))
        ),
    })
}

pub async fn test_provider_draft(
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
) -> AppResult<AiProviderDraftTestResult> {
    let prompt = required_text("测试输入", prompt)?;
    let output = generate_text(provider, api_key, &prompt).await?;
    Ok(AiProviderDraftTestResult {
        ok: true,
        message: format!("模型测试通过：{}", provider.kind.as_str()),
        output,
    })
}

pub async fn generate_text(
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::ai(error.to_string()))?;
    let response = send_provider_request(
        &client,
        provider,
        api_key,
        prompt,
        ProviderRequestMode::Text,
    )
    .await?;
    if !response.status.is_success() {
        return Err(AppError::ai(format!(
            "LLM Provider 返回 {}：{}",
            response.status,
            redact_sensitive(&response_error_excerpt(&response.body))
        )));
    }
    let value = serde_json::from_str::<Value>(&response.body)
        .map_err(|error| AppError::ai(format!("LLM 响应不是有效 JSON: {error}")))?;
    extract_text(provider.kind, &value).ok_or_else(|| AppError::ai("LLM 响应中未找到文本内容"))
}

pub async fn generate_text_stream(
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
    mut cancel: oneshot::Receiver<()>,
    mut on_delta: impl FnMut(String) -> AppResult<()> + Send,
) -> AppResult<ProviderTextStreamResult> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::ai(error.to_string()))?;
    let mut response = send_provider_stream_request(&client, provider, api_key, prompt).await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))?;
        return Err(AppError::ai(format!(
            "LLM Provider 返回 {}：{}",
            status,
            redact_sensitive(&response_error_excerpt(&body))
        )));
    }

    let mut buffer = String::new();
    let mut output = String::new();
    loop {
        tokio::select! {
            _ = &mut cancel => {
                return Ok(ProviderTextStreamResult::Cancelled(output));
            }
            chunk = response.chunk() => {
                let Some(chunk) = chunk
                    .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))?
                else {
                    break;
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                for data in drain_sse_data(&mut buffer) {
                    if let Some(delta) = extract_stream_delta(provider.kind, &data)? {
                        output.push_str(&delta);
                        on_delta(delta)?;
                    }
                }
            }
        }
    }

    if !buffer.trim().is_empty() {
        for data in drain_remaining_sse_data(&mut buffer) {
            if let Some(delta) = extract_stream_delta(provider.kind, &data)? {
                output.push_str(&delta);
                on_delta(delta)?;
            }
        }
    }

    if output.trim().is_empty() {
        return Err(AppError::ai("LLM 响应中未找到文本内容"));
    }

    Ok(ProviderTextStreamResult::Complete(output))
}

pub async fn generate_tool_chat(
    provider: &AiProviderProfile,
    api_key: &str,
    messages: &[ProviderChatMessage],
    tools: &[AiToolDefinition],
) -> AppResult<ProviderToolChatResponse> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::ai(error.to_string()))?;
    let response = send_tool_request(&client, provider, api_key, messages, tools).await?;
    if !response.status.is_success() {
        return Err(AppError::ai(format!(
            "LLM Provider 返回 {}：{}",
            response.status,
            redact_sensitive(&response_error_excerpt(&response.body))
        )));
    }
    let value = serde_json::from_str::<Value>(&response.body)
        .map_err(|error| AppError::ai(format!("LLM 响应不是有效 JSON: {error}")))?;
    parse_tool_response(provider.kind, tools, &value)
}

struct ProviderResponse {
    status: StatusCode,
    body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderRequestMode {
    Text,
}

async fn send_provider_request(
    client: &reqwest::Client,
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
    mode: ProviderRequestMode,
) -> AppResult<ProviderResponse> {
    let request = match provider.kind {
        AiProviderKind::OpenAiChat => {
            let request = client.post(provider_endpoint(&provider.base_url, "chat/completions"));
            let request = apply_optional_bearer(request, api_key);
            request.json(&json!({
                "model": provider.model,
                "messages": [
                    { "role": "system", "content": system_prompt_for_mode(mode) },
                    { "role": "user", "content": prompt }
                ],
                "max_tokens": max_tokens_for_mode(mode),
                "temperature": 0.1
            }))
        }
        AiProviderKind::OpenAiResponses => {
            let request = client.post(provider_endpoint(&provider.base_url, "responses"));
            let request = apply_optional_bearer(request, api_key);
            request.json(&json!({
                "model": provider.model,
                "input": prompt,
                "max_output_tokens": max_tokens_for_mode(mode),
                "temperature": 0.1
            }))
        }
        AiProviderKind::Anthropic => client
            .post(provider_endpoint(&provider.base_url, "messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": provider.model,
                "max_tokens": max_tokens_for_mode(mode),
                "temperature": 0.1,
                "messages": [
                    { "role": "user", "content": prompt }
                ]
            })),
    };
    let response = request
        .send()
        .await
        .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))?;
    Ok(ProviderResponse { status, body })
}

async fn send_provider_stream_request(
    client: &reqwest::Client,
    provider: &AiProviderProfile,
    api_key: &str,
    prompt: &str,
) -> AppResult<reqwest::Response> {
    let request = match provider.kind {
        AiProviderKind::OpenAiChat => {
            let request = client.post(provider_endpoint(&provider.base_url, "chat/completions"));
            let request = apply_optional_bearer(request, api_key);
            request.json(&json!({
                "model": provider.model,
                "messages": [
                    { "role": "system", "content": system_prompt_for_mode(ProviderRequestMode::Text) },
                    { "role": "user", "content": prompt }
                ],
                "max_tokens": max_tokens_for_mode(ProviderRequestMode::Text),
                "temperature": 0.1,
                "stream": true
            }))
        }
        AiProviderKind::OpenAiResponses => {
            let request = client.post(provider_endpoint(&provider.base_url, "responses"));
            let request = apply_optional_bearer(request, api_key);
            request.json(&json!({
                "model": provider.model,
                "input": prompt,
                "max_output_tokens": max_tokens_for_mode(ProviderRequestMode::Text),
                "temperature": 0.1,
                "stream": true
            }))
        }
        AiProviderKind::Anthropic => client
            .post(provider_endpoint(&provider.base_url, "messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": provider.model,
                "max_tokens": max_tokens_for_mode(ProviderRequestMode::Text),
                "temperature": 0.1,
                "stream": true,
                "messages": [
                    { "role": "user", "content": prompt }
                ]
            })),
    };
    request
        .send()
        .await
        .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))
}

async fn send_tool_request(
    client: &reqwest::Client,
    provider: &AiProviderProfile,
    api_key: &str,
    messages: &[ProviderChatMessage],
    tools: &[AiToolDefinition],
) -> AppResult<ProviderResponse> {
    let request = match provider.kind {
        AiProviderKind::OpenAiChat => {
            let request = client.post(provider_endpoint(&provider.base_url, "chat/completions"));
            let request = apply_optional_bearer(request, api_key);
            request.json(&json!({
                "model": provider.model,
                "messages": openai_chat_messages(messages),
                "tools": openai_chat_tools(tools),
                "tool_choice": "auto",
                "max_tokens": 768,
                "temperature": 0.1
            }))
        }
        AiProviderKind::OpenAiResponses => {
            let request = client.post(provider_endpoint(&provider.base_url, "responses"));
            let request = apply_optional_bearer(request, api_key);
            request.json(&json!({
                "model": provider.model,
                "input": openai_responses_input(messages),
                "tools": openai_responses_tools(tools),
                "max_output_tokens": 768,
                "temperature": 0.1
            }))
        }
        AiProviderKind::Anthropic => {
            let (system, anthropic_messages) = anthropic_messages(messages);
            let mut body = json!({
                "model": provider.model,
                "max_tokens": 768,
                "temperature": 0.1,
                "messages": anthropic_messages,
                "tools": anthropic_tools(tools)
            });
            if !system.is_empty() {
                body["system"] = Value::String(system);
            }
            client
                .post(provider_endpoint(&provider.base_url, "messages"))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
        }
    };
    let response = request
        .send()
        .await
        .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::ai(redact_sensitive(&error.to_string())))?;
    Ok(ProviderResponse { status, body })
}

fn openai_chat_messages(messages: &[ProviderChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            json!({
                "role": normalize_provider_role(&message.role),
                "content": message.content
            })
        })
        .collect()
}

fn openai_responses_input(messages: &[ProviderChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            json!({
                "role": normalize_provider_role(&message.role),
                "content": message.content
            })
        })
        .collect()
}

fn anthropic_messages(messages: &[ProviderChatMessage]) -> (String, Vec<Value>) {
    let system = messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut items = messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| {
            let role = if message.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            json!({ "role": role, "content": message.content })
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        items.push(json!({ "role": "user", "content": "" }));
    }
    (system, items)
}

fn normalize_provider_role(role: &str) -> &str {
    match role {
        "system" | "assistant" => role,
        _ => "user",
    }
}

fn openai_chat_tools(tools: &[AiToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "function": {
                    "name": tool_wire_name(&tool.id),
                    "description": format!("{}。风险等级：{}。", tool.description, tool.risk_level.as_str()),
                    "parameters": tool_parameters(tool)
                }
            })
        })
        .collect()
}

fn openai_responses_tools(tools: &[AiToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool_wire_name(&tool.id),
                "description": format!("{}。风险等级：{}。", tool.description, tool.risk_level.as_str()),
                "parameters": tool_parameters(tool)
            })
        })
        .collect()
}

fn anthropic_tools(tools: &[AiToolDefinition]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool_wire_name(&tool.id),
                "description": format!("{}。风险等级：{}。", tool.description, tool.risk_level.as_str()),
                "input_schema": tool_parameters(tool)
            })
        })
        .collect()
}

fn tool_parameters(tool: &AiToolDefinition) -> Value {
    if tool.id == "terminal.write" {
        return json!({
            "type": "object",
            "properties": {
                "runtime_session_id": { "type": "string" },
                "data": { "type": "string", "description": "写入终端的数据，通常以回车结尾。" },
                "pane_id": { "type": "string" },
                "saved_session_id": { "type": "string" },
                "target_title": { "type": "string" },
                "cwd": { "type": "string" }
            },
            "required": ["runtime_session_id", "data"],
            "additionalProperties": true
        });
    }
    if tool.id == "terminal.list" {
        return json!({
            "type": "object",
            "properties": {
                "saved_session_id": { "type": "string" }
            },
            "additionalProperties": false
        });
    }
    if tool.id == "terminal.open" {
        return json!({
            "type": "object",
            "properties": {
                "saved_session_id": { "type": "string" }
            },
            "required": ["saved_session_id"],
            "additionalProperties": false
        });
    }
    if tool.id == "terminal.read" {
        return json!({
            "type": "object",
            "properties": {
                "runtime_session_id": { "type": "string" },
                "cursor": { "type": "integer", "minimum": 0 },
                "max_chars": { "type": "integer", "minimum": 1, "maximum": 4000 }
            },
            "required": ["runtime_session_id"],
            "additionalProperties": false
        });
    }
    if tool.id == "terminal.close" {
        return json!({
            "type": "object",
            "properties": {
                "runtime_session_id": { "type": "string" }
            },
            "required": ["runtime_session_id"],
            "additionalProperties": false
        });
    }
    if tool.id == "ssh.execute" {
        return json!({
            "type": "object",
            "properties": {
                "saved_session_id": { "type": "string" },
                "script": { "type": "string", "maxLength": 16384 }
            },
            "required": ["saved_session_id", "script"],
            "additionalProperties": false
        });
    }
    if tool.id == "history.search" {
        return json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" },
                "scope_kind": { "type": "string", "enum": ["saved_session", "local_profile"] },
                "scope_id": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
            },
            "required": ["scope_kind", "scope_id"],
            "additionalProperties": false
        });
    }
    if tool.id == "history.clear" {
        return json!({
            "type": "object",
            "properties": {
                "scope_kind": { "type": "string", "enum": ["saved_session", "local_profile"] },
                "scope_id": { "type": "string" }
            },
            "required": ["scope_kind", "scope_id"],
            "additionalProperties": false
        });
    }
    if matches!(tool.id.as_str(), "sessions.list" | "llm_provider.list") {
        return json!({
            "type": "object",
            "properties": {
                "query": { "type": "string" }
            },
            "additionalProperties": false
        });
    }
    if matches!(
        tool.id.as_str(),
        "llm_provider.create" | "llm_provider.update"
    ) {
        return json!({
            "type": "object",
            "properties": {
                "draft": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string" },
                        "kind": {
                            "type": "string",
                            "enum": ["openai_chat", "openai_responses", "anthropic"],
                            "description": "/v1/chat/completions 使用 openai_chat，/v1/responses 使用 openai_responses。"
                        },
                        "base_url": {
                            "type": "string",
                            "description": "Provider 根 URL；完整 /v1/chat/completions 会保存为去掉 /chat/completions 后的 /v1。"
                        },
                        "model": { "type": "string" },
                        "enabled": { "type": "boolean" },
                        "is_default": { "type": "boolean" }
                    },
                    "required": ["name", "kind", "base_url", "model", "enabled"],
                    "additionalProperties": true
                },
                "curl": {
                    "type": "string",
                    "description": "用户提供的 curl 请求原文；工具会解析 URL 和 model。不要包含 API Key。"
                },
                "url": { "type": "string" },
                "model": { "type": "string" },
                "name": { "type": "string" },
                "kind": {
                    "type": "string",
                    "enum": ["openai_chat", "openai_responses", "anthropic"]
                }
            },
            "additionalProperties": false
        });
    }
    if tool.id == "sessions.save" {
        return json!({
            "type": "object",
            "properties": {
                "draft": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "更新已有连接时填写；新建连接时省略。"
                        },
                        "name": {
                            "type": "string",
                            "description": "连接显示名称；如果用户未指定名称，使用主机名或 IP。不要把密码填到 name。"
                        },
                        "type": {
                            "type": "string",
                            "enum": ["ssh", "local", "rdp"],
                            "description": "连接类型；远程 Linux/服务器连接通常使用 ssh。"
                        },
                        "group_id": {
                            "type": ["string", "null"],
                            "description": "已有分组 ID；不知道时优先填写 group_name。"
                        },
                        "group_name": {
                            "type": "string",
                            "description": "现有分组名称；不知道 group_id 但用户指定分组名时填写，工具会解析为已有分组。"
                        },
                        "host": {
                            "type": "string",
                            "description": "SSH/RDP 主机名或 IP。"
                        },
                        "port": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 65535,
                            "description": "端口；SSH 默认 22，RDP 默认 3389。"
                        },
                        "username": {
                            "type": "string",
                            "description": "登录用户名。"
                        },
                        "auth_mode": {
                            "type": "string",
                            "enum": ["password", "key", "agent", "none"],
                            "description": "认证方式；提供密码时填 password。"
                        },
                        "password": {
                            "type": "string",
                            "description": "用户提供的 SSH/RDP 登录密码必须填在这里；工具会写入本机凭据存储，不进入 SQLite。"
                        },
                        "url": {
                            "type": "string",
                            "description": "可选 ssh:// 或 rdp:// 连接 URL；可包含用户名、密码、主机和端口。"
                        },
                        "description": { "type": ["string", "null"] },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "sort_order": { "type": "integer" }
                    },
                    "required": ["name", "type"],
                    "additionalProperties": true
                },
                "group_name": {
                    "type": "string",
                    "description": "现有分组名称；等价于 draft.group_name。"
                },
                "url": {
                    "type": "string",
                    "description": "可选 ssh:// 或 rdp:// 连接 URL。"
                },
                "username": {
                    "type": "string",
                    "description": "登录用户名；draft.username 缺失时使用。"
                },
                "password": {
                    "type": "string",
                    "description": "一次性登录密码；draft.password 缺失时使用。"
                }
            },
            "required": ["draft"],
            "additionalProperties": false
        });
    }
    if tool.id == "session_groups.save" {
        return json!({
            "type": "object",
            "properties": {
                "draft": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "更新已有分组时填写；新建分组时省略。"
                        },
                        "parent_id": {
                            "type": ["string", "null"],
                            "description": "父分组 ID；创建顶层分组时填 null 或省略。"
                        },
                        "name": {
                            "type": "string",
                            "description": "分组名称，例如 移动机房。"
                        },
                        "expanded": {
                            "type": "boolean",
                            "description": "分组是否默认展开。"
                        },
                        "sort_order": {
                            "type": "integer",
                            "description": "同级排序值；不确定时填 0。"
                        }
                    },
                    "required": ["name"],
                    "additionalProperties": false
                }
            },
            "required": ["draft"],
            "additionalProperties": false
        });
    }
    json!({
        "type": "object",
        "properties": {},
        "additionalProperties": true
    })
}

fn parse_tool_response(
    kind: AiProviderKind,
    tools: &[AiToolDefinition],
    value: &Value,
) -> AppResult<ProviderToolChatResponse> {
    match kind {
        AiProviderKind::OpenAiChat => Ok(parse_openai_chat_tool_response(tools, value)),
        AiProviderKind::OpenAiResponses => Ok(parse_openai_responses_tool_response(tools, value)),
        AiProviderKind::Anthropic => Ok(parse_anthropic_tool_response(tools, value)),
    }
}

fn parse_openai_chat_tool_response(
    tools: &[AiToolDefinition],
    value: &Value,
) -> ProviderToolChatResponse {
    let message = value.pointer("/choices/0/message").unwrap_or(&Value::Null);
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let function = item.get("function")?;
                    let name = function.get("name").and_then(Value::as_str)?;
                    Some(ProviderToolCall {
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool-call")
                            .to_string(),
                        tool_id: tool_id_from_wire_name(name, tools),
                        arguments: parse_tool_arguments(function.get("arguments")),
                        reason: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ProviderToolChatResponse {
        message: text,
        tool_calls,
    }
}

fn parse_openai_responses_tool_response(
    tools: &[AiToolDefinition],
    value: &Value,
) -> ProviderToolChatResponse {
    let message = extract_openai_responses_text(value).unwrap_or_default();
    let tool_calls = value
        .get("output")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
                .filter_map(|item| {
                    let name = item.get("name").and_then(Value::as_str)?;
                    Some(ProviderToolCall {
                        id: item
                            .get("call_id")
                            .or_else(|| item.get("id"))
                            .and_then(Value::as_str)
                            .unwrap_or("tool-call")
                            .to_string(),
                        tool_id: tool_id_from_wire_name(name, tools),
                        arguments: parse_tool_arguments(item.get("arguments")),
                        reason: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ProviderToolChatResponse {
        message,
        tool_calls,
    }
}

fn parse_anthropic_tool_response(
    tools: &[AiToolDefinition],
    value: &Value,
) -> ProviderToolChatResponse {
    let content = value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let message = content
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let tool_calls = content
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|part| {
            let name = part.get("name").and_then(Value::as_str)?;
            Some(ProviderToolCall {
                id: part
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("tool-call")
                    .to_string(),
                tool_id: tool_id_from_wire_name(name, tools),
                arguments: part.get("input").cloned().unwrap_or_else(|| json!({})),
                reason: None,
            })
        })
        .collect::<Vec<_>>();
    ProviderToolChatResponse {
        message,
        tool_calls,
    }
}

fn parse_tool_arguments(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => {
            serde_json::from_str::<Value>(text).unwrap_or_else(|_| json!({}))
        }
        Some(Value::Object(_)) => value.cloned().unwrap_or_else(|| json!({})),
        Some(other) => json!({ "value": other }),
        None => json!({}),
    }
}

fn tool_wire_name(tool_id: &str) -> String {
    tool_id.replace('.', "__")
}

fn tool_id_from_wire_name(name: &str, tools: &[AiToolDefinition]) -> String {
    tools
        .iter()
        .find(|tool| tool_wire_name(&tool.id) == name)
        .map(|tool| tool.id.clone())
        .unwrap_or_else(|| name.replace("__", "."))
}

fn response_error_excerpt(body: &str) -> String {
    body.chars().take(RESPONSE_ERROR_EXCERPT_CHARS).collect()
}

fn system_prompt_for_mode(mode: ProviderRequestMode) -> &'static str {
    match mode {
        ProviderRequestMode::Text => "Return a concise plain text response.",
    }
}

fn max_tokens_for_mode(mode: ProviderRequestMode) -> u16 {
    match mode {
        ProviderRequestMode::Text => 512,
    }
}

fn extract_text(kind: AiProviderKind, value: &Value) -> Option<String> {
    match kind {
        AiProviderKind::OpenAiChat => value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        AiProviderKind::OpenAiResponses => extract_openai_responses_text(value),
        AiProviderKind::Anthropic => value
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    }
}

fn extract_stream_delta(kind: AiProviderKind, data: &str) -> AppResult<Option<String>> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(None);
    }
    let value = serde_json::from_str::<Value>(data)
        .map_err(|error| AppError::ai(format!("LLM 流式响应不是有效 JSON: {error}")))?;
    let delta = match kind {
        AiProviderKind::OpenAiChat => value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        AiProviderKind::OpenAiResponses => {
            if value.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
                value
                    .get("delta")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            } else {
                None
            }
        }
        AiProviderKind::Anthropic => {
            if value.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                value
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            } else {
                None
            }
        }
    };
    Ok(delta)
}

fn drain_sse_data(buffer: &mut String) -> Vec<String> {
    let mut events = Vec::new();
    while let Some((index, separator_len)) = find_sse_separator(buffer) {
        let frame = buffer[..index].to_string();
        buffer.drain(..index + separator_len);
        if let Some(data) = sse_frame_data(&frame) {
            events.push(data);
        }
    }
    events
}

fn drain_remaining_sse_data(buffer: &mut String) -> Vec<String> {
    let frame = std::mem::take(buffer);
    sse_frame_data(&frame).into_iter().collect()
}

fn find_sse_separator(buffer: &str) -> Option<(usize, usize)> {
    let lf = buffer.find("\n\n").map(|index| (index, 2));
    let crlf = buffer.find("\r\n\r\n").map(|index| (index, 4));
    match (lf, crlf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn sse_frame_data(frame: &str) -> Option<String> {
    let lines = frame
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            line.strip_prefix("data:")
                .map(|data| data.trim_start().to_string())
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn extract_openai_responses_text(value: &Value) -> Option<String> {
    if let Some(text) = value.pointer("/output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    let output = value.get("output")?.as_array()?;
    for item in output {
        let Some(content) = item.get("content") else {
            continue;
        };
        if let Some(text) = extract_openai_output_content_text(content) {
            return Some(text);
        }
    }
    None
}

fn extract_openai_output_content_text(content: &Value) -> Option<String> {
    match content {
        Value::Array(parts) => parts.iter().find_map(extract_openai_output_part_text),
        Value::Object(_) => extract_openai_output_part_text(content),
        _ => None,
    }
}

fn extract_openai_output_part_text(part: &Value) -> Option<String> {
    if part.get("type").and_then(Value::as_str) == Some("output_text") {
        return part
            .get("text")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
    }
    None
}

fn provider_endpoint(base_url: &str, path: &str) -> String {
    let trimmed_base = base_url.trim_end_matches('/');
    let trimmed_path = path.trim_start_matches('/');
    if trimmed_base.ends_with(trimmed_path) {
        return trimmed_base.to_string();
    }
    format!("{}/{}", trimmed_base, trimmed_path)
}

fn apply_optional_bearer(
    request: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn run_async<T>(future: impl std::future::Future<Output = AppResult<T>>) -> AppResult<T> {
    tokio::runtime::Runtime::new()
        .map_err(|error| AppError::ai(error.to_string()))?
        .block_on(future)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::{
        extract_stream_delta, extract_text, openai_responses_tools, parse_tool_response,
        select_enabled_provider,
    };
    use crate::models::{
        ai::{AiToolDefinition, RiskLevel},
        credential::{AiProviderKind, AiProviderProfileDraft},
    };
    use crate::services::credential_service::{CredentialService, MemorySecretStore};
    use crate::storage::sqlite::SqliteStore;

    #[test]
    fn responses_text_extraction_scans_all_output_message_content() {
        let response = json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                {
                    "type": "message",
                    "content": [
                        { "type": "output_text", "text": "pwd" }
                    ]
                }
            ]
        });

        assert_eq!(
            extract_text(AiProviderKind::OpenAiResponses, &response),
            Some("pwd".to_string())
        );
    }

    #[test]
    fn responses_text_extraction_accepts_single_content_object() {
        let response = json!({
            "output": [
                { "type": "reasoning", "content": [] },
                {
                    "type": "message",
                    "content": {
                        "type": "output_text",
                        "text": "Spark uses a driver and executors."
                    }
                }
            ]
        });

        assert_eq!(
            extract_text(AiProviderKind::OpenAiResponses, &response),
            Some("Spark uses a driver and executors.".to_string())
        );
    }

    #[test]
    fn chat_completions_tool_response_maps_function_name_back_to_tool_id() {
        let response = json!({
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {
                                    "name": "terminal__write",
                                    "arguments": "{\"runtime_session_id\":\"runtime-1\",\"data\":\"pwd\\r\"}"
                                }
                            }
                        ]
                    }
                }
            ]
        });

        let parsed = parse_tool_response(AiProviderKind::OpenAiChat, &tool_defs(), &response)
            .expect("tool response should parse");

        assert_eq!(parsed.tool_calls[0].tool_id, "terminal.write");
        assert_eq!(
            parsed.tool_calls[0].arguments["runtime_session_id"],
            "runtime-1"
        );
    }

    #[test]
    fn responses_tool_schema_is_flat_and_response_tool_call_parses_arguments() {
        let tools = tool_defs();
        let tool_schema = openai_responses_tools(&tools);
        assert_eq!(tool_schema[0]["type"], "function");
        assert_eq!(tool_schema[0]["name"], "terminal__write");
        assert!(tool_schema[0].get("function").is_none());

        let response = json!({
            "output": [
                {
                    "type": "function_call",
                    "call_id": "call-2",
                    "name": "terminal__write",
                    "arguments": "{\"runtime_session_id\":\"runtime-1\",\"data\":\"whoami\\r\"}"
                }
            ]
        });

        let parsed = parse_tool_response(AiProviderKind::OpenAiResponses, &tools, &response)
            .expect("responses tool call should parse");

        assert_eq!(parsed.tool_calls[0].id, "call-2");
        assert_eq!(parsed.tool_calls[0].tool_id, "terminal.write");
        assert_eq!(parsed.tool_calls[0].arguments["data"], "whoami\r");
    }

    #[test]
    fn terminal_and_ssh_tool_schemas_expose_operational_arguments() {
        let tools = [
            ("terminal.list", RiskLevel::Low),
            ("terminal.open", RiskLevel::Medium),
            ("terminal.read", RiskLevel::Low),
            ("terminal.close", RiskLevel::Medium),
            ("ssh.execute", RiskLevel::High),
        ]
        .into_iter()
        .map(|(id, risk_level)| AiToolDefinition {
            id: id.to_string(),
            title: id.to_string(),
            description: id.to_string(),
            risk_level,
            requires_confirmation: false,
        })
        .collect::<Vec<_>>();
        let schemas = openai_responses_tools(&tools);

        assert_eq!(
            schemas[1]["parameters"]["required"],
            json!(["saved_session_id"])
        );
        assert_eq!(
            schemas[2]["parameters"]["required"],
            json!(["runtime_session_id"])
        );
        assert_eq!(
            schemas[3]["parameters"]["required"],
            json!(["runtime_session_id"])
        );
        assert_eq!(
            schemas[4]["parameters"]["required"],
            json!(["saved_session_id", "script"])
        );
    }

    #[test]
    fn session_group_save_tool_schema_exposes_required_draft_fields() {
        let tools = vec![AiToolDefinition {
            id: "session_groups.save".to_string(),
            title: "保存会话分组".to_string(),
            description: "新增或更新会话分组".to_string(),
            risk_level: RiskLevel::Medium,
            requires_confirmation: false,
        }];

        let chat_schema = super::openai_chat_tools(&tools);
        let chat_parameters = &chat_schema[0]["function"]["parameters"];
        assert_eq!(chat_parameters["required"], json!(["draft"]));
        assert_eq!(
            chat_parameters["properties"]["draft"]["required"],
            json!(["name"])
        );
        assert_eq!(
            chat_parameters["properties"]["draft"]["properties"]["name"]["description"],
            "分组名称，例如 移动机房。"
        );

        let responses_schema = openai_responses_tools(&tools);
        assert_eq!(
            responses_schema[0]["parameters"]["properties"]["draft"]["properties"]["name"]["type"],
            "string"
        );
    }

    #[test]
    fn session_save_tool_schema_exposes_connection_and_group_name_fields() {
        let tools = vec![AiToolDefinition {
            id: "sessions.save".to_string(),
            title: "保存会话".to_string(),
            description: "新增或更新 SSH/Local/RDP 会话配置".to_string(),
            risk_level: RiskLevel::Medium,
            requires_confirmation: false,
        }];

        let chat_schema = super::openai_chat_tools(&tools);
        let draft_properties =
            &chat_schema[0]["function"]["parameters"]["properties"]["draft"]["properties"];
        assert_eq!(
            draft_properties["type"]["enum"],
            json!(["ssh", "local", "rdp"])
        );
        assert_eq!(
            draft_properties["group_name"]["description"],
            "现有分组名称；不知道 group_id 但用户指定分组名时填写，工具会解析为已有分组。"
        );
        assert_eq!(
            draft_properties["name"]["description"],
            "连接显示名称；如果用户未指定名称，使用主机名或 IP。不要把密码填到 name。"
        );
        assert_eq!(
            draft_properties["password"]["description"],
            "用户提供的 SSH/RDP 登录密码必须填在这里；工具会写入本机凭据存储，不进入 SQLite。"
        );

        let responses_schema = openai_responses_tools(&tools);
        assert_eq!(
            responses_schema[0]["parameters"]["properties"]["draft"]["required"],
            json!(["name", "type"])
        );
    }

    #[test]
    fn llm_provider_create_tool_schema_exposes_curl_and_chat_fields() {
        let tools = vec![AiToolDefinition {
            id: "llm_provider.create".to_string(),
            title: "创建 LLM Provider".to_string(),
            description: "新增模型 Provider 配置".to_string(),
            risk_level: RiskLevel::Medium,
            requires_confirmation: false,
        }];

        let chat_schema = super::openai_chat_tools(&tools);
        let parameters = &chat_schema[0]["function"]["parameters"];
        assert_eq!(
            parameters["properties"]["draft"]["properties"]["kind"]["enum"],
            json!(["openai_chat", "openai_responses", "anthropic"])
        );
        assert!(parameters["properties"]["curl"]["description"]
            .as_str()
            .unwrap_or_default()
            .contains("curl 请求原文"));
        assert!(
            parameters["properties"]["draft"]["properties"]["base_url"]["description"]
                .as_str()
                .unwrap_or_default()
                .contains("/chat/completions")
        );
    }

    #[test]
    fn anthropic_tool_response_parses_tool_use_input() {
        let response = json!({
            "content": [
                { "type": "text", "text": "我会读取当前目录。" },
                {
                    "type": "tool_use",
                    "id": "toolu-1",
                    "name": "terminal__write",
                    "input": { "runtime_session_id": "runtime-1", "data": "pwd\r" }
                }
            ]
        });

        let parsed = parse_tool_response(AiProviderKind::Anthropic, &tool_defs(), &response)
            .expect("anthropic tool use should parse");

        assert!(parsed.message.contains("读取当前目录"));
        assert_eq!(parsed.tool_calls[0].tool_id, "terminal.write");
        assert_eq!(parsed.tool_calls[0].arguments["data"], "pwd\r");
    }

    #[test]
    fn chat_messages_downgrade_persisted_tool_context_to_user_role() {
        let messages = super::openai_chat_messages(&[super::ProviderChatMessage {
            role: "tool".to_string(),
            content: "工具结果：done".to_string(),
        }]);

        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "工具结果：done");
    }

    #[test]
    fn provider_endpoint_accepts_base_url_or_full_endpoint() {
        assert_eq!(
            super::provider_endpoint("http://example.test/v1", "responses"),
            "http://example.test/v1/responses"
        );
        assert_eq!(
            super::provider_endpoint("http://example.test/v1/responses", "responses"),
            "http://example.test/v1/responses"
        );
    }

    #[test]
    fn stream_delta_extracts_openai_chat_content() {
        let delta = extract_stream_delta(
            AiProviderKind::OpenAiChat,
            r#"{"choices":[{"delta":{"content":"pong"}}]}"#,
        )
        .expect("chat stream chunk should parse");

        assert_eq!(delta.as_deref(), Some("pong"));
    }

    #[test]
    fn stream_delta_extracts_openai_responses_output_text_delta() {
        let delta = extract_stream_delta(
            AiProviderKind::OpenAiResponses,
            r#"{"type":"response.output_text.delta","delta":"pong"}"#,
        )
        .expect("responses stream chunk should parse");

        assert_eq!(delta.as_deref(), Some("pong"));
    }

    #[test]
    fn stream_delta_extracts_anthropic_text_delta() {
        let delta = extract_stream_delta(
            AiProviderKind::Anthropic,
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}"#,
        )
        .expect("anthropic stream chunk should parse");

        assert_eq!(delta.as_deref(), Some("pong"));
    }

    #[test]
    fn stream_delta_ignores_done_marker_and_non_text_events() {
        assert_eq!(
            extract_stream_delta(AiProviderKind::OpenAiChat, "[DONE]")
                .expect("done marker should be accepted"),
            None
        );
        assert_eq!(
            extract_stream_delta(
                AiProviderKind::OpenAiResponses,
                r#"{"type":"response.created","response":{"id":"resp_1"}}"#,
            )
            .expect("non text responses event should be accepted"),
            None
        );
    }

    #[test]
    fn select_enabled_provider_prefers_enabled_default_provider() {
        let credentials = credential_service_with_providers(&[
            ("disabled-default", false, true),
            ("enabled-a", true, false),
            ("enabled-default", true, true),
        ]);

        let selected =
            select_enabled_provider(&credentials).expect("enabled default provider should select");

        assert_eq!(selected.id, "enabled-default");
    }

    #[test]
    fn select_enabled_provider_uses_first_enabled_provider_when_no_default_is_enabled() {
        let credentials = credential_service_with_providers(&[
            ("disabled-default", false, true),
            ("enabled-a", true, false),
            ("enabled-b", true, false),
        ]);

        let selected =
            select_enabled_provider(&credentials).expect("first enabled provider should select");

        assert_eq!(selected.id, "enabled-a");
    }

    #[test]
    fn select_enabled_provider_rejects_when_no_provider_is_enabled() {
        let credentials = credential_service_with_providers(&[
            ("disabled-a", false, false),
            ("disabled-default", false, true),
        ]);

        let error = select_enabled_provider(&credentials)
            .expect_err("missing enabled provider should fail");

        assert!(error.to_string().contains("请先配置并启用 AI Provider"));
    }

    fn tool_defs() -> Vec<AiToolDefinition> {
        vec![AiToolDefinition {
            id: "terminal.write".to_string(),
            title: "写入终端".to_string(),
            description: "向指定运行终端写入输入".to_string(),
            risk_level: RiskLevel::High,
            requires_confirmation: true,
        }]
    }

    fn credential_service_with_providers(providers: &[(&str, bool, bool)]) -> CredentialService {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let credentials =
            CredentialService::with_secret_store(store, Arc::new(MemorySecretStore::default()));
        for (id, enabled, is_default) in providers {
            credentials
                .save_ai_provider(AiProviderProfileDraft {
                    id: Some((*id).to_string()),
                    name: (*id).to_string(),
                    kind: AiProviderKind::OpenAiResponses,
                    base_url: "http://example.test/v1".to_string(),
                    model: "gpt-test".to_string(),
                    api_key: None,
                    api_key_ref: None,
                    enabled: *enabled,
                    is_default: *is_default,
                })
                .expect("provider should save");
        }
        credentials
    }
}
