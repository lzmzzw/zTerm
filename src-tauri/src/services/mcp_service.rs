// Author: Liz
use std::{
    collections::HashMap,
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{oneshot, Notify, Semaphore},
    task::{JoinHandle, JoinSet},
};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        ai::{AiApprovalMode, AiToolAuditRecord, AiToolPrepareRequest, RiskLevel},
        session::SessionType,
        terminal::RuntimeSessionKind,
    },
    services::{
        ai_tool_service::AiToolService,
        credential_service::{SecretStore, SystemSecretStore},
    },
    storage::{ai::get_ai_connection_approval_mode, sessions::get_session, sqlite::SqliteStore},
};

const MCP_PROTOCOL_VERSION: &str = "2025-11-25";
const MCP_PATH: &str = "/mcp";
const MCP_TOKEN_ENV_VAR: &str = "ZTERM_MCP_TOKEN";
const MCP_TOKEN_SECRET_REF: &str = "mcp:bearer-token";
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONSECUTIVE_ACCEPT_ERRORS: u32 = 5;
const MAX_CONCURRENT_CONNECTIONS: usize = 32;
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MCP_APPROVAL_WAIT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
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
    agent_bindings: Arc<Mutex<HashMap<String, AgentMcpBinding>>>,
}

pub struct McpService {
    lifecycle: Arc<Mutex<McpLifecycle>>,
    lifecycle_changed: Arc<Notify>,
    next_generation: AtomicU64,
    secret_store: Arc<dyn SecretStore>,
    agent_bindings: Arc<Mutex<HashMap<String, AgentMcpBinding>>>,
}

enum McpLifecycle {
    Stopped,
    Starting { generation: u64 },
    Running(McpRuntime),
    Stopping { generation: u64 },
}

#[derive(Clone, Debug)]
pub struct AgentMcpBinding {
    pub agent_session_id: String,
    pub runtime_session_id: String,
    pub saved_session_id: Option<String>,
    pub target_runtime_kind: RuntimeSessionKind,
    pub target_label: String,
}

#[derive(Clone, Debug)]
pub struct AgentMcpAccess {
    pub endpoint: String,
    pub token: String,
}

struct McpRuntime {
    generation: u64,
    endpoint: String,
    token: Arc<Mutex<String>>,
    shutdown: Option<oneshot::Sender<()>>,
    listener_task: JoinHandle<()>,
}

struct McpStartGuard {
    lifecycle: Arc<Mutex<McpLifecycle>>,
    lifecycle_changed: Arc<Notify>,
    generation: u64,
    committed: bool,
}

