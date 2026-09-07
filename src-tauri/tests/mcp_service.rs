// Author: Liz
use std::{
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use reqwest::StatusCode;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::Command,
    time::timeout,
};
use uuid::Uuid;
use zterm_lib::{
    commands::mcp::start_mcp_if_enabled,
    error::AppResult,
    models::{
        ai::{AiToolConfirmRequest, AiToolFrontendActionEvent},
        session::{AuthMode, SavedSessionDraft, SessionType},
        settings::McpSettings,
        terminal::{RuntimeSessionInfo, RuntimeSessionKind},
    },
    services::{
        ai_tool_service::{AiToolCommandWriter, AiToolService},
        credential_service::MemorySecretStore,
        mcp_service::{
            handle_http_request, mcp_tool_catalog, AgentMcpBinding, McpHttpRequest, McpService,
            DEFAULT_MCP_PORT,
        },
    },
    storage::{
        ai::{get_ai_tool_pending_state, upsert_ai_connection_approval_policy},
        sessions::save_session,
        settings::{get_app_settings, save_app_settings},
        sqlite::SqliteStore,
    },
};

#[derive(Default)]
struct FakeToolWriter;

impl AiToolCommandWriter for FakeToolWriter {
    fn write_terminal(&self, _runtime_session_id: &str, _data: &str) -> AppResult<()> {
        Ok(())
    }

    fn list_terminals(&self) -> AppResult<Vec<RuntimeSessionInfo>> {
        Ok(vec![
            RuntimeSessionInfo {
                runtime_session_id: "runtime-1".to_string(),
                saved_session_id: Some("session-1".to_string()),
                history_scope_kind: None,
                history_scope_id: None,
                pane_id: "pane-1".to_string(),
                title: "Production".to_string(),
                kind: RuntimeSessionKind::Ssh,
                initial_cwd: None,
                cols: 120,
                rows: 32,
            },
            RuntimeSessionInfo {
                runtime_session_id: "runtime-local".to_string(),
                saved_session_id: None,
                history_scope_kind: None,
                history_scope_id: None,
                pane_id: "pane-2".to_string(),
                title: "PowerShell".to_string(),
                kind: RuntimeSessionKind::Local,
                initial_cwd: None,
                cols: 120,
                rows: 32,
            },
        ])
    }

    fn terminal_output_cursor(&self, _runtime_session_id: &str) -> AppResult<Option<usize>> {
        Ok(Some(42))
    }

    fn read_terminal_output_after(
        &self,
        _runtime_session_id: &str,
        _cursor: usize,
    ) -> AppResult<Option<String>> {
        Ok(Some("pwd\r\n/home/ops\r\nops@host:~$ ".to_string()))
    }

    fn read_terminal_output_tail(
        &self,
        _runtime_session_id: &str,
        _max_chars: usize,
    ) -> AppResult<Option<String>> {
        Ok(Some("recent terminal output".to_string()))
    }
}

#[derive(Default)]
struct CountingToolWriter {
    list_calls: AtomicUsize,
}

impl AiToolCommandWriter for CountingToolWriter {
    fn write_terminal(&self, _runtime_session_id: &str, _data: &str) -> AppResult<()> {
        Ok(())
    }

    fn list_terminals(&self) -> AppResult<Vec<RuntimeSessionInfo>> {
        self.list_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }

    fn terminal_output_cursor(&self, _runtime_session_id: &str) -> AppResult<Option<usize>> {
        Ok(None)
    }

    fn read_terminal_output_after(
        &self,
        _runtime_session_id: &str,
        _cursor: usize,
    ) -> AppResult<Option<String>> {
        Ok(None)
    }

    fn read_terminal_output_tail(
        &self,
        _runtime_session_id: &str,
        _max_chars: usize,
    ) -> AppResult<Option<String>> {
        Ok(None)
    }
}

#[derive(Default)]
struct MutableToolWriter {
    terminals: Mutex<Vec<RuntimeSessionInfo>>,
    reads: Mutex<Vec<String>>,
    actions: Mutex<Vec<AiToolFrontendActionEvent>>,
}

impl MutableToolWriter {
    fn set_terminals(&self, terminals: Vec<RuntimeSessionInfo>) {
        *self.terminals.lock().expect("test terminals lock") = terminals;
    }

    fn read_runtime_ids(&self) -> Vec<String> {
        self.reads.lock().expect("test reads lock").clone()
    }

    fn action_runtime_ids(&self) -> Vec<String> {
        self.actions
            .lock()
            .expect("test actions lock")
            .iter()
            .filter_map(|event| event.arguments["runtime_session_id"].as_str())
            .map(ToOwned::to_owned)
            .collect()
    }
}

impl AiToolCommandWriter for MutableToolWriter {
    fn write_terminal(&self, _runtime_session_id: &str, _data: &str) -> AppResult<()> {
        Ok(())
    }

    fn emit_tool_action(&self, event: AiToolFrontendActionEvent) -> AppResult<()> {
        self.actions.lock().expect("test actions lock").push(event);
        Ok(())
    }

    fn list_terminals(&self) -> AppResult<Vec<RuntimeSessionInfo>> {
        Ok(self.terminals.lock().expect("test terminals lock").clone())
    }

    fn terminal_output_cursor(&self, _runtime_session_id: &str) -> AppResult<Option<usize>> {
        Ok(Some(1))
    }

