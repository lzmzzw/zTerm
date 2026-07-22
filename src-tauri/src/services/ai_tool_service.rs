// Author: Liz
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::Emitter;
use uuid::Uuid;

use crate::services::{
    command_history_service::CommandHistoryService,
    credential_service::CredentialService,
    ftp_service,
    server_info_service::ServerInfoService,
    sftp_service::{local_path_total_bytes, SftpService, TransferProgressUpdate},
    ssh_command_service::SshCommandService,
    ssh_container_service::{
        build_container_list_script, enabled_container_options, parse_container_ps_output,
    },
    terminal_manager::TerminalManager,
    transfer_queue::TransferQueue,
};
use crate::{
    error::{AppError, AppResult},
    models::{
        ai::{
            AiApprovalMode, AiMessageRole, AiToolAuditListRequest, AiToolAuditRecord,
            AiToolConfirmRequest, AiToolDefinition, AiToolFrontendActionEvent,
            AiToolInvocationStatus, AiToolPendingInvocation, AiToolPrepareRequest,
            AiToolSecretInputs, RiskLevel,
        },
        credential::{AiProviderProfile, AiProviderProfileDraft, CredentialDraft, CredentialKind},
        history::{HistoryScopeKind, HistorySearchOptions},
        server_info::{ServerInfoRequest, ServerInfoSnapshot},
        session::{AuthMode, SavedSession, SavedSessionDraft, SessionGroupDraft, SessionType},
        sftp::{
            TransferConflictPolicy, TransferDirection, TransferEndpoint, TransferEndpointKind,
            TransferKind, TransferStatus, TransferTask, TransferTaskOrigin,
        },
        terminal::RuntimeSessionInfo,
        terminal_profile::TerminalProfileDraft,
        workspace::{
            PaneNode, WorkspaceDefinitionDraft, WorkspaceStatus, WorkspaceTabDraft,
            WorkspaceTerminalTab,
        },
    },
    security::redaction::redact_sensitive,
    storage::{
        ai::{
            delete_ai_tool_pending, get_ai_provider_profile, get_ai_tool_pending_state,
            insert_ai_conversation_message, insert_ai_tool_audit, list_ai_provider_profiles,
            list_ai_tool_audits, list_ai_tool_pending, update_ai_conversation_approval_mode,
            upsert_ai_tool_pending,
        },
        history::{clear_command_history, search_command_history},
        sessions::{
            delete_session, delete_session_group, get_session, list_sessions, save_session,
            save_session_group,
        },
        settings::get_app_settings,
        sqlite::SqliteStore,
        transfers::list_transfer_tasks,
        workspace::{get_workspace, list_workspaces, remove_workspace, save_workspace},
    },
};

pub trait AiToolCommandWriter: Send + Sync {
    fn write_terminal(&self, runtime_session_id: &str, data: &str) -> AppResult<()>;

    fn emit_tool_action(&self, _event: AiToolFrontendActionEvent) -> AppResult<()> {
        Ok(())
    }

    fn notify_pending_tools(&self) -> AppResult<()> {
        Ok(())
    }

