// Author: Liz
use std::sync::{Arc, Mutex};

use serde_json::json;
use zterm_lib::{
    error::AppResult,
    models::ai::{
        AiApprovalMode, AiConversationCreateRequest, AiConversationMessageAppendRequest,
        AiMessageRole, AiToolConfirmRequest, AiToolInvocationStatus, AiToolPrepareRequest,
        AiToolSecretInputs, RiskLevel,
    },
    models::credential::CredentialKind,
    models::history::{CommandHistoryDraft, HistoryScopeKind, HistorySearchOptions},
    models::session::{AuthMode, SavedSessionDraft, SessionType},
    services::{
        ai_conversation_service::AiConversationService,
        ai_tool_service::{AiToolCommandWriter, AiToolService},
        credential_service::{CredentialService, MemorySecretStore},
    },
    storage::{
        ai::get_ai_tool_pending_state,
        credentials::list_credentials,
        history::{insert_command_history, search_command_history},
        sessions::list_sessions,
        sqlite::SqliteStore,
    },
};

#[derive(Default)]
struct FakeToolWriter {
    writes: Mutex<Vec<(String, String)>>,
    output_after_write: Mutex<Option<String>>,
}

impl FakeToolWriter {
    fn with_output(output: &str) -> Self {
        Self {
            writes: Mutex::new(Vec::new()),
            output_after_write: Mutex::new(Some(output.to_string())),
        }
    }

    fn writes(&self) -> Vec<(String, String)> {
        self.writes.lock().expect("writer lock").clone()
    }
}

impl AiToolCommandWriter for FakeToolWriter {
    fn write_terminal(&self, runtime_session_id: &str, data: &str) -> AppResult<()> {
        self.writes
            .lock()
            .expect("writer lock")
            .push((runtime_session_id.to_string(), data.to_string()));
        Ok(())
    }

    fn terminal_output_cursor(&self, _runtime_session_id: &str) -> AppResult<Option<usize>> {
        Ok(Some(0))
    }

    fn read_terminal_output_after(
        &self,
        _runtime_session_id: &str,
        _cursor: usize,
    ) -> AppResult<Option<String>> {
        Ok(self.output_after_write.lock().expect("writer lock").clone())
    }
}

#[test]
fn tool_catalog_exposes_workspace_snapshots_without_workspace_close() {
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));
    let tool_ids = service
        .definitions()
        .into_iter()
        .map(|definition| definition.id)
        .collect::<Vec<_>>();

    assert!(!tool_ids.iter().any(|tool_id| tool_id == "workspace.close"));
    assert!(tool_ids
        .iter()
        .any(|tool_id| tool_id == "workspace.restore"));
    assert!(tool_ids.iter().any(|tool_id| tool_id == "workspace.delete"));
}

#[test]
fn conversation_service_persists_conversation_and_messages() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiConversationService::default();

    let conversation = service
        .create(
            &store,
            AiConversationCreateRequest {
                title: Some("排查终端问题".to_string()),
                scope_kind: "follow_focus".to_string(),
                scope_ref_json: Some(json!({"runtime_session_id": "runtime-1"}).to_string()),
                approval_mode: None,
            },
        )
        .expect("conversation should create");
    let message = service
        .append_message(
            &store,
            AiConversationMessageAppendRequest {
                conversation_id: conversation.id.clone(),
                role: AiMessageRole::User,
                content: "列出文件".to_string(),
                metadata_json: None,
            },
        )
        .expect("message should append");

    let loaded = service
        .get(&store, &conversation.id)
        .expect("conversation should load");
    assert_eq!(loaded.id, conversation.id);
    assert_eq!(loaded.messages, vec![message]);
    assert_eq!(
        service
            .list(&store, None, Some(10))
            .expect("conversations should list")
            .first()
            .expect("conversation summary should exist")
            .id,
        conversation.id
    );
}