    fn read_terminal_output_after(
        &self,
        runtime_session_id: &str,
        _cursor: usize,
    ) -> AppResult<Option<String>> {
        self.reads
            .lock()
            .expect("test reads lock")
            .push(runtime_session_id.to_string());
        Ok(Some(format!("output:{runtime_session_id}")))
    }

    fn read_terminal_output_tail(
        &self,
        runtime_session_id: &str,
        _max_chars: usize,
    ) -> AppResult<Option<String>> {
        self.reads
            .lock()
            .expect("test reads lock")
            .push(runtime_session_id.to_string());
        Ok(Some(format!("output:{runtime_session_id}")))
    }
}

fn ssh_runtime(runtime_session_id: &str, saved_session_id: &str) -> RuntimeSessionInfo {
    RuntimeSessionInfo {
        runtime_session_id: runtime_session_id.to_string(),
        saved_session_id: Some(saved_session_id.to_string()),
        history_scope_kind: None,
        history_scope_id: None,
        pane_id: format!("pane-{runtime_session_id}"),
        title: runtime_session_id.to_string(),
        kind: RuntimeSessionKind::Ssh,
        initial_cwd: None,
        cols: 120,
        rows: 32,
    }
}

fn ssh_container_runtime(runtime_session_id: &str, saved_session_id: &str) -> RuntimeSessionInfo {
    RuntimeSessionInfo {
        kind: RuntimeSessionKind::SshContainer,
        ..ssh_runtime(runtime_session_id, saved_session_id)
    }
}

async fn call_sidebar_tool(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    id: u64,
    name: &str,
    arguments: Value,
) -> Value {
    client
        .post(endpoint)
        .bearer_auth(token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments }
        }))
        .send()
        .await
        .expect("sidebar MCP request should send")
        .json::<Value>()
        .await
        .expect("sidebar MCP response should be JSON")
}

#[tokio::test]
async fn mcp_http_handler_rejects_missing_bearer_and_bad_origin() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));

    let missing_auth = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        request(
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
            vec![],
        ),
    )
    .await
    .expect("request should handle");
    assert_eq!(missing_auth.status, 401);

    let bad_origin = handle_http_request(
        store,
        tools,
        "token-1",
        request(
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
            vec![
                ("authorization".to_string(), "Bearer token-1".to_string()),
                ("origin".to_string(), "https://evil.example".to_string()),
            ],
        ),
    )
    .await
    .expect("request should handle");
    assert_eq!(bad_origin.status, 403);
}

#[tokio::test]
async fn mcp_http_handler_supports_initialize_tools_list_and_pending_tool_call() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));

    let initialize = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_request(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"})),
    )
    .await
    .expect("initialize should handle");
    assert_eq!(initialize.status, 200);
    let initialize_body: Value = serde_json::from_slice(&initialize.body).expect("json body");
    assert_eq!(initialize_body["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(
        initialize_body["result"]["serverInfo"]["name"],
        "zTerm Headless"
    );
    assert!(initialize_body["result"]["instructions"]
        .as_str()
        .expect("headless instructions")
        .contains("不写入任何终端滚动屏"));

    let initialized = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        })),
    )
    .await
    .expect("initialized notification should handle");
    assert_eq!(initialized.status, 202);
    assert!(initialized.body.is_empty());

    let list = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_request(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})),
    )
    .await
    .expect("tools/list should handle");
    let list_body: Value = serde_json::from_slice(&list.body).expect("json body");
    let tool_names = list_body["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        tool_names,
        vec![
            "approval.wait",
            "sessions.list",
            "sessions.save",
            "ssh.execute",
            "ssh.upload",
            "ssh.download",
            "sftp.upload",
            "sftp.download",
            "ftp.upload",
            "ftp.download",
            "transfer.list",
        ]
    );
    let listed_tools = list_body["result"]["tools"].as_array().expect("tools");
    for tool in listed_tools {
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_ne!(tool["inputSchema"]["properties"], json!({}));
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
    let call = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "sessions.delete",
                "arguments": { "id": "missing-session" }
            }
        })),
    )
    .await
    .expect("tools/call should handle");
    let call_body: Value = serde_json::from_slice(&call.body).expect("json body");
    assert_eq!(call_body["error"]["code"], -32601);
    assert!(call_body["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("not exposed"));
}

#[tokio::test]
async fn mcp_service_binds_localhost_and_serves_json_rpc() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    let status = service
        .start(store, tools, Some(0))
        .await
        .expect("mcp service should start");

    let endpoint = status.endpoint.clone().expect("endpoint");
    assert!(endpoint.starts_with("http://127.0.0.1:"));
    let token = status.token.clone().expect("token");

    let response = reqwest::Client::new()
        .post(&endpoint)
        .bearer_auth(token)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .expect("request should send");
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.json::<Value>().await.expect("json body");
    assert!(body["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .any(|tool| tool["name"] == "ssh.execute"));

    service.stop_and_wait().await.expect("service should stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_mcp_starts_share_one_listener_and_concurrent_stops_wait_for_it() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = Arc::new(McpService::with_secret_store(Arc::new(
        MemorySecretStore::default(),
    )));

    let mut starts = Vec::new();
    for _ in 0..12 {
        let store = Arc::clone(&store);
        let tools = tools.clone();
        let service = Arc::clone(&service);
        starts.push(tokio::spawn(async move {
            service.ensure_running(store, tools, Some(0)).await
        }));
    }
    let mut endpoints = Vec::new();
    for start in starts {
        let status = start
            .await
            .expect("start task should join")
            .expect("MCP start should succeed");
        endpoints.push(status.endpoint.expect("running endpoint"));
    }
    assert!(endpoints.iter().all(|endpoint| endpoint == &endpoints[0]));

    let mut stops = Vec::new();
    for _ in 0..4 {
        let service = Arc::clone(&service);
        stops.push(tokio::spawn(async move { service.stop_and_wait().await }));
    }
    for stop in stops {
        let status = stop
            .await
            .expect("stop task should join")
            .expect("MCP stop should succeed");
        assert!(!status.enabled);
    }
    assert!(service.status().is_none());
}

