// Author: Liz
use std::sync::Arc;

use reqwest::StatusCode;
use serde_json::{json, Value};
use zterm_lib::{
    error::AppResult,
    services::{
        ai_tool_service::{AiToolCommandWriter, AiToolService},
        mcp_service::{handle_http_request, McpHttpRequest, McpService},
    },
    storage::sqlite::SqliteStore,
};

#[derive(Default)]
struct FakeToolWriter;

impl AiToolCommandWriter for FakeToolWriter {
    fn write_terminal(&self, _runtime_session_id: &str, _data: &str) -> AppResult<()> {
        Ok(())
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
    assert!(tool_names.contains(&"sessions.list"));
    assert!(tool_names.contains(&"workspace.save"));

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
    assert_eq!(
        call_body["result"]["structuredContent"]["status"],
        "pending"
    );
}

#[tokio::test]
async fn mcp_service_binds_localhost_and_serves_json_rpc() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let tools = AiToolService::with_writer(Arc::new(FakeToolWriter));
    let service = McpService::default();
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
        .any(|tool| tool["name"] == "zterm.context"));

    service.stop().expect("service should stop");
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
