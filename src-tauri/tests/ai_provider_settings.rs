// Author: Liz
use std::{
    env,
    io::{Read, Write},
    net::TcpListener,
    sync::Arc,
    thread,
};

use serde_json::json;
use zterm_lib::{
    error::AppError,
    models::credential::{AiProviderDraftTestRequest, AiProviderKind, AiProviderProfileDraft},
    services::credential_service::{CredentialService, MemorySecretStore},
    storage::{ai::list_ai_provider_profiles, sqlite::SqliteStore},
};

#[test]
fn ai_provider_wire_kind_uses_frontend_protocol_values() {
    let request = serde_json::from_value::<AiProviderDraftTestRequest>(json!({
        "draft": {
            "id": null,
            "name": "Gpt-5",
            "kind": "openai_responses",
            "base_url": "http://example.test/v1",
            "model": "gpt-5",
            "api_key": null,
            "api_key_ref": null,
            "enabled": true,
            "is_default": false
        },
        "prompt": "介绍一下Spark的执行架构"
    }))
    .expect("frontend protocol value should deserialize");

    assert_eq!(request.draft.kind, AiProviderKind::OpenAiResponses);
    assert_eq!(
        serde_json::to_value(AiProviderKind::OpenAiResponses).expect("kind should serialize"),
        json!("openai_responses")
    );
}

#[test]
fn provider_save_uses_keyring_ref_without_plain_api_key() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );
    let api_key = "sk-phase8-provider-secret";

    let profile = service
        .save_ai_provider(AiProviderProfileDraft {
            id: Some("openai-compatible".to_string()),
            name: "OpenAI Compatible".to_string(),
            kind: AiProviderKind::OpenAiChat,
            base_url: "https://api.example.test/v1".to_string(),
            model: "gpt-test".to_string(),
            api_key: Some(api_key.to_string()),
            api_key_ref: None,
            enabled: true,
            is_default: true,
        })
        .expect("provider should save");

    assert_ne!(profile.api_key_ref, api_key);
    assert_eq!(profile.kind, AiProviderKind::OpenAiChat);
    assert_eq!(
        service
            .read_secret(&profile.api_key_ref)
            .expect("api key should be stored in secret store"),
        api_key
    );
    assert_eq!(
        list_ai_provider_profiles(store.as_ref())
            .expect("providers should list")
            .len(),
        1
    );
    assert_eq!(provider_plaintext_hits(store.as_ref(), api_key), 0);
}

#[test]
fn provider_delete_removes_owned_api_key_secret() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );
    let profile = service
        .save_ai_provider(AiProviderProfileDraft {
            id: Some("openai-compatible".to_string()),
            name: "OpenAI Compatible".to_string(),
            kind: AiProviderKind::OpenAiChat,
            base_url: "https://api.example.test/v1".to_string(),
            model: "gpt-test".to_string(),
            api_key: Some("sk-phase8-provider-secret".to_string()),
            api_key_ref: None,
            enabled: true,
            is_default: true,
        })
        .expect("provider should save");

    service
        .delete_ai_provider(&profile.id)
        .expect("provider should delete");

    let error = service
        .read_secret(&profile.api_key_ref)
        .expect_err("owned api key secret should be removed");
    assert!(matches!(error, AppError::NotFound(_)));
}

#[test]
fn provider_save_supports_three_protocol_kinds() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );

    for (id, kind) in [
        ("chat", AiProviderKind::OpenAiChat),
        ("responses", AiProviderKind::OpenAiResponses),
        ("anthropic", AiProviderKind::Anthropic),
    ] {
        let profile = service
            .save_ai_provider(AiProviderProfileDraft {
                id: Some(id.to_string()),
                name: format!("{id} provider"),
                kind,
                base_url: "https://api.example.test/v1".to_string(),
                model: "model-test".to_string(),
                api_key: Some(format!("sk-{id}-secret")),
                api_key_ref: None,
                enabled: true,
                is_default: id == "chat",
            })
            .expect("provider should save");
        assert_eq!(profile.kind, kind);
        assert_eq!(profile.is_default, id == "chat");
    }

    let providers = list_ai_provider_profiles(store.as_ref()).expect("providers should list");
    assert_eq!(providers.len(), 3);
    assert!(providers
        .iter()
        .any(|profile| profile.kind == AiProviderKind::OpenAiResponses));
    assert!(providers
        .iter()
        .any(|profile| profile.kind == AiProviderKind::Anthropic));
}

#[test]
fn openai_compatible_provider_can_be_saved_without_api_key() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );

    let profile = service
        .save_ai_provider(AiProviderProfileDraft {
            id: Some("local-responses".to_string()),
            name: "Local Responses".to_string(),
            kind: AiProviderKind::OpenAiResponses,
            base_url: "http://172.16.41.198:5555/v1".to_string(),
            model: "any-model".to_string(),
            api_key: None,
            api_key_ref: None,
            enabled: true,
            is_default: true,
        })
        .expect("openai-compatible provider should allow no api key");

    assert_eq!(profile.api_key_ref, "");
    assert_eq!(
        service
            .list_ai_providers()
            .expect("providers should list")
            .first()
            .expect("saved provider should exist")
            .api_key_ref,
        ""
    );
    assert_eq!(
        service
            .list_credentials()
            .expect("credentials should list")
            .len(),
        0
    );
}

#[test]
fn anthropic_provider_still_requires_api_key() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );

    let error = service
        .save_ai_provider(AiProviderProfileDraft {
            id: Some("anthropic-no-key".to_string()),
            name: "Anthropic".to_string(),
            kind: AiProviderKind::Anthropic,
            base_url: "https://api.anthropic.com/v1".to_string(),
            model: "claude-test".to_string(),
            api_key: None,
            api_key_ref: None,
            enabled: true,
            is_default: true,
        })
        .expect_err("anthropic provider should require api key");

    assert!(matches!(error, AppError::Validation(message) if message.contains("API Key")));
}

