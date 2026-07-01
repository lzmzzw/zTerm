// Author: Liz
use std::{
    collections::HashMap,
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
    models::ai::{AiApprovalMode, AiToolAuditRecord, AiToolPrepareRequest},
    services::ai_tool_service::AiToolService,
    storage::sqlite::SqliteStore,
};

const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const MCP_PATH: &str = "/mcp";
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub enabled: bool,
    pub endpoint: Option<String>,
    pub token: Option<String>,
}

#[derive(Clone)]
struct McpContext {
    storage: Arc<SqliteStore>,
    tools: AiToolService,
    token: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct McpService {
    runtime: Mutex<Option<McpRuntime>>,
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
    pub async fn start(
        &self,
        storage: Arc<SqliteStore>,
        tools: AiToolService,
        port: Option<u16>,
    ) -> AppResult<McpServerStatus> {
        if let Some(status) = self.status() {
            return Ok(status);
        }

        let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port.unwrap_or(0));
        let listener = TcpListener::bind(bind_addr)
            .await
            .map_err(|error| AppError::ai(format!("MCP 服务绑定失败: {error}")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|error| AppError::ai(format!("MCP 服务地址读取失败: {error}")))?;
        let endpoint = format!("http://127.0.0.1:{}{MCP_PATH}", local_addr.port());
        let token = Arc::new(Mutex::new(generate_token()));
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

        let token_value = token
            .lock()
            .map_err(|_| AppError::ai("MCP token lock was poisoned"))?
            .clone();
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
            let tools = tools
                .definitions()
                .into_iter()
                .map(|tool| {
                    json!({
                        "name": tool.id,
                        "title": tool.title,
                        "description": tool.description,
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": true
                        }
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
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            mcp_tool_call_result(store, tools, name, arguments)?
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

fn mcp_tool_call_result(
    store: &SqliteStore,
    tools: &AiToolService,
    name: &str,
    arguments: Value,
) -> AppResult<Value> {
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
        AiApprovalMode::Safe,
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
    Ok(mcp_audit_result(audit))
}

fn mcp_audit_result(audit: AiToolAuditRecord) -> Value {
    let is_error = audit.status.as_str() == "failed";
    let text = audit
        .result_summary
        .clone()
        .or_else(|| audit.error.clone())
        .unwrap_or_else(|| "工具调用已完成。".to_string());
    json!({
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
    })
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
