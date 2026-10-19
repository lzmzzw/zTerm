// Author: Liz
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::de::DeserializeOwned;
use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::services::{
    ai_tool_catalog::{tool_definition, tool_definitions},
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
            AiApprovalMode, AiToolAuditListRequest, AiToolAuditRecord, AiToolConfirmRequest,
            AiToolDefinition, AiToolFrontendActionEvent, AiToolInvocationStatus,
            AiToolPendingInvocation, AiToolPrepareRequest, AiToolSecretInputs, RiskLevel,
        },
        credential::{CredentialDraft, CredentialKind},
        history::{HistoryScopeKind, HistorySearchOptions},
        server_info::{ServerInfoRequest, ServerInfoSnapshot},
        session::{AuthMode, SavedSession, SavedSessionDraft, SessionGroupDraft, SessionType},
        sftp::{
            TransferConflictPolicy, TransferDirection, TransferEndpoint, TransferEndpointKind,
            TransferKind, TransferStatus, TransferTask, TransferTaskOrigin,
        },
        terminal::{RuntimeSessionInfo, RuntimeSessionKind},
        terminal_profile::TerminalProfileDraft,
    },
    security::redaction::redact_sensitive,
    storage::{
        ai::{
            ai_tool_pending_exists, delete_ai_tool_pending, find_ai_tool_pending_by_request,
            get_ai_tool_audit_by_invocation_id, get_ai_tool_pending_state, insert_ai_tool_audit,
            list_ai_tool_audits, list_ai_tool_pending, upsert_ai_tool_pending,
        },
        history::{clear_command_history, search_command_history},
        sessions::{
            delete_session, delete_session_group, get_session, list_sessions, save_session,
            save_session_group,
        },
        settings::get_app_settings,
        sqlite::SqliteStore,
        transfers::list_transfer_tasks,
    },
    time::now_ms,
    validation::required_text,
};

pub(crate) const TERMINAL_READ_DEFAULT_CHARS: usize = 4000;
pub(crate) const TERMINAL_READ_MAX_CHARS: usize = 24_000;

fn terminal_read_budget(arguments: &Value) -> usize {
    arguments
        .get("max_chars")
        .and_then(Value::as_u64)
        .unwrap_or(TERMINAL_READ_DEFAULT_CHARS as u64)
        .clamp(1, TERMINAL_READ_MAX_CHARS as u64) as usize
}