#[test]
fn conversation_service_redacts_user_message_secrets_before_persisting_history() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiConversationService::default();
    let conversation = service
        .create(
            &store,
            AiConversationCreateRequest {
                title: Some("创建连接".to_string()),
                scope_kind: "follow_focus".to_string(),
                scope_ref_json: Some("{}".to_string()),
                approval_mode: None,
            },
        )
        .expect("conversation should create");
    let password = "history-password!";
    let message = format!("帮我创建 ssh://ops:{password}@example.test:2200");

    let saved = service
        .append_message(
            &store,
            AiConversationMessageAppendRequest {
                conversation_id: conversation.id.clone(),
                role: AiMessageRole::User,
                content: message,
                metadata_json: None,
            },
        )
        .expect("message should append");

    assert!(!saved.content.contains(password));
    assert!(saved
        .content
        .contains("ssh://ops:<redacted-secret>@example.test:2200"));
    let loaded = service
        .get(&store, &conversation.id)
        .expect("conversation should load");
    assert!(!serde_json::to_string(&loaded).unwrap().contains(password));
}

#[test]
fn tool_service_prepares_confirms_and_audits_terminal_write() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let writer = Arc::new(FakeToolWriter::default());
    let service = AiToolService::with_writer(writer.clone());

    let pending = service
        .prepare(
            &store,
            AiToolPrepareRequest {
                tool_id: "terminal.write".to_string(),
                arguments: json!({
                    "runtime_session_id": "runtime-1",
                    "data": "pwd\r"
                }),
                reason: Some("执行 AI 建议命令".to_string()),
                requested_by: Some("test".to_string()),
                conversation_id: Some("conversation-1".to_string()),
                run_id: None,
                step_id: None,
            },
        )
        .expect("tool call should prepare");

    assert_eq!(pending.tool_id, "terminal.write");
    assert!(pending.requires_confirmation);
    assert_eq!(pending.status, AiToolInvocationStatus::Pending);
    assert!(writer.writes().is_empty());

    let audit = service
        .confirm(
            &store,
            AiToolConfirmRequest {
                invocation_id: pending.id.clone(),
                approved: true,
                audit_context_json: Some(json!({"conversation_id": "conversation-1"}).to_string()),
                secret_inputs: None,
            },
        )
        .expect("tool call should confirm");

    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert_eq!(
        writer.writes(),
        vec![("runtime-1".to_string(), "pwd\r".to_string())]
    );
    assert_eq!(
        service
            .list_audit(&store, Some(10))
            .expect("audits should list")
            .first()
            .expect("audit should exist")
            .id,
        audit.id
    );
    assert!(service
        .list_pending(&store)
        .expect("pending should list")
        .is_empty());
}

#[test]
fn tool_service_rejects_without_executing() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let writer = Arc::new(FakeToolWriter::default());
    let service = AiToolService::with_writer(writer.clone());
    let pending = service
        .prepare(
            &store,
            AiToolPrepareRequest {
                tool_id: "terminal.write".to_string(),
                arguments: json!({
                    "runtime_session_id": "runtime-1",
                    "data": "rm -rf /"
                }),
                reason: None,
                requested_by: None,
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
        )
        .expect("tool call should prepare");

    let audit = service
        .confirm(
            &store,
            AiToolConfirmRequest {
                invocation_id: pending.id,
                approved: false,
                audit_context_json: None,
                secret_inputs: None,
            },
        )
        .expect("tool call should reject");

    assert_eq!(audit.status, AiToolInvocationStatus::Rejected);
    assert!(writer.writes().is_empty());
}

#[test]
fn tool_service_safe_mode_auto_executes_low_risk_terminal_write_with_readback() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let conversation = AiConversationService::default()
        .create(
            &store,
            AiConversationCreateRequest {
                title: Some("安全审批".to_string()),
                scope_kind: "follow_focus".to_string(),
                scope_ref_json: Some("{}".to_string()),
                approval_mode: Some(AiApprovalMode::Safe),
            },
        )
        .expect("conversation should create");
    let writer = Arc::new(FakeToolWriter::with_output("C:\\workspace\r\n"));
    let service = AiToolService::with_writer(writer.clone());

    let outcome = service
        .execute_if_allowed(
            &store,
            terminal_write_request("pwd\r", Some(conversation.id.clone()), Some("pane-main")),
            AiApprovalMode::Safe,
        )
        .expect("low risk command should execute");

    assert!(outcome.pending_invocation.is_none());
    let audit = outcome.audit_record.expect("audit should be recorded");
    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert_eq!(audit.risk_level, RiskLevel::Low);
    assert!(audit
        .result_summary
        .as_deref()
        .expect("result summary")
        .contains("C:\\workspace"));
    assert_eq!(
        writer.writes(),
        vec![("runtime-1".to_string(), "pwd\r".to_string())]
    );

    let loaded = AiConversationService::default()
        .get(&store, &conversation.id)
        .expect("conversation should load");
    assert!(loaded
        .messages
        .iter()
        .any(|message| message.role == AiMessageRole::Tool
            && message.content.contains("C:\\workspace")));
}