    fn list_terminals(&self) -> AppResult<Vec<RuntimeSessionInfo>> {
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

#[derive(Debug, Clone)]
pub struct AiToolExecutionOutcome {
    pub pending_invocation: Option<AiToolPendingInvocation>,
    pub audit_record: Option<AiToolAuditRecord>,
    pub structured_content: Option<Value>,
}

#[derive(Debug, Clone)]
struct AiToolExecutionResult {
    summary: String,
    affected_domains: Vec<String>,
    structured_content: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TerminalReference {
    pub terminal_ref: String,
    pub runtime_session_id: String,
}

#[derive(Clone)]
pub struct AiToolService {
    writer: Arc<dyn AiToolCommandWriter>,
    terminal_references: Arc<Mutex<HashMap<String, String>>>,
    credential_service: Option<CredentialService>,
    transfer_queue: Option<TransferQueue>,
    sftp_service: Option<SftpService>,
    server_info_service: Option<ServerInfoService>,
    ssh_command_service: Option<SshCommandService>,
}

#[derive(Clone)]
pub struct RuntimeAiToolWriter {
    manager: Arc<TerminalManager>,
    history: Arc<CommandHistoryService>,
    app_handle: Option<tauri::AppHandle>,
}

impl RuntimeAiToolWriter {
    pub fn new(manager: Arc<TerminalManager>, history: Arc<CommandHistoryService>) -> Self {
        Self {
            manager,
            history,
            app_handle: None,
        }
    }

    pub fn with_app_handle(
        manager: Arc<TerminalManager>,
        history: Arc<CommandHistoryService>,
        app_handle: tauri::AppHandle,
    ) -> Self {
        Self {
            manager,
            history,
            app_handle: Some(app_handle),
        }
    }
}

impl AiToolCommandWriter for RuntimeAiToolWriter {
    fn emit_tool_action(&self, event: AiToolFrontendActionEvent) -> AppResult<()> {
        if let Some(app_handle) = &self.app_handle {
            app_handle
                .emit("zterm:tool-action", event)
                .map_err(|error| AppError::ai(format!("分发前端工具动作失败: {error}")))?;
        }
        Ok(())
    }

    fn notify_pending_tools(&self) -> AppResult<()> {
        if let Some(app_handle) = &self.app_handle {
            app_handle
                .emit("zterm:tool-pending", ())
                .map_err(|error| AppError::ai(format!("通知待确认工具失败: {error}")))?;
        }
        Ok(())
    }

    fn list_terminals(&self) -> AppResult<Vec<RuntimeSessionInfo>> {
        self.manager.runtime_infos()
    }

    fn write_terminal(&self, runtime_session_id: &str, data: &str) -> AppResult<()> {
        self.manager.write(runtime_session_id, data)?;
        self.history.capture_input(runtime_session_id, data)
    }

    fn terminal_output_cursor(&self, runtime_session_id: &str) -> AppResult<Option<usize>> {
        self.manager.output_cursor(runtime_session_id).map(Some)
    }

    fn read_terminal_output_after(
        &self,
        runtime_session_id: &str,
        cursor: usize,
    ) -> AppResult<Option<String>> {
        self.manager
            .wait_for_output_after(runtime_session_id, cursor, 2500, 250, 4000)
    }

    fn read_terminal_output_tail(
        &self,
        runtime_session_id: &str,
        max_chars: usize,
    ) -> AppResult<Option<String>> {
        self.manager.output_tail(runtime_session_id, max_chars)
    }
}

impl AiToolService {
    pub fn with_writer(writer: Arc<dyn AiToolCommandWriter>) -> Self {
        Self {
            writer,
            terminal_references: Arc::new(Mutex::new(HashMap::new())),
            credential_service: None,
            transfer_queue: None,
            sftp_service: None,
            server_info_service: None,
            ssh_command_service: None,
        }
    }

    pub fn with_credential_service(
        writer: Arc<dyn AiToolCommandWriter>,
        credential_service: CredentialService,
    ) -> Self {
        Self {
            writer,
            terminal_references: Arc::new(Mutex::new(HashMap::new())),
            credential_service: Some(credential_service),
            transfer_queue: None,
            sftp_service: None,
            server_info_service: None,
            ssh_command_service: None,
        }
    }

    pub fn with_runtime_services(
        writer: Arc<dyn AiToolCommandWriter>,
        credential_service: CredentialService,
        transfer_queue: TransferQueue,
        sftp_service: SftpService,
        server_info_service: ServerInfoService,
        ssh_command_service: SshCommandService,
    ) -> Self {
        Self {
            writer,
            terminal_references: Arc::new(Mutex::new(HashMap::new())),
            credential_service: Some(credential_service),
            transfer_queue: Some(transfer_queue),
            sftp_service: Some(sftp_service),
            server_info_service: Some(server_info_service),
            ssh_command_service: Some(ssh_command_service),
        }
    }

    pub fn definitions(&self) -> Vec<AiToolDefinition> {
        tool_definitions()
    }

    pub fn saved_session_id_for_runtime(
        &self,
        runtime_session_id: &str,
    ) -> AppResult<Option<String>> {
        let runtime_session_id = required_text("运行时会话 ID", runtime_session_id)?;
        Ok(self
            .writer
            .list_terminals()?
            .into_iter()
            .find(|runtime| runtime.runtime_session_id == runtime_session_id)
            .and_then(|runtime| runtime.saved_session_id))
    }

    /// Replaces the in-memory UI numbering map. The map is deliberately
    /// transient: it is never stored with MCP settings, pending calls, or audits.
    /// A resolved request still retains its supplied label in the existing
    /// pending/audit summary path for human-readable target confirmation.
    pub fn set_terminal_references(&self, references: Vec<TerminalReference>) -> AppResult<()> {
        let active_runtime_ids = self
            .writer
            .list_terminals()?
            .into_iter()
            .map(|runtime| runtime.runtime_session_id)
            .collect::<HashSet<_>>();
        let mut next = HashMap::new();
        let mut mapped_runtime_ids = HashSet::new();

        for reference in references {
            let terminal_ref = validate_terminal_reference(&reference.terminal_ref)?;
            let runtime_session_id = required_text("运行时会话 ID", &reference.runtime_session_id)?;
            if !active_runtime_ids.contains(&runtime_session_id) {
                return Err(AppError::validation(format!(
                    "终端编号 {terminal_ref} 指向的运行终端不存在"
                )));
            }
            if next
                .insert(terminal_ref.clone(), runtime_session_id.clone())
                .is_some()
            {
                return Err(AppError::validation(format!(
                    "终端编号重复: {terminal_ref}"
                )));
            }
            if !mapped_runtime_ids.insert(runtime_session_id) {
                return Err(AppError::validation("同一运行终端不能映射多个终端编号"));
            }
        }

        *self
            .terminal_references
            .lock()
            .map_err(|_| AppError::ai("终端编号映射锁已损坏"))? = next;
        Ok(())
    }

    /// Resolves only terminal read/write aliases. The returned arguments retain
    /// `terminal_ref` for human-readable pending/audit summaries and add the
    /// established runtime ID for the existing execution path.
    pub fn resolve_terminal_target_arguments(
        &self,
        tool_id: &str,
        mut arguments: Value,
    ) -> AppResult<Value> {
        if !matches!(tool_id, "terminal.read" | "terminal.write") {
            return Ok(arguments);
        }
        let object = arguments
            .as_object_mut()
            .ok_or_else(|| AppError::validation("终端工具参数必须是对象"))?;
        let terminal_ref = object
            .get("terminal_ref")
            .and_then(Value::as_str)
            .map(validate_terminal_reference)
            .transpose()?;
        let runtime_session_id = object
            .get("runtime_session_id")
            .and_then(Value::as_str)
            .map(|value| required_text("运行时会话 ID", value))
            .transpose()?;

        match (terminal_ref, runtime_session_id) {
            (Some(terminal_ref), Some(runtime_session_id)) => {
                let resolved = self.runtime_id_for_terminal_reference(&terminal_ref)?;
                if resolved != runtime_session_id {
                    return Err(AppError::validation(
                        "terminal_ref 与 runtime_session_id 指向不同终端",
                    ));
                }
            }
            (Some(terminal_ref), None) => {
                let runtime_session_id = self.runtime_id_for_terminal_reference(&terminal_ref)?;
                object.insert(
                    "runtime_session_id".to_string(),
                    Value::String(runtime_session_id),
                );
            }
            (None, Some(_)) => {}
            (None, None) => {
                return Err(AppError::validation(
                    "terminal.read 和 terminal.write 必须提供 runtime_session_id 或 terminal_ref",
                ));
            }
        }
        Ok(arguments)
    }

    fn runtime_id_for_terminal_reference(&self, terminal_ref: &str) -> AppResult<String> {
        let terminal_ref = validate_terminal_reference(terminal_ref)?;
        self.terminal_references
            .lock()
            .map_err(|_| AppError::ai("终端编号映射锁已损坏"))?
            .get(&terminal_ref)
            .cloned()
            .ok_or_else(|| {
                AppError::validation(format!("终端编号未关联当前运行终端: {terminal_ref}"))
            })
    }

    pub fn prepare(
        &self,
        store: &SqliteStore,
        request: AiToolPrepareRequest,
    ) -> AppResult<AiToolPendingInvocation> {
        let pending = self.build_pending(store, request, AiApprovalMode::RequestApproval)?;
        upsert_ai_tool_pending(store, &pending.0, &pending.1)?;
        Ok(pending.0)
    }

    pub fn execute_if_allowed(
        &self,
        store: &SqliteStore,
        request: AiToolPrepareRequest,
        approval_mode: AiApprovalMode,
    ) -> AppResult<AiToolExecutionOutcome> {
        let (pending, arguments) = self.build_pending(store, request, approval_mode)?;
        if pending.requires_confirmation {
            upsert_ai_tool_pending(store, &pending, &arguments)?;
            let _ = self.writer.notify_pending_tools();
            return Ok(AiToolExecutionOutcome {
                pending_invocation: Some(pending),
                audit_record: None,
                structured_content: None,
            });
        }

        let invocation_id = pending.id.clone();
        let (audit, structured_content) = self.audit_execution(
            store,
            invocation_id,
            pending,
            &arguments,
            true,
            None,
            Some(
                json!({ "approval_mode": approval_mode.as_str(), "auto_approved": true })
                    .to_string(),
            ),
        )?;
        Ok(AiToolExecutionOutcome {
            pending_invocation: None,
            audit_record: Some(audit),
            structured_content,
        })
    }

    fn build_pending(
        &self,
        store: &SqliteStore,
        request: AiToolPrepareRequest,
        approval_mode: AiApprovalMode,
    ) -> AppResult<(AiToolPendingInvocation, Value)> {
        let tool = tool_definition(&request.tool_id)?;
        let arguments = self.prepare_arguments_for_tool(store, &tool.id, request.arguments)?;
        reject_secret_argument_values(&arguments)?;
        validate_arguments(&tool.id, &arguments)?;
        let risk = assess_risk(&tool, &arguments);
        let secret_input = secret_input_requirement(store, &tool.id, &arguments)?;
        let requires_confirmation =
            requires_confirmation(&tool.id, approval_mode, risk.level) || secret_input.required;
        let pending = AiToolPendingInvocation {
            id: Uuid::new_v4().to_string(),
            tool_id: tool.id,
            tool_title: tool.title,
            risk_level: risk.level,
            arguments_summary: summarize_arguments(&arguments),
            target_summary: target_summary(&arguments),
            risk_summary: risk.summary,
            requires_confirmation,
            requires_secret_input: secret_input.required,
            secret_input_label: secret_input.label,
            status: AiToolInvocationStatus::Pending,
            created_at_ms: now_ms(),
            conversation_id: normalize_optional(request.conversation_id),
            run_id: normalize_optional(request.run_id),
            step_id: normalize_optional(request.step_id),
            reason: normalize_optional(request.reason),
            requested_by: normalize_optional(request.requested_by),
        };
        Ok((pending, arguments))
    }

    pub fn confirm(
        &self,
        store: &SqliteStore,
        request: AiToolConfirmRequest,
    ) -> AppResult<AiToolAuditRecord> {
        let invocation_id = required_text("待确认工具调用 ID", request.invocation_id)?;
        let (pending, arguments) = get_ai_tool_pending_state(store, &invocation_id)?;
        let (audit, _) = self.audit_execution(
            store,
            invocation_id,
            pending,
            &arguments,
            request.approved,
            request.secret_inputs,
            normalize_optional(request.audit_context_json),
        )?;
        delete_ai_tool_pending(store, &audit.invocation_id)?;
        Ok(audit)
    }

    #[allow(clippy::too_many_arguments)]
    fn audit_execution(
        &self,
        store: &SqliteStore,
        invocation_id: String,
        pending: AiToolPendingInvocation,
        arguments: &Value,
        approved: bool,
        secret_inputs: Option<AiToolSecretInputs>,
        audit_context_json: Option<String>,
    ) -> AppResult<(AiToolAuditRecord, Option<Value>)> {
        let execution = if approved {
            if pending.requires_secret_input
                && !secret_inputs_present_for_tool(&pending.tool_id, secret_inputs.as_ref())
            {
                Err(AppError::validation("确认该工具需要在本地输入认证信息"))
            } else {
                self.execute(store, &pending.tool_id, arguments, secret_inputs.as_ref())
            }
        } else {
            self.cleanup_rejected_prepared_secret(&pending.tool_id, arguments);
            Ok(AiToolExecutionResult {
                summary: "用户已拒绝执行。".to_string(),
                affected_domains: Vec::new(),
                structured_content: None,
            })
        };
        let completed_at_ms = now_ms();
        let structured_content = execution
            .as_ref()
            .ok()
            .and_then(|result| result.structured_content.clone());
        let audit = match execution {
            Ok(result) => AiToolAuditRecord {
                id: Uuid::new_v4().to_string(),
                invocation_id: invocation_id.clone(),
                tool_id: pending.tool_id.clone(),
                tool_title: pending.tool_title.clone(),
                risk_level: pending.risk_level,
                arguments_summary: pending.arguments_summary.clone(),
                risk_summary: pending.risk_summary.clone(),
                status: if approved {
                    AiToolInvocationStatus::Succeeded
                } else {
                    AiToolInvocationStatus::Rejected
                },
                result_summary: Some(result.summary),
                error: None,
                audit_context_json: audit_context_json.clone(),
                affected_domains: result.affected_domains,
                created_at_ms: pending.created_at_ms,
                completed_at_ms,
            },
            Err(error) => AiToolAuditRecord {
                id: Uuid::new_v4().to_string(),
                invocation_id,
                tool_id: pending.tool_id.clone(),
                tool_title: pending.tool_title.clone(),
                risk_level: pending.risk_level,
                arguments_summary: pending.arguments_summary.clone(),
                risk_summary: pending.risk_summary.clone(),
                status: AiToolInvocationStatus::Failed,
                result_summary: None,
                error: Some(error.to_string()),
                audit_context_json,
                affected_domains: affected_domains_for_tool(&pending.tool_id),
                created_at_ms: pending.created_at_ms,
                completed_at_ms,
            },
        };
        insert_ai_tool_audit(store, &audit)?;
        persist_tool_message(store, &pending, &audit)?;
        Ok((audit, structured_content))
    }

    pub fn list_pending(&self, store: &SqliteStore) -> AppResult<Vec<AiToolPendingInvocation>> {
        list_ai_tool_pending(store)
    }

    pub fn list_audit(
        &self,
        store: &SqliteStore,
        limit: Option<usize>,
    ) -> AppResult<Vec<AiToolAuditRecord>> {
        list_ai_tool_audits(store, limit.unwrap_or(100))
    }

    pub fn list_audit_with_request(
        &self,
        store: &SqliteStore,
        request: Option<AiToolAuditListRequest>,
    ) -> AppResult<Vec<AiToolAuditRecord>> {
        self.list_audit(store, request.and_then(|value| value.limit))
    }

    fn execute(
        &self,
        store: &SqliteStore,
        tool_id: &str,
        arguments: &Value,
        secret_inputs: Option<&AiToolSecretInputs>,
    ) -> AppResult<AiToolExecutionResult> {
        match tool_id {
            "terminal.write" => {
                let runtime_session_id = string_arg(arguments, "runtime_session_id")?;
                let data = string_arg_preserve(arguments, "data")?;
                let cursor = self.writer.terminal_output_cursor(&runtime_session_id)?;
                self.writer.write_terminal(&runtime_session_id, &data)?;
                let output = cursor
                    .map(|cursor| {
                        self.writer
                            .read_terminal_output_after(&runtime_session_id, cursor)
                    })
                    .transpose()?
                    .flatten();
                let next_cursor = self.writer.terminal_output_cursor(&runtime_session_id)?;
                let readable_output = terminal_output_for_response(&data, output.as_deref(), 4000);
                Ok(structured_execution_result(
                    terminal_write_result_summary(&data, output.as_deref()),
                    ["terminal", "history"],
                    json!({
                        "runtime_session_id": runtime_session_id,
                        "output": readable_output,
                        "cursor": next_cursor
                    }),
                ))
            }
            "terminal.list" => {
                let saved_session_id = optional_string_arg(arguments, "saved_session_id");
                let terminals = self
                    .writer
                    .list_terminals()?
                    .into_iter()
                    .filter(|terminal| {
                        saved_session_id.as_ref().is_none_or(|saved_session_id| {
                            terminal.saved_session_id.as_deref() == Some(saved_session_id.as_str())
                        })
                    })
                    .collect::<Vec<_>>();
                Ok(structured_execution_result(
                    format!("终端运行态已读取：{} 个。", terminals.len()),
                    ["terminal"],
                    json!({ "terminals": terminals }),
                ))
            }
            "terminal.read" => {
                let runtime_session_id = string_arg(arguments, "runtime_session_id")?;
                let max_chars = optional_usize_arg(arguments, "max_chars")
                    .unwrap_or(4000)
                    .clamp(1, 4000);
                let cursor = optional_usize_arg(arguments, "cursor");
                let output = match cursor {
                    Some(cursor) => self
                        .writer
                        .read_terminal_output_after(&runtime_session_id, cursor)?,
                    None => self
                        .writer
                        .read_terminal_output_tail(&runtime_session_id, max_chars)?,
                };
                let next_cursor = self.writer.terminal_output_cursor(&runtime_session_id)?;
                let output = output
                    .map(|value| terminal_read_output_for_response(&value, max_chars))
                    .unwrap_or_default();
                let summary = if output.is_empty() {
                    "终端输出：未读取到内容。".to_string()
                } else {
                    format!("终端输出：\n{output}")
                };
                Ok(structured_execution_result(
                    summary,
                    ["terminal"],
                    json!({
                        "runtime_session_id": runtime_session_id,
                        "output": output,
                        "cursor": next_cursor
                    }),
                ))
            }
            "terminal.close" => {
                self.emit_frontend_action(tool_id, arguments, affected_domains_for_tool(tool_id))
            }
            "terminal.open" | "terminal.split" | "terminal.focus" | "workspace.open_tool" => {
                self.emit_frontend_action(tool_id, arguments, affected_domains_for_tool(tool_id))
            }
            "history.search" => {
                let query = optional_string_arg(arguments, "query");
                let scope_kind = history_scope_kind_arg(arguments)?;
                let scope_id = string_arg(arguments, "scope_id")?;
                let limit = optional_usize_arg(arguments, "limit");
                let entries = search_command_history(
                    store,
                    HistorySearchOptions {
                        query,
                        scope_kind: Some(scope_kind),
                        scope_id: Some(scope_id),
                        limit,
                        deduplicate: None,
                    },
                )?;
                Ok(execution_result(
                    format!("命令历史已读取：{} 条。", entries.len()),
                    ["history"],
                ))
            }
            "history.clear" => {
                let scope_kind = history_scope_kind_arg(arguments)?;
                let scope_id = string_arg(arguments, "scope_id")?;
                clear_command_history(store, Some(scope_kind), Some(scope_id.as_str()))?;
                Ok(execution_result("命令历史已清理。", ["history"]))
            }
            "sessions.list" => {
                let sessions = list_sessions(store)?;
                let query =
                    optional_string_arg(arguments, "query").map(|value| value.to_ascii_lowercase());
                let sanitized_sessions = sessions
                    .sessions
                    .iter()
                    .filter(|session| {
                        query.as_ref().is_none_or(|query| {
                            session.name.to_ascii_lowercase().contains(query)
                                || session.host.to_ascii_lowercase().contains(query)
                                || session.username.to_ascii_lowercase().contains(query)
                        })
                    })
                    .map(sanitized_session_value)
                    .collect::<Vec<_>>();
                Ok(structured_execution_result(
                    format!(
                        "会话树已读取：{} 个分组，{} 个会话。",
                        sessions.groups.len(),
                        sessions.sessions.len()
                    ),
                    ["sessions"],
                    json!({
                        "groups": sessions.groups,
                        "sessions": sanitized_sessions
                    }),
                ))
            }
            "session_groups.save" => {
                let draft = object_arg::<SessionGroupDraft>(arguments, "draft")?;
                let group = save_session_group(store, draft)?;
                Ok(execution_result(
                    format!("会话分组已保存：{}。", group.name),
                    ["sessions"],
                ))
            }
            "session_groups.delete" => {
                let id = string_arg(arguments, "id")?;
                delete_session_group(store, &id)?;
                Ok(execution_result("会话分组已删除。", ["sessions"]))
            }
            "sessions.save" => {
                let mut draft = object_arg::<SavedSessionDraft>(arguments, "draft")?;
                self.apply_session_password_secret(&mut draft, secret_inputs)?;
                let session = save_session(store, draft)?;
                Ok(structured_execution_result(
                    format!("会话已保存：{}。", session.name),
                    ["sessions", "workspace"],
                    json!({ "session": sanitized_session_value(&session) }),
                ))
            }
            "sessions.delete" => {
                let id = string_arg(arguments, "id")?;
                delete_session(store, &id)?;
                Ok(execution_result("会话已删除。", ["sessions", "workspace"]))
            }
            "sessions.open" => {
                self.emit_frontend_action(tool_id, arguments, affected_domains_for_tool(tool_id))
            }
            "sessions.test" => {
                let draft = object_arg::<SavedSessionDraft>(arguments, "draft")?;
                validate_session_draft_for_test(store, draft)?;
                Ok(execution_result("会话配置测试通过。", ["sessions"]))
            }
            "llm_provider.list" => {
                let query =
                    optional_string_arg(arguments, "query").map(|value| value.to_ascii_lowercase());
                let providers = list_ai_provider_profiles(store)?;
                let sanitized_providers = providers
                    .iter()
                    .filter(|provider| {
                        query.as_ref().is_none_or(|query| {
                            provider.name.to_ascii_lowercase().contains(query)
                                || provider.model.to_ascii_lowercase().contains(query)
                        })
                    })
                    .map(sanitized_provider_value)
                    .collect::<Vec<_>>();
                Ok(structured_execution_result(
                    format!("LLM Provider 已读取：{} 个。", providers.len()),
                    ["models"],
                    json!({ "providers": sanitized_providers }),
                ))
            }
            "llm_provider.create" | "llm_provider.update" => {
                let mut draft = object_arg::<AiProviderProfileDraft>(arguments, "draft")?;
                apply_ai_provider_secret_input(&mut draft, secret_inputs)?;
                let credentials = self.credential_service()?;
                let profile = credentials.save_ai_provider(draft)?;
                Ok(structured_execution_result(
                    format!("LLM Provider 已保存：{}。", profile.name),
                    ["models"],
                    json!({ "provider": sanitized_provider_value(&profile) }),
                ))
            }
            "llm_provider.delete" => {
                let id = string_arg(arguments, "id")?;
                self.credential_service()?.delete_ai_provider(&id)?;
                Ok(execution_result("LLM Provider 已删除。", ["models"]))
            }
            "llm_provider.test" => {
                let id = string_arg(arguments, "id")?;
                let result = self.credential_service()?.test_ai_provider(&id)?;
                Ok(execution_result(
                    format!("LLM Provider 测试结果：{}。", result.message),
                    ["models"],
                ))
            }
            "settings.get" => {
                let settings = get_app_settings(store)?;
                Ok(execution_result(
                    format!(
                        "设置已读取：主题 {:?}，UI 字号 {}，终端字号 {}。",
                        settings.theme, settings.ui_font_size, settings.terminal_font_size
                    ),
                    ["settings"],
                ))
            }
            "settings.update_ai_security" => {
                let conversation_id = string_arg(arguments, "conversation_id")?;
                let approval_mode = ai_approval_mode_arg(arguments)?;
                update_ai_conversation_approval_mode(store, &conversation_id, approval_mode)?;
                Ok(execution_result("AI 会话审批模式已更新。", ["ai"]))
            }
            "workspace.list" => {
                let workspaces = list_workspaces(store)?;
                Ok(execution_result(
                    format!("工作区已读取：{} 个。", workspaces.len()),
                    ["workspace"],
                ))
            }
            "workspace.get" => {
                let workspace_id = string_arg(arguments, "workspace_id")?;
                let workspace = get_workspace(store, &workspace_id)?;
                Ok(execution_result(
                    format!(
                        "工作区已读取：{}，{} 个标签。",
                        workspace.name,
                        workspace.tabs.len()
                    ),
                    ["workspace"],
                ))
            }
            "workspace.save" => {
                let draft = workspace_draft_arg(arguments)?;
                let workspace = save_workspace(store, draft)?;
                Ok(execution_result(
                    format!("工作区已保存：{}。", workspace.name),
                    ["workspace"],
                ))
            }
            "workspace.delete" => {
                let workspace_id = string_arg(arguments, "workspace_id")?;
                remove_workspace(store, &workspace_id)?;
                Ok(execution_result("工作区定义已删除。", ["workspace"]))
            }
            "workspace.restore" => {
                self.emit_frontend_action(tool_id, arguments, vec!["workspace".to_string()])
            }
            "terminal_profile.list" => {
                let profiles =
                    crate::services::terminal_profile_service::list_or_detect_terminal_profiles(
                        store,
                    )?;
                Ok(execution_result(
                    format!("终端 Profile 已读取：{} 个。", profiles.len()),
                    ["terminal", "settings"],
                ))
            }
            "terminal_profile.set_default" => {
                let draft = object_arg::<TerminalProfileDraft>(arguments, "draft")?;
                let profile =
                    crate::services::terminal_profile_service::set_default_profile(store, draft)?;
                Ok(execution_result(
                    format!("默认终端 Profile 已设置：{}。", profile.name),
                    ["terminal", "settings"],
                ))
            }
            "transfer.list" => {
                let saved_session_id = optional_string_arg(arguments, "saved_session_id");
                let limit = optional_u32_arg(arguments, "limit").unwrap_or(200);
                let tasks = list_transfer_tasks(store, saved_session_id.as_deref(), limit)?;
                let sanitized_tasks = tasks
                    .iter()
                    .map(sanitized_transfer_task_value)
                    .collect::<Vec<_>>();
                Ok(structured_execution_result(
                    format!("传输任务已读取：{} 个。", tasks.len()),
                    ["transfer"],
                    json!({ "tasks": sanitized_tasks }),
                ))
            }
            "transfer.retry" => {
                let task_id = string_arg(arguments, "task_id")?;
                let task = self.transfer_queue()?.retry_failed(&task_id)?;
                Ok(execution_result(
                    format!("传输任务已重试：{}。", task.id),
                    ["transfer"],
                ))
            }
            "transfer.pause" => {
                let task_id = string_arg(arguments, "task_id")?;
                let task = self.transfer_queue()?.pause(&task_id)?;
                Ok(execution_result(
                    format!("传输任务已暂停：{}。", task.id),
                    ["transfer"],
                ))
            }
            "transfer.resume" => {
                let task_id = string_arg(arguments, "task_id")?;
                let task = self.transfer_queue()?.resume(&task_id)?;
                Ok(execution_result(
                    format!("传输任务已恢复：{}。", task.id),
                    ["transfer"],
                ))
            }
            "transfer.cancel" => {
                let task_id = string_arg(arguments, "task_id")?;
                let task = self.transfer_queue()?.cancel(&task_id)?;
                Ok(execution_result(
                    format!("传输任务已取消：{}。", task.id),
                    ["transfer"],
                ))
            }
            "transfer.delete" => {
                let task_id = string_arg(arguments, "task_id")?;
                self.transfer_queue()?.delete(&task_id)?;
                Ok(execution_result("传输任务已删除。", ["transfer"]))
            }
            "sftp.list" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let path = string_arg(arguments, "path")?;
                let session = get_session(store, &saved_session_id)?;
                let service = self.sftp_service()?;
                let all_sessions = list_sessions(store)?.sessions;
                let credential_service = self.credential_service()?;
                let entries = block_on_tool(service.list(
                    &session,
                    &all_sessions,
                    &credential_service,
                    &path,
                ))?;
                Ok(execution_result(
                    format!("SFTP 目录已读取：{} 项。", entries.len()),
                    ["files"],
                ))
            }
            "sftp.mkdir" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let path = string_arg(arguments, "path")?;
                let session = get_session(store, &saved_session_id)?;
                let service = self.sftp_service()?;
                let all_sessions = list_sessions(store)?.sessions;
                let credential_service = self.credential_service()?;
                block_on_tool(service.create_dir(
                    &session,
                    &all_sessions,
                    &credential_service,
                    &path,
                ))?;
                Ok(execution_result("SFTP 目录已创建。", ["files"]))
            }
            "sftp.delete" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let path = string_arg(arguments, "path")?;
                let recursive = optional_bool_arg(arguments, "recursive").unwrap_or(false);
                let session = get_session(store, &saved_session_id)?;
                let service = self.sftp_service()?;
                let all_sessions = list_sessions(store)?.sessions;
                let credential_service = self.credential_service()?;
                block_on_tool(service.delete(
                    &session,
                    &all_sessions,
                    &credential_service,
                    &path,
                    recursive,
                ))?;
                Ok(execution_result("SFTP 路径已删除。", ["files"]))
            }
            "sftp.rename" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let from = string_arg(arguments, "from")?;
                let to = string_arg(arguments, "to")?;
                let session = get_session(store, &saved_session_id)?;
                let service = self.sftp_service()?;
                let all_sessions = list_sessions(store)?.sessions;
                let credential_service = self.credential_service()?;
                block_on_tool(service.rename(
                    &session,
                    &all_sessions,
                    &credential_service,
                    &from,
                    &to,
                ))?;
                Ok(execution_result("SFTP 路径已重命名。", ["files"]))
            }
            "zterm.context" => self.zterm_context(store),
            "zterm.search" => self.zterm_search(store, arguments),
            "server_info.snapshot" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let snapshot = block_on_tool(self.server_info_service()?.snapshot(
                    store,
                    self.ssh_command_service()?,
                    self.credential_service()?,
                    ServerInfoRequest { saved_session_id },
                ))?;
                Ok(execution_result(
                    server_info_snapshot_summary(&snapshot),
                    ["monitor"],
                ))
            }
            "ssh_container.list" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let ssh_commands = self.ssh_command_service()?;
                let credential_service = self.credential_service()?;
                let session = get_session(store, &saved_session_id)?;
                let container = enabled_container_options(&session)?;
                let script = build_container_list_script(&container.runtime)?;
                let all_sessions = list_sessions(store)?.sessions;
                let output = block_on_tool(ssh_commands.execute(
                    &session,
                    &all_sessions,
                    script,
                    &credential_service,
                ))?;
                if !output.success {
                    let detail = if output.stderr.trim().is_empty() {
                        output.stdout.trim()
                    } else {
                        output.stderr.trim()
                    };
                    return Err(AppError::ssh(if detail.is_empty() {
                        "容器列表获取失败".to_string()
                    } else {
                        detail.to_string()
                    }));
                }
                let containers = parse_container_ps_output(&output.stdout);
                let running = containers
                    .iter()
                    .filter(|container| container.running)
                    .count();
                Ok(execution_result(
                    format!(
                        "SSH 容器列表已读取：{} 个，运行中 {} 个。",
                        containers.len(),
                        running
                    ),
                    ["terminal"],
                ))
            }
            "ssh.execute" => {
                let saved_session_id = string_arg(arguments, "saved_session_id")?;
                let script = string_arg_preserve(arguments, "script")?;
                let session = get_session(store, &saved_session_id)?;
                if session.session_type != SessionType::Ssh {
                    return Err(AppError::validation("ssh.execute 只支持 SSH 连接"));
                }
                let all_sessions = list_sessions(store)?.sessions;
                let output = block_on_tool(self.ssh_command_service()?.execute_reusable(
                    "mcp",
                    &session,
                    &all_sessions,
                    script,
                    &self.credential_service()?,
                ))?;
                Ok(structured_execution_result(
                    format!(
                        "SSH 命令执行完成：exit_code={}，耗时 {} ms。",
                        output
                            .exit_code
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".to_string()),
                        output.duration_ms
                    ),
                    ["terminal", "history"],
                    json!({
                        "saved_session_id": saved_session_id,
                        "stdout": redact_sensitive(&output.stdout),
                        "stderr": redact_sensitive(&output.stderr),
                        "exit_code": output.exit_code,
                        "success": output.success,
                        "stdout_truncated": output.stdout_truncated,
                        "stderr_truncated": output.stderr_truncated,
                        "duration_ms": output.duration_ms
                    }),
                ))
            }
            "ssh.upload" | "sftp.upload" | "ftp.upload" => self.enqueue_saved_connection_transfer(
                store,
                tool_id,
                arguments,
                TransferDirection::Upload,
            ),
            "ssh.download" | "sftp.download" | "ftp.download" => self
                .enqueue_saved_connection_transfer(
                    store,
                    tool_id,
                    arguments,
                    TransferDirection::Download,
                ),
            "history.record" => {
                self.emit_frontend_action(tool_id, arguments, affected_domains_for_tool(tool_id))
            }
            _ => Err(AppError::validation(format!("不支持的 AI 工具: {tool_id}"))),
        }
    }

    fn prepare_arguments_for_tool(
        &self,
        store: &SqliteStore,
        tool_id: &str,
        arguments: Value,
    ) -> AppResult<Value> {
        let arguments = normalized_arguments(arguments);
        if tool_id == "session_groups.save" {
            return self.prepare_session_group_save_arguments(arguments);
        }
        if tool_id == "sessions.save" {
            return self.prepare_session_save_arguments(store, arguments);
        }
        if tool_id == "llm_provider.create" || tool_id == "llm_provider.update" {
            return self.prepare_llm_provider_save_arguments(arguments);
        }
        Ok(arguments)
    }

    fn prepare_session_group_save_arguments(&self, mut arguments: Value) -> AppResult<Value> {
        let Some(root) = arguments.as_object_mut() else {
            return Ok(arguments);
        };
        let Some(draft_value) = root.get_mut("draft") else {
            return Ok(arguments);
        };
        let Some(draft_object) = draft_value.as_object_mut() else {
            return Ok(arguments);
        };
        if !draft_object.contains_key("expanded") {
            draft_object.insert("expanded".to_string(), Value::Bool(true));
        }
        if !draft_object.contains_key("sort_order") {
            draft_object.insert("sort_order".to_string(), Value::from(0));
        }
        Ok(arguments)
    }

    fn prepare_session_save_arguments(
        &self,
        store: &SqliteStore,
        mut arguments: Value,
    ) -> AppResult<Value> {
        let Some(root) = arguments.as_object_mut() else {
            return Ok(arguments);
        };
        let top_url = take_nonempty_string(root, "url");
        let top_username = take_nonempty_string(root, "username")
            .or_else(|| take_nonempty_string(root, "account"));
        let top_password = take_nonempty_string(root, "password");
        let top_group_name = take_nonempty_string(root, "group_name");
        let reuse_auth_from_session_id = take_nonempty_string(root, "reuse_auth_from_session_id");
        let Some(draft_value) = root.get_mut("draft") else {
            return Ok(arguments);
        };
        let Some(draft_object) = draft_value.as_object_mut() else {
            return Ok(arguments);
        };

        if let Some(source_session_id) = reuse_auth_from_session_id {
            let source = get_session(store, &source_session_id)?;
            draft_object.insert(
                "auth_mode".to_string(),
                Value::String(source.auth_mode.as_str().to_string()),
            );
            match source.credential_ref {
                Some(credential_ref) => {
                    draft_object
                        .insert("credential_ref".to_string(), Value::String(credential_ref));
                }
                None => {
                    draft_object.remove("credential_ref");
                }
            }
            if source.auth_mode == AuthMode::Key && !draft_object.contains_key("ssh_options") {
                if let Some(options) = source.ssh_options {
                    draft_object.insert(
                        "ssh_options".to_string(),
                        json!({
                            "connect_timeout_ms": options.connect_timeout_ms,
                            "keepalive_interval_ms": options.keepalive_interval_ms,
                            "proxy_command": null,
                            "identity_file": options.identity_file,
                            "jump_hosts": [],
                            "tunnels": [],
                            "container": null
                        }),
                    );
                }
            }
        }

        let draft_url = take_nonempty_string(draft_object, "url").or(top_url);
        let explicit_password = take_nonempty_string(draft_object, "password").or(top_password);
        let parsed_url = draft_url.as_deref().map(parse_session_url).transpose()?;
        let mut password = explicit_password.or_else(|| {
            parsed_url
                .as_ref()
                .and_then(|url| url.password.clone())
                .filter(|value| !value.trim().is_empty())
        });

        if let Some(url) = parsed_url.as_ref() {
            set_missing_string(draft_object, "type", url.session_type);
            set_missing_string(draft_object, "host", &url.host);
            if !draft_object.contains_key("port") {
                draft_object.insert("port".to_string(), Value::from(url.port));
            }
            if !url.username.is_empty() {
                set_missing_string(draft_object, "username", &url.username);
            }
            set_missing_string(draft_object, "name", &url.host);
        }
        if let Some(username) = top_username {
            set_missing_string(draft_object, "username", &username);
        }
        if password.is_none() {
            password = recover_password_misplaced_in_name(draft_object);
        }
        let group_name = take_nonempty_string(draft_object, "group_name").or(top_group_name);
        if draft_object
            .get("group_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            if let Some(group_name) = group_name {
                if let Some(group_id) = resolve_session_group_id_by_name(store, &group_name)? {
                    draft_object.insert("group_id".to_string(), Value::String(group_id));
                }
            }
        }
        if password.is_some() {
            set_missing_string(draft_object, "auth_mode", "password");
        }
        set_missing_string(draft_object, "host", "localhost");
        set_missing_string(draft_object, "username", "");
        set_missing_string(draft_object, "auth_mode", "none");
        if !draft_object.contains_key("port") {
            draft_object.insert("port".to_string(), Value::from(22));
        }
        if !draft_object.contains_key("tags") {
            draft_object.insert("tags".to_string(), Value::Array(Vec::new()));
        }
        if !draft_object.contains_key("sort_order") {
            draft_object.insert("sort_order".to_string(), Value::from(0));
        }
        if draft_object
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "rdp")
            && !draft_object.contains_key("rdp_options")
        {
            draft_object.insert(
                "rdp_options".to_string(),
                json!({
                    "domain": null,
                    "width": 1280,
                    "height": 720,
                    "color_depth": 32,
                    "redirect_clipboard": true,
                    "fullscreen": false
                }),
            );
        }

        let draft =
            serde_json::from_value::<SavedSessionDraft>(Value::Object(draft_object.clone()))
                .map_err(|error| AppError::validation(format!("工具参数 draft 无效: {error}")))?;
        if let Some(password) = password {
            let credential_ref = self.save_session_password_credential(&draft, password)?;
            draft_object.insert("credential_ref".to_string(), Value::String(credential_ref));
            draft_object.insert(
                "_ai_created_credential_ref".to_string(),
                draft_object
                    .get("credential_ref")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
        }
        Ok(arguments)
    }

    fn prepare_llm_provider_save_arguments(&self, mut arguments: Value) -> AppResult<Value> {
        let Some(root) = arguments.as_object_mut() else {
            return Ok(arguments);
        };
        let top_curl = take_nonempty_string(root, "curl")
            .or_else(|| take_nonempty_string(root, "request"))
            .or_else(|| take_nonempty_string(root, "command"))
            .or_else(|| take_nonempty_string(root, "value"));
        let top_url = take_nonempty_string(root, "url")
            .or_else(|| take_nonempty_string(root, "endpoint"))
            .or_else(|| take_nonempty_string(root, "base_url"));
        let top_model = take_nonempty_string(root, "model");
        let top_kind = take_nonempty_string(root, "kind");
        let top_name = take_nonempty_string(root, "name");
        let source = top_curl.as_deref();
        let parsed_url = top_url
            .or_else(|| source.and_then(extract_first_http_url))
            .map(|url| normalize_provider_base_url(&url));
        let parsed_model = top_model
            .or_else(|| source.and_then(|value| extract_json_string_field(value, "model")));
        let parsed_kind = top_kind
            .or_else(|| parsed_url.as_deref().map(infer_provider_kind_from_url))
            .unwrap_or_else(|| "openai_chat".to_string());

        let draft_value = root
            .entry("draft".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        let Some(draft_object) = draft_value.as_object_mut() else {
            return Ok(arguments);
        };
        if let Some(name) = top_name.or_else(|| parsed_model.clone()) {
            set_missing_string(draft_object, "name", &name);
        }
        if let Some(url) = parsed_url {
            set_missing_string(draft_object, "base_url", &url);
        }
        if let Some(model) = parsed_model {
            set_missing_string(draft_object, "model", &model);
        }
        set_missing_string(draft_object, "kind", &parsed_kind);
        if !draft_object.contains_key("enabled") {
            draft_object.insert("enabled".to_string(), Value::Bool(true));
        }
        if !draft_object.contains_key("is_default") {
            draft_object.insert("is_default".to_string(), Value::Bool(false));
        }
        Ok(arguments)
    }

    fn cleanup_rejected_prepared_secret(&self, tool_id: &str, arguments: &Value) {
        if tool_id != "sessions.save" {
            return;
        }
        let Some(credential_ref) = arguments
            .get("draft")
            .and_then(Value::as_object)
            .and_then(|draft| draft.get("_ai_created_credential_ref"))
            .and_then(Value::as_str)
            .and_then(credential_id_from_ref)
        else {
            return;
        };
        if let Some(service) = self.credential_service.as_ref() {
            let _ = service.delete_credential(&credential_ref);
        }
    }

    fn save_session_password_credential(
        &self,
        draft: &SavedSessionDraft,
        password: String,
    ) -> AppResult<String> {
        if draft.auth_mode != AuthMode::Password {
            return Err(AppError::validation(
                "AI 提供的会话密码只支持 SSH/RDP 密码认证",
            ));
        }
        let kind = match draft.session_type {
            SessionType::Ssh | SessionType::Sftp | SessionType::Ftp => CredentialKind::SshPassword,
            SessionType::Rdp => CredentialKind::RdpPassword,
            SessionType::Local => {
                return Err(AppError::validation("本机会话不支持保存密码"));
            }
        };
        let credential_id = draft
            .credential_ref
            .as_deref()
            .and_then(credential_id_from_ref)
            .or_else(|| {
                draft
                    .id
                    .as_deref()
                    .map(|id| format!("ai-session-{id}-password"))
            })
            .unwrap_or_else(|| format!("ai-session-{}-password", Uuid::new_v4()));
        let record = self
            .credential_service()?
            .save_credential(CredentialDraft {
                id: Some(credential_id),
                name: format!("{} 密码", draft.name),
                kind,
                secret: password,
            })?;
        Ok(record.credential_ref)
    }

    fn apply_session_password_secret(
        &self,
        draft: &mut SavedSessionDraft,
        secret_inputs: Option<&AiToolSecretInputs>,
    ) -> AppResult<()> {
        if draft.auth_mode != AuthMode::Password || draft.credential_ref.is_some() {
            return Ok(());
        }
        let password = secret_inputs_password(secret_inputs)
            .ok_or_else(|| AppError::validation("保存密码连接需要在 zTerm 本地输入密码"))?;
        draft.credential_ref = Some(self.save_session_password_credential(draft, password)?);
        Ok(())
    }

    fn emit_frontend_action(
        &self,
        action: &str,
        arguments: &Value,
        affected_domains: Vec<String>,
    ) -> AppResult<AiToolExecutionResult> {
        self.writer.emit_tool_action(AiToolFrontendActionEvent {
            action: action.to_string(),
            arguments: arguments.clone(),
            affected_domains: affected_domains.clone(),
        })?;
        Ok(AiToolExecutionResult {
            summary: format!("已分发前端动作：{action}。"),
            affected_domains,
            structured_content: None,
        })
    }

    fn credential_service(&self) -> AppResult<CredentialService> {
        self.credential_service
            .clone()
            .ok_or_else(|| AppError::ai("AI 工具执行器未装配凭据服务"))
    }

    fn transfer_queue(&self) -> AppResult<TransferQueue> {
        self.transfer_queue
            .clone()
            .ok_or_else(|| AppError::ai("AI 工具执行器未装配传输队列服务"))
    }

    fn sftp_service(&self) -> AppResult<SftpService> {
        self.sftp_service
            .clone()
            .ok_or_else(|| AppError::ai("AI 工具执行器未装配 SFTP 服务"))
    }

    fn enqueue_saved_connection_transfer(
        &self,
        store: &SqliteStore,
        tool_id: &str,
        arguments: &Value,
        direction: TransferDirection,
    ) -> AppResult<AiToolExecutionResult> {
        let saved_session_id = string_arg(arguments, "saved_session_id")?;
        let local_path = string_arg(arguments, "local_path")?;
        let remote_path = string_arg(arguments, "remote_path")?;
        let kind = optional_transfer_kind_arg(arguments)?;
        let conflict_policy = optional_transfer_conflict_policy_arg(arguments)?
            .unwrap_or(TransferConflictPolicy::Overwrite);
        let session = get_session(store, &saved_session_id)?;
        validate_transfer_tool_session(tool_id, session.session_type)?;
        let protocol_label = session_protocol_label(session.session_type);
        let all_sessions = list_sessions(store)?.sessions;
        let total_bytes = if direction == TransferDirection::Upload {
            block_on_tool(local_path_total_bytes(&local_path))?
        } else {
            0
        };
        let source_endpoint = match direction {
            TransferDirection::Upload => TransferEndpoint {
                kind: TransferEndpointKind::Local,
                saved_session_id: None,
                path: local_path.clone(),
            },
            TransferDirection::Download => TransferEndpoint {
                kind: TransferEndpointKind::SavedSession,
                saved_session_id: Some(saved_session_id.clone()),
                path: remote_path.clone(),
            },
        };
        let destination_endpoint = match direction {
            TransferDirection::Upload => TransferEndpoint {
                kind: TransferEndpointKind::SavedSession,
                saved_session_id: Some(saved_session_id.clone()),
                path: remote_path.clone(),
            },
            TransferDirection::Download => TransferEndpoint {
                kind: TransferEndpointKind::Local,
                saved_session_id: None,
                path: local_path.clone(),
            },
        };
        let queue = self.transfer_queue()?;
        let task = queue.enqueue_with_endpoints(
            &saved_session_id,
            direction,
            &local_path,
            &remote_path,
            kind,
            conflict_policy,
            total_bytes,
            TransferTaskOrigin::FileTransfer,
            &source_endpoint,
            &destination_endpoint,
        )?;
        spawn_ai_file_transfer(
            self.sftp_service()?,
            queue,
            session,
            all_sessions,
            self.credential_service()?,
            task.clone(),
        )?;
        Ok(structured_execution_result(
            format!("{} 文件传输已入队：{}。", protocol_label, task.id),
            ["files", "transfer"],
            json!({ "task": task }),
        ))
    }

    fn server_info_service(&self) -> AppResult<ServerInfoService> {
        self.server_info_service
            .clone()
            .ok_or_else(|| AppError::ai("AI 工具执行器未装配资源监控服务"))
    }

    fn ssh_command_service(&self) -> AppResult<SshCommandService> {
        self.ssh_command_service
            .clone()
            .ok_or_else(|| AppError::ai("AI 工具执行器未装配 SSH 命令服务"))
    }

    fn zterm_context(&self, store: &SqliteStore) -> AppResult<AiToolExecutionResult> {
        let sessions = list_sessions(store)?;
        let providers = list_ai_provider_profiles(store)?;
        let workspaces = list_workspaces(store)?;
        let terminals = self.writer.list_terminals()?;
        Ok(execution_result(
            format!(
                "zTerm 上下文：{} 个分组，{} 个会话，{} 个模型，{} 个工作区，{} 个运行终端。",
                sessions.groups.len(),
                sessions.sessions.len(),
                providers.len(),
                workspaces.len(),
                terminals.len()
            ),
            ["sessions", "models", "workspace", "terminal"],
        ))
    }

    fn zterm_search(
        &self,
        store: &SqliteStore,
        arguments: &Value,
    ) -> AppResult<AiToolExecutionResult> {
        let query = string_arg(arguments, "query")?.to_ascii_lowercase();
        let sessions = list_sessions(store)?;
        let providers = list_ai_provider_profiles(store)?;
        let workspaces = list_workspaces(store)?;
        let session_matches = sessions
            .sessions
            .iter()
            .filter(|session| {
                session.name.to_ascii_lowercase().contains(&query)
                    || session.host.to_ascii_lowercase().contains(&query)
                    || session.id.to_ascii_lowercase().contains(&query)
            })
            .count();
        let provider_matches = providers
            .iter()
            .filter(|provider| {
                provider.name.to_ascii_lowercase().contains(&query)
                    || provider.model.to_ascii_lowercase().contains(&query)
                    || provider.id.to_ascii_lowercase().contains(&query)
            })
            .count();
        let workspace_matches = workspaces
            .iter()
            .filter(|workspace| {
                workspace.name.to_ascii_lowercase().contains(&query)
                    || workspace.id.to_ascii_lowercase().contains(&query)
            })
            .count();
        Ok(execution_result(
            format!(
                "搜索完成：会话 {} 个，模型 {} 个，工作区 {} 个。",
                session_matches, provider_matches, workspace_matches
            ),
            ["sessions", "models", "workspace"],
        ))
    }
}

