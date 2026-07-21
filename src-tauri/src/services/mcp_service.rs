// Author: Liz
use std::{
    collections::HashMap,
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::ai::{AiApprovalMode, AiToolAuditRecord, AiToolPrepareRequest, RiskLevel},
    services::{
        ai_tool_service::AiToolService,
        credential_service::{SecretStore, SystemSecretStore},
    },
    storage::{ai::get_ai_connection_approval_mode, sqlite::SqliteStore},
};

const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const MCP_PATH: &str = "/mcp";
const MCP_TOKEN_ENV_VAR: &str = "ZTERM_MCP_TOKEN";
const MCP_TOKEN_SECRET_REF: &str = "mcp:bearer-token";
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
pub const DEFAULT_MCP_PORT: u16 = 9419;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct McpToolDefinition {
    pub id: String,
    pub title: String,
    pub description: String,
    pub risk_level: RiskLevel,
    pub requires_confirmation: bool,
    pub input_schema: Value,
}

#[derive(Clone)]
struct McpContext {
    storage: Arc<SqliteStore>,
    tools: AiToolService,
    token: Arc<Mutex<String>>,
}

pub struct McpService {
    runtime: Mutex<Option<McpRuntime>>,
    secret_store: Arc<dyn SecretStore>,
}

struct McpRuntime {
    endpoint: String,
    token: Arc<Mutex<String>>,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug, Clone)]
pub struct McpHttpRequest {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpHttpResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

impl McpService {
    pub fn with_secret_store(secret_store: Arc<dyn SecretStore>) -> Self {
        Self {
            runtime: Mutex::new(None),
            secret_store,
        }
    }

    pub async fn start(
        &self,
        storage: Arc<SqliteStore>,
        tools: AiToolService,
        port: Option<u16>,
    ) -> AppResult<McpServerStatus> {
        if let Some(status) = self.status() {
            return Ok(status);
        }

        let token_value = self.load_or_create_token()?;
        let listener = bind_mcp_listener(configured_mcp_port(port))
            .await
            .map_err(|error| AppError::ai(format!("MCP 服务绑定失败: {error}")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|error| AppError::ai(format!("MCP 服务地址读取失败: {error}")))?;
        let endpoint = format!("http://127.0.0.1:{}{MCP_PATH}", local_addr.port());
        let token = Arc::new(Mutex::new(token_value.clone()));
        let context = McpContext {
            storage,
            tools,
            token: Arc::clone(&token),
        };
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, peer_addr)) = accepted else {
                            continue;
                        };
                        if !peer_addr.ip().is_loopback() {
                            continue;
                        }
                        let context = context.clone();
                        tokio::spawn(async move {
                            let _ = handle_connection(stream, context).await;
                        });
                    }
                }
            }
        });

        let status = McpServerStatus {
            enabled: true,
            endpoint: Some(endpoint.clone()),
            token: Some(token_value),
        };
        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::ai("MCP runtime lock was poisoned"))?;
        *guard = Some(McpRuntime {
            endpoint,
            token,
            shutdown: Some(shutdown_tx),
        });
        Ok(status)
    }

    pub fn stop(&self) -> AppResult<McpServerStatus> {
        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::ai("MCP runtime lock was poisoned"))?;
        if let Some(mut runtime) = guard.take() {
            if let Some(shutdown) = runtime.shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        Ok(McpServerStatus {
            enabled: false,
            endpoint: None,
            token: None,
        })
    }

    pub fn rotate_token(&self) -> AppResult<McpServerStatus> {
        let guard = self
            .runtime
            .lock()
            .map_err(|_| AppError::ai("MCP runtime lock was poisoned"))?;
        let Some(runtime) = guard.as_ref() else {
            return Ok(McpServerStatus {
                enabled: false,
                endpoint: None,
                token: None,
            });
        };
        let token = generate_token();
        self.secret_store.set_secret(MCP_TOKEN_SECRET_REF, &token)?;
        *runtime
            .token
            .lock()
            .map_err(|_| AppError::ai("MCP token lock was poisoned"))? = token.clone();
        Ok(McpServerStatus {
            enabled: true,
            endpoint: Some(runtime.endpoint.clone()),
            token: Some(token),
        })
    }

    fn load_or_create_token(&self) -> AppResult<String> {
        match self.secret_store.get_secret(MCP_TOKEN_SECRET_REF) {
            Ok(token) if !token.trim().is_empty() => Ok(token),
            Ok(_) | Err(AppError::NotFound(_)) => {
                let token = env::var(MCP_TOKEN_ENV_VAR)
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(generate_token);
                self.secret_store.set_secret(MCP_TOKEN_SECRET_REF, &token)?;
                Ok(token)
            }
            Err(error) => Err(error),
        }
    }

    pub fn status(&self) -> Option<McpServerStatus> {
        let guard = self.runtime.lock().ok()?;
        let runtime = guard.as_ref()?;
        let token = runtime.token.lock().ok()?.clone();
        Some(McpServerStatus {
            enabled: true,
            endpoint: Some(runtime.endpoint.clone()),
            token: Some(token),
        })
    }
}