#[tokio::test]
async fn stopped_mcp_listener_releases_port_for_immediate_restart() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    let first = service
        .ensure_running(Arc::clone(&store), tools.clone(), Some(0))
        .await
        .expect("first MCP start should succeed");
    let port = first
        .endpoint
        .as_deref()
        .and_then(|endpoint| endpoint.strip_prefix("http://127.0.0.1:"))
        .and_then(|endpoint| endpoint.strip_suffix("/mcp"))
        .and_then(|port| port.parse::<u16>().ok())
        .expect("ephemeral endpoint port");

    service
        .stop_and_wait()
        .await
        .expect("listener should stop and release its port");
    assert!(service.status().is_none());

    let restarted = service
        .ensure_running(store, tools, Some(port))
        .await
        .expect("MCP should immediately restart on the released port");
    assert_eq!(
        restarted.endpoint.as_deref(),
        Some(format!("http://127.0.0.1:{port}/mcp").as_str())
    );
    service
        .stop_and_wait()
        .await
        .expect("restarted listener should stop");
}

#[tokio::test]
async fn disabling_mcp_cancels_preaccepted_request_before_tool_execution() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let writer = Arc::new(CountingToolWriter::default());
    let tools = AiToolService::with_writer(writer.clone());
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    let status = service
        .ensure_running(store, tools, Some(0))
        .await
        .expect("MCP start should succeed");
    let endpoint = status.endpoint.expect("endpoint");
    let token = status.token.expect("token");
    let port = endpoint
        .strip_prefix("http://127.0.0.1:")
        .and_then(|endpoint| endpoint.strip_suffix("/mcp"))
        .and_then(|port| port.parse::<u16>().ok())
        .expect("endpoint port");
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("client should connect");
    let body = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"terminal.list","arguments":{}}}"#;
    let partial_headers = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n",
        body.len()
    );
    stream
        .write_all(partial_headers.as_bytes())
        .await
        .expect("partial request should write");
    tokio::time::sleep(Duration::from_millis(30)).await;

    timeout(Duration::from_secs(1), service.stop_and_wait())
        .await
        .expect("stop should not wait for the slow request timeout")
        .expect("MCP stop should succeed");

    let mut response = Vec::new();
    let completed_request = async {
        stream
            .write_all(b"Content-Type: application/json\r\n\r\n")
            .await?;
        stream.write_all(body).await
    }
    .await;
    if completed_request.is_ok() {
        let _ = timeout(
            Duration::from_millis(200),
            stream.read_to_end(&mut response),
        )
        .await;
    }
    assert_eq!(writer.list_calls.load(Ordering::SeqCst), 0);
    assert!(!response.windows(6).any(|window| window == b"200 OK"));
}