fn tool_definitions() -> Vec<AiToolDefinition> {
    [
        (
            "terminal.list",
            "列出终端",
            "读取当前终端运行态摘要",
            RiskLevel::Low,
            false,
        ),
        (
            "terminal.write",
            "写入终端",
            "向指定运行终端写入输入",
            RiskLevel::High,
            true,
        ),
        (
            "terminal.open",
            "打开终端",
            "打开保存的会话或本地终端",
            RiskLevel::Medium,
            true,
        ),
        (
            "terminal.read",
            "读取终端",
            "读取运行终端的最近或增量输出",
            RiskLevel::Low,
            false,
        ),
        (
            "terminal.close",
            "关闭终端",
            "关闭指定运行终端",
            RiskLevel::Medium,
            true,
        ),
        (
            "terminal.split",
            "终端分屏",
            "在工作区拆分终端 pane",
            RiskLevel::Medium,
            true,
        ),
        (
            "terminal.focus",
            "聚焦终端",
            "切换当前活动 pane 或 tab",
            RiskLevel::Low,
            false,
        ),
        (
            "workspace.open_tool",
            "打开工具面板",
            "切换右侧工具面板",
            RiskLevel::Low,
            false,
        ),
        (
            "settings.get",
            "读取设置",
            "读取 zTerm 应用设置摘要",
            RiskLevel::Low,
            false,
        ),
        (
            "settings.update_ai_security",
            "更新 AI 安全设置",
            "更新 AI 工具审批策略",
            RiskLevel::High,
            true,
        ),
        (
            "llm_provider.list",
            "列出 LLM Provider",
            "读取 Provider 配置摘要",
            RiskLevel::Low,
            false,
        ),
        (
            "llm_provider.create",
            "创建 LLM Provider",
            "新增模型 Provider 配置",
            RiskLevel::Medium,
            false,
        ),
        (
            "llm_provider.update",
            "更新 LLM Provider",
            "修改模型 Provider 配置",
            RiskLevel::Medium,
            false,
        ),
        (
            "llm_provider.delete",
            "删除 LLM Provider",
            "删除模型 Provider 配置",
            RiskLevel::Critical,
            true,
        ),
        (
            "llm_provider.test",
            "测试 LLM Provider",
            "调用 Provider 测试请求",
            RiskLevel::Medium,
            true,
        ),
        (
            "sessions.list",
            "列出会话",
            "读取保存的会话树",
            RiskLevel::Low,
            false,
        ),
        (
            "session_groups.save",
            "保存会话分组",
            "新增或更新会话分组",
            RiskLevel::Medium,
            false,
        ),
        (
            "session_groups.delete",
            "删除会话分组",
            "删除空会话分组",
            RiskLevel::Critical,
            true,
        ),
        (
            "sessions.save",
            "保存会话",
            "新增或更新 SSH/Local/RDP 会话配置",
            RiskLevel::Medium,
            false,
        ),
        (
            "sessions.delete",
            "删除会话",
            "删除保存的会话配置",
            RiskLevel::Critical,
            true,
        ),
        (
            "sessions.open",
            "打开会话",
            "打开保存的 SSH/Local/RDP 会话",
            RiskLevel::Medium,
            true,
        ),
        (
            "sessions.test",
            "测试会话",
            "测试会话配置",
            RiskLevel::Medium,
            true,
        ),
        (
            "ssh.upload",
            "SSH 上传",
            "通过 SSH 连接的 SFTP 子系统上传本地文件或目录",
            RiskLevel::High,
            true,
        ),
        (
            "ssh.download",
            "SSH 下载",
            "通过 SSH 连接的 SFTP 子系统下载远程文件或目录",
            RiskLevel::Medium,
            true,
        ),
        (
            "sftp.list",
            "列出 SFTP 目录",
            "读取远程目录",
            RiskLevel::Low,
            false,
        ),
        (
            "sftp.mkdir",
            "创建 SFTP 目录",
            "创建远程目录",
            RiskLevel::High,
            true,
        ),
        (
            "sftp.upload",
            "SFTP 上传",
            "上传本地文件到远程路径",
            RiskLevel::High,
            true,
        ),
        (
            "sftp.download",
            "SFTP 下载",
            "下载远程文件到本地路径",
            RiskLevel::Medium,
            true,
        ),
        (
            "sftp.delete",
            "SFTP 删除",
            "删除远程路径",
            RiskLevel::Critical,
            true,
        ),
        (
            "sftp.rename",
            "SFTP 重命名",
            "重命名远程路径",
            RiskLevel::High,
            true,
        ),
        (
            "ftp.upload",
            "FTP 上传",
            "通过已保存 FTP 连接上传本地文件或目录",
            RiskLevel::High,
            true,
        ),
        (
            "ftp.download",
            "FTP 下载",
            "通过已保存 FTP 连接下载远程文件或目录",
            RiskLevel::Medium,
            true,
        ),
        (
            "history.search",
            "搜索历史",
            "搜索命令历史",
            RiskLevel::Low,
            false,
        ),
        (
            "history.record",
            "记录历史",
            "写入命令历史记录",
            RiskLevel::Medium,
            true,
        ),
        (
            "history.clear",
            "清理历史",
            "清空命令历史",
            RiskLevel::High,
            true,
        ),
        (
            "workspace.list",
            "列出工作区",
            "读取已保存工作区列表",
            RiskLevel::Low,
            false,
        ),
        (
            "workspace.get",
            "读取工作区",
            "读取单个工作区定义",
            RiskLevel::Low,
            false,
        ),
        (
            "workspace.save",
            "保存工作区",
            "按简化参数新增或更新工作区定义",
            RiskLevel::Medium,
            false,
        ),
        (
            "workspace.delete",
            "删除工作区",
            "物理删除非默认工作区定义",
            RiskLevel::Critical,
            true,
        ),
        (
            "workspace.restore",
            "恢复工作区",
            "在前端恢复已保存工作区布局",
            RiskLevel::Medium,
            false,
        ),
        (
            "terminal_profile.list",
            "列出终端 Profile",
            "读取本机终端 Profile",
            RiskLevel::Low,
            false,
        ),
        (
            "terminal_profile.set_default",
            "设置默认终端",
            "设置默认本机终端 Profile",
            RiskLevel::Medium,
            false,
        ),
        (
            "transfer.list",
            "列出传输任务",
            "读取传输任务列表",
            RiskLevel::Low,
            false,
        ),
        (
            "transfer.retry",
            "重试传输",
            "重试失败传输任务",
            RiskLevel::Medium,
            false,
        ),
        (
            "transfer.pause",
            "暂停传输",
            "暂停运行期传输任务",
            RiskLevel::Medium,
            false,
        ),
        (
            "transfer.resume",
            "恢复传输",
            "恢复暂停传输任务",
            RiskLevel::Medium,
            false,
        ),
        (
            "transfer.cancel",
            "取消传输",
            "取消传输任务",
            RiskLevel::High,
            true,
        ),
        (
            "transfer.delete",
            "删除传输记录",
            "删除传输任务记录",
            RiskLevel::Critical,
            true,
        ),
        (
            "server_info.snapshot",
            "采集服务器快照",
            "采集当前 SSH 主机资源快照",
            RiskLevel::Low,
            false,
        ),
        (
            "ssh_container.list",
            "列出 SSH 容器",
            "读取 SSH 会话远端容器列表",
            RiskLevel::Low,
            false,
        ),
        (
            "ssh.execute",
            "执行 SSH 命令",
            "通过保存连接复用 zTerm 认证执行非交互脚本",
            RiskLevel::High,
            true,
        ),
        (
            "zterm.context",
            "读取 zTerm 上下文",
            "读取当前资源数量和工作台上下文",
            RiskLevel::Low,
            false,
        ),
        (
            "zterm.search",
            "搜索 zTerm 资源",
            "按关键词搜索会话、模型和工作区",
            RiskLevel::Low,
            false,
        ),
    ]
    .into_iter()
    .map(
        |(id, title, description, risk_level, requires_confirmation)| AiToolDefinition {
            id: id.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            risk_level,
            requires_confirmation,
        },
    )
    .collect()
}