impl Default for McpService {
    fn default() -> Self {
        Self::with_secret_store(Arc::new(SystemSecretStore))
    }
}

pub async fn handle_http_request(
    storage: Arc<SqliteStore>,
    tools: AiToolService,
    token: &str,
    request: McpHttpRequest,
) -> AppResult<McpHttpResponse> {
    if request.path != MCP_PATH {
        return Ok(json_response(404, json!({ "error": "not_found" })));
    }
    if !origin_is_allowed(header(&request.headers, "origin")) {
        return Ok(json_response(403, json!({ "error": "origin_forbidden" })));
    }
    if header(&request.headers, "authorization").as_deref()
        != Some(format!("Bearer {token}").as_str())
    {
        return Ok(json_response(401, json!({ "error": "unauthorized" })));
    }
    if request.method != "POST" {
        return Ok(json_response(405, json!({ "error": "method_not_allowed" })));
    }
    let body = serde_json::from_slice::<Value>(&request.body)
        .map_err(|error| AppError::ai(format!("MCP 请求不是有效 JSON: {error}")))?;
    let response = handle_json_rpc(storage.as_ref(), &tools, body)?;
    Ok(json_response(200, response))
}

fn handle_json_rpc(store: &SqliteStore, tools: &AiToolService, body: Value) -> AppResult<Value> {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "zTerm", "version": env!("CARGO_PKG_VERSION") }
        }),
        "tools/list" => {
            let tools = mcp_tool_catalog()
                .into_iter()
                .map(|tool| {
                    json!({
                        "name": tool.id,
                        "title": tool.title,
                        "description": tool.description,
                        "inputSchema": tool.input_schema
                    })
                })
                .collect::<Vec<_>>();
            json!({ "tools": tools })
        }
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::validation("MCP tools/call 缺少 name"))?;
            if !mcp_tool_catalog().iter().any(|tool| tool.id == name) {
                return Ok(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": format!("tool not exposed by zTerm MCP: {name}")
                    }
                }));
            }
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if mcp_contains_plaintext_secret(&arguments) {
                return Ok(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32602,
                        "message": "MCP tool arguments must not contain plaintext secrets; provide authentication in zTerm"
                    }
                }));
            }
            if let Err(message) = validate_mcp_arguments(name, &arguments) {
                return Ok(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": message }
                }));
            }
            let mapped_name = match name {
                "llm_provider.save"
                    if arguments
                        .pointer("/draft/id")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty()) =>
                {
                    "llm_provider.update"
                }
                "llm_provider.save" => "llm_provider.create",
                _ => name,
            };
            match mcp_tool_call_result(store, tools, mapped_name, arguments) {
                Ok(result) => result,
                Err(error) => {
                    return Ok(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32602, "message": error.to_string() }
                    }));
                }
            }
        }
        _ => {
            return Ok(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "method not found" }
            }));
        }
    };
    Ok(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

pub fn mcp_tool_catalog() -> Vec<McpToolDefinition> {
    vec![
        mcp_tool(
            "sessions.list",
            "列出连接",
            "返回不含认证 secret 的已保存连接列表",
            RiskLevel::Low,
            false,
            object_schema(
                json!({
                    "query": { "type": "string", "description": "按名称、主机或用户名筛选。" }
                }),
                &[],
            ),
        ),
        mcp_tool(
            "sessions.save",
            "保存连接",
            "创建或更新连接；认证由 zTerm 本地提供或从已有连接复用",
            RiskLevel::Medium,
            false,
            object_schema(
                json!({
                    "draft": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "name": { "type": "string" },
                            "type": { "type": "string", "enum": ["ssh", "local", "rdp"] },
                            "group_id": { "type": ["string", "null"] },
                            "group_name": { "type": "string" },
                            "host": { "type": "string" },
                            "port": { "type": "integer", "minimum": 1, "maximum": 65535 },
                            "username": { "type": "string" },
                            "auth_mode": { "type": "string", "enum": ["password", "key", "agent", "none"] },
                            "description": { "type": ["string", "null"] },
                            "tags": { "type": "array", "items": { "type": "string" } },
                            "sort_order": { "type": "integer" }
                        },
                        "required": ["name", "type", "host", "port", "username", "auth_mode"],
                        "additionalProperties": false
                    },
                    "reuse_auth_from_session_id": {
                        "type": "string",
                        "description": "复用已有连接的认证引用，引用本身不会返回给 MCP。"
                    }
                }),
                &["draft"],
            ),
        ),
        mcp_tool(
            "terminal.list",
            "列出终端",
            "返回 zTerm 当前运行终端及 runtime ID",
            RiskLevel::Low,
            false,
            object_schema(
                json!({
                    "saved_session_id": { "type": "string", "description": "可选的连接 ID 筛选。" }
                }),
                &[],
            ),
        ),
        mcp_tool(
            "terminal.open",
            "打开终端",
            "在 zTerm 中打开已保存连接；随后通过 terminal.list 获取 runtime ID",
            RiskLevel::Medium,
            true,
            object_schema(
                json!({
                    "saved_session_id": { "type": "string" }
                }),
                &["saved_session_id"],
            ),
        ),
        mcp_tool(
            "terminal.read",
            "读取终端",
            "读取运行终端的输出尾部或指定 cursor 之后的增量输出",
            RiskLevel::Low,
            false,
            object_schema(
                json!({
                    "runtime_session_id": { "type": "string" },
                    "cursor": { "type": "integer", "minimum": 0 },
                    "max_chars": { "type": "integer", "minimum": 1, "maximum": 4000 }
                }),
                &["runtime_session_id"],
            ),
        ),
        mcp_tool(
            "terminal.write",
            "写入终端",
            "向运行终端写入数据并回读本次产生的输出",
            RiskLevel::High,
            true,
            object_schema(
                json!({
                    "runtime_session_id": { "type": "string" },
                    "data": { "type": "string", "description": "写入终端的数据，命令通常以回车结尾。" }
                }),
                &["runtime_session_id", "data"],
            ),
        ),
        mcp_tool(
            "terminal.close",
            "关闭终端",
            "关闭指定 zTerm 运行终端",
            RiskLevel::Medium,
            true,
            object_schema(
                json!({
                    "runtime_session_id": { "type": "string" }
                }),
                &["runtime_session_id"],
            ),
        ),
        mcp_tool(
            "ssh.execute",
            "执行 SSH 命令",
            "通过已保存连接执行非交互脚本并复用 zTerm 的认证和 SSH 连接",
            RiskLevel::High,
            true,
            object_schema(
                json!({
                    "saved_session_id": { "type": "string" },
                    "script": { "type": "string", "maxLength": 16384 }
                }),
                &["saved_session_id", "script"],
            ),
        ),
        mcp_tool(
            "ssh.upload",
            "SSH 上传",
            "基于已有 SSH 连接和认证，通过 SFTP 子系统上传本地文件或目录",
            RiskLevel::High,
            true,
            file_transfer_schema("上传目标远程路径"),
        ),
        mcp_tool(
            "ssh.download",
            "SSH 下载",
            "基于已有 SSH 连接和认证，通过 SFTP 子系统下载远程文件或目录",
            RiskLevel::Medium,
            true,
            file_transfer_schema("下载来源远程路径"),
        ),
        mcp_tool(
            "sftp.upload",
            "SFTP 上传",
            "基于已有 SSH/SFTP 连接和认证上传本地文件或目录",
            RiskLevel::High,
            true,
            file_transfer_schema("上传目标远程路径"),
        ),
        mcp_tool(
            "sftp.download",
            "SFTP 下载",
            "基于已有 SSH/SFTP 连接和认证下载远程文件或目录",
            RiskLevel::Medium,
            true,
            file_transfer_schema("下载来源远程路径"),
        ),
        mcp_tool(
            "ftp.upload",
            "FTP 上传",
            "基于已有 FTP 连接和认证上传本地文件或目录",
            RiskLevel::High,
            true,
            file_transfer_schema("上传目标远程路径"),
        ),
        mcp_tool(
            "ftp.download",
            "FTP 下载",
            "基于已有 FTP 连接和认证下载远程文件或目录",
            RiskLevel::Medium,
            true,
            file_transfer_schema("下载来源远程路径"),
        ),
        mcp_tool(
            "transfer.list",
            "查询传输任务",
            "查询已入队文件传输的状态、进度和脱敏错误",
            RiskLevel::Low,
            false,
            object_schema(
                json!({
                    "saved_session_id": { "type": "string", "description": "可选的连接 ID 筛选。" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000 }
                }),
                &[],
            ),
        ),
        mcp_tool(
            "llm_provider.list",
            "列出模型",
            "返回不含 API Key 的模型 Provider 列表",
            RiskLevel::Low,
            false,
            object_schema(
                json!({
                    "query": { "type": "string", "description": "按名称或模型筛选。" }
                }),
                &[],
            ),
        ),
        mcp_tool(
            "llm_provider.save",
            "保存模型",
            "创建或更新模型 Provider；需要 API Key 时在 zTerm 本地确认",
            RiskLevel::Medium,
            false,
            object_schema(
                json!({
                    "draft": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string" },
                            "name": { "type": "string" },
                            "kind": { "type": "string", "enum": ["openai_chat", "openai_responses", "anthropic"] },
                            "base_url": { "type": "string" },
                            "model": { "type": "string" },
                            "enabled": { "type": "boolean" },
                            "is_default": { "type": "boolean" }
                        },
                        "required": ["name", "kind", "base_url", "model", "enabled"],
                        "additionalProperties": false
                    }
                }),
                &["draft"],
            ),
        ),
    ]
}