#[test]
fn tool_service_terminal_write_result_summary_is_readable() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let conversation = AiConversationService::default()
        .create(
            &store,
            AiConversationCreateRequest {
                title: Some("可读摘要".to_string()),
                scope_kind: "follow_focus".to_string(),
                scope_ref_json: Some("{}".to_string()),
                approval_mode: Some(AiApprovalMode::Safe),
            },
        )
        .expect("conversation should create");
    let writer = Arc::new(FakeToolWriter::with_output(
        "pwd\u{1b}[?2004l\r\r\n/home/demo\r\n\u{1b}[?2004h\u{1b}[32muser@host\u{1b}[m:\u{1b}[34m~\u{1b}[m$ ",
    ));
    let service = AiToolService::with_writer(writer);

    let outcome = service
        .execute_if_allowed(
            &store,
            terminal_write_request("pwd\r", Some(conversation.id.clone()), Some("pane-main")),
            AiApprovalMode::Safe,
        )
        .expect("command should execute");

    let audit = outcome.audit_record.expect("audit should be recorded");
    let summary = audit.result_summary.as_deref().expect("result summary");
    assert!(summary.contains("命令：pwd"));
    assert!(summary.contains("终端输出：\n/home/demo"));
    assert!(!summary.contains('\u{1b}'));
    assert!(!summary.contains("?2004"));
    assert!(!summary.contains("user@host"));

    let loaded = AiConversationService::default()
        .get(&store, &conversation.id)
        .expect("conversation should load");
    let tool_message = loaded
        .messages
        .iter()
        .find(|message| message.role == AiMessageRole::Tool)
        .expect("tool message should persist");
    assert_eq!(tool_message.content, summary);
}

#[test]
fn tool_service_safe_mode_keeps_high_risk_terminal_write_pending_with_captured_target() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let writer = Arc::new(FakeToolWriter::default());
    let service = AiToolService::with_writer(writer.clone());

    let outcome = service
        .execute_if_allowed(
            &store,
            terminal_write_request("rm -rf /tmp/demo\r", None, Some("pane-left")),
            AiApprovalMode::Safe,
        )
        .expect("high risk command should prepare pending");

    assert!(outcome.audit_record.is_none());
    let pending = outcome.pending_invocation.expect("pending should exist");
    assert_eq!(pending.risk_level, RiskLevel::Critical);
    assert!(pending.requires_confirmation);
    assert!(pending
        .target_summary
        .as_deref()
        .expect("target summary")
        .contains("pane_id=pane-left"));
    assert!(writer.writes().is_empty());
}