impl McpStartGuard {
    fn new(
        lifecycle: Arc<Mutex<McpLifecycle>>,
        lifecycle_changed: Arc<Notify>,
        generation: u64,
    ) -> Self {
        Self {
            lifecycle,
            lifecycle_changed,
            generation,
            committed: false,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for McpStartGuard {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let Ok(mut lifecycle) = self.lifecycle.lock() else {
            return;
        };
        if matches!(
            &*lifecycle,
            McpLifecycle::Starting {
                generation: active_generation
            } if *active_generation == self.generation
        ) {
            *lifecycle = McpLifecycle::Stopped;
            self.lifecycle_changed.notify_waiters();
        }
    }
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
            lifecycle: Arc::new(Mutex::new(McpLifecycle::Stopped)),
            lifecycle_changed: Arc::new(Notify::new()),
            next_generation: AtomicU64::new(1),
            secret_store,
            agent_bindings: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start(
        &self,
        storage: Arc<SqliteStore>,
        tools: AiToolService,
        port: Option<u16>,
    ) -> AppResult<McpServerStatus> {
        self.ensure_running(storage, tools, port).await
    }

    pub async fn ensure_running(
        &self,
        storage: Arc<SqliteStore>,
        tools: AiToolService,
        port: Option<u16>,
    ) -> AppResult<McpServerStatus> {
        enum StartDecision {
            Running(McpServerStatus),
            Wait,
            Start(u64),
        }

        let generation = loop {
            let changed = self.lifecycle_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let decision = {
                let mut lifecycle = self
                    .lifecycle
                    .lock()
                    .map_err(|_| AppError::ai("MCP lifecycle lock was poisoned"))?;
                match &*lifecycle {
                    McpLifecycle::Running(runtime) if !runtime.listener_task.is_finished() => {
                        StartDecision::Running(runtime_status(runtime)?)
                    }
                    McpLifecycle::Running(_) => {
                        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
                        *lifecycle = McpLifecycle::Starting { generation };
                        StartDecision::Start(generation)
                    }
                    McpLifecycle::Starting { .. } | McpLifecycle::Stopping { .. } => {
                        StartDecision::Wait
                    }
                    McpLifecycle::Stopped => {
                        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
                        *lifecycle = McpLifecycle::Starting { generation };
                        StartDecision::Start(generation)
                    }
                }
            };
            match decision {
                StartDecision::Running(status) => return Ok(status),
                StartDecision::Wait => changed.as_mut().await,
                StartDecision::Start(generation) => break generation,
            }
        };
        let mut start_guard = McpStartGuard::new(
            Arc::clone(&self.lifecycle),
            Arc::clone(&self.lifecycle_changed),
            generation,
        );

        let prepared = async {
            let token_value = self.load_or_create_token()?;
            let listener = bind_mcp_listener(configured_mcp_port(port))
                .await
                .map_err(|error| AppError::ai(format!("MCP 服务绑定失败: {error}")))?;
            let local_addr = listener
                .local_addr()
                .map_err(|error| AppError::ai(format!("MCP 服务地址读取失败: {error}")))?;
            Ok::<_, AppError>((token_value, listener, local_addr))
        }
        .await;
        let (token_value, listener, local_addr) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => return Err(error),
        };
        let endpoint = format!("http://127.0.0.1:{}{MCP_PATH}", local_addr.port());
        let token = Arc::new(Mutex::new(token_value.clone()));
        let context = McpContext {
            storage,
            tools,
            token: Arc::clone(&token),
            agent_bindings: Arc::clone(&self.agent_bindings),
        };
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let lifecycle = Arc::clone(&self.lifecycle);
        let lifecycle_changed = Arc::clone(&self.lifecycle_changed);
        let listener_task = tokio::spawn(async move {
            let mut consecutive_accept_errors = 0_u32;
            let mut connections = JoinSet::new();
            let connection_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
            'listener: loop {
                tokio::select! {
                    biased;
                    _ = &mut shutdown_rx => break,
                    completed = connections.join_next(), if !connections.is_empty() => {
                        if let Some(Err(error)) = completed {
                            eprintln!("MCP connection task failed: {error}");
                        }
                    }
                    accepted = listener.accept() => {
                        match accepted {
                            Ok((stream, peer_addr)) => {
                                consecutive_accept_errors = 0;
                                if !peer_addr.ip().is_loopback() {
                                    continue;
                                }
                                let Ok(connection_slot) = Arc::clone(&connection_slots).try_acquire_owned() else {
                                    continue;
                                };
                                let context = context.clone();
                                connections.spawn(async move {
                                    let _connection_slot = connection_slot;
                                    let _ = handle_connection(stream, context).await;
                                });
                            }
                            Err(error) => {
                                consecutive_accept_errors += 1;
                                eprintln!(
                                    "MCP listener accept failed ({consecutive_accept_errors}/{MAX_CONSECUTIVE_ACCEPT_ERRORS}): {error}"
                                );
                                if consecutive_accept_errors >= MAX_CONSECUTIVE_ACCEPT_ERRORS {
                                    break 'listener;
                                }
                                let delay = Duration::from_millis(
                                    25_u64.saturating_mul(1_u64 << (consecutive_accept_errors - 1)),
                                );
                                tokio::select! {
                                    _ = &mut shutdown_rx => break 'listener,
                                    _ = tokio::time::sleep(delay) => {}
                                }
                            }
                        }
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
            mark_listener_finished(&lifecycle, &lifecycle_changed, generation);
        });

        let status = McpServerStatus {
            enabled: true,
            endpoint: Some(endpoint.clone()),
            token: Some(token_value),
        };
        let mut pending_runtime = Some(McpRuntime {
            generation,
            endpoint,
            token,
            shutdown: Some(shutdown_tx),
            listener_task,
        });
        let installed = {
            let mut lifecycle = self
                .lifecycle
                .lock()
                .map_err(|_| AppError::ai("MCP lifecycle lock was poisoned"))?;
            if matches!(
                &*lifecycle,
                McpLifecycle::Starting {
                    generation: active_generation
                } if *active_generation == generation
            ) {
                *lifecycle =
                    McpLifecycle::Running(pending_runtime.take().expect("pending MCP runtime"));
                true
            } else {
                false
            }
        };
        if !installed {
            let mut runtime = pending_runtime.expect("uninstalled MCP runtime");
            if let Some(shutdown) = runtime.shutdown.take() {
                let _ = shutdown.send(());
            }
            let _ = runtime.listener_task.await;
            return Err(AppError::ai("MCP 服务启动期间状态已变更"));
        }
        start_guard.commit();
        self.lifecycle_changed.notify_waiters();
        Ok(status)
    }

    pub async fn stop_and_wait(&self) -> AppResult<McpServerStatus> {
        enum StopDecision {
            Stopped,
            Wait,
            Stop(McpRuntime),
        }

        let mut runtime = loop {
            let changed = self.lifecycle_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let decision = {
                let mut lifecycle = self
                    .lifecycle
                    .lock()
                    .map_err(|_| AppError::ai("MCP lifecycle lock was poisoned"))?;
                match &*lifecycle {
                    McpLifecycle::Stopped => StopDecision::Stopped,
                    McpLifecycle::Starting { .. } | McpLifecycle::Stopping { .. } => {
                        StopDecision::Wait
                    }
                    McpLifecycle::Running(_) => {
                        let McpLifecycle::Running(runtime) =
                            std::mem::replace(&mut *lifecycle, McpLifecycle::Stopped)
                        else {
                            unreachable!();
                        };
                        let generation = runtime.generation;
                        *lifecycle = McpLifecycle::Stopping { generation };
                        StopDecision::Stop(runtime)
                    }
                }
            };
            match decision {
                StopDecision::Stopped => return Ok(disabled_status()),
                StopDecision::Wait => changed.as_mut().await,
                StopDecision::Stop(runtime) => break runtime,
            }
        };
        if let Some(shutdown) = runtime.shutdown.take() {
            let _ = shutdown.send(());
        }
        let generation = runtime.generation;
        let joined = runtime.listener_task.await;
        let mut lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| AppError::ai("MCP lifecycle lock was poisoned"))?;
        if matches!(
            &*lifecycle,
            McpLifecycle::Stopping {
                generation: active_generation
            } if *active_generation == generation
        ) {
            *lifecycle = McpLifecycle::Stopped;
        }
        self.lifecycle_changed.notify_waiters();
        joined.map_err(|error| AppError::ai(format!("MCP listener task failed: {error}")))?;
        Ok(disabled_status())
    }

    pub fn rotate_token(&self) -> AppResult<McpServerStatus> {
        let lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| AppError::ai("MCP lifecycle lock was poisoned"))?;
        let McpLifecycle::Running(runtime) = &*lifecycle else {
            return Ok(disabled_status());
        };
        if runtime.listener_task.is_finished() {
            return Ok(disabled_status());
        }
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
        let mut lifecycle = self.lifecycle.lock().ok()?;
        match &*lifecycle {
            McpLifecycle::Running(runtime) if !runtime.listener_task.is_finished() => {
                runtime_status(runtime).ok()
            }
            McpLifecycle::Running(_) => {
                *lifecycle = McpLifecycle::Stopped;
                self.lifecycle_changed.notify_waiters();
                None
            }
            _ => None,
        }
    }

    pub fn register_agent_binding(&self, binding: AgentMcpBinding) -> AppResult<AgentMcpAccess> {
        let endpoint = self
            .status()
            .and_then(|status| status.endpoint)
            .ok_or_else(|| AppError::ai("zTerm MCP 服务未启动"))?;
        let token = generate_token();
        let mut bindings = self
            .agent_bindings
            .lock()
            .map_err(|_| AppError::ai("Agent MCP 绑定锁已损坏"))?;
        bindings.retain(|_, existing| existing.agent_session_id != binding.agent_session_id);
        bindings.insert(token.clone(), binding);
        Ok(AgentMcpAccess { endpoint, token })
    }

    pub fn unregister_agent_binding(&self, agent_session_id: &str) -> AppResult<()> {
        self.agent_bindings
            .lock()
            .map_err(|_| AppError::ai("Agent MCP 绑定锁已损坏"))?
            .retain(|_, binding| binding.agent_session_id != agent_session_id);
        Ok(())
    }
}

fn runtime_status(runtime: &McpRuntime) -> AppResult<McpServerStatus> {
    let token = runtime
        .token
        .lock()
        .map_err(|_| AppError::ai("MCP token lock was poisoned"))?
        .clone();
    Ok(McpServerStatus {
        enabled: true,
        endpoint: Some(runtime.endpoint.clone()),
        token: Some(token),
    })
}

fn disabled_status() -> McpServerStatus {
    McpServerStatus {
        enabled: false,
        endpoint: None,
        token: None,
    }
}

fn mark_listener_finished(
    lifecycle: &Mutex<McpLifecycle>,
    lifecycle_changed: &Notify,
    generation: u64,
) {
    let Ok(mut lifecycle) = lifecycle.lock() else {
        return;
    };
    if matches!(
        &*lifecycle,
        McpLifecycle::Running(runtime) if runtime.generation == generation
    ) || matches!(
        &*lifecycle,
        McpLifecycle::Starting {
            generation: active_generation
        } if *active_generation == generation
    ) {
        *lifecycle = McpLifecycle::Stopped;
    }
    lifecycle_changed.notify_waiters();
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
    if body.get("id").is_none() {
        return Ok(accepted_response());
    }
    let wait_for_approval = !request_prefers_async(&request.headers);
    let response = handle_json_rpc(storage.as_ref(), &tools, body, wait_for_approval).await?;
    Ok(json_response(200, response))
}

async fn handle_json_rpc(
    store: &SqliteStore,
    tools: &AiToolService,
    body: Value,
    wait_for_approval: bool,
) -> AppResult<Value> {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "zTerm Headless", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "这是 zTerm 的外部 Headless Profile。服务器命令通过独立 SSH 执行并返回结构化结果，不打开、不读取也不写入任何终端滚动屏。zTerm 负责最终风险判断与本地 pending 审批；需要确认时原 tools/call 会等待 zTerm 的结果，不要重新提交原操作。若收到 pending，请只用 approval.wait 继续等待同一 invocation_id。"
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
            match mcp_tool_call_result(store, tools, name, arguments, wait_for_approval).await {
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
            "approval.wait",
            "等待审批结果",
            "仅在工具返回 pending 时使用；按 invocation_id 等待原调用在 zTerm 中确认并返回执行结果，不会重放原操作",
            RiskLevel::Low,
            false,
            object_schema(
                json!({
                    "invocation_id": { "type": "string", "description": "pending 响应返回的调用 ID。" }
                }),
                &["invocation_id"],
            ),
        ),
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
            "ssh.execute",
            "执行 SSH 命令",
            "通过已保存连接执行非交互脚本并复用 zTerm 认证；不会打开或写入终端滚动屏",
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
            RiskLevel::Medium,
            false,
            file_transfer_schema("上传目标远程路径"),
        ),
        mcp_tool(
            "ssh.download",
            "SSH 下载",
            "基于已有 SSH 连接和认证，通过 SFTP 子系统下载远程文件或目录",
            RiskLevel::Low,
            false,
            file_transfer_schema("下载来源远程路径"),
        ),
        mcp_tool(
            "sftp.upload",
            "SFTP 上传",
            "基于已有 SSH/SFTP 连接和认证上传本地文件或目录",
            RiskLevel::Medium,
            false,
            file_transfer_schema("上传目标远程路径"),
        ),
        mcp_tool(
            "sftp.download",
            "SFTP 下载",
            "基于已有 SSH/SFTP 连接和认证下载远程文件或目录",
            RiskLevel::Low,
            false,
            file_transfer_schema("下载来源远程路径"),
        ),
        mcp_tool(
            "ftp.upload",
            "FTP 上传",
            "基于已有 FTP 连接和认证上传本地文件或目录",
            RiskLevel::Medium,
            false,
            file_transfer_schema("上传目标远程路径"),
        ),
        mcp_tool(
            "ftp.download",
            "FTP 下载",
            "基于已有 FTP 连接和认证下载远程文件或目录",
            RiskLevel::Low,
            false,
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

async fn mcp_tool_call_result(
    store: &SqliteStore,
    tools: &AiToolService,
    name: &str,
    arguments: Value,
    wait_for_approval: bool,
) -> AppResult<Value> {
    if name == "approval.wait" {
        let invocation_id = arguments
            .get("invocation_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AppError::validation("approval.wait 缺少 invocation_id"))?;
        let timeout = if wait_for_approval {
            MCP_APPROVAL_WAIT_TIMEOUT
        } else {
            Duration::ZERO
        };
        return match tools
            .wait_for_mcp_completion(store, invocation_id, timeout)
            .await?
        {
            Some(outcome) => mcp_completed_outcome(outcome),
            None => Ok(mcp_pending_result(
                invocation_id,
                "approval.wait",
                None,
                true,
            )),
        };
    }
    let approval_mode = mcp_tool_approval_mode(store, tools, &arguments)?;
    let outcome = tools.execute_if_allowed(
        store,
        AiToolPrepareRequest {
            tool_id: name.to_string(),
            arguments,
            reason: Some("MCP tools/call".to_string()),
            requested_by: Some("mcp".to_string()),
            run_id: None,
            step_id: None,
        },
        approval_mode,
    )?;
    if let Some(pending) = outcome.pending_invocation {
        if wait_for_approval {
            if let Some(outcome) = tools
                .wait_for_mcp_completion(store, &pending.id, MCP_APPROVAL_WAIT_TIMEOUT)
                .await?
            {
                return mcp_completed_outcome(outcome);
            }
        }
        return Ok(mcp_pending_result(
            &pending.id,
            &pending.tool_id,
            Some(pending.risk_level),
            wait_for_approval,
        ));
    }
    mcp_completed_outcome(outcome)
}

fn mcp_completed_outcome(
    outcome: crate::services::ai_tool_service::AiToolExecutionOutcome,
) -> AppResult<Value> {
    let audit = outcome
        .audit_record
        .ok_or_else(|| AppError::ai("MCP 工具调用未产生结果"))?;
    Ok(mcp_audit_result(audit, outcome.structured_content))
}

fn mcp_pending_result(
    invocation_id: &str,
    tool_id: &str,
    risk_level: Option<RiskLevel>,
    wait_timed_out: bool,
) -> Value {
    let text = if wait_timed_out {
        format!(
            "工具 {tool_id} 仍在等待 zTerm 内确认。不要重新提交原操作；请使用 approval.wait 并传入 invocation_id={invocation_id} 继续等待。"
        )
    } else {
        format!(
            "工具 {tool_id} 等待 zTerm 内确认。请使用 approval.wait 并传入 invocation_id={invocation_id} 获取原调用结果，不要重新提交原操作。"
        )
    };
    let mut structured_content = json!({
        "status": "pending",
        "invocation_id": invocation_id,
        "tool_id": tool_id,
        "affected_domains": []
    });
    if let Some(risk_level) = risk_level {
        structured_content["risk_level"] = Value::String(risk_level.as_str().to_string());
    }
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured_content,
        "isError": false
    })
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
        "sessions.list" => &["query"][..],
        "approval.wait" => &["invocation_id"][..],
        "sessions.save" => &["draft", "reuse_auth_from_session_id"][..],
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
        _ => return Err(format!("tool not exposed by zTerm MCP: {tool_name}")),
    };
    reject_unknown_mcp_keys(object, allowed, "arguments")?;
    if let Some(draft) = object.get("draft").and_then(Value::as_object) {
        let draft_allowed = &[
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
        ][..];
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
    let request = read_http_request_with_timeout(&mut stream, HTTP_REQUEST_TIMEOUT).await?;
    let token = context
        .token
        .lock()
        .map_err(|_| AppError::ai("MCP token lock was poisoned"))?
        .clone();
    let authorization = header(&request.headers, "authorization");
    let response = if authorization.as_deref() == Some(format!("Bearer {token}").as_str()) {
        handle_http_request(context.storage, context.tools, &token, request).await?
    } else {
        let scoped_token = authorization
            .as_deref()
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default();
        let binding = context
            .agent_bindings
            .lock()
            .map_err(|_| AppError::ai("Agent MCP 绑定锁已损坏"))?
            .get(scoped_token)
            .cloned();
        match binding {
            Some(binding) => {
                handle_agent_http_request(context.storage, context.tools, binding, request).await?
            }
            None => json_response(401, json!({ "error": "unauthorized" })),
        }
    };
    write_http_response(&mut stream, response).await
}

async fn read_http_request_with_timeout(
    stream: &mut TcpStream,
    timeout_duration: Duration,
) -> AppResult<McpHttpRequest> {
    tokio::time::timeout(timeout_duration, read_http_request(stream))
        .await
        .map_err(|_| AppError::ai("MCP 请求读取超时"))?
}

async fn handle_agent_http_request(
    storage: Arc<SqliteStore>,
    tools: AiToolService,
    binding: AgentMcpBinding,
    request: McpHttpRequest,
) -> AppResult<McpHttpResponse> {
    if request.path != MCP_PATH {
        return Ok(json_response(404, json!({ "error": "not_found" })));
    }
    if !origin_is_allowed(header(&request.headers, "origin")) {
        return Ok(json_response(403, json!({ "error": "origin_forbidden" })));
    }
    if request.method != "POST" {
        return Ok(json_response(405, json!({ "error": "method_not_allowed" })));
    }
    let body = serde_json::from_slice::<Value>(&request.body)
        .map_err(|error| AppError::ai(format!("MCP 请求不是有效 JSON: {error}")))?;
    if body.get("id").is_none() {
        return Ok(accepted_response());
    }
    let wait_for_approval = !request_prefers_async(&request.headers);
    let response =
        handle_agent_json_rpc(storage.as_ref(), &tools, &binding, body, wait_for_approval).await?;
    Ok(json_response(200, response))
}

async fn handle_agent_json_rpc(
    store: &SqliteStore,
    tools: &AiToolService,
    binding: &AgentMcpBinding,
    body: Value,
    wait_for_approval: bool,
) -> AppResult<Value> {
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = match method {
        "initialize" => json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "zTerm Visible Terminal", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "这是 zTerm 侧栏 Codex CLI 的 Visible Terminal Profile。当前连接、当前标签、激活标签指 zTerm 活动 SSH 终端，不是本机。每次先调用 terminal.list 读取 active_runtime_session_id，再显式指定 runtime_session_id 读写；为 null 时请用户激活 SSH 标签，不探索本机或猜目标。所有服务器命令必须写入可见 SSH 终端并保留在滚动屏；可以列出连接、在标签或新分屏打开其他 SSH 连接，再按 runtime_session_id 操作其滚动屏。不得使用 headless ssh.execute。zTerm 负责最终风险判断与本地 pending 审批；需要确认时原 tools/call 会等待 zTerm 的结果，不要重新提交原操作。"
        }),
        "ping" => json!({}),
        "tools/list" => json!({
            "tools": [
                {
                    "name": "sessions.list",
                    "title": "列出 SSH 连接",
                    "description": "列出 zTerm 已保存且不含认证 secret 的 SSH 连接，供打开新的可见终端。",
                    "inputSchema": object_schema(json!({
                        "query": { "type": "string", "description": "按连接名称、主机或用户名筛选。" }
                    }), &[])
                },
                {
                    "name": "terminal.list",
                    "title": "列出可见 SSH 终端",
                    "description": "识别当前连接、当前标签、激活标签的首选工具。返回可见 SSH 终端及 active_runtime_session_id（实时活动 SSH runtime；无有效活动 SSH 时为 null）。据此显式传 runtime_session_id 读写，不把绑定终端或本机 cwd 当作活动标签。",
                    "inputSchema": object_schema(json!({}), &[])
                },
                {
                    "name": "terminal.open",
                    "title": "打开可见 SSH 终端",
                    "description": "在当前分栏的新标签或新分屏中打开已保存 SSH 连接；命令和输出始终显示在其滚动屏。",
                    "inputSchema": object_schema(json!({
                        "saved_session_id": { "type": "string" },
                        "placement": {
                            "type": "string",
                            "enum": ["tab", "split_horizontal", "split_vertical"],
                            "default": "tab",
                            "description": "tab 在当前分栏新建标签；split_horizontal 或 split_vertical 新建分屏。"
                        }
                    }), &["saved_session_id"])
                },
                {
                    "name": "terminal.read",
                    "title": "读取可见终端",
                    "description": format!("读取 zTerm 可见 SSH 终端的滚动屏；不提供 runtime_session_id 时保持初始绑定终端，若其已关闭则仅回退到同一 SSH 连接的可见终端：{}", binding.target_label),
                    "inputSchema": object_schema(json!({
                        "runtime_session_id": { "type": "string", "description": "可选；来自 terminal.list。" },
                        "cursor": { "type": "integer", "minimum": 0 },
                        "max_chars": { "type": "integer", "minimum": 1, "maximum": 4000 }
                    }), &[])
                },
                {
                    "name": "terminal.write",
                    "title": "操作可见终端",
                    "description": "将数据写入指定可见 SSH 终端并回读新增输出；未指定 runtime_session_id 时使用绑定目标或同一 SSH 连接的回退目标；指令和输出保留在该终端滚动屏。",
                    "inputSchema": object_schema(json!({
                        "runtime_session_id": { "type": "string", "description": "可选；不提供时使用初始绑定终端。" },
                        "data": { "type": "string", "minLength": 1, "maxLength": 16384 }
                    }), &["data"])
                },
                {
                    "name": "terminal.close",
                    "title": "关闭可见终端",
                    "description": "关闭指定可见 SSH 终端；不提供 runtime_session_id 时关闭绑定目标或同一 SSH 连接的回退目标。",
                    "inputSchema": object_schema(json!({
                        "runtime_session_id": { "type": "string", "description": "可选；来自 terminal.list。" }
                    }), &[])
                }
            ]
        }),
        "tools/call" => {
            let params = body.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(
                name,
                "sessions.list"
                    | "terminal.list"
                    | "terminal.open"
                    | "terminal.read"
                    | "terminal.write"
                    | "terminal.close"
            ) {
                return Ok(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32601, "message": "sidebar Codex may only operate visible zTerm SSH terminals" }
                }));
            }
            let mut arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if mcp_contains_plaintext_secret(&arguments) {
                return Ok(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32602, "message": "MCP tool arguments must not contain plaintext secrets; provide authentication in zTerm" }
                }));
            }
            let Some(object) = arguments.as_object_mut() else {
                return Ok(mcp_json_rpc_error(
                    id,
                    -32602,
                    "MCP tool arguments must be an object",
                ));
            };
            let allowed = match name {
                "sessions.list" => &["query"][..],
                "terminal.list" => &[][..],
                "terminal.open" => &["saved_session_id", "placement"][..],
                "terminal.read" => &["runtime_session_id", "cursor", "max_chars"][..],
                "terminal.write" => &["runtime_session_id", "data"][..],
                "terminal.close" => &["runtime_session_id"][..],
                _ => unreachable!(),
            };
            if let Err(message) = reject_unknown_mcp_keys(object, allowed, "arguments") {
                return Ok(mcp_json_rpc_error(id, -32602, message));
            }
            match name {
                "sessions.list" => {
                    object.insert("session_type".to_string(), Value::String("ssh".to_string()));
                }
                "terminal.list" => {
                    object.insert("ssh_only".to_string(), Value::Bool(true));
                }
                "terminal.open" => {
                    let Some(saved_session_id) = object
                        .get("saved_session_id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    else {
                        return Ok(mcp_json_rpc_error(
                            id,
                            -32602,
                            "terminal.open requires saved_session_id",
                        ));
                    };
                    let session = match get_session(store, saved_session_id) {
                        Ok(session) => session,
                        Err(error) => return Ok(mcp_json_rpc_error(id, -32602, error)),
                    };
                    if session.session_type != SessionType::Ssh {
                        return Ok(mcp_json_rpc_error(
                            id,
                            -32602,
                            "zTerm 侧栏只能为已保存 SSH 连接打开可见终端",
                        ));
                    }
                    let placement = object
                        .get("placement")
                        .and_then(Value::as_str)
                        .unwrap_or("tab")
                        .to_string();
                    if !matches!(
                        placement.as_str(),
                        "tab" | "split_horizontal" | "split_vertical"
                    ) {
                        return Ok(mcp_json_rpc_error(
                            id,
                            -32602,
                            "terminal.open placement 无效",
                        ));
                    }
                    object.insert("placement".to_string(), Value::String(placement));
                }
                "terminal.read" | "terminal.write" | "terminal.close" => {
                    if name == "terminal.write"
                        && object.get("data").and_then(Value::as_str).is_none()
                    {
                        return Ok(json!({
                            "jsonrpc": "2.0", "id": id,
                            "error": { "code": -32602, "message": "terminal.write requires data" }
                        }));
                    }
                    let explicit_runtime_session_id = object
                        .get("runtime_session_id")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty());
                    let runtime_session_id = match explicit_runtime_session_id {
                        Some(runtime_session_id) => {
                            if let Err(error) = tools.ensure_visible_ssh_runtime(runtime_session_id)
                            {
                                return Ok(mcp_json_rpc_error(id, -32602, error));
                            }
                            runtime_session_id.to_string()
                        }
                        None => match tools.resolve_sidebar_default_ssh_runtime(
                            &binding.runtime_session_id,
                            binding.saved_session_id.as_deref(),
                            binding.target_runtime_kind,
                        ) {
                            Ok(runtime_session_id) => runtime_session_id,
                            Err(error) => return Ok(mcp_json_rpc_error(id, -32602, error)),
                        },
                    };
                    if let Err(error) = tools.ensure_visible_ssh_runtime(&runtime_session_id) {
                        return Ok(mcp_json_rpc_error(id, -32602, error));
                    }
                    object.insert(
                        "runtime_session_id".to_string(),
                        Value::String(runtime_session_id),
                    );
                }
                _ => unreachable!(),
            }
            match mcp_tool_call_result(store, tools, name, arguments, wait_for_approval).await {
                Ok(result) => result,
                Err(error) => return Ok(mcp_json_rpc_error(id, -32602, error)),
            }
        }
        _ => {
            return Ok(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": "method not found" }
            }))
        }
    };
    Ok(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn mcp_json_rpc_error(id: Value, code: i64, message: impl ToString) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.to_string() }
    })
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
        202 => "Accepted",
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