fn mcp_tool(
    id: &str,
    title: &str,
    description: &str,
    risk_level: RiskLevel,
    requires_confirmation: bool,
    input_schema: Value,
) -> McpToolDefinition {
    McpToolDefinition {
        id: id.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        risk_level,
        requires_confirmation,
        input_schema,
    }
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    schema
}

fn file_transfer_schema(remote_path_description: &str) -> Value {
    object_schema(
        json!({
            "saved_session_id": {
                "type": "string",
                "description": "zTerm 已保存连接的 ID；认证仅由 zTerm 本地读取。"
            },
            "local_path": {
                "type": "string",
                "description": "当前 zTerm 所在 Windows 主机上的绝对本地路径。"
            },
            "remote_path": {
                "type": "string",
                "description": remote_path_description
            },
            "kind": {
                "type": "string",
                "enum": ["file", "directory"],
                "description": "可选；不提供时由传输服务探测。"
            },
            "conflict_policy": {
                "type": "string",
                "enum": ["overwrite", "skip", "rename"],
                "default": "overwrite"
            }
        }),
        &["saved_session_id", "local_path", "remote_path"],
    )
}

fn mcp_tool_call_result(
    store: &SqliteStore,
    tools: &AiToolService,
    name: &str,
    arguments: Value,
) -> AppResult<Value> {
    let approval_mode = mcp_tool_approval_mode(store, tools, &arguments)?;
    let outcome = tools.execute_if_allowed(
        store,
        AiToolPrepareRequest {
            tool_id: name.to_string(),
            arguments,
            reason: Some("MCP tools/call".to_string()),
            requested_by: Some("mcp".to_string()),
            conversation_id: None,
            run_id: None,
            step_id: None,
        },
        approval_mode,
    )?;
    if let Some(pending) = outcome.pending_invocation {
        return Ok(json!({
            "content": [
                { "type": "text", "text": format!("工具 {} 等待 zTerm 内确认。", pending.tool_id) }
            ],
            "structuredContent": {
                "status": "pending",
                "invocation_id": pending.id,
                "tool_id": pending.tool_id,
                "risk_level": pending.risk_level.as_str(),
                "affected_domains": []
            },
            "isError": false
        }));
    }
    let audit = outcome
        .audit_record
        .ok_or_else(|| AppError::ai("MCP 工具调用未产生结果"))?;
    Ok(mcp_audit_result(audit, outcome.structured_content))
}