#[tokio::test]
async fn sidebar_agent_token_is_scoped_to_visible_ssh_terminals() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    save_session(
        store.as_ref(),
        SavedSessionDraft {
            id: Some("session-1".to_string()),
            name: "Production".to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "ssh.example.test".to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_mode: AuthMode::None,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        },
    )
    .expect("SSH session should save");
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    service
        .start(store, tools, Some(0))
        .await
        .expect("mcp service should start");
    let access = service
        .register_agent_binding(AgentMcpBinding {
            agent_session_id: "agent-1".to_string(),
            runtime_session_id: "runtime-1".to_string(),
            saved_session_id: Some("session-1".to_string()),
            target_runtime_kind: RuntimeSessionKind::Ssh,
            target_label: "Production".to_string(),
        })
        .expect("agent binding should register");

    let client = reqwest::Client::new();
    let initialize = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({"jsonrpc": "2.0", "id": 0, "method": "initialize"}))
        .send()
        .await
        .expect("initialize should send");
    assert_eq!(initialize.status(), StatusCode::OK);
    let initialize_body = initialize.json::<Value>().await.expect("initialize JSON");
    assert_eq!(
        initialize_body["result"]["serverInfo"]["name"],
        "zTerm Visible Terminal"
    );
    assert!(initialize_body["result"]["instructions"]
        .as_str()
        .expect("visible terminal instructions")
        .contains("滚动屏"));

    let initialized = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }))
        .send()
        .await
        .expect("initialized notification should send");
    assert_eq!(initialized.status(), StatusCode::ACCEPTED);
    assert_eq!(initialized.bytes().await.expect("empty body").len(), 0);

    let listed = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
        .send()
        .await
        .expect("tools/list should send")
        .json::<Value>()
        .await
        .expect("tools/list JSON");
    let names = listed["result"]["tools"]
        .as_array()
        .expect("tools")
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "sessions.list",
            "terminal.list",
            "terminal.open",
            "terminal.read",
            "terminal.write",
            "terminal.close"
        ]
    );

    let sessions = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0", "id": 10, "method": "tools/call",
            "params": { "name": "sessions.list", "arguments": {} }
        }))
        .send()
        .await
        .expect("sessions.list should send")
        .json::<Value>()
        .await
        .expect("sessions.list JSON");
    assert_eq!(
        sessions["result"]["structuredContent"]["result"]["sessions"][0]["id"],
        "session-1"
    );

    let terminals = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0", "id": 11, "method": "tools/call",
            "params": { "name": "terminal.list", "arguments": {} }
        }))
        .send()
        .await
        .expect("terminal.list should send")
        .json::<Value>()
        .await
        .expect("terminal.list JSON");
    assert_eq!(
        terminals["result"]["structuredContent"]["result"]["terminals"][0]["runtime_session_id"],
        "runtime-1"
    );
    assert_eq!(
        terminals["result"]["structuredContent"]["result"]["terminals"]
            .as_array()
            .expect("visible SSH terminals")
            .len(),
        1
    );

    let opened = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0", "id": 12, "method": "tools/call",
            "params": {
                "name": "terminal.open",
                "arguments": {
                    "saved_session_id": "session-1",
                    "placement": "split_horizontal"
                }
            }
        }))
        .send()
        .await
        .expect("terminal.open should send")
        .json::<Value>()
        .await
        .expect("terminal.open JSON");
    assert_eq!(opened["result"]["structuredContent"]["status"], "succeeded");

    let read = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {
                "name": "terminal.read",
                "arguments": { "runtime_session_id": "runtime-1" }
            }
        }))
        .send()
        .await
        .expect("terminal.read should send")
        .json::<Value>()
        .await
        .expect("terminal.read JSON");
    assert_eq!(
        read["result"]["structuredContent"]["result"]["runtime_session_id"],
        "runtime-1"
    );

    let local_rejected = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0", "id": 13, "method": "tools/call",
            "params": {
                "name": "terminal.read",
                "arguments": { "runtime_session_id": "runtime-local" }
            }
        }))
        .send()
        .await
        .expect("local terminal rejection should send")
        .json::<Value>()
        .await
        .expect("local terminal rejection JSON");
    assert_eq!(local_rejected["error"]["code"], -32602);

    let rejected = client
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": "ssh.execute", "arguments": { "script": "pwd" } }
        }))
        .send()
        .await
        .expect("ssh.execute rejection should send")
        .json::<Value>()
        .await
        .expect("ssh.execute rejection JSON");
    assert_eq!(rejected["error"]["code"], -32601);

    service.stop_and_wait().await.expect("service should stop");
}

