// Author: Liz
use std::sync::{Arc, Mutex};

use serde_json::json;
use zterm_lib::{
    error::AppResult,
    models::ai::{
        AiApprovalMode, AiConversationCreateRequest, AiConversationMessageAppendRequest,
        AiMessageRole, AiToolConfirmRequest, AiToolInvocationStatus, AiToolPrepareRequest,
        RiskLevel,
    },
    models::history::{CommandHistoryDraft, HistoryScopeKind, HistorySearchOptions},
    services::{
        ai_conversation_service::AiConversationService,
        ai_tool_service::{AiToolCommandWriter, AiToolService},
    },
    storage::{
        history::{insert_command_history, search_command_history},
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
        .expect("history clear should execute in full access mode");
    assert!(clear.pending_invocation.is_none());

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
        .expect("full access should execute risk command");
    assert!(full_access.pending_invocation.is_none());
    assert_eq!(
        full_access.audit_record.expect("full access audit").status,
        AiToolInvocationStatus::Succeeded
    );
    assert_eq!(
        writer.writes(),
        vec![("runtime-1".to_string(), "rm -rf /tmp/demo\r".to_string())]
    );
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