fn mcp_tool_approval_mode(
    store: &SqliteStore,
    tools: &AiToolService,
    arguments: &Value,
) -> AppResult<AiApprovalMode> {
    if let Some(saved_session_id) = arguments
        .get("saved_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return get_ai_connection_approval_mode(store, saved_session_id);
    }
    if let Some(runtime_session_id) = arguments
        .get("runtime_session_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(saved_session_id) = tools.saved_session_id_for_runtime(runtime_session_id)? {
            return get_ai_connection_approval_mode(store, &saved_session_id);
        }
    }
    Ok(AiApprovalMode::Safe)
}

fn mcp_audit_result(audit: AiToolAuditRecord, structured_content: Option<Value>) -> Value {
    let is_error = audit.status.as_str() == "failed";
    let text = audit
        .result_summary
        .clone()
        .or_else(|| audit.error.clone())
        .unwrap_or_else(|| "工具调用已完成。".to_string());
    let mut result = json!({
        "content": [
            { "type": "text", "text": text }
        ],
        "structuredContent": {
            "status": audit.status.as_str(),
            "invocation_id": audit.invocation_id,
            "tool_id": audit.tool_id,
            "affected_domains": audit.affected_domains
        },
        "isError": is_error
    });
    if let Some(structured_content) = structured_content {
        result["structuredContent"]["result"] = structured_content;
    }
    result
}