#[tokio::test]
async fn sidebar_agent_default_runtime_falls_back_only_within_its_ssh_connection() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    save_session(
        store.as_ref(),
        SavedSessionDraft {
            id: Some("session-1".to_string()),
            name: "Shared SSH".to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "ssh.example.test".to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_mode: AuthMode::None,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        },
    )
    .expect("SSH session should save");
    let writer = Arc::new(MutableToolWriter::default());
    writer.set_terminals(vec![
        ssh_runtime("runtime-original", "session-1"),
        ssh_runtime("runtime-fallback", "session-1"),
        ssh_runtime("runtime-other", "session-2"),
    ]);
    let tools = AiToolService::with_writer(writer.clone());
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    service
        .start(Arc::clone(&store), tools.clone(), Some(0))
        .await
        .expect("MCP service should start");
    let access = service
        .register_agent_binding(AgentMcpBinding {
            agent_session_id: "agent-shared-ssh".to_string(),
            runtime_session_id: "runtime-original".to_string(),
            saved_session_id: Some("session-1".to_string()),
            target_runtime_kind: RuntimeSessionKind::Ssh,
            target_label: "Shared SSH".to_string(),
        })
        .expect("agent binding should register");
    let client = reqwest::Client::new();

    let original = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        40,
        "terminal.read",
        json!({}),
    )
    .await;
    assert_eq!(
        original["result"]["structuredContent"]["result"]["runtime_session_id"],
        "runtime-original"
    );

    writer.set_terminals(vec![
        ssh_runtime("runtime-fallback", "session-1"),
        ssh_runtime("runtime-other", "session-2"),
    ]);
    let fallback = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        41,
        "terminal.read",
        json!({}),
    )
    .await;
    assert_eq!(
        fallback["result"]["structuredContent"]["result"]["runtime_session_id"],
        "runtime-fallback"
    );
    let write = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        42,
        "terminal.write",
        json!({ "data": "pwd\r" }),
    )
    .await;
    assert_eq!(
        write["result"]["structuredContent"]["result"]["runtime_session_id"],
        "runtime-fallback"
    );
    let close = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        43,
        "terminal.close",
        json!({}),
    )
    .await;
    assert_eq!(close["result"]["structuredContent"]["status"], "succeeded");
    assert_eq!(writer.action_runtime_ids(), vec!["runtime-fallback"]);

    let explicit_other = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        44,
        "terminal.read",
        json!({ "runtime_session_id": "runtime-other" }),
    )
    .await;
    assert_eq!(
        explicit_other["result"]["structuredContent"]["result"]["runtime_session_id"],
        "runtime-other"
    );
    let explicit_missing = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        45,
        "terminal.read",
        json!({ "runtime_session_id": "runtime-missing" }),
    )
    .await;
    assert_eq!(explicit_missing["error"]["code"], -32602);

    writer.set_terminals(vec![ssh_runtime("runtime-other", "session-2")]);
    let no_default_target = call_sidebar_tool(
        &client,
        &access.endpoint,
        &access.token,
        46,
        "terminal.read",
        json!({}),
    )
    .await;
    assert_eq!(no_default_target["error"]["code"], -32602);

    writer.set_terminals(vec![
        ssh_container_runtime("container-original", "session-1"),
        ssh_runtime("runtime-fallback", "session-1"),
    ]);
    let container_access = service
        .register_agent_binding(AgentMcpBinding {
            agent_session_id: "agent-container".to_string(),
            runtime_session_id: "container-original".to_string(),
            saved_session_id: Some("session-1".to_string()),
            target_runtime_kind: RuntimeSessionKind::SshContainer,
            target_label: "Container SSH".to_string(),
        })
        .expect("container binding should register");
    let container_original = call_sidebar_tool(
        &client,
        &container_access.endpoint,
        &container_access.token,
        47,
        "terminal.read",
        json!({}),
    )
    .await;
    assert_eq!(
        container_original["result"]["structuredContent"]["result"]["runtime_session_id"],
        "container-original"
    );
    writer.set_terminals(vec![ssh_runtime("runtime-fallback", "session-1")]);
    let container_default = call_sidebar_tool(
        &client,
        &container_access.endpoint,
        &container_access.token,
        48,
        "terminal.read",
        json!({}),
    )
    .await;
    assert_eq!(container_default["error"]["code"], -32602);

    upsert_ai_connection_approval_policy(
        store.as_ref(),
        "session-1",
        zterm_lib::models::ai::AiApprovalMode::RequestApproval,
    )
    .expect("connection policy should save");
    let pending_client = reqwest::Client::new();
    let pending_endpoint = access.endpoint.clone();
    let pending_token = access.token.clone();
    let pending_request = tokio::spawn(async move {
        call_sidebar_tool(
            &pending_client,
            &pending_endpoint,
            &pending_token,
            49,
            "terminal.read",
            json!({}),
        )
        .await
    });
    let pending_id = timeout(Duration::from_secs(1), async {
        loop {
            if let Some(pending) = tools
                .list_pending(store.as_ref())
                .expect("pending tools should list")
                .into_iter()
                .find(|pending| pending.tool_id == "terminal.read")
            {
                break pending.id;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fallback read should become pending");
    let (_, pending_arguments) = get_ai_tool_pending_state(store.as_ref(), &pending_id)
        .expect("pending arguments should persist");
    assert_eq!(pending_arguments["runtime_session_id"], "runtime-fallback");

    writer.set_terminals(vec![ssh_runtime("runtime-other", "session-2")]);
    tools
        .confirm(
            store.as_ref(),
            AiToolConfirmRequest {
                invocation_id: pending_id,
                approved: true,
                audit_context_json: None,
                secret_inputs: None,
            },
        )
        .expect("approval should execute the resolved original target");
    let completed = pending_request
        .await
        .expect("pending request should finish");
    assert_eq!(
        completed["result"]["structuredContent"]["result"]["runtime_session_id"],
        "runtime-fallback"
    );
    assert_eq!(
        writer.read_runtime_ids().last().map(String::as_str),
        Some("runtime-fallback")
    );

    service.stop_and_wait().await.expect("service should stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a locally logged-in Codex CLI and performs one model request"]
async fn codex_cli_discovers_sidebar_tools_with_native_model_configuration() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    service
        .start(store, tools, Some(0))
        .await
        .expect("mcp service should start");
    let access = service
        .register_agent_binding(AgentMcpBinding {
            agent_session_id: "agent-codex-smoke".to_string(),
            runtime_session_id: "runtime-1".to_string(),
            saved_session_id: Some("session-1".to_string()),
            target_runtime_kind: RuntimeSessionKind::Ssh,
            target_label: "Codex smoke terminal".to_string(),
        })
        .expect("agent binding should register");

    let smoke_root = std::env::temp_dir().join(format!("zterm-codex-smoke-{}", Uuid::new_v4()));
    fs::create_dir_all(&smoke_root).expect("smoke directory should create");
    let endpoint_config = format!("mcp_servers.zterm.url={}", toml_string(&access.endpoint));
    let token_config =
        "mcp_servers.zterm.bearer_token_env_var=\"ZTERM_AGENT_MCP_TOKEN\"".to_string();
    let approval_config = "mcp_servers.zterm.default_tools_approval_mode=\"approve\"".to_string();
    let mut command = codex_command();
    command
        .current_dir(&smoke_root)
        .env("ZTERM_AGENT_MCP_TOKEN", &access.token)
        .args([
            "-s",
            "read-only",
            "-a",
            "never",
            "-c",
            &endpoint_config,
            "-c",
            &token_config,
            "-c",
            &approval_config,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--json",
            "Call the zterm terminal.read MCP tool exactly once and report its output. Do not use shell tools.",
        ]);
    let output = timeout(Duration::from_secs(120), command.output())
        .await
        .expect("Codex smoke should finish before timeout")
        .expect("Codex smoke should launch");
    service.stop_and_wait().await.expect("service should stop");
    fs::remove_dir_all(&smoke_root).expect("smoke directory should remove");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "Codex smoke failed");
    let events = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let tool_call = events.iter().find(|event| {
        event["type"] == "item.completed"
            && event["item"]["type"] == "mcp_tool_call"
            && event["item"]["server"] == "zterm"
            && event["item"]["tool"] == "terminal.read"
    });
    assert!(
        tool_call.is_some(),
        "Codex did not call zterm terminal.read"
    );
    let tool_call = tool_call.expect("tool call");
    assert_eq!(
        tool_call["item"]["status"],
        "completed",
        "tool call: {}",
        serde_json::to_string(&tool_call["item"]).expect("tool call JSON")
    );
}

fn codex_command() -> Command {
    if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "codex"]);
        command
    } else {
        Command::new("codex")
    }
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[test]
fn mcp_default_port_is_stable_for_external_client_configuration() {
    assert_eq!(DEFAULT_MCP_PORT, 9419);
}