fn tool_definition(tool_id: &str) -> AppResult<AiToolDefinition> {
    let tool_id = required_text("工具 ID", tool_id)?;
    tool_definitions()
        .into_iter()
        .find(|tool| tool.id == tool_id)
        .ok_or_else(|| AppError::validation(format!("不支持的 AI 工具: {tool_id}")))
}

fn validate_arguments(tool_id: &str, arguments: &Value) -> AppResult<()> {
    match tool_id {
        "terminal.write" => {
            let _ = string_arg(arguments, "runtime_session_id")?;
            let _ = string_arg_preserve(arguments, "data")?;
        }
        "terminal.read" => {
            let _ = string_arg(arguments, "runtime_session_id")?;
            if optional_usize_arg(arguments, "max_chars").is_some_and(|value| value > 4000) {
                return Err(AppError::validation("max_chars 不能超过 4000"));
            }
        }
        "terminal.open" => {
            let _ = string_arg(arguments, "saved_session_id")?;
        }
        "terminal.close" => {
            let _ = string_arg(arguments, "runtime_session_id")?;
        }
        "ssh.execute" => {
            let _ = string_arg(arguments, "saved_session_id")?;
            let script = string_arg_preserve(arguments, "script")?;
            if script.chars().count() > 16_384 {
                return Err(AppError::validation("SSH script 不能超过 16384 个字符"));
            }
        }
        "history.search" | "history.clear" => {
            let _ = history_scope_kind_arg(arguments)?;
            let _ = string_arg(arguments, "scope_id")?;
        }
        "settings.get" | "llm_provider.list" | "sessions.list" | "terminal.list" => {}
        "session_groups.save" => {
            let _ = object_arg::<SessionGroupDraft>(arguments, "draft")?;
        }
        "session_groups.delete"
        | "sessions.delete"
        | "llm_provider.delete"
        | "llm_provider.test" => {
            let _ = string_arg(arguments, "id")?;
        }
        "sessions.save" | "sessions.test" => {
            let _ = object_arg::<SavedSessionDraft>(arguments, "draft")?;
        }
        "llm_provider.create" | "llm_provider.update" => {
            let _ = object_arg::<AiProviderProfileDraft>(arguments, "draft")?;
        }
        "settings.update_ai_security" => {
            let _ = string_arg(arguments, "conversation_id")?;
            let _ = ai_approval_mode_arg(arguments)?;
        }
        "workspace.get" | "workspace.delete" | "workspace.restore" => {
            let _ = string_arg(arguments, "workspace_id")?;
        }
        "workspace.save" => {
            let _ = workspace_draft_arg(arguments)?;
        }
        "terminal_profile.set_default" => {
            let _ = object_arg::<TerminalProfileDraft>(arguments, "draft")?;
        }
        "zterm.search" => {
            let _ = string_arg(arguments, "query")?;
        }
        "transfer.retry" | "transfer.pause" | "transfer.resume" | "transfer.cancel"
        | "transfer.delete" => {
            let _ = string_arg(arguments, "task_id")?;
        }
        "transfer.list" => {
            if optional_u32_arg(arguments, "limit").is_some_and(|value| value > 1000) {
                return Err(AppError::validation("传输任务 limit 不能超过 1000"));
            }
        }
        "ssh.upload" | "ssh.download" | "sftp.upload" | "sftp.download" | "ftp.upload"
        | "ftp.download" => {
            let _ = string_arg(arguments, "saved_session_id")?;
            let local_path = string_arg(arguments, "local_path")?;
            if !Path::new(&local_path).is_absolute() {
                return Err(AppError::validation("local_path 必须是绝对路径"));
            }
            let _ = string_arg(arguments, "remote_path")?;
            let _ = optional_transfer_kind_arg(arguments)?;
            let _ = optional_transfer_conflict_policy_arg(arguments)?;
        }
        "sftp.delete" => {
            let _ = string_arg(arguments, "saved_session_id")?;
            let _ = string_arg(arguments, "path")?;
        }
        "sftp.list" | "sftp.mkdir" => {
            let _ = string_arg(arguments, "saved_session_id")?;
            let _ = string_arg(arguments, "path")?;
        }
        "sftp.rename" => {
            let _ = string_arg(arguments, "saved_session_id")?;
            let _ = string_arg(arguments, "from")?;
            let _ = string_arg(arguments, "to")?;
        }
        "server_info.snapshot" | "ssh_container.list" => {
            let _ = string_arg(arguments, "saved_session_id")?;
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct AssessedRisk {
    level: RiskLevel,
    summary: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct SecretInputRequirement {
    required: bool,
    label: Option<String>,
}

fn secret_input_requirement(
    store: &SqliteStore,
    tool_id: &str,
    arguments: &Value,
) -> AppResult<SecretInputRequirement> {
    if tool_id == "sessions.save" {
        let draft = object_arg::<SavedSessionDraft>(arguments, "draft")?;
        if draft.auth_mode == AuthMode::Password && draft.credential_ref.is_none() {
            return Ok(SecretInputRequirement {
                required: true,
                label: Some("SSH/RDP 密码".to_string()),
            });
        }
        return Ok(SecretInputRequirement::default());
    }
    if !matches!(tool_id, "llm_provider.create" | "llm_provider.update") {
        return Ok(SecretInputRequirement::default());
    }
    let draft = object_arg::<AiProviderProfileDraft>(arguments, "draft")?;
    if ai_provider_draft_has_api_key_material(store, &draft) {
        return Ok(SecretInputRequirement::default());
    }
    if crate::services::credential_service::allows_empty_api_key(draft.kind) {
        return Ok(SecretInputRequirement::default());
    }
    Ok(SecretInputRequirement {
        required: true,
        label: Some("API Key".to_string()),
    })
}

fn ai_provider_draft_has_api_key_material(
    store: &SqliteStore,
    draft: &AiProviderProfileDraft,
) -> bool {
    if draft
        .api_key
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    if draft
        .api_key_ref
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    draft
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|id| get_ai_provider_profile(store, id).ok())
        .is_some_and(|profile| !profile.api_key_ref.trim().is_empty())
}

fn apply_ai_provider_secret_input(
    draft: &mut AiProviderProfileDraft,
    secret_inputs: Option<&AiToolSecretInputs>,
) -> AppResult<()> {
    let Some(api_key) = secret_inputs_api_key(secret_inputs) else {
        return Ok(());
    };
    draft.api_key = Some(api_key);
    Ok(())
}

fn secret_inputs_api_key(secret_inputs: Option<&AiToolSecretInputs>) -> Option<String> {
    secret_inputs?
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn secret_inputs_password(secret_inputs: Option<&AiToolSecretInputs>) -> Option<String> {
    secret_inputs?
        .password
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn secret_inputs_present_for_tool(
    tool_id: &str,
    secret_inputs: Option<&AiToolSecretInputs>,
) -> bool {
    if tool_id == "sessions.save" {
        secret_inputs_password(secret_inputs).is_some()
    } else {
        secret_inputs_api_key(secret_inputs).is_some()
    }
}

fn assess_risk(tool: &AiToolDefinition, arguments: &Value) -> AssessedRisk {
    if tool.id == "terminal.write" || tool.id == "ssh.execute" {
        let command = arguments
            .get(if tool.id == "ssh.execute" {
                "script"
            } else {
                "data"
            })
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim_matches(['\r', '\n']);
        let risk = crate::services::ai_risk::classify_command(command);
        return AssessedRisk {
            level: risk.risk_level,
            summary: Some(format!("{}；{}。", risk.reason, risk.expected_effect)),
        };
    }
    AssessedRisk {
        level: tool.risk_level,
        summary: None,
    }
}

fn requires_confirmation(
    tool_id: &str,
    approval_mode: AiApprovalMode,
    risk_level: RiskLevel,
) -> bool {
    if force_confirmation_tool(tool_id)
        || (matches!(tool_id, "terminal.write" | "ssh.execute")
            && matches!(risk_level, RiskLevel::High | RiskLevel::Critical))
    {
        return true;
    }
    match approval_mode {
        AiApprovalMode::RequestApproval => true,
        AiApprovalMode::Safe => matches!(risk_level, RiskLevel::High | RiskLevel::Critical),
        AiApprovalMode::FullAccess => false,
    }
}

fn force_confirmation_tool(tool_id: &str) -> bool {
    tool_id.ends_with(".delete")
        || matches!(
            tool_id,
            "session_groups.delete"
                | "workspace.delete"
                | "history.clear"
                | "sftp.delete"
                | "transfer.cancel"
                | "transfer.delete"
                | "settings.update_ai_security"
                | "llm_provider.delete"
                | "sessions.delete"
                | "ssh.upload"
                | "ssh.download"
                | "sftp.upload"
                | "sftp.download"
                | "ftp.upload"
                | "ftp.download"
        )
}

fn target_summary(arguments: &Value) -> Option<String> {
    let object = arguments.as_object()?;
    let mut parts = Vec::new();
    for key in [
        "terminal_ref",
        "target_title",
        "pane_id",
        "runtime_session_id",
        "saved_session_id",
        "scope_kind",
        "scope_id",
        "cwd",
    ] {
        if let Some(value) = object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            parts.push(format!("{key}={}", redact_sensitive(&truncate(value, 96))));
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

fn persist_tool_message(
    store: &SqliteStore,
    pending: &AiToolPendingInvocation,
    audit: &AiToolAuditRecord,
) -> AppResult<()> {
    let Some(conversation_id) = pending
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let content = audit
        .result_summary
        .clone()
        .or_else(|| audit.error.clone())
        .unwrap_or_else(|| "工具调用已完成。".to_string());
    let metadata = json!({
        "invocation_id": audit.invocation_id,
        "tool_id": audit.tool_id,
        "status": audit.status.as_str(),
        "risk_level": audit.risk_level.as_str(),
        "affected_domains": audit.affected_domains
    })
    .to_string();
    match insert_ai_conversation_message(
        store,
        &Uuid::new_v4().to_string(),
        conversation_id,
        AiMessageRole::Tool,
        &content,
        Some(&metadata),
    ) {
        Ok(_) => Ok(()),
        Err(AppError::NotFound(_)) => Ok(()),
        Err(error) => Err(error),
    }
}

fn normalized_arguments(arguments: Value) -> Value {
    match arguments {
        Value::Object(_) => arguments,
        Value::Null => json!({}),
        other => json!({ "value": other }),
    }
}

#[derive(Debug, Clone)]
struct ParsedSessionUrl {
    session_type: &'static str,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
}

fn parse_session_url(value: &str) -> AppResult<ParsedSessionUrl> {
    let url = reqwest::Url::parse(value.trim())
        .map_err(|error| AppError::validation(format!("连接 URL 无效: {error}")))?;
    let session_type = match url.scheme().to_ascii_lowercase().as_str() {
        "ssh" => "ssh",
        "rdp" => "rdp",
        scheme => {
            return Err(AppError::validation(format!(
                "AI 创建连接暂只支持 ssh:// 或 rdp:// URL，当前为 {scheme}://"
            )));
        }
    };
    let host = url
        .host_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation("连接 URL 缺少主机"))?
        .to_string();
    let default_port = if session_type == "rdp" { 3389 } else { 22 };
    Ok(ParsedSessionUrl {
        session_type,
        host,
        port: url.port().unwrap_or(default_port),
        username: url.username().trim().to_string(),
        password: url.password().map(ToOwned::to_owned),
    })
}

fn take_nonempty_string(object: &mut Map<String, Value>, key: &str) -> Option<String> {
    match object.remove(key)? {
        Value::String(value) => {
            let value = value.trim().to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        }
        other => {
            object.insert(key.to_string(), other);
            None
        }
    }
}

fn set_missing_string(object: &mut Map<String, Value>, key: &str, value: &str) {
    let has_value = object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if !has_value && !value.trim().is_empty() {
        object.insert(key.to_string(), Value::String(value.trim().to_string()));
    }
}

fn extract_first_http_url(value: &str) -> Option<String> {
    let start = value.find("http://").or_else(|| value.find("https://"))?;
    let tail = &value[start..];
    let end = tail
        .char_indices()
        .find_map(|(index, ch)| {
            if ch.is_whitespace() || matches!(ch, '\'' | '"' | '\\' | ')' | ']') {
                Some(index)
            } else {
                None
            }
        })
        .unwrap_or(tail.len());
    let url = tail[..end].trim_matches([',', ';']);
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

fn normalize_provider_base_url(url: &str) -> String {
    let mut value = url.trim().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/responses", "/messages"] {
        if value.ends_with(suffix) {
            value.truncate(value.len().saturating_sub(suffix.len()));
            break;
        }
    }
    value
}

fn infer_provider_kind_from_url(url: &str) -> String {
    let normalized = url.to_ascii_lowercase();
    if normalized.contains("/responses") {
        "openai_responses".to_string()
    } else if normalized.contains("anthropic") || normalized.contains("/messages") {
        "anthropic".to_string()
    } else {
        "openai_chat".to_string()
    }
}

fn extract_json_string_field(value: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\"");
    let start = value.find(&needle)?;
    let after_key = &value[start + needle.len()..];
    let colon = after_key.find(':')?;
    let after_colon = after_key[colon + 1..].trim_start();
    let mut chars = after_colon.chars();
    if chars.next()? != '"' {
        return None;
    }
    let mut output = String::new();
    let mut escaped = false;
    for ch in chars {
        if escaped {
            output.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            break;
        }
        output.push(ch);
    }
    let output = output.trim();
    if output.is_empty() {
        None
    } else {
        Some(output.to_string())
    }
}

fn recover_password_misplaced_in_name(draft_object: &mut Map<String, Value>) -> Option<String> {
    let session_type = draft_object.get("type").and_then(Value::as_str)?;
    if !matches!(session_type, "ssh" | "rdp") {
        return None;
    }
    let auth_mode = draft_object
        .get("auth_mode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if !auth_mode.is_empty() && auth_mode != "password" {
        return None;
    }
    if draft_object
        .get("credential_ref")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return None;
    }

    let name = draft_object
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let host = draft_object
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let username = draft_object
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    if name == host || name.contains(host) || name.contains(username) {
        return None;
    }
    if !looks_like_misplaced_secret(name) {
        return None;
    }

    let password = name.to_string();
    draft_object.insert("name".to_string(), Value::String(host.to_string()));
    Some(password)
}

fn looks_like_misplaced_secret(value: &str) -> bool {
    let value = value.trim();
    value.len() >= 8
        && !value.chars().any(char::is_whitespace)
        && value.chars().any(|ch| {
            matches!(
                ch,
                '@' | '!' | '#' | '$' | '%' | '^' | '&' | '*' | '+' | '='
            )
        })
}

fn resolve_session_group_id_by_name(
    store: &SqliteStore,
    group_name: &str,
) -> AppResult<Option<String>> {
    let group_name = required_text("分组名称", group_name)?;
    let sessions = list_sessions(store)?;
    let exact = sessions
        .groups
        .iter()
        .find(|group| group.name.trim() == group_name)
        .or_else(|| {
            sessions
                .groups
                .iter()
                .find(|group| group.name.trim().eq_ignore_ascii_case(&group_name))
        });
    match exact {
        Some(group) => Ok(Some(group.id.clone())),
        None => Err(AppError::validation(format!(
            "未找到会话分组：{group_name}，请先创建分组或提供 group_id"
        ))),
    }
}

fn credential_id_from_ref(credential_ref: &str) -> Option<String> {
    credential_ref
        .strip_prefix("credential:")
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn summarize_arguments(arguments: &Value) -> String {
    let Some(object) = arguments.as_object() else {
        return redact_sensitive(&arguments.to_string());
    };
    if object.is_empty() {
        return "无参数".to_string();
    }
    object
        .iter()
        .map(|(key, value)| format!("{key}={}", summarize_value(key, value)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn reject_secret_argument_values(arguments: &Value) -> AppResult<()> {
    let mut path = Vec::new();
    if let Some(secret_path) = find_secret_argument_path(arguments, &mut path) {
        return Err(AppError::validation(format!(
            "工具参数包含敏感字段 {secret_path}；请由本地确认弹窗写入 OS keyring"
        )));
    }
    Ok(())
}

fn find_secret_argument_path(value: &Value, path: &mut Vec<String>) -> Option<String> {
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                path.push(key.clone());
                if is_plain_secret_key(key) && secret_value_present(child) {
                    return Some(path.join("."));
                }
                if let Some(found) = find_secret_argument_path(child, path) {
                    return Some(found);
                }
                path.pop();
            }
            None
        }
        Value::Array(items) => {
            for (index, child) in items.iter().enumerate() {
                path.push(index.to_string());
                if let Some(found) = find_secret_argument_path(child, path) {
                    return Some(found);
                }
                path.pop();
            }
            None
        }
        _ => None,
    }
}

fn secret_value_present(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        Value::Array(items) => items.iter().any(secret_value_present),
        Value::Object(object) => object.values().any(secret_value_present),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

fn is_plain_secret_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    if normalized.ends_with("_ref") || normalized == "credential_ref" || normalized == "api_key_ref"
    {
        return false;
    }
    normalized == "api_key"
        || normalized == "token"
        || normalized.ends_with("_token")
        || normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
}

fn summarize_value(key: &str, value: &Value) -> String {
    if is_sensitive_key(key) {
        return "[已脱敏]".to_string();
    }
    match value {
        Value::String(value) => redact_sensitive(&truncate(value, 96)),
        Value::Number(_) | Value::Bool(_) | Value::Null => value.to_string(),
        Value::Array(value) => format!("[{} 项]", value.len()),
        Value::Object(value) => format!("{{{} 项}}", value.len()),
    }
}

fn validate_terminal_reference(value: &str) -> AppResult<String> {
    let value = value.trim().to_ascii_uppercase();
    let first_digit = value
        .char_indices()
        .find_map(|(index, character)| character.is_ascii_digit().then_some(index))
        .ok_or_else(|| AppError::validation("terminal_ref 必须采用 A1 形式"))?;
    let (pane_label, tab_index) = value.split_at(first_digit);
    if pane_label.is_empty()
        || !pane_label
            .chars()
            .all(|character| character.is_ascii_uppercase())
        || tab_index.is_empty()
        || !tab_index
            .chars()
            .all(|character| character.is_ascii_digit())
        || tab_index.starts_with('0')
    {
        return Err(AppError::validation("terminal_ref 必须采用 A1 形式"));
    }
    Ok(value)
}

fn string_arg(arguments: &Value, key: &str) -> AppResult<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::validation(format!("缺少工具参数: {key}")))
}

fn string_arg_preserve(arguments: &Value, key: &str) -> AppResult<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::validation(format!("缺少工具参数: {key}")))
}

fn optional_string_arg(arguments: &Value, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn history_scope_kind_arg(arguments: &Value) -> AppResult<HistoryScopeKind> {
    let value = string_arg(arguments, "scope_kind")?;
    HistoryScopeKind::from_db(&value)
        .ok_or_else(|| AppError::validation("历史作用域类型必须是 saved_session 或 local_profile"))
}

fn optional_usize_arg(arguments: &Value, key: &str) -> Option<usize> {
    arguments
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn optional_u32_arg(arguments: &Value, key: &str) -> Option<u32> {
    arguments
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn optional_bool_arg(arguments: &Value, key: &str) -> Option<bool> {
    arguments.get(key).and_then(Value::as_bool)
}

fn optional_transfer_kind_arg(arguments: &Value) -> AppResult<Option<TransferKind>> {
    optional_string_arg(arguments, "kind")
        .map(|value| {
            TransferKind::from_db(&value)
                .ok_or_else(|| AppError::validation("传输类型必须是 file 或 directory"))
        })
        .transpose()
}

fn optional_transfer_conflict_policy_arg(
    arguments: &Value,
) -> AppResult<Option<TransferConflictPolicy>> {
    optional_string_arg(arguments, "conflict_policy")
        .map(|value| {
            TransferConflictPolicy::from_db(&value)
                .ok_or_else(|| AppError::validation("冲突策略必须是 overwrite、skip 或 rename"))
        })
        .transpose()
}

fn validate_transfer_tool_session(tool_id: &str, session_type: SessionType) -> AppResult<()> {
    let valid = match tool_id {
        "ftp.upload" | "ftp.download" => session_type == SessionType::Ftp,
        "ssh.upload" | "ssh.download" => session_type == SessionType::Ssh,
        "sftp.upload" | "sftp.download" => {
            matches!(session_type, SessionType::Ssh | SessionType::Sftp)
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AppError::validation(format!(
            "工具 {tool_id} 与连接类型 {} 不匹配",
            session_type.as_str()
        )))
    }
}

fn session_protocol_label(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Ftp => "FTP",
        SessionType::Sftp => "SFTP",
        SessionType::Ssh => "SSH/SFTP",
        SessionType::Local | SessionType::Rdp => "不支持的协议",
    }
}

fn block_on_tool<T>(future: impl std::future::Future<Output = AppResult<T>>) -> AppResult<T> {
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(future)),
        Err(_) => tokio::runtime::Runtime::new()
            .map_err(|error| AppError::ai(error.to_string()))?
            .block_on(future),
    }
}

fn object_arg<T: DeserializeOwned>(arguments: &Value, key: &str) -> AppResult<T> {
    let value = arguments
        .get(key)
        .cloned()
        .ok_or_else(|| AppError::validation(format!("缺少工具参数: {key}")))?;
    serde_json::from_value(value)
        .map_err(|error| AppError::validation(format!("工具参数 {key} 无效: {error}")))
}

fn ai_approval_mode_arg(arguments: &Value) -> AppResult<AiApprovalMode> {
    let value = string_arg(arguments, "approval_mode")?;
    AiApprovalMode::from_db(&value)
        .ok_or_else(|| AppError::validation("审批模式必须是 request_approval、safe 或 full_access"))
}

fn execution_result(
    summary: impl Into<String>,
    affected_domains: impl IntoIterator<Item = impl AsRef<str>>,
) -> AiToolExecutionResult {
    AiToolExecutionResult {
        summary: summary.into(),
        affected_domains: affected_domains
            .into_iter()
            .map(|value| value.as_ref().to_string())
            .collect(),
        structured_content: None,
    }
}

fn structured_execution_result(
    summary: impl Into<String>,
    affected_domains: impl IntoIterator<Item = impl AsRef<str>>,
    structured_content: Value,
) -> AiToolExecutionResult {
    let mut result = execution_result(summary, affected_domains);
    result.structured_content = Some(structured_content);
    result
}

fn server_info_snapshot_summary(snapshot: &ServerInfoSnapshot) -> String {
    let host = snapshot
        .hostname
        .as_deref()
        .unwrap_or(snapshot.host_name.as_str());
    let cpu = snapshot
        .cpu_count
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    let processes = snapshot
        .process_count
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string());
    format!(
        "服务器快照已采集：{host}，CPU {cpu} 核，磁盘 {} 项，进程 {processes} 个。",
        snapshot.disks.len()
    )
}