pub struct AiTerminalOutputSnapshot {
    pub output: Option<String>,
    pub cursor: Option<usize>,
    pub truncated: bool,
}

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

    fn read_terminal_output_snapshot(
        &self,
        runtime_session_id: &str,
        cursor: Option<usize>,
        max_chars: usize,
    ) -> AppResult<AiTerminalOutputSnapshot> {
        let output = match cursor {
            Some(cursor) => self.read_terminal_output_after(runtime_session_id, cursor)?,
            None => self.read_terminal_output_tail(runtime_session_id, max_chars)?,
        };
        Ok(AiTerminalOutputSnapshot {
            output,
            cursor: self.terminal_output_cursor(runtime_session_id)?,
            truncated: false,
        })
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

#[derive(Clone)]
pub struct AiToolService {
    writer: Arc<dyn AiToolCommandWriter>,
    credential_service: Option<CredentialService>,
    transfer_queue: Option<TransferQueue>,
    sftp_service: Option<SftpService>,
    server_info_service: Option<ServerInfoService>,
    ssh_command_service: Option<SshCommandService>,
    completion_broker: Arc<AiToolCompletionBroker>,
    active_terminal: Arc<Mutex<Option<String>>>,
}

const COMPLETION_TTL: Duration = Duration::from_secs(15 * 60);
const COMPLETION_MAX_ENTRIES: usize = 128;

#[derive(Default)]
struct AiToolCompletionBroker {
    completed: Mutex<HashMap<String, (Instant, AiToolExecutionOutcome)>>,
    changed: Notify,
}

impl AiToolCompletionBroker {
    fn publish(&self, outcome: AiToolExecutionOutcome) -> AppResult<()> {
        let invocation_id = outcome
            .audit_record
            .as_ref()
            .map(|audit| audit.invocation_id.clone())
            .ok_or_else(|| AppError::ai("MCP 审批完成结果缺少审计记录"))?;
        let mut completed = self
            .completed
            .lock()
            .map_err(|_| AppError::ai("MCP 审批完成状态锁已损坏"))?;
        prune_completions(&mut completed);
        completed.insert(invocation_id, (Instant::now(), outcome));
        prune_completions(&mut completed);
        drop(completed);
        self.changed.notify_waiters();
        Ok(())
    }

    fn get(&self, invocation_id: &str) -> AppResult<Option<AiToolExecutionOutcome>> {
        let mut completed = self
            .completed
            .lock()
            .map_err(|_| AppError::ai("MCP 审批完成状态锁已损坏"))?;
        prune_completions(&mut completed);
        Ok(completed
            .get(invocation_id)
            .map(|(_, outcome)| outcome.clone()))
    }
}

fn prune_completions(completed: &mut HashMap<String, (Instant, AiToolExecutionOutcome)>) {
    let now = Instant::now();
    completed.retain(|_, (created_at, _)| now.duration_since(*created_at) <= COMPLETION_TTL);
    if completed.len() <= COMPLETION_MAX_ENTRIES {
        return;
    }
    let mut ranked = completed
        .iter()
        .map(|(invocation_id, (created_at, _))| (invocation_id.clone(), *created_at))
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(_, created_at)| *created_at);
    for (invocation_id, _) in ranked
        .into_iter()
        .take(completed.len() - COMPLETION_MAX_ENTRIES)
    {
        completed.remove(&invocation_id);
    }
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
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
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

    fn read_terminal_output_snapshot(
        &self,
        runtime_session_id: &str,
        cursor: Option<usize>,
        max_chars: usize,
    ) -> AppResult<AiTerminalOutputSnapshot> {
        let read = match cursor {
            Some(cursor) => self.manager.wait_for_output_read_after(
                runtime_session_id,
                cursor,
                2500,
                250,
                max_chars,
            )?,
            None => Some(self.manager.output_read_after_cursor(
                runtime_session_id,
                0,
                max_chars,
            )?),
        };
        match read {
            Some(read) => Ok(AiTerminalOutputSnapshot {
                output: Some(read.output),
                cursor: Some(read.cursor),
                truncated: read.truncated,
            }),
            None => Ok(AiTerminalOutputSnapshot {
                output: None,
                cursor,
                truncated: false,
            }),
        }
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
            credential_service: None,
            transfer_queue: None,
            sftp_service: None,
            server_info_service: None,
            ssh_command_service: None,
            completion_broker: Arc::new(AiToolCompletionBroker::default()),
            active_terminal: Arc::new(Mutex::new(None)),
        }
    }

    pub fn with_credential_service(
        writer: Arc<dyn AiToolCommandWriter>,
        credential_service: CredentialService,
    ) -> Self {
        Self {
            writer,
            credential_service: Some(credential_service),
            transfer_queue: None,
            sftp_service: None,
            server_info_service: None,
            ssh_command_service: None,
            completion_broker: Arc::new(AiToolCompletionBroker::default()),
            active_terminal: Arc::new(Mutex::new(None)),
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
            credential_service: Some(credential_service),
            transfer_queue: Some(transfer_queue),
            sftp_service: Some(sftp_service),
            server_info_service: Some(server_info_service),
            ssh_command_service: Some(ssh_command_service),
            completion_broker: Arc::new(AiToolCompletionBroker::default()),
            active_terminal: Arc::new(Mutex::new(None)),
        }
    }

    /// UI observation only; never changes a bound or pending command target.
    pub fn set_active_terminal(&self, runtime_session_id: Option<String>) -> AppResult<()> {
        let mut active = self
            .active_terminal
            .lock()
            .map_err(|_| AppError::ai("活动终端上下文锁已损坏"))?;
        *active = None;
        if let Some(id) = runtime_session_id {
            self.ensure_visible_ssh_runtime(&id)?;
            *active = Some(id);
        }
        Ok(())
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

    pub fn ensure_visible_ssh_runtime(&self, runtime_session_id: &str) -> AppResult<()> {
        let runtime_session_id = required_text("运行时会话 ID", runtime_session_id)?;
        let runtime = self
            .visible_ssh_runtime(&runtime_session_id)?
            .ok_or_else(|| {
                AppError::not_found(format!("终端运行态不存在: {runtime_session_id}"))
            })?;
        ensure_visible_ssh_runtime_info(&runtime)
    }

    /// Resolves the default runtime for a sidebar agent without expanding its connection scope.
    ///
    /// A still-visible initial runtime is always retained.  A closed regular SSH runtime may
    /// fall back to another visible regular SSH runtime for the same saved connection.  Container
    /// runtimes intentionally never use this fallback: their container identity is not encoded by
    /// `saved_session_id` and selecting another runtime would cross that boundary.
    pub fn resolve_sidebar_default_ssh_runtime(
        &self,
        initial_runtime_session_id: &str,
        saved_session_id: Option<&str>,
        initial_runtime_kind: RuntimeSessionKind,
    ) -> AppResult<String> {
        let initial_runtime_session_id =
            required_text("初始运行时会话 ID", initial_runtime_session_id)?;
        let runtimes = self.writer.list_terminals()?;

        if let Some(runtime) = runtimes
            .iter()
            .find(|runtime| runtime.runtime_session_id == initial_runtime_session_id)
        {
            ensure_visible_ssh_runtime_info(runtime)?;
            return Ok(runtime.runtime_session_id.clone());
        }

        if initial_runtime_kind != RuntimeSessionKind::Ssh {
            return Err(AppError::not_found(format!(
                "初始 SSH 终端已关闭，且该终端不允许按连接回退: {initial_runtime_session_id}"
            )));
        }
        let Some(saved_session_id) = saved_session_id
            .map(str::trim)
            .filter(|saved_session_id| !saved_session_id.is_empty())
        else {
            return Err(AppError::not_found(format!(
                "初始 SSH 终端已关闭，且没有可回退的已保存连接: {initial_runtime_session_id}"
            )));
        };

        let fallback = runtimes
            .iter()
            .filter(|runtime| runtime.kind == RuntimeSessionKind::Ssh)
            .filter(|runtime| runtime.saved_session_id.as_deref() == Some(saved_session_id))
            .min_by(|left, right| left.runtime_session_id.cmp(&right.runtime_session_id))
            .ok_or_else(|| {
                AppError::not_found(format!(
                    "初始 SSH 终端已关闭，当前没有同一连接的可见 SSH 终端: {saved_session_id}"
                ))
            })?;
        Ok(fallback.runtime_session_id.clone())
    }

    fn visible_ssh_runtime(
        &self,
        runtime_session_id: &str,
    ) -> AppResult<Option<RuntimeSessionInfo>> {
        Ok(self
            .writer
            .list_terminals()?
            .into_iter()
            .find(|runtime| runtime.runtime_session_id == runtime_session_id))
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
            if let Some(requested_by) = pending
                .requested_by
                .as_deref()
                .filter(|requested_by| *requested_by == "mcp")
            {
                if let Some(existing) = find_ai_tool_pending_by_request(
                    store,
                    &pending.tool_id,
                    &arguments,
                    requested_by,
                )? {
                    let _ = self.writer.notify_pending_tools();
                    return Ok(AiToolExecutionOutcome {
                        pending_invocation: Some(existing),
                        audit_record: None,
                        structured_content: None,
                    });
                }
            }
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
        let secret_input = secret_input_requirement(&tool.id, &arguments)?;
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
        let requested_by_mcp = pending.requested_by.as_deref() == Some("mcp");
        let (audit, structured_content) = self.audit_execution(
            store,
            invocation_id,
            pending,
            &arguments,
            request.approved,
            request.secret_inputs,
            normalize_optional(request.audit_context_json),
        )?;
        delete_ai_tool_pending(store, &audit.invocation_id)?;
        if requested_by_mcp {
            self.completion_broker.publish(AiToolExecutionOutcome {
                pending_invocation: None,
                audit_record: Some(audit.clone()),
                structured_content,
            })?;
        }
        Ok(audit)
    }

    pub async fn wait_for_mcp_completion(
        &self,
        store: &SqliteStore,
        invocation_id: &str,
        timeout: Duration,
    ) -> AppResult<Option<AiToolExecutionOutcome>> {
        let invocation_id = required_text("MCP 工具调用 ID", invocation_id)?;
        let wait = async {
            loop {
                let changed = self.completion_broker.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if let Some(outcome) = self.completion_broker.get(&invocation_id)? {
                    return Ok(Some(outcome));
                }
                if let Some(audit) = get_ai_tool_audit_by_invocation_id(store, &invocation_id)? {
                    return Ok(Some(AiToolExecutionOutcome {
                        pending_invocation: None,
                        audit_record: Some(audit),
                        structured_content: None,
                    }));
                }
                if !ai_tool_pending_exists(store, &invocation_id)? {
                    return Err(AppError::not_found(format!(
                        "MCP tool invocation not found: {invocation_id}"
                    )));
                }
                changed.as_mut().await;
            }
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(result) => result,
            Err(_) => Ok(None),
        }
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
                let snapshot =
                    self.writer
                        .read_terminal_output_snapshot(&runtime_session_id, cursor, 4000)?;
                let output = snapshot.output;
                let next_cursor = snapshot.cursor;
                let readable_output = terminal_output_for_response(&data, output.as_deref(), 4000);
                Ok(structured_execution_result(
                    terminal_write_result_summary(&data, output.as_deref()),
                    ["terminal", "history"],
                    json!({
                        "runtime_session_id": runtime_session_id,
                        "output": readable_output,
                        "cursor": next_cursor,
                        "truncated": snapshot.truncated
                    }),
                ))
            }
            "terminal.list" => {
                let saved_session_id = optional_string_arg(arguments, "saved_session_id");
                let ssh_only = arguments
                    .get("ssh_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let terminals = self
                    .writer
                    .list_terminals()?
                    .into_iter()
                    .filter(|terminal| {
                        saved_session_id.as_ref().is_none_or(|saved_session_id| {
                            terminal.saved_session_id.as_deref() == Some(saved_session_id.as_str())
                        })
                    })
                    .filter(|terminal| {
                        !ssh_only
                            || matches!(
                                terminal.kind,
                                RuntimeSessionKind::Ssh | RuntimeSessionKind::SshContainer
                            )
                    })
                    .collect::<Vec<_>>();
                Ok(structured_execution_result(
                    format!("终端运行态已读取：{} 个。", terminals.len()),
                    ["terminal"],
                    json!({
                        "active_runtime_session_id": self.active_terminal.lock()
                            .map_err(|_| AppError::ai("活动终端上下文锁已损坏"))?
                            .as_ref()
                            .filter(|id| terminals.iter().any(|terminal| {
                                terminal.runtime_session_id == **id
                                    && matches!(terminal.kind, RuntimeSessionKind::Ssh | RuntimeSessionKind::SshContainer)
                            })).cloned(),
                        "terminals": terminals
                    }),
                ))
            }
            "terminal.read" => {
                let runtime_session_id = string_arg(arguments, "runtime_session_id")?;
                let max_chars = terminal_read_budget(arguments);
                let cursor = optional_usize_arg(arguments, "cursor");
                let snapshot = self.writer.read_terminal_output_snapshot(
                    &runtime_session_id,
                    cursor,
                    max_chars,
                )?;
                let output = snapshot.output;
                let next_cursor = snapshot.cursor;
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
                        "cursor": next_cursor,
                        "truncated": snapshot.truncated,
                        "effective_max_chars": max_chars
                    }),
                ))
            }
            "terminal.close" => {
                self.emit_frontend_action(tool_id, arguments, affected_domains_for_tool(tool_id))
            }
            "terminal.open" | "terminal.split" | "terminal.focus" | "tool.open" => {
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
                let session_type = optional_string_arg(arguments, "session_type");
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
                    .filter(|session| {
                        session_type.as_ref().is_none_or(|session_type| {
                            session.session_type.as_str() == session_type.as_str()
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
                    ["sessions"],
                    json!({ "session": sanitized_session_value(&session) }),
                ))
            }
            "sessions.delete" => {
                let id = string_arg(arguments, "id")?;
                delete_session(store, &id)?;
                Ok(execution_result("会话已删除。", ["sessions"]))
            }
            "sessions.open" => {
                self.emit_frontend_action(tool_id, arguments, affected_domains_for_tool(tool_id))
            }
            "sessions.test" => {
                let draft = object_arg::<SavedSessionDraft>(arguments, "draft")?;
                validate_session_draft_for_test(store, draft)?;
                Ok(execution_result("会话配置测试通过。", ["sessions"]))
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
        let terminals = self.writer.list_terminals()?;
        Ok(execution_result(
            format!(
                "zTerm 上下文：{} 个分组，{} 个会话，{} 个运行终端。",
                sessions.groups.len(),
                sessions.sessions.len(),
                terminals.len()
            ),
            ["sessions", "terminal"],
        ))
    }

    fn zterm_search(
        &self,
        store: &SqliteStore,
        arguments: &Value,
    ) -> AppResult<AiToolExecutionResult> {
        let query = string_arg(arguments, "query")?.to_ascii_lowercase();
        let sessions = list_sessions(store)?;
        let session_matches = sessions
            .sessions
            .iter()
            .filter(|session| {
                session.name.to_ascii_lowercase().contains(&query)
                    || session.host.to_ascii_lowercase().contains(&query)
                    || session.id.to_ascii_lowercase().contains(&query)
            })
            .count();
        Ok(execution_result(
            format!("搜索完成：会话 {} 个。", session_matches),
            ["sessions"],
        ))
    }
}

fn ensure_visible_ssh_runtime_info(runtime: &RuntimeSessionInfo) -> AppResult<()> {
    if !matches!(
        runtime.kind,
        RuntimeSessionKind::Ssh | RuntimeSessionKind::SshContainer
    ) {
        return Err(AppError::validation(
            "zTerm 侧栏只允许操作可见的 SSH 服务器终端",
        ));
    }
    Ok(())
}

fn validate_arguments(tool_id: &str, arguments: &Value) -> AppResult<()> {
    match tool_id {
        "terminal.write" => {
            let _ = string_arg(arguments, "runtime_session_id")?;
            let _ = string_arg_preserve(arguments, "data")?;
        }
        "terminal.read" => {
            let _ = string_arg(arguments, "runtime_session_id")?;
            if arguments
                .get("max_chars")
                .is_some_and(|value| value.as_u64().is_none_or(|budget| budget == 0))
            {
                return Err(AppError::validation(
                    "max_chars 必须是正整数；可省略以使用默认值",
                ));
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
        "settings.get" | "sessions.list" | "terminal.list" => {}
        "session_groups.save" => {
            let _ = object_arg::<SessionGroupDraft>(arguments, "draft")?;
        }
        "session_groups.delete" | "sessions.delete" => {
            let _ = string_arg(arguments, "id")?;
        }
        "sessions.save" | "sessions.test" => {
            let _ = object_arg::<SavedSessionDraft>(arguments, "draft")?;
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

fn secret_input_requirement(tool_id: &str, arguments: &Value) -> AppResult<SecretInputRequirement> {
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
    Ok(SecretInputRequirement::default())
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
        false
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
    match approval_mode {
        AiApprovalMode::RequestApproval => true,
        AiApprovalMode::Safe => {
            force_confirmation_tool(tool_id)
                || matches!(risk_level, RiskLevel::High | RiskLevel::Critical)
        }
        AiApprovalMode::FullAccess => false,
    }
}

fn force_confirmation_tool(tool_id: &str) -> bool {
    tool_id.ends_with(".delete")
        || matches!(
            tool_id,
            "session_groups.delete"
                | "history.clear"
                | "sftp.delete"
                | "transfer.cancel"
                | "transfer.delete"
                | "sessions.delete"
        )
}

fn target_summary(arguments: &Value) -> Option<String> {
    let object = arguments.as_object()?;
    let mut parts = Vec::new();
    for key in [
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
        "tool.open" => &["tools"],
        "settings.get" => &["settings"],
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
        tool if tool.starts_with("terminal_profile.") => &["terminal", "settings"],
        tool if tool.starts_with("transfer.") => &["transfer"],
        "server_info.snapshot" => &["monitor"],
        "ssh_container.list" => &["terminal"],
        "zterm.context" | "zterm.search" => &["sessions", "terminal"],
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

#[cfg(test)]
mod output_snapshot_tests {
    use super::*;

    #[test]
    fn terminal_read_budget_is_bounded_and_preserves_unicode_snapshot() {
        assert_eq!(terminal_read_budget(&json!({})), 4000);
        let manager = Arc::new(TerminalManager::default());
        let store = Arc::new(SqliteStore::open_in_memory().unwrap());
        let writer =
            RuntimeAiToolWriter::new(manager.clone(), Arc::new(CommandHistoryService::new(store)));
        manager.record_output("test", &"中".repeat(24_000)).unwrap();
        for (requested, expected) in [
            (1, 1),
            (4000, 4000),
            (5000, 5000),
            (24_000, 24_000),
            (100_000, 24_000),
            (u64::MAX, 24_000),
        ] {
            let budget = terminal_read_budget(&json!({"max_chars": requested}));
            assert_eq!(budget, expected);
            let snapshot = writer
                .read_terminal_output_snapshot("test", Some(0), budget)
                .unwrap();
            assert_eq!(snapshot.output.unwrap().chars().count(), expected);
            assert_eq!(snapshot.cursor, Some(72_000));
            assert_eq!(snapshot.truncated, expected < 24_000);
        }
    }

    #[test]
    fn terminal_read_accepts_large_budgets_but_rejects_invalid_types() {
        for budget in [1, 4000, 5000, 24_000, 100_000, u64::MAX] {
            assert!(
                validate_arguments(
                    "terminal.read",
                    &json!({
                        "runtime_session_id": "test", "max_chars": budget
                    })
                )
                .is_ok(),
                "budget {budget}"
            );
        }
        for budget in [json!(0), json!(-1), json!(1.5), json!("5000"), Value::Null] {
            assert!(
                validate_arguments(
                    "terminal.read",
                    &json!({
                        "runtime_session_id": "test", "max_chars": budget
                    })
                )
                .is_err(),
                "invalid budget {budget}"
            );
        }
    }

    #[test]
    fn runtime_writer_preserves_cursor_and_reports_lost_history() {
        let manager = Arc::new(TerminalManager::default());
        let store = Arc::new(SqliteStore::open_in_memory().unwrap());
        let writer =
            RuntimeAiToolWriter::new(manager.clone(), Arc::new(CommandHistoryService::new(store)));
        manager.record_output("test", &"x".repeat(30_000)).unwrap();
        let snapshot = writer
            .read_terminal_output_snapshot("test", Some(0), 4000)
            .unwrap();
        assert_eq!(snapshot.cursor, Some(30_000));
        assert!(snapshot.truncated);
        assert_eq!(snapshot.output.unwrap().len(), 4000);
        manager.record_output("test", "新输出").unwrap();
        let next = writer
            .read_terminal_output_snapshot("test", snapshot.cursor, 4000)
            .unwrap();
        assert_eq!(next.cursor, Some(30_009));
        assert_eq!(next.output.as_deref(), Some("新输出"));
        assert!(!next.truncated);
    }
}