#[test]
fn visible_terminal_profile_rejects_local_runtimes() {
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    tools
        .ensure_visible_ssh_runtime("runtime-1")
        .expect("SSH runtime should be visible to sidebar Codex");
    let error = tools
        .ensure_visible_ssh_runtime("runtime-local")
        .expect_err("local runtime must remain outside the visible SSH profile");
    assert!(error.to_string().contains("SSH 服务器终端"));
}

#[tokio::test]
async fn mcp_token_is_reused_and_rotation_persists_across_service_instances() {
    let secrets = Arc::new(MemorySecretStore::default());
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));

    let first_service = McpService::with_secret_store(secrets.clone());
    let first_status = first_service
        .start(Arc::clone(&store), tools.clone(), Some(0))
        .await
        .expect("first MCP service should start");
    let first_token = first_status.token.expect("first token");
    first_service
        .stop_and_wait()
        .await
        .expect("first service should stop");

    let second_service = McpService::with_secret_store(secrets.clone());
    let second_status = second_service
        .start(Arc::clone(&store), tools.clone(), Some(0))
        .await
        .expect("second MCP service should start");
    assert_eq!(second_status.token.as_deref(), Some(first_token.as_str()));
    let rotated_token = second_service
        .rotate_token()
        .expect("token rotation should succeed")
        .token
        .expect("rotated token");
    assert_ne!(rotated_token, first_token);
    second_service
        .stop_and_wait()
        .await
        .expect("second service should stop");

    let third_service = McpService::with_secret_store(secrets);
    let third_status = third_service
        .start(store, tools, Some(0))
        .await
        .expect("third MCP service should start");
    assert_eq!(third_status.token.as_deref(), Some(rotated_token.as_str()));
    third_service
        .stop_and_wait()
        .await
        .expect("third service should stop");
}

#[tokio::test]
async fn enabled_mcp_setting_starts_listener_without_opening_settings_page() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let mut settings = get_app_settings(store.as_ref()).expect("settings should load");
    let reserved = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("port should reserve");
    let port = reserved.local_addr().expect("local address").port();
    drop(reserved);
    settings.mcp = McpSettings {
        enabled: true,
        port: Some(port),
    };
    save_app_settings(store.as_ref(), settings).expect("settings should save");

    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = Arc::new(McpService::with_secret_store(Arc::new(
        MemorySecretStore::default(),
    )));
    let status = start_mcp_if_enabled(Arc::clone(&store), tools, Arc::clone(&service))
        .await
        .expect("enabled MCP should start");

    assert!(status.enabled);
    assert_eq!(
        status.endpoint.as_deref(),
        Some(format!("http://127.0.0.1:{port}/mcp").as_str())
    );
    service.stop_and_wait().await.expect("service should stop");
}

#[tokio::test]
async fn headless_mcp_rejects_visible_terminal_listing() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": { "name": "terminal.list", "arguments": {} }
        })),
    )
    .await
    .expect("terminal.list rejection should handle");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body["error"]["code"], -32601);
    assert!(body["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("not exposed"));
}

#[tokio::test]
async fn mcp_rejects_plaintext_secrets_before_tool_preparation() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "sessions.save",
                "arguments": {
                    "draft": {
                        "name": "secret-host",
                        "type": "ssh",
                        "host": "example.internal",
                        "port": 22,
                        "username": "ops",
                        "auth_mode": "password",
                        "password": "do-not-store"
                    }
                }
            }
        })),
    )
    .await
    .expect("secret rejection should be a JSON-RPC response");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body["error"]["code"], -32602);
    assert!(!String::from_utf8_lossy(&response.body).contains("do-not-store"));
}

#[tokio::test]
async fn mcp_rejects_hidden_credential_reference_arguments() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "sessions.save",
                "arguments": {
                    "draft": {
                        "name": "hidden-ref",
                        "type": "ssh",
                        "host": "example.internal",
                        "port": 22,
                        "username": "ops",
                        "auth_mode": "password",
                        "credential_ref": "credential-must-stay-private"
                    }
                }
            }
        })),
    )
    .await
    .expect("unknown argument should return JSON-RPC error");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body["error"]["code"], -32602);
    assert!(body["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("unknown MCP tool argument"));
    assert!(!String::from_utf8_lossy(&response.body).contains("credential-must-stay-private"));
}

#[tokio::test]
async fn headless_mcp_rejects_visible_terminal_read_and_write() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let read = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "terminal.read",
                "arguments": { "runtime_session_id": "runtime-1", "cursor": 10 }
            }
        })),
    )
    .await
    .expect("terminal.read rejection should handle");
    let read_body: Value = serde_json::from_slice(&read.body).expect("json body");
    assert_eq!(read_body["error"]["code"], -32601);

    let write = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "terminal.write",
                "arguments": { "runtime_session_id": "runtime-1", "data": "pwd\r" }
            }
        })),
    )
    .await
    .expect("terminal.write rejection should handle");
    let write_body: Value = serde_json::from_slice(&write.body).expect("json body");
    assert_eq!(write_body["error"]["code"], -32601);
}