fn affected_domains_for_tool(tool_id: &str) -> Vec<String> {
    let domains: &[&str] = match tool_id {
        "terminal.list" | "terminal.read" | "terminal.write" | "terminal.open"
        | "terminal.close" | "terminal.split" | "terminal.focus" | "ssh.execute" => &["terminal"],
        "workspace.open_tool" => &["workspace"],
        "settings.get" => &["settings"],
        "settings.update_ai_security" => &["ai"],
        tool if tool.starts_with("llm_provider.") => &["models"],
        "sessions.list"
        | "sessions.open"
        | "sessions.test"
        | "sessions.save"
        | "sessions.delete"
        | "session_groups.save"
        | "session_groups.delete" => &["sessions"],
        tool if tool.starts_with("ssh.") && tool != "ssh.execute" => &["files", "transfer"],
        tool if tool.starts_with("sftp.") || tool.starts_with("ftp.") => &["files", "transfer"],
        tool if tool.starts_with("history.") => &["history"],
        tool if tool.starts_with("workspace.") => &["workspace"],
        tool if tool.starts_with("terminal_profile.") => &["terminal", "settings"],
        tool if tool.starts_with("transfer.") => &["transfer"],
        "server_info.snapshot" => &["monitor"],
        "ssh_container.list" => &["terminal"],
        "zterm.context" | "zterm.search" => &["sessions", "models", "workspace", "terminal"],
        _ => &[],
    };
    domains.iter().map(|value| (*value).to_string()).collect()
}