fn mcp_contains_plaintext_secret(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, child)| {
            let key = key.to_ascii_lowercase();
            let is_reference = key.ends_with("_ref");
            let is_secret = !is_reference
                && (key == "api_key"
                    || key == "token"
                    || key.ends_with("_token")
                    || key.contains("password")
                    || key.contains("passwd")
                    || key.contains("secret")
                    || key.contains("private_key"));
            (is_secret && !child.is_null()) || mcp_contains_plaintext_secret(child)
        }),
        Value::Array(items) => items.iter().any(mcp_contains_plaintext_secret),
        _ => false,
    }
}

fn validate_mcp_arguments(tool_name: &str, arguments: &Value) -> Result<(), String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| "MCP tool arguments must be an object".to_string())?;
    let allowed = match tool_name {
        "sessions.list" | "llm_provider.list" => &["query"][..],
        "sessions.save" => &["draft", "reuse_auth_from_session_id"][..],
        "terminal.list" => &["saved_session_id"][..],
        "terminal.open" => &["saved_session_id"][..],
        "terminal.read" => &["runtime_session_id", "cursor", "max_chars"][..],
        "terminal.write" => &["runtime_session_id", "data"][..],
        "terminal.close" => &["runtime_session_id"][..],
        "ssh.execute" => &["saved_session_id", "script"][..],
        "ssh.upload" | "ssh.download" | "sftp.upload" | "sftp.download" | "ftp.upload"
        | "ftp.download" => &[
            "saved_session_id",
            "local_path",
            "remote_path",
            "kind",
            "conflict_policy",
        ][..],
        "transfer.list" => &["saved_session_id", "limit"][..],
        "llm_provider.save" => &["draft"][..],
        _ => return Err(format!("tool not exposed by zTerm MCP: {tool_name}")),
    };
    reject_unknown_mcp_keys(object, allowed, "arguments")?;

    if let Some(draft) = object.get("draft").and_then(Value::as_object) {
        let draft_allowed = if tool_name == "sessions.save" {
            &[
                "id",
                "name",
                "type",
                "group_id",
                "group_name",
                "host",
                "port",
                "username",
                "auth_mode",
                "description",
                "tags",
                "sort_order",
            ][..]
        } else {
            &[
                "id",
                "name",
                "kind",
                "base_url",
                "model",
                "enabled",
                "is_default",
            ][..]
        };
        reject_unknown_mcp_keys(draft, draft_allowed, "arguments.draft")?;
    }
    Ok(())
}