fn accepted_response() -> McpHttpResponse {
    McpHttpResponse {
        status: 202,
        content_type: "application/json".to_string(),
        body: Vec::new(),
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

fn request_prefers_async(headers: &[(String, String)]) -> bool {
    header(headers, "prefer").is_some_and(|value| {
        value
            .split(',')
            .any(|preference| preference.trim().eq_ignore_ascii_case("respond-async"))
    })
}

fn origin_is_allowed(origin: Option<String>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let origin = origin.trim();
    if origin.eq_ignore_ascii_case("tauri://localhost") {
        return true;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
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
    use std::{future::pending, sync::Arc, time::Duration};

    use tokio::{io::AsyncWriteExt, sync::Notify};

    use crate::services::credential_service::MemorySecretStore;

    use super::{
        bind_mcp_listener, configured_mcp_port, mark_listener_finished, origin_is_allowed,
        read_http_request_with_timeout, McpLifecycle, McpRuntime, McpService, McpStartGuard,
        DEFAULT_MCP_PORT,
    };

    #[test]
    fn missing_mcp_port_uses_stable_default_and_explicit_zero_stays_ephemeral() {
        assert_eq!(configured_mcp_port(None), DEFAULT_MCP_PORT);
        assert_eq!(configured_mcp_port(Some(0)), 0);
    }

    #[test]
    fn origin_validation_accepts_only_exact_loopback_hosts() {
        for origin in [
            None,
            Some("http://127.0.0.1:9419".to_string()),
            Some("http://localhost:9419".to_string()),
            Some("http://[::1]:9419".to_string()),
            Some("tauri://localhost".to_string()),
        ] {
            assert!(origin_is_allowed(origin));
        }
        for origin in [
            "http://127.0.0.1.evil.test",
            "http://localhost.evil.test",
            "http://127.0.0.1@evil.test",
            "https://localhost",
            "http://localhost/path",
        ] {
            assert!(!origin_is_allowed(Some(origin.to_string())));
        }
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

    #[tokio::test]
    async fn aborted_start_future_rolls_back_starting_state() {
        let generation = 7;
        let lifecycle = Arc::new(std::sync::Mutex::new(McpLifecycle::Starting { generation }));
        let lifecycle_changed = Arc::new(Notify::new());
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let start_task = tokio::spawn({
            let lifecycle = Arc::clone(&lifecycle);
            let lifecycle_changed = Arc::clone(&lifecycle_changed);
            async move {
                let _guard = McpStartGuard::new(lifecycle, lifecycle_changed, generation);
                let _ = entered_tx.send(());
                pending::<()>().await;
            }
        });
        entered_rx.await.expect("start future should enter");

        start_task.abort();
        let _ = start_task.await;

        assert!(matches!(
            &*lifecycle.lock().expect("lifecycle lock"),
            McpLifecycle::Stopped
        ));
    }

    #[tokio::test]
    async fn listener_task_exit_clears_running_status() {
        let generation = 9;
        let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
        let lifecycle = Arc::clone(&service.lifecycle);
        let lifecycle_changed = Arc::clone(&service.lifecycle_changed);
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
        let listener_task = tokio::spawn(async move {
            let _ = exit_rx.await;
            mark_listener_finished(&lifecycle, &lifecycle_changed, generation);
        });
        let (shutdown, _shutdown_rx) = tokio::sync::oneshot::channel();
        *service.lifecycle.lock().expect("lifecycle lock") = McpLifecycle::Running(McpRuntime {
            generation,
            endpoint: "http://127.0.0.1:9419/mcp".to_string(),
            token: Arc::new(std::sync::Mutex::new("test-token".to_string())),
            shutdown: Some(shutdown),
            listener_task,
        });
        assert!(service.status().is_some());

        exit_tx.send(()).expect("listener exit signal");
        tokio::time::timeout(Duration::from_secs(1), async {
            while service.status().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("listener exit should clear status");
        assert!(service.status().is_none());
    }

    #[tokio::test]
    async fn slow_http_request_times_out() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener.local_addr().expect("listener address");
        let client_task = tokio::spawn(async move {
            let mut client = tokio::net::TcpStream::connect(address)
                .await
                .expect("test client should connect");
            client
                .write_all(b"POST /mcp HTTP/1.1\r\nHost: localhost\r\n")
                .await
                .expect("partial request should write");
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let (mut server, _) = listener.accept().await.expect("server should accept");

        let error = read_http_request_with_timeout(&mut server, Duration::from_millis(25))
            .await
            .expect_err("slow request should time out");

        assert!(error.to_string().contains("请求读取超时"));
        client_task.abort();
        let _ = client_task.await;
    }
}