#[test]
fn draft_test_calls_model_without_persisting_provider_or_key() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );
    let server = TestHttpServer::start(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 22\r\n\r\n{\"output_text\":\"pong\"}",
    );

    let result = service
        .test_ai_provider_draft(AiProviderDraftTestRequest {
            draft: AiProviderProfileDraft {
                id: None,
                name: "Draft Responses".to_string(),
                kind: AiProviderKind::OpenAiResponses,
                base_url: format!("{}/v1", server.base_url()),
                model: "any-model".to_string(),
                api_key: None,
                api_key_ref: None,
                enabled: true,
                is_default: false,
            },
            prompt: "say pong".to_string(),
        })
        .expect("draft test should call provider");

    assert!(result.ok);
    assert_eq!(result.output, "pong");
    assert_eq!(
        service
            .list_ai_providers()
            .expect("providers should list")
            .len(),
        0
    );
    assert_eq!(
        service
            .list_credentials()
            .expect("credentials should list")
            .len(),
        0
    );
    let request = server.request();
    assert!(request.starts_with("POST /v1/responses "));
    assert!(!request.to_ascii_lowercase().contains("authorization:"));
    assert!(request.contains("\"input\":\"say pong\""));
}

#[test]
fn draft_test_parses_success_body_longer_than_error_excerpt_limit() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );
    let output = "Spark driver and executors. ".repeat(90);
    let body = format!(r#"{{"output_text":"{output}"}}"#);
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
        body.len(),
        body
    );
    let server = TestHttpServer::start(response);

    let result = service
        .test_ai_provider_draft(AiProviderDraftTestRequest {
            draft: AiProviderProfileDraft {
                id: None,
                name: "Draft Responses".to_string(),
                kind: AiProviderKind::OpenAiResponses,
                base_url: format!("{}/v1", server.base_url()),
                model: "any-model".to_string(),
                api_key: None,
                api_key_ref: None,
                enabled: true,
                is_default: false,
            },
            prompt: "explain spark".to_string(),
        })
        .expect("draft test should parse a full success response body");

    assert_eq!(result.output, output);
}

#[test]
fn draft_test_rejects_anthropic_without_api_key() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );

    let error = service
        .test_ai_provider_draft(AiProviderDraftTestRequest {
            draft: AiProviderProfileDraft {
                id: None,
                name: "Anthropic".to_string(),
                kind: AiProviderKind::Anthropic,
                base_url: "https://api.anthropic.com/v1".to_string(),
                model: "claude-test".to_string(),
                api_key: None,
                api_key_ref: None,
                enabled: true,
                is_default: false,
            },
            prompt: "hello".to_string(),
        })
        .expect_err("anthropic draft test should require an api key");

    assert!(matches!(error, AppError::Credential(message) if message.contains("API Key")));
}

#[test]
#[ignore = "requires a controlled OpenAI-compatible endpoint and ZTERM_SMOKE_LLM_* environment variables"]
fn draft_test_smoke_openai_compatible_endpoint_from_env() {
    let base_url = env::var("ZTERM_SMOKE_LLM_BASE_URL")
        .expect("ZTERM_SMOKE_LLM_BASE_URL should point to the OpenAI-compatible /v1 endpoint");
    let model = env::var("ZTERM_SMOKE_LLM_MODEL").unwrap_or_else(|_| "gpt-5".to_string());
    let prompt = env::var("ZTERM_SMOKE_LLM_PROMPT")
        .unwrap_or_else(|_| "介绍一下Spark的执行架构".to_string());
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(MemorySecretStore::default()),
    );

    let result = service
        .test_ai_provider_draft(AiProviderDraftTestRequest {
            draft: AiProviderProfileDraft {
                id: None,
                name: "Smoke Responses".to_string(),
                kind: AiProviderKind::OpenAiResponses,
                base_url,
                model,
                api_key: None,
                api_key_ref: None,
                enabled: true,
                is_default: false,
            },
            prompt,
        })
        .expect("controlled OpenAI-compatible endpoint should return model text");

    assert!(result.ok);
    assert!(
        !result.output.trim().is_empty(),
        "smoke endpoint should return non-empty model text"
    );
    assert_eq!(
        service
            .list_ai_providers()
            .expect("providers should list")
            .len(),
        0
    );
    assert_eq!(
        service
            .list_credentials()
            .expect("credentials should list")
            .len(),
        0
    );
}

fn provider_plaintext_hits(store: &SqliteStore, secret: &str) -> i64 {
    store
        .with_connection(|connection| {
            let hits = connection.query_row(
                "
                select count(*) from ai_provider_profiles
                where id = ?1 or name = ?1 or base_url = ?1 or model = ?1 or api_key_ref = ?1
                ",
                [secret],
                |row| row.get::<_, i64>(0),
            )?;
            Ok(hits)
        })
        .expect("provider plaintext scan should run")
}

struct TestHttpServer {
    address: String,
    handle: thread::JoinHandle<String>,
}

impl TestHttpServer {
    fn start(response: impl Into<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("test server should bind");
        let address = format!("http://{}", listener.local_addr().expect("server address"));
        let response = response.into();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("request should arrive");
            let mut buffer = [0_u8; 4096];
            let size = stream.read(&mut buffer).expect("request should read");
            stream
                .write_all(response.as_bytes())
                .expect("response should write");
            String::from_utf8_lossy(&buffer[..size]).to_string()
        });
        Self { address, handle }
    }

    fn base_url(&self) -> &str {
        &self.address
    }

    fn request(self) -> String {
        self.handle.join().expect("server thread should finish")
    }
}