#[test]
fn tool_service_history_tools_require_and_use_history_scope() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    for (scope_id, runtime_session_id, command, started_at_ms) in [
        ("pwsh", "runtime-pwsh", "pwd", 10),
        ("git-bash", "runtime-git", "whoami", 20),
    ] {
        insert_command_history(
            &store,
            CommandHistoryDraft {
                scope_kind: Some(HistoryScopeKind::LocalProfile),
                scope_id: Some(scope_id.to_string()),
                runtime_session_id: runtime_session_id.to_string(),
                command: command.to_string(),
                cwd: None,
                exit_code: None,
                started_at_ms,
                finished_at_ms: None,
            },
        )
        .expect("history should insert");
    }

    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));
    let old_argument_error = service
        .prepare(
            &store,
            AiToolPrepareRequest {
                tool_id: "history.search".to_string(),
                arguments: json!({ "saved_session_id": "legacy-session" }),
                reason: None,
                requested_by: None,
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
        )
        .expect_err("legacy saved_session_id argument should be rejected");
    assert!(old_argument_error.to_string().contains("scope_kind"));

    let search = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "history.search".to_string(),
                arguments: json!({
                    "scope_kind": "local_profile",
                    "scope_id": "pwsh",
                    "query": "pw"
                }),
                reason: None,
                requested_by: None,
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("history search should execute in safe mode");
    assert!(search.pending_invocation.is_none());
    assert!(search
        .audit_record
        .expect("history search audit")
        .result_summary
        .expect("history search result")
        .contains("1 条"));

    let clear = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "history.clear".to_string(),
                arguments: json!({
                    "scope_kind": "local_profile",
                    "scope_id": "pwsh"
                }),
                reason: None,
                requested_by: None,
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::FullAccess,
        )
        .expect("history clear should require confirmation even in full access mode");
    assert!(clear.audit_record.is_none());
    let clear_pending = clear
        .pending_invocation
        .expect("history clear should prepare pending");
    let clear_audit = service
        .confirm(
            &store,
            AiToolConfirmRequest {
                invocation_id: clear_pending.id,
                approved: true,
                audit_context_json: None,
                secret_inputs: None,
            },
        )
        .expect("confirmed clear should execute");
    assert_eq!(clear_audit.status, AiToolInvocationStatus::Succeeded);

    let cleared_entries = search_command_history(
        &store,
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::LocalProfile),
            scope_id: Some("pwsh".to_string()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("cleared history should search");
    assert!(cleared_entries.is_empty());

    let other_scope_entries = search_command_history(
        &store,
        HistorySearchOptions {
            query: None,
            scope_kind: Some(HistoryScopeKind::LocalProfile),
            scope_id: Some("git-bash".to_string()),
            limit: None,
            deduplicate: None,
        },
    )
    .expect("other scope history should search");
    assert_eq!(other_scope_entries.len(), 1);
    assert_eq!(other_scope_entries[0].command, "whoami");
}

#[test]
fn tool_service_request_approval_requires_confirmation_for_low_risk_and_full_access_executes_high_risk(
) {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let writer = Arc::new(FakeToolWriter::default());
    let service = AiToolService::with_writer(writer.clone());

    let request_approval = service
        .execute_if_allowed(
            &store,
            terminal_write_request("pwd\r", None, None),
            AiApprovalMode::RequestApproval,
        )
        .expect("request approval should prepare pending");
    assert!(request_approval.pending_invocation.is_some());
    assert!(writer.writes().is_empty());

    let full_access = service
        .execute_if_allowed(
            &store,
            terminal_write_request("rm -rf /tmp/demo\r", None, None),
            AiApprovalMode::FullAccess,
        )
        .expect("full access should still prepare high risk terminal write");
    assert!(full_access.audit_record.is_none());
    assert!(full_access.pending_invocation.is_some());
    assert!(writer.writes().is_empty());
}