fn reject_unknown_mcp_keys(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), String> {
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("unknown MCP tool argument: {path}.{key}"));
    }
    Ok(())
}

async fn handle_connection(mut stream: TcpStream, context: McpContext) -> AppResult<()> {
    let request = read_http_request(&mut stream).await?;
    let token = context
        .token
        .lock()
        .map_err(|_| AppError::ai("MCP token lock was poisoned"))?
        .clone();
    let response = handle_http_request(context.storage, context.tools, &token, request).await?;
    write_http_response(&mut stream, response).await
}

async fn read_http_request(stream: &mut TcpStream) -> AppResult<McpHttpRequest> {
    let mut buffer = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 1024];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| AppError::ai(format!("读取 MCP HTTP 请求失败: {error}")))?;
        if read == 0 {
            return Err(AppError::ai("MCP HTTP 请求为空"));
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_HTTP_HEADER_BYTES {
            return Err(AppError::ai("MCP HTTP 请求头过大"));
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
    };
    let header_bytes = &buffer[..header_end];
    let header_text = String::from_utf8_lossy(header_bytes);
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| AppError::ai("MCP HTTP 请求行为空"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let content_length = header_map(&headers)
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_HTTP_BODY_BYTES {
        return Err(AppError::ai("MCP HTTP 请求体过大"));
    }
    let body_start = header_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let mut chunk = vec![0_u8; content_length - body.len()];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| AppError::ai(format!("读取 MCP HTTP 请求体失败: {error}")))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);
    Ok(McpHttpRequest {
        method,
        path,
        headers,
        body,
    })
}

async fn write_http_response(stream: &mut TcpStream, response: McpHttpResponse) -> AppResult<()> {
    let status_text = match response.status {
        200 => "OK",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        response.status,
        status_text,
        response.content_type,
        response.body.len()
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|error| AppError::ai(format!("写入 MCP HTTP 响应头失败: {error}")))?;
    stream
        .write_all(&response.body)
        .await
        .map_err(|error| AppError::ai(format!("写入 MCP HTTP 响应体失败: {error}")))?;
    Ok(())
}

fn json_response(status: u16, body: Value) -> McpHttpResponse {
    McpHttpResponse {
        status,
        content_type: "application/json".to_string(),
        body: serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec()),
    }
}

fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    headers
        .iter()
        .find(|(header_name, _)| header_name.eq_ignore_ascii_case(&name))
        .map(|(_, value)| value.clone())
}

fn header_map(headers: &[(String, String)]) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(key, value)| (key.to_ascii_lowercase(), value.clone()))
        .collect()
}

fn origin_is_allowed(origin: Option<String>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let origin = origin.trim().to_ascii_lowercase();
    origin.starts_with("http://127.0.0.1")
        || origin.starts_with("http://localhost")
        || origin.starts_with("http://[::1]")
        || origin == "tauri://localhost"
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn generate_token() -> String {
    Uuid::new_v4().simple().to_string()
}

fn configured_mcp_port(port: Option<u16>) -> u16 {
    port.unwrap_or(DEFAULT_MCP_PORT)
}

async fn bind_mcp_listener(port: u16) -> std::io::Result<TcpListener> {
    let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    match TcpListener::bind(bind_addr).await {
        Ok(listener) => Ok(listener),
        Err(error) if port != 0 && error.kind() == std::io::ErrorKind::AddrInUse => {
            TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).await
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::{bind_mcp_listener, configured_mcp_port, DEFAULT_MCP_PORT};

    #[test]
    fn missing_mcp_port_uses_stable_default_and_explicit_zero_stays_ephemeral() {
        assert_eq!(configured_mcp_port(None), DEFAULT_MCP_PORT);
        assert_eq!(configured_mcp_port(Some(0)), 0);
    }

    #[tokio::test]
    async fn occupied_mcp_port_falls_back_to_an_available_port() {
        let occupied = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test port should bind");
        let occupied_port = occupied.local_addr().expect("occupied address").port();

        let listener = bind_mcp_listener(occupied_port)
            .await
            .expect("occupied port should fall back");
        let actual_port = listener.local_addr().expect("fallback address").port();

        assert_ne!(actual_port, occupied_port);
        assert_ne!(actual_port, 0);
    }
}