fn validate_session_draft_for_test(store: &SqliteStore, draft: SavedSessionDraft) -> AppResult<()> {
    let session = preview_session_from_draft(draft);
    match session.session_type {
        crate::models::session::SessionType::Ssh => {
            crate::services::ssh_terminal_service::build_ssh_arguments(&session)?;
        }
        crate::models::session::SessionType::Rdp => {
            let _ = crate::services::rdp_service::build_mstsc_arguments(&session)?;
        }
        crate::models::session::SessionType::Local => {
            let profiles =
                crate::services::terminal_profile_service::list_or_detect_terminal_profiles(store)?;
            if profiles.is_empty() {
                return Err(AppError::validation("未检测到可用本机终端"));
            }
        }
        crate::models::session::SessionType::Sftp => {
            crate::services::ssh_terminal_service::build_ssh_arguments(&session)?;
        }
        crate::models::session::SessionType::Ftp => {
            if session.port == 0 || session.host.trim().is_empty() {
                return Err(AppError::validation("FTP 主机和端口不能为空"));
            }
        }
    }
    Ok(())
}

fn preview_session_from_draft(draft: SavedSessionDraft) -> crate::models::session::SavedSession {
    crate::models::session::SavedSession {
        id: draft.id.unwrap_or_else(|| "preview".to_string()),
        name: draft.name,
        session_type: draft.session_type,
        group_id: draft.group_id,
        host: if draft.host.trim().is_empty() {
            "localhost".to_string()
        } else {
            draft.host
        },
        port: draft.port,
        username: draft.username,
        auth_mode: draft.auth_mode,
        credential_ref: draft.credential_ref,
        description: draft.description,
        tags: draft.tags,
        sort_order: draft.sort_order,
        created_at_ms: 0,
        updated_at_ms: 0,
        last_used_at_ms: None,
        ssh_options: draft.ssh_options,
        rdp_options: draft.rdp_options,
        local_options: draft.local_options,
        ftp_options: draft.ftp_options,
    }
}