#[test]
fn tool_service_resource_save_executes_and_reports_affected_domains() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));

    let outcome = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "sessions.save".to_string(),
                arguments: json!({
                    "draft": local_session_draft("session-ai", "AI Local")
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("session save should auto execute in safe mode");

    assert!(outcome.pending_invocation.is_none());
    let audit = outcome.audit_record.expect("audit should be recorded");
    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert_eq!(
        audit.affected_domains,
        vec!["sessions".to_string(), "workspace".to_string()]
    );
    assert!(audit
        .result_summary
        .as_deref()
        .expect("result summary")
        .contains("AI Local"));

    let sessions = list_sessions(&store).expect("sessions should list");
    assert!(sessions
        .sessions
        .iter()
        .any(|session| session.id == "session-ai" && session.name == "AI Local"));
}

#[test]
fn tool_service_session_group_save_defaults_missing_ai_draft_fields() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));

    let outcome = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "session_groups.save".to_string(),
                arguments: json!({
                    "draft": {
                        "name": "移动机房"
                    }
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("session group save should default optional AI fields");

    assert!(outcome.pending_invocation.is_none());
    let audit = outcome.audit_record.expect("audit should be recorded");
    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert_eq!(audit.affected_domains, vec!["sessions".to_string()]);
    assert!(audit
        .result_summary
        .as_deref()
        .expect("result summary")
        .contains("移动机房"));

    let sessions = list_sessions(&store).expect("sessions should list");
    let group = sessions
        .groups
        .iter()
        .find(|group| group.name == "移动机房")
        .expect("AI group should save");
    assert!(group.expanded);
    assert_eq!(group.sort_order, 0);
}

#[test]
fn tool_service_session_save_resolves_existing_group_name_without_creating_duplicate_group() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let secrets = Arc::new(MemorySecretStore::default());
    let credential_service = CredentialService::with_secret_store(store.clone(), secrets);
    let service = AiToolService::with_credential_service(
        Arc::new(FakeToolWriter::default()),
        credential_service.clone(),
    );
    let group = zterm_lib::storage::sessions::save_session_group(
        store.as_ref(),
        zterm_lib::models::session::SessionGroupDraft {
            id: Some("group-mobile-room".to_string()),
            parent_id: None,
            name: "移动机房".to_string(),
            expanded: true,
            sort_order: 0,
        },
    )
    .expect("group should save");
    zterm_lib::storage::sessions::save_session_group(
        store.as_ref(),
        zterm_lib::models::session::SessionGroupDraft {
            id: Some("group-mobile-room-duplicate".to_string()),
            parent_id: None,
            name: "移动机房".to_string(),
            expanded: true,
            sort_order: 1,
        },
    )
    .expect("duplicate existing group should save");

    let outcome = service
        .execute_if_allowed(
            store.as_ref(),
            AiToolPrepareRequest {
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
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("session save should resolve group_name");

    assert!(outcome.pending_invocation.is_none());
    let audit = outcome.audit_record.expect("audit should be recorded");
    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert!(audit
        .result_summary
        .as_deref()
        .expect("result summary")
        .contains("172.16.41.181"));

    let sessions = list_sessions(store.as_ref()).expect("sessions should list");
    assert_eq!(
        sessions
            .groups
            .iter()
            .filter(|item| item.name == "移动机房")
            .count(),
        2
    );
    let session = sessions
        .sessions
        .iter()
        .find(|item| item.name == "172.16.41.181")
        .expect("AI session should save");
    assert_eq!(session.group_id.as_deref(), Some(group.id.as_str()));
    assert_eq!(session.host, "172.16.41.181");
    assert_eq!(session.username, "ubuntu");
    assert!(session.credential_ref.is_some());
}

#[test]
fn tool_service_session_save_recovers_password_misplaced_in_name() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let secrets = Arc::new(MemorySecretStore::default());
    let credential_service = CredentialService::with_secret_store(store.clone(), secrets);
    let service = AiToolService::with_credential_service(
        Arc::new(FakeToolWriter::default()),
        credential_service.clone(),
    );
    let password = "ai-created-password!";

    let outcome = service
        .execute_if_allowed(
            store.as_ref(),
            AiToolPrepareRequest {
                tool_id: "sessions.save".to_string(),
                arguments: json!({
                    "draft": {
                        "name": password,
                        "type": "ssh",
                        "host": "172.16.41.181",
                        "port": 22,
                        "username": "ubuntu",
                        "auth_mode": "password"
                    }
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("session save should recover misplaced password");

    assert!(outcome.pending_invocation.is_none());
    let audit = outcome.audit_record.expect("audit should be recorded");
    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert!(!audit.arguments_summary.contains(password));

    let sessions = list_sessions(store.as_ref()).expect("sessions should list");
    let session = sessions
        .sessions
        .iter()
        .find(|item| item.host == "172.16.41.181")
        .expect("AI session should save");
    assert_eq!(session.name, "172.16.41.181");
    assert_eq!(session.auth_mode, AuthMode::Password);
    let credential_ref = session
        .credential_ref
        .as_deref()
        .expect("session should reference saved password");
    assert_eq!(
        credential_service
            .read_secret(credential_ref)
            .expect("password should be stored"),
        password
    );
}

#[test]
fn tool_service_session_save_stores_ai_supplied_password_without_persisting_plaintext() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
    let secrets = Arc::new(MemorySecretStore::default());
    let credential_service = CredentialService::with_secret_store(store.clone(), secrets);
    let conversation = AiConversationService::default()
        .create(
            store.as_ref(),
            AiConversationCreateRequest {
                title: Some("AI 创建连接".to_string()),
                scope_kind: "follow_focus".to_string(),
                scope_ref_json: Some("{}".to_string()),
                approval_mode: Some(AiApprovalMode::Safe),
            },
        )
        .expect("conversation should create");
    let service = AiToolService::with_credential_service(
        Arc::new(FakeToolWriter::default()),
        credential_service.clone(),
    );
    let password = "ai-created-password!";
    let url = format!("ssh://ops:{password}@example.test:2200");

    let outcome = service
        .execute_if_allowed(
            store.as_ref(),
            AiToolPrepareRequest {
                tool_id: "sessions.save".to_string(),
                arguments: json!({
                    "draft": {
                        "id": "ssh-ai-secret",
                        "name": "AI SSH",
                        "url": url
                    }
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: Some(conversation.id.clone()),
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::RequestApproval,
        )
        .expect("session save should accept an AI supplied password");

    assert!(outcome.audit_record.is_none());
    let pending = outcome
        .pending_invocation
        .expect("session save should wait for approval");
    assert!(!pending.arguments_summary.contains(password));
    assert!(!pending.arguments_summary.contains(&url));
    assert!(!pending
        .target_summary
        .unwrap_or_default()
        .contains(password));
    let (_stored_pending, stored_arguments) =
        get_ai_tool_pending_state(store.as_ref(), &pending.id).expect("pending state should load");
    let stored_arguments_json =
        serde_json::to_string(&stored_arguments).expect("pending arguments should serialize");
    assert!(!stored_arguments_json.contains(password));
    assert!(!stored_arguments_json.contains(&url));
    assert!(stored_arguments_json.contains("credential:ai-session-ssh-ai-secret-password"));

    let audit = service
        .confirm(
            store.as_ref(),
            AiToolConfirmRequest {
                invocation_id: pending.id,
                approved: true,
                audit_context_json: None,
                secret_inputs: None,
            },
        )
        .expect("confirmed session save should execute");
    assert_eq!(audit.status, AiToolInvocationStatus::Succeeded);
    assert!(!audit.arguments_summary.contains(password));
    assert!(!audit.arguments_summary.contains(&url));
    assert!(!audit.result_summary.unwrap_or_default().contains(password));

    let sessions = list_sessions(store.as_ref()).expect("sessions should list");
    let session = sessions
        .sessions
        .iter()
        .find(|session| session.id == "ssh-ai-secret")
        .expect("AI session should save");
    let credential_ref = session
        .credential_ref
        .as_deref()
        .expect("session should point to keyring credential");
    assert_eq!(session.host, "example.test");
    assert_eq!(session.port, 2200);
    assert_eq!(session.username, "ops");
    assert_ne!(credential_ref, password);
    assert_eq!(
        credential_service
            .read_secret(credential_ref)
            .expect("password should be stored in keyring"),
        password
    );

    let credentials = list_credentials(store.as_ref()).expect("credentials should list");
    let credential = credentials
        .iter()
        .find(|record| record.credential_ref == credential_ref)
        .expect("credential metadata should save");
    assert_eq!(credential.kind, CredentialKind::SshPassword);
    assert_ne!(credential.id, password);
    assert!(!credential.name.contains(password));

    let loaded = AiConversationService::default()
        .get(store.as_ref(), &conversation.id)
        .expect("conversation should load");
    let serialized_messages =
        serde_json::to_string(&loaded.messages).expect("messages should serialize");
    assert!(!serialized_messages.contains(password));
}

#[test]
fn tool_service_requires_backend_services_for_server_info_and_container_tools() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));

    let server_info = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "server_info.snapshot".to_string(),
                arguments: json!({ "saved_session_id": "ssh-prod" }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("missing server info service should be audited");
    let server_info_audit = server_info.audit_record.expect("server info audit");
    assert_eq!(server_info_audit.status, AiToolInvocationStatus::Failed);
    assert_eq!(
        server_info_audit.affected_domains,
        vec!["monitor".to_string()]
    );
    assert!(server_info_audit
        .error
        .as_deref()
        .expect("server info error")
        .contains("资源监控服务"));

    let containers = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "ssh_container.list".to_string(),
                arguments: json!({ "saved_session_id": "ssh-prod" }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect("missing ssh command service should be audited");
    let containers_audit = containers.audit_record.expect("container audit");
    assert_eq!(containers_audit.status, AiToolInvocationStatus::Failed);
    assert_eq!(
        containers_audit.affected_domains,
        vec!["terminal".to_string()]
    );
    assert!(containers_audit
        .error
        .as_deref()
        .expect("container error")
        .contains("SSH 命令服务"));
}

#[test]
fn tool_service_full_access_still_keeps_delete_and_clear_pending() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));

    let delete_outcome = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "sessions.delete".to_string(),
                arguments: json!({ "id": "session-ai" }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::FullAccess,
        )
        .expect("delete should prepare pending");

    assert!(delete_outcome.audit_record.is_none());
    let pending = delete_outcome.pending_invocation.expect("delete pending");
    assert_eq!(pending.tool_id, "sessions.delete");
    assert!(pending.requires_confirmation);

    let clear_outcome = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "history.clear".to_string(),
                arguments: json!({
                    "scope_kind": "local_profile",
                    "scope_id": "pwsh"
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::FullAccess,
        )
        .expect("clear should prepare pending");

    assert!(clear_outcome.audit_record.is_none());
    assert_eq!(
        clear_outcome
            .pending_invocation
            .expect("clear pending")
            .tool_id,
        "history.clear"
    );
}

#[test]
fn tool_service_rejects_secret_values_in_tool_arguments() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));

    let error = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "llm_provider.create".to_string(),
                arguments: json!({
                    "draft": {
                        "name": "Secret provider",
                        "kind": "openai_responses",
                        "base_url": "http://example.test/v1",
                        "model": "gpt-test",
                        "api_key": "sk-test-secret",
                        "enabled": true,
                        "is_default": false
                    }
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::Safe,
        )
        .expect_err("secret-bearing arguments should be rejected");

    assert!(error.to_string().contains("敏感字段"));
}

#[test]
fn tool_service_provider_secret_is_collected_only_during_confirm() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let service = AiToolService::with_writer(Arc::new(FakeToolWriter::default()));

    let outcome = service
        .execute_if_allowed(
            &store,
            AiToolPrepareRequest {
                tool_id: "llm_provider.create".to_string(),
                arguments: json!({
                    "draft": {
                        "name": "Anthropic Local Secret",
                        "kind": "anthropic",
                        "base_url": "https://api.anthropic.com",
                        "model": "claude-test",
                        "enabled": true,
                        "is_default": false
                    }
                }),
                reason: None,
                requested_by: Some("test".to_string()),
                conversation_id: None,
                run_id: None,
                step_id: None,
            },
            AiApprovalMode::FullAccess,
        )
        .expect("secret-backed provider should prepare pending");

    assert!(outcome.audit_record.is_none());
    let pending = outcome.pending_invocation.expect("provider pending");
    assert!(pending.requires_confirmation);
    assert!(pending.requires_secret_input);
    assert_eq!(pending.secret_input_label.as_deref(), Some("API Key"));
    assert!(!pending.arguments_summary.contains("sk-local-only"));

    let audit = service
        .confirm(
            &store,
            AiToolConfirmRequest {
                invocation_id: pending.id,
                approved: true,
                audit_context_json: None,
                secret_inputs: Some(AiToolSecretInputs {
                    api_key: Some("sk-local-only".to_string()),
                    password: None,
                }),
            },
        )
        .expect("confirm should produce an audit even when runtime service is missing");

    assert_eq!(audit.status, AiToolInvocationStatus::Failed);
    assert!(!audit.arguments_summary.contains("sk-local-only"));
    assert!(!audit
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("sk-local-only"));
}

fn terminal_write_request(
    data: &str,
    conversation_id: Option<String>,
    pane_id: Option<&str>,
) -> AiToolPrepareRequest {
    AiToolPrepareRequest {
        tool_id: "terminal.write".to_string(),
        arguments: json!({
            "runtime_session_id": "runtime-1",
            "pane_id": pane_id,
            "target_title": "主终端",
            "data": data
        }),
        reason: Some("test".to_string()),
        requested_by: Some("test".to_string()),
        conversation_id,
        run_id: None,
        step_id: None,
    }
}

fn local_session_draft(id: &str, name: &str) -> SavedSessionDraft {
    SavedSessionDraft {
        id: Some(id.to_string()),
        name: name.to_string(),
        session_type: SessionType::Local,
        group_id: None,
        host: "localhost".to_string(),
        port: 22,
        username: String::new(),
        auth_mode: AuthMode::None,
        credential_ref: None,
        description: None,
        tags: Vec::new(),
        sort_order: 0,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
        ftp_options: None,
    }
}