#[tokio::test]
async fn mcp_uses_the_target_ssh_connection_approval_policy() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    save_session(
        store.as_ref(),
        SavedSessionDraft {
            id: Some("session-1".to_string()),
            name: "Policy SSH".to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "ssh.example.test".to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_mode: AuthMode::None,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        },
    )
    .expect("ssh session should save");
    upsert_ai_connection_approval_policy(
        store.as_ref(),
        "session-1",
        zterm_lib::models::ai::AiApprovalMode::RequestApproval,
    )
    .expect("connection policy should save");
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = McpService::with_secret_store(Arc::new(MemorySecretStore::default()));
    service
        .start(Arc::clone(&store), tools.clone(), Some(0))
        .await
        .expect("MCP service should start");
    let access = service
        .register_agent_binding(AgentMcpBinding {
            agent_session_id: "agent-policy".to_string(),
            runtime_session_id: "runtime-1".to_string(),
            saved_session_id: Some("session-1".to_string()),
            target_runtime_kind: RuntimeSessionKind::Ssh,
            target_label: "Policy SSH".to_string(),
        })
        .expect("agent binding should register");
    let client = reqwest::Client::new();
    let endpoint = access.endpoint.clone();
    let token = access.token.clone();
    let pending_request = tokio::spawn(async move {
        client
            .post(endpoint)
            .bearer_auth(token)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 30,
                "method": "tools/call",
                "params": {
                    "name": "terminal.read",
                    "arguments": { "runtime_session_id": "runtime-1" }
                }
            }))
            .send()
            .await
            .expect("terminal.read should send")
            .json::<Value>()
            .await
            .expect("terminal.read JSON")
    });
    let pending_id = timeout(Duration::from_secs(1), async {
        loop {
            if let Some(pending) = tools
                .list_pending(store.as_ref())
                .expect("pending tools should list")
                .into_iter()
                .find(|pending| pending.tool_id == "terminal.read")
            {
                break pending.id;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("terminal.read should become pending");
    let (pending, arguments) = get_ai_tool_pending_state(store.as_ref(), &pending_id)
        .expect("resolved MCP pending arguments should persist");
    assert!(pending
        .target_summary
        .as_deref()
        .expect("terminal target summary")
        .contains("runtime_session_id=runtime-1"));
    assert_eq!(arguments["runtime_session_id"], "runtime-1");

    tools
        .confirm(
            store.as_ref(),
            AiToolConfirmRequest {
                invocation_id: pending_id,
                approved: true,
                audit_context_json: None,
                secret_inputs: None,
            },
        )
        .expect("zTerm approval should execute the original invocation");
    let approved_body = pending_request
        .await
        .expect("pending request task should finish");
    assert_eq!(
        approved_body["result"]["structuredContent"]["status"],
        "succeeded"
    );
    assert_eq!(
        approved_body["result"]["structuredContent"]["result"]["output"],
        "recent terminal output"
    );

    upsert_ai_connection_approval_policy(
        store.as_ref(),
        "session-1",
        zterm_lib::models::ai::AiApprovalMode::FullAccess,
    )
    .expect("connection policy should update");
    let executed_body = reqwest::Client::new()
        .post(&access.endpoint)
        .bearer_auth(&access.token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {
                "name": "terminal.read",
                "arguments": { "runtime_session_id": "runtime-1" }
            }
        }))
        .send()
        .await
        .expect("terminal.read should send")
        .json::<Value>()
        .await
        .expect("terminal.read JSON");
    assert_eq!(
        executed_body["result"]["structuredContent"]["status"],
        "succeeded"
    );
    service.stop_and_wait().await.expect("service should stop");
}

#[tokio::test]
async fn mcp_session_save_reuses_auth_without_exposing_credential_reference() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let source = save_session(
        store.as_ref(),
        SavedSessionDraft {
            id: Some("source-session".to_string()),
            name: "Source".to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "source.internal".to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_mode: AuthMode::Password,
            credential_ref: Some("credential-source".to_string()),
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        },
    )
    .expect("source session should save");
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {
                "name": "sessions.save",
                "arguments": {
                    "draft": {
                        "name": "Target",
                        "type": "ssh",
                        "host": "target.internal",
                        "port": 22,
                        "username": "ops"
                    },
                    "reuse_auth_from_session_id": source.id
                }
            }
        })),
    )
    .await
    .expect("sessions.save should handle");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    let saved = &body["result"]["structuredContent"]["result"]["session"];
    assert_eq!(saved["has_saved_auth"], true);
    assert!(saved.get("credential_ref").is_none());
    assert!(!String::from_utf8_lossy(&response.body).contains("credential-source"));
}

#[tokio::test]
async fn mcp_password_session_requires_local_zterm_secret_input() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_async_request(json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "sessions.save",
                "arguments": {
                    "draft": {
                        "name": "Prompted",
                        "type": "ssh",
                        "host": "prompt.internal",
                        "port": 22,
                        "username": "ops",
                        "auth_mode": "password"
                    }
                }
            }
        })),
    )
    .await
    .expect("sessions.save should create pending");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body["result"]["structuredContent"]["status"], "pending");
    assert_eq!(
        body["result"]["structuredContent"]["tool_id"],
        "sessions.save"
    );
}

