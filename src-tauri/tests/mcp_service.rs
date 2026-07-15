// Author: Liz
use std::sync::Arc;

use reqwest::StatusCode;
use serde_json::{json, Value};
use zterm_lib::{
    commands::mcp::start_mcp_if_enabled,
    error::AppResult,
    models::{
        session::{AuthMode, SavedSessionDraft, SessionType},
        settings::McpSettings,
        terminal::{RuntimeSessionInfo, RuntimeSessionKind},
    },
    services::{
        ai_tool_service::{AiToolCommandWriter, AiToolService},
        credential_service::{CredentialService, MemorySecretStore},
        mcp_service::{handle_http_request, McpHttpRequest, McpService, DEFAULT_MCP_PORT},
    },
    storage::{
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
        Ok(vec![RuntimeSessionInfo {
            runtime_session_id: "runtime-1".to_string(),
            saved_session_id: Some("session-1".to_string()),
            history_scope_kind: None,
            history_scope_id: None,
            pane_id: "pane-1".to_string(),
            title: "Production".to_string(),
            kind: RuntimeSessionKind::Ssh,
            cols: 120,
            rows: 32,
        }])
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
            "sessions.list",
            "sessions.save",
            "terminal.list",
            "terminal.open",
            "terminal.read",
            "terminal.write",
            "terminal.close",
            "ssh.execute",
            "llm_provider.list",
            "llm_provider.save",
        ]
    );
    let listed_tools = list_body["result"]["tools"].as_array().expect("tools");
    for tool in listed_tools {
        assert_eq!(tool["inputSchema"]["type"], "object");
        assert_ne!(tool["inputSchema"]["properties"], json!({}));
        assert_eq!(tool["inputSchema"]["additionalProperties"], false);
    }
    let terminal_write = listed_tools
        .iter()
        .find(|tool| tool["name"] == "terminal.write")
        .expect("terminal.write schema");
    assert_eq!(
        terminal_write["inputSchema"]["required"],
        json!(["runtime_session_id", "data"])
    );

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

    service.stop().expect("service should stop");
}

#[test]
fn mcp_default_port_is_stable_for_external_client_configuration() {
    assert_eq!(DEFAULT_MCP_PORT, 9419);
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
    first_service.stop().expect("first service should stop");

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
    second_service.stop().expect("second service should stop");

    let third_service = McpService::with_secret_store(secrets);
    let third_status = third_service
        .start(store, tools, Some(0))
        .await
        .expect("third MCP service should start");
    assert_eq!(third_status.token.as_deref(), Some(rotated_token.as_str()));
    third_service.stop().expect("third service should stop");
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
    service.stop().expect("service should stop");
}

#[tokio::test]
async fn mcp_terminal_list_returns_structured_runtime_data() {
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
    .expect("terminal.list should handle");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    assert_eq!(
        body["result"]["structuredContent"]["result"]["terminals"][0]["runtime_session_id"],
        "runtime-1"
    );
    assert_eq!(
        body["result"]["structuredContent"]["result"]["terminals"][0]["saved_session_id"],
        "session-1"
    );
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
async fn mcp_terminal_read_and_write_return_output_with_cursor() {
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
    .expect("terminal.read should handle");
    let read_body: Value = serde_json::from_slice(&read.body).expect("json body");
    assert_eq!(
        read_body["result"]["structuredContent"]["result"]["cursor"],
        42
    );
    assert!(read_body["result"]["structuredContent"]["result"]["output"]
        .as_str()
        .expect("terminal output")
        .contains("/home/ops"));

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
    .expect("terminal.write should handle");
    let write_body: Value = serde_json::from_slice(&write.body).expect("json body");
    assert_eq!(
        write_body["result"]["structuredContent"]["result"]["cursor"],
        42
    );
    assert_eq!(
        write_body["result"]["structuredContent"]["result"]["output"],
        "/home/ops"
    );
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
        authed_request(json!({
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
async fn mcp_model_save_returns_sanitized_provider_data() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let credentials = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );
    let tools = AiToolService::with_credential_service(Arc::new(FakeToolWriter), credentials);
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "llm_provider.save",
                "arguments": {
                    "draft": {
                        "name": "Local OpenAI",
                        "kind": "openai_responses",
                        "base_url": "http://127.0.0.1:11434/v1",
                        "model": "local-model",
                        "enabled": true,
                        "is_default": true
                    }
                }
            }
        })),
    )
    .await
    .expect("llm_provider.save should handle");
    let body: Value = serde_json::from_slice(&response.body).expect("json body");
    let provider = &body["result"]["structuredContent"]["result"]["provider"];
    assert_eq!(provider["name"], "Local OpenAI");
    assert_eq!(provider["model"], "local-model");
    assert_eq!(provider["has_api_key"], false);
    assert!(provider.get("api_key_ref").is_none());
}

#[tokio::test]
async fn mcp_ssh_execute_keeps_high_risk_scripts_pending() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let response = handle_http_request(
        store,
        tools,
        "token-1",
        authed_request(json!({
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
}

fn authed_request(body: Value) -> McpHttpRequest {
    request(
        body,
        vec![("authorization".to_string(), "Bearer token-1".to_string())],
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