fn workspace_draft_arg(arguments: &Value) -> AppResult<WorkspaceDefinitionDraft> {
    if arguments.get("draft").is_some() {
        return object_arg::<WorkspaceDefinitionDraft>(arguments, "draft");
    }
    simplified_workspace_draft(arguments)
}

fn simplified_workspace_draft(arguments: &Value) -> AppResult<WorkspaceDefinitionDraft> {
    let name = string_arg(arguments, "name")?;
    let layout = optional_string_arg(arguments, "layout").unwrap_or_else(|| "single".to_string());
    let connections = arguments
        .get("connections")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let terminal_tabs = workspace_terminal_tabs(&connections)?;
    let root = workspace_root_for_layout(&layout, &terminal_tabs)?;
    Ok(WorkspaceDefinitionDraft {
        id: optional_string_arg(arguments, "id"),
        name,
        status: WorkspaceStatus::Closed,
        active_tab_id: "tab-1".to_string(),
        tabs: vec![WorkspaceTabDraft {
            id: "tab-1".to_string(),
            title: "默认标签".to_string(),
            active_pane_id: first_leaf_id(&root).unwrap_or_else(|| "pane-1".to_string()),
            root,
            sort_order: 0,
        }],
        sort_order: optional_usize_arg(arguments, "sort_order")
            .and_then(|value| i64::try_from(value).ok())
            .unwrap_or(0),
    })
}