#[tokio::test]
async fn mcp_ssh_execute_keeps_high_risk_scripts_pending() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_async_request(json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {
                "name": "ssh.execute",
                "arguments": {
                    "saved_session_id": "missing-session",
                    "script": "rm -rf /tmp/zterm-risk-check"
                }
            }
        })),
    )
    .await
    .expect("high risk ssh.execute should create pending");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body["result"]["structuredContent"]["status"], "pending");
    assert_eq!(
        body["result"]["structuredContent"]["tool_id"],
        "ssh.execute"
    );
    assert!(body["result"]["content"][0]["text"]
        .as_str()
        .expect("pending guidance")
        .contains("approval.wait"));
    let invocation_id = body["result"]["structuredContent"]["invocation_id"]
        .as_str()
        .expect("pending invocation ID")
        .to_string();
    let retried = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_async_request(json!({
            "jsonrpc": "2.0",
            "id": 13,
            "method": "tools/call",
            "params": {
                "name": "ssh.execute",
                "arguments": {
                    "saved_session_id": "missing-session",
                    "script": "rm -rf /tmp/zterm-risk-check"
                }
            }
        })),
    )
    .await
    .expect("identical pending retry should handle");
    let retried_body: Value = serde_json::from_slice(&retried.body).expect("json body");
    assert_eq!(
        retried_body["result"]["structuredContent"]["invocation_id"],
        invocation_id
    );
    assert_eq!(
        tools
            .list_pending(store.as_ref())
            .expect("pending tools should list")
            .len(),
        1
    );
    let audit = tools
        .confirm(
            store.as_ref(),
            AiToolConfirmRequest {
                invocation_id: invocation_id.clone(),
                approved: true,
                audit_context_json: None,
                secret_inputs: None,
            },
        )
        .expect("approval should produce a failed audit for the missing test session");
    assert_eq!(audit.status.as_str(), "failed");

    let waited = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 14,
            "method": "tools/call",
            "params": {
                "name": "approval.wait",
                "arguments": { "invocation_id": invocation_id }
            }
        })),
    )
    .await
    .expect("approval.wait should return the original completion");
    let waited_body: Value = serde_json::from_slice(&waited.body).expect("json body");
    assert_eq!(
        waited_body["result"]["structuredContent"]["status"],
        "failed"
    );
}

#[tokio::test]
async fn mcp_full_automation_executes_critical_commands_without_pending() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    save_session(
        store.as_ref(),
        SavedSessionDraft {
            id: Some("critical-session".to_string()),
            name: "Critical SSH".to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "127.0.0.1".to_string(),
            port: 1,
            username: "ops".to_string(),
            auth_mode: AuthMode::None,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        },
    )
    .expect("SSH session should save");
    upsert_ai_connection_approval_policy(
        store.as_ref(),
        "critical-session",
        zterm_lib::models::ai::AiApprovalMode::FullAccess,
    )
    .expect("full automation policy should save");
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 13,
            "method": "tools/call",
            "params": {
                "name": "ssh.execute",
                "arguments": {
                    "saved_session_id": "critical-session",
                    "script": "rm -rf /"
                }
            }
        })),
    )
    .await
    .expect("critical ssh.execute should execute without approval");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(body["result"]["structuredContent"]["status"], "failed");
    assert_eq!(
        body["result"]["structuredContent"]["tool_id"],
        "ssh.execute"
    );
    assert!(tools
        .list_pending(store.as_ref())
        .expect("pending tools should list")
        .is_empty());
}

#[tokio::test]
async fn mcp_file_transfers_expose_complete_schemas_for_efficient_approval() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let list = handle_http_request(
        Arc::clone(&store),
        tools.clone(),
        "token-1",
        authed_request(json!({"jsonrpc": "2.0", "id": 20, "method": "tools/list"})),
    )
    .await
    .expect("tools/list should handle");
    let list_body: Value = serde_json::from_slice(&list.body).expect("json body");
    for name in [
        "ssh.upload",
        "ssh.download",
        "sftp.upload",
        "sftp.download",
        "ftp.upload",
        "ftp.download",
    ] {
        let tool = list_body["result"]["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .find(|tool| tool["name"] == name)
            .expect("file transfer tool");
        assert_eq!(
            tool["inputSchema"]["required"],
            json!(["saved_session_id", "local_path", "remote_path"])
        );
        assert_eq!(
            tool["inputSchema"]["properties"]["conflict_policy"]["enum"],
            json!(["overwrite", "skip", "rename"])
        );
    }

    let catalog = mcp_tool_catalog();
    for name in [
        "ssh.upload",
        "ssh.download",
        "sftp.upload",
        "sftp.download",
        "ftp.upload",
        "ftp.download",
    ] {
        let tool = catalog
            .iter()
            .find(|tool| tool.id == name)
            .expect("file transfer definition");
        assert!(!tool.requires_confirmation);
        if name.ends_with(".download") {
            assert_eq!(tool.risk_level.as_str(), "low");
        } else {
            assert_eq!(tool.risk_level.as_str(), "medium");
        }
    }
}

fn authed_request(body: Value) -> McpHttpRequest {
    request(
        body,
        vec![("authorization".to_string(), "Bearer token-1".to_string())],
    )
}

fn authed_async_request(body: Value) -> McpHttpRequest {
    request(
        body,
        vec![
            ("authorization".to_string(), "Bearer token-1".to_string()),
            ("prefer".to_string(), "respond-async".to_string()),
        ],
    )
}

fn request(body: Value, headers: Vec<(String, String)>) -> McpHttpRequest {
    McpHttpRequest {
        method: "POST".to_string(),
        path: "/mcp".to_string(),
        headers,
        body: serde_json::to_vec(&body).expect("json request"),
    }
}