fn workspace_terminal_tabs(items: &[Value]) -> AppResult<Vec<WorkspaceTerminalTab>> {
    if items.is_empty() {
        return Ok(vec![WorkspaceTerminalTab {
            id: "terminal-1".to_string(),
            title: "本地终端".to_string(),
            runtime_session_id: None,
            saved_session_id: None,
            connection_source: Some("default_local".to_string()),
            container_target: None,
            path: None,
            startup_command: None,
            restore_status: None,
            restore_error: None,
        }]);
    }
    items
        .iter()
        .enumerate()
        .map(|(index, item)| workspace_terminal_tab(index + 1, item))
        .collect()
}

fn workspace_terminal_tab(index: usize, item: &Value) -> AppResult<WorkspaceTerminalTab> {
    let object = item.as_object();
    let saved_session_id = item.as_str().map(ToOwned::to_owned).or_else(|| {
        object
            .and_then(|object| object.get("saved_session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });
    let connection_source = object
        .and_then(|object| object.get("connection_source"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            if saved_session_id.is_some() {
                Some("saved_session".to_string())
            } else {
                Some("default_local".to_string())
            }
        });
    let title = object
        .and_then(|object| object.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| saved_session_id.clone())
        .unwrap_or_else(|| "本地终端".to_string());
    Ok(WorkspaceTerminalTab {
        id: format!("terminal-{index}"),
        title,
        runtime_session_id: None,
        saved_session_id,
        connection_source,
        container_target: None,
        path: object
            .and_then(|object| object.get("path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        startup_command: object
            .and_then(|object| object.get("startup_command"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
        restore_status: None,
        restore_error: None,
    })
}

fn workspace_root_for_layout(
    layout: &str,
    terminal_tabs: &[WorkspaceTerminalTab],
) -> AppResult<PaneNode> {
    let layout = layout.trim().to_ascii_lowercase();
    let leaf = |index: usize, tabs: Vec<WorkspaceTerminalTab>| PaneNode::Leaf {
        id: format!("pane-{index}"),
        runtime_session_id: None,
        saved_session_id: tabs.first().and_then(|tab| tab.saved_session_id.clone()),
        title: tabs
            .first()
            .map(|tab| tab.title.clone())
            .unwrap_or_else(|| format!("Pane {index}")),
        active_terminal_tab_id: tabs.first().map(|tab| tab.id.clone()),
        terminal_tabs: tabs,
    };
    let mut tabs = terminal_tabs.to_vec();
    if tabs.is_empty() {
        tabs = workspace_terminal_tabs(&[])?;
    }
    let take_tab = |tabs: &[WorkspaceTerminalTab], index: usize| {
        vec![tabs.get(index).cloned().unwrap_or_else(|| tabs[0].clone())]
    };
    match layout.as_str() {
        "single" => Ok(leaf(1, tabs)),
        "two_columns" => Ok(PaneNode::Split {
            id: "split-1".to_string(),
            direction: "horizontal".to_string(),
            ratio: 0.5,
            first: Box::new(leaf(1, take_tab(&tabs, 0))),
            second: Box::new(leaf(2, take_tab(&tabs, 1))),
        }),
        "two_rows" => Ok(PaneNode::Split {
            id: "split-1".to_string(),
            direction: "vertical".to_string(),
            ratio: 0.5,
            first: Box::new(leaf(1, take_tab(&tabs, 0))),
            second: Box::new(leaf(2, take_tab(&tabs, 1))),
        }),
        "grid_2x2" => Ok(PaneNode::Split {
            id: "split-1".to_string(),
            direction: "vertical".to_string(),
            ratio: 0.5,
            first: Box::new(PaneNode::Split {
                id: "split-2".to_string(),
                direction: "horizontal".to_string(),
                ratio: 0.5,
                first: Box::new(leaf(1, take_tab(&tabs, 0))),
                second: Box::new(leaf(2, take_tab(&tabs, 1))),
            }),
            second: Box::new(PaneNode::Split {
                id: "split-3".to_string(),
                direction: "horizontal".to_string(),
                ratio: 0.5,
                first: Box::new(leaf(3, take_tab(&tabs, 2))),
                second: Box::new(leaf(4, take_tab(&tabs, 3))),
            }),
        }),
        _ => Err(AppError::validation(
            "工作区布局必须是 single、two_columns、two_rows 或 grid_2x2",
        )),
    }
}

fn first_leaf_id(node: &PaneNode) -> Option<String> {
    match node {
        PaneNode::Leaf { id, .. } => Some(id.clone()),
        PaneNode::Split { first, .. } => first_leaf_id(first),
    }
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    ["key", "token", "secret", "password", "passwd", "credential"]
        .iter()
        .any(|part| normalized.contains(part))
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(max_chars).collect::<String>())
    }
}

fn terminal_write_result_summary(command: &str, output: Option<&str>) -> String {
    let readable_command = readable_terminal_command(command);
    let command = redact_sensitive(&truncate(&readable_command, 240));
    let output = output
        .and_then(|value| readable_terminal_output(value, &readable_command))
        .map(|value| redact_sensitive(&truncate(&value, 1600)));
    match output {
        Some(output) => format!("命令已写入活动终端。\n命令：{command}\n终端输出：\n{output}"),
        None => format!("命令已写入活动终端。\n命令：{command}\n终端输出：未读取到额外输出。"),
    }
}

fn terminal_output_for_response(command: &str, output: Option<&str>, max_chars: usize) -> String {
    output
        .and_then(|value| readable_terminal_output(value, &readable_terminal_command(command)))
        .map(|value| redact_sensitive(&truncate(&value, max_chars)))
        .unwrap_or_default()
}

fn terminal_read_output_for_response(output: &str, max_chars: usize) -> String {
    redact_sensitive(&truncate(
        &strip_terminal_controls(output)
            .replace("\r\n", "\n")
            .replace('\r', "\n"),
        max_chars,
    ))
}

fn sanitized_session_value(session: &SavedSession) -> Value {
    json!({
        "id": session.id,
        "name": session.name,
        "type": session.session_type.as_str(),
        "group_id": session.group_id,
        "host": session.host,
        "port": session.port,
        "username": session.username,
        "auth_mode": session.auth_mode.as_str(),
        "has_saved_auth": session.credential_ref.is_some(),
        "description": session.description,
        "tags": session.tags,
        "sort_order": session.sort_order,
        "last_used_at_ms": session.last_used_at_ms
    })
}

fn sanitized_provider_value(provider: &AiProviderProfile) -> Value {
    json!({
        "id": provider.id,
        "name": provider.name,
        "kind": provider.kind.as_str(),
        "base_url": provider.base_url,
        "model": provider.model,
        "has_api_key": !provider.api_key_ref.trim().is_empty(),
        "enabled": provider.enabled,
        "is_default": provider.is_default,
        "created_at_ms": provider.created_at_ms,
        "updated_at_ms": provider.updated_at_ms
    })
}

fn sanitized_transfer_task_value(task: &TransferTask) -> Value {
    json!({
        "id": task.id,
        "saved_session_id": task.saved_session_id,
        "direction": task.direction,
        "local_path": task.local_path,
        "remote_path": task.remote_path,
        "kind": task.kind,
        "conflict_policy": task.conflict_policy,
        "total_bytes": task.total_bytes,
        "transferred_bytes": task.transferred_bytes,
        "status": task.status,
        "error_message": task.error_message.as_deref().map(redact_sensitive),
        "created_at_ms": task.created_at_ms,
        "updated_at_ms": task.updated_at_ms,
        "task_origin": task.task_origin,
        "source_endpoint": task.source_endpoint,
        "destination_endpoint": task.destination_endpoint
    })
}

fn readable_terminal_command(command: &str) -> String {
    strip_terminal_controls(command)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn readable_terminal_output(output: &str, command: &str) -> Option<String> {
    let command_lines = command
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let normalized = strip_terminal_controls(output)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let lines = normalized
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            !command_lines
                .iter()
                .any(|command_line| line == command_line)
        })
        .filter(|line| !looks_like_shell_prompt(line))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let text = lines.join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn looks_like_shell_prompt(line: &str) -> bool {
    let value = line.trim();
    ((value.ends_with('$') || value.ends_with('#')) && value.contains('@') && value.contains(':'))
        || (value.starts_with("PS ") && value.ends_with('>'))
        || (value.ends_with('>') && value.contains(":\\"))
}

fn strip_terminal_controls(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.next() {
                Some('[') => {
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    let mut escaped = false;
                    for next in chars.by_ref() {
                        if escaped {
                            if next == '\\' {
                                break;
                            }
                            escaped = false;
                            continue;
                        }
                        if next == '\u{1b}' {
                            escaped = true;
                        } else if next == '\u{7}' {
                            break;
                        }
                    }
                }
                Some('P' | '_' | '^' | 'X') => {
                    let mut escaped = false;
                    for next in chars.by_ref() {
                        if escaped {
                            if next == '\\' {
                                break;
                            }
                            escaped = false;
                        } else if next == '\u{1b}' {
                            escaped = true;
                        }
                    }
                }
                Some('O') => {
                    chars.next();
                }
                Some(_) | None => {}
            }
            continue;
        }
        if ch.is_control() && !matches!(ch, '\r' | '\n' | '\t') {
            continue;
        }
        output.push(ch);
    }
    output
}

fn spawn_ai_file_transfer(
    service: SftpService,
    queue: TransferQueue,
    session: SavedSession,
    all_sessions: Vec<SavedSession>,
    credentials: CredentialService,
    task: TransferTask,
) -> AppResult<()> {
    let control = match queue.register_control(&task.id) {
        Ok(control) => control,
        Err(error) => {
            let error = redact_sensitive(&error.to_string());
            let _ = queue.mark_failed(&task.id, &error);
            return Err(AppError::ai(error));
        }
    };
    tauri::async_runtime::spawn(async move {
        let _execution_slot = match queue.acquire_execution_slot(&control).await {
            Ok(slot) => slot,
            Err(_) => {
                let _ = queue.unregister_control(&task.id);
                return;
            }
        };
        let running = match queue.mark_running(&task.id) {
            Ok(task) => task,
            Err(_) => {
                let _ = queue.unregister_control(&task.id);
                return;
            }
        };
        if matches!(
            running.status,
            TransferStatus::Cancelled | TransferStatus::Paused
        ) {
            let _ = queue.unregister_control(&task.id);
            return;
        }
        let progress_queue = queue.clone();
        let progress_task_id = task.id.clone();
        let mut progress = move |update: TransferProgressUpdate| -> AppResult<()> {
            progress_queue.mark_progress_with_total(
                &progress_task_id,
                update.transferred_bytes,
                update.total_bytes,
            )?;
            Ok(())
        };
        let result = match (session.session_type, task.direction) {
            (SessionType::Ftp, TransferDirection::Upload) => {
                ftp_service::upload_path(
                    &session,
                    &credentials,
                    None,
                    &task.local_path,
                    &task.remote_path,
                    task.kind,
                    task.conflict_policy,
                    Some(control.clone()),
                    &mut progress,
                )
                .await
            }
            (SessionType::Ftp, TransferDirection::Download) => {
                ftp_service::download_path(
                    &session,
                    &credentials,
                    None,
                    &task.remote_path,
                    &task.local_path,
                    task.kind,
                    task.conflict_policy,
                    Some(control.clone()),
                    &mut progress,
                )
                .await
            }
            (_, TransferDirection::Upload) => {
                service
                    .upload_path(
                        &session,
                        &all_sessions,
                        &credentials,
                        &task.local_path,
                        &task.remote_path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
            (_, TransferDirection::Download) => {
                service
                    .download_path(
                        &session,
                        &all_sessions,
                        &credentials,
                        &task.remote_path,
                        &task.local_path,
                        task.kind,
                        task.conflict_policy,
                        Some(control.clone()),
                        &mut progress,
                    )
                    .await
            }
        };
        match queue.get(&task.id) {
            Ok(current) if current.status == TransferStatus::Cancelled => {}
            Ok(_) => match result {
                Ok(()) => {
                    let _ = queue.mark_done(&task.id);
                }
                Err(error) => {
                    let error = redact_sensitive(&error.to_string());
                    let _ = queue.mark_failed(&task.id, &error);
                }
            },
            Err(_) => {}
        }
        let _ = queue.unregister_control(&task.id);
    });
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
