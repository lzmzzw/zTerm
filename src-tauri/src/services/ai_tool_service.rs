// Author: Liz
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use uuid::Uuid;

use crate::services::{
    command_history_service::CommandHistoryService, terminal_manager::TerminalManager,
};
use crate::{
    error::{AppError, AppResult},
    models::{
        ai::{
            AiApprovalMode, AiMessageRole, AiToolAuditListRequest, AiToolAuditRecord,
            AiToolConfirmRequest, AiToolDefinition, AiToolInvocationStatus,
            AiToolPendingInvocation, AiToolPrepareRequest, RiskLevel,
        },
        history::{HistoryScopeKind, HistorySearchOptions},
    },
    security::redaction::redact_sensitive,
    storage::{
        ai::{
            delete_ai_tool_pending, get_ai_tool_pending_state, insert_ai_conversation_message,
            insert_ai_tool_audit, list_ai_provider_profiles, list_ai_tool_audits,
            list_ai_tool_pending, upsert_ai_tool_pending,
        },
        history::{clear_command_history, search_command_history},
        sessions::list_sessions,
        settings::get_app_settings,
        sqlite::SqliteStore,
    },
};

pub trait AiToolCommandWriter: Send + Sync {
    fn write_terminal(&self, runtime_session_id: &str, data: &str) -> AppResult<()>;

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
}

#[derive(Debug, Clone)]
pub struct AiToolExecutionOutcome {
    pub pending_invocation: Option<AiToolPendingInvocation>,
    pub audit_record: Option<AiToolAuditRecord>,
}

#[derive(Clone)]
pub struct AiToolService {
    writer: Arc<dyn AiToolCommandWriter>,
}

#[derive(Clone)]
pub struct RuntimeAiToolWriter {
    manager: Arc<TerminalManager>,
    history: Arc<CommandHistoryService>,
}

impl RuntimeAiToolWriter {
    pub fn new(manager: Arc<TerminalManager>, history: Arc<CommandHistoryService>) -> Self {
        Self { manager, history }
    }
}

impl AiToolCommandWriter for RuntimeAiToolWriter {
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
}

impl AiToolService {
    pub fn with_writer(writer: Arc<dyn AiToolCommandWriter>) -> Self {
        Self { writer }
    }

    pub fn definitions(&self) -> Vec<AiToolDefinition> {
        tool_definitions()
    }

    pub fn prepare(
        &self,
        store: &SqliteStore,
        request: AiToolPrepareRequest,
    ) -> AppResult<AiToolPendingInvocation> {
        let pending = self.build_pending(request, AiApprovalMode::RequestApproval)?;
        upsert_ai_tool_pending(store, &pending.0, &pending.1)?;
        Ok(pending.0)
    }

    pub fn execute_if_allowed(
        &self,
        store: &SqliteStore,
        request: AiToolPrepareRequest,
        approval_mode: AiApprovalMode,
    ) -> AppResult<AiToolExecutionOutcome> {
        let (pending, arguments) = self.build_pending(request, approval_mode)?;
        if pending.requires_confirmation {
            upsert_ai_tool_pending(store, &pending, &arguments)?;
            return Ok(AiToolExecutionOutcome {
                pending_invocation: Some(pending),
                audit_record: None,
            });
        }

        let invocation_id = pending.id.clone();
        let audit = self.audit_execution(
            store,
            invocation_id,
            pending,
            &arguments,
            true,
            Some(
                json!({ "approval_mode": approval_mode.as_str(), "auto_approved": true })
                    .to_string(),
            ),
        )?;
        Ok(AiToolExecutionOutcome {
            pending_invocation: None,
            audit_record: Some(audit),
        })
    }

    fn build_pending(
        &self,
        request: AiToolPrepareRequest,
        approval_mode: AiApprovalMode,
    ) -> AppResult<(AiToolPendingInvocation, Value)> {
        let tool = tool_definition(&request.tool_id)?;
        let arguments = normalized_arguments(request.arguments);
        validate_arguments(&tool.id, &arguments)?;
        let risk = assess_risk(&tool, &arguments);
        let pending = AiToolPendingInvocation {
            id: Uuid::new_v4().to_string(),
            tool_id: tool.id,
            tool_title: tool.title,
            risk_level: risk.level,
            arguments_summary: summarize_arguments(&arguments),
            target_summary: target_summary(&arguments),
            risk_summary: risk.summary,
            requires_confirmation: requires_confirmation(approval_mode, risk.level),
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
        let audit = self.audit_execution(
            store,
            invocation_id,
            pending,
            &arguments,
            request.approved,
            normalize_optional(request.audit_context_json),
        )?;
        delete_ai_tool_pending(store, &audit.invocation_id)?;
        Ok(audit)
    }

    fn audit_execution(
        &self,
        store: &SqliteStore,
        invocation_id: String,
        pending: AiToolPendingInvocation,
        arguments: &Value,
        approved: bool,
        audit_context_json: Option<String>,
    ) -> AppResult<AiToolAuditRecord> {
        let execution = if approved {
            self.execute(store, &pending.tool_id, arguments)
        } else {
            Ok("用户已拒绝执行。".to_string())
        };
        let completed_at_ms = now_ms();
        let audit = match execution {
            Ok(summary) => AiToolAuditRecord {
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
                result_summary: Some(summary),
                error: None,
                audit_context_json: audit_context_json.clone(),
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
                created_at_ms: pending.created_at_ms,
                completed_at_ms,
            },
        };
        insert_ai_tool_audit(store, &audit)?;
        persist_tool_message(store, &pending, &audit)?;
        Ok(audit)
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

    fn execute(&self, store: &SqliteStore, tool_id: &str, arguments: &Value) -> AppResult<String> {
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
                Ok(terminal_write_result_summary(&data, output.as_deref()))
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
                Ok(format!("命令历史已读取：{} 条。", entries.len()))
            }
            "history.clear" => {
                let scope_kind = history_scope_kind_arg(arguments)?;
                let scope_id = string_arg(arguments, "scope_id")?;
                clear_command_history(store, Some(scope_kind), Some(scope_id.as_str()))?;
                Ok("命令历史已清理。".to_string())
            }
            "sessions.list" => {
                let sessions = list_sessions(store)?;
                Ok(format!(
                    "会话树已读取：{} 个分组，{} 个会话。",
                    sessions.groups.len(),
                    sessions.sessions.len()
                ))
            }
            "llm_provider.list" => {
                let providers = list_ai_provider_profiles(store)?;
                Ok(format!("LLM Provider 已读取：{} 个。", providers.len()))
            }
            "settings.get" => {
                let settings = get_app_settings(store)?;
                Ok(format!(
                    "设置已读取：主题 {:?}，UI 字号 {}，终端字号 {}。",
                    settings.theme, settings.ui_font_size, settings.terminal_font_size
                ))
            }
            "terminal.list"
            | "terminal.open"
            | "terminal.split"
            | "terminal.focus"
            | "workspace.open_tool"
            | "settings.update_ai_security"
            | "llm_provider.create"
            | "llm_provider.update"
            | "llm_provider.delete"
            | "llm_provider.test"
            | "sessions.open"
            | "sessions.test"
            | "sftp.list"
            | "sftp.mkdir"
            | "sftp.upload"
            | "sftp.download"
            | "sftp.delete"
            | "sftp.rename"
            | "history.record" => Ok(format!(
                "工具 {tool_id} 已通过 AI 审批，实际操作请通过 zTerm 对应受控 IPC 执行。"
            )),
            _ => Err(AppError::validation(format!("不支持的 AI 工具: {tool_id}"))),
        }
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
            RiskLevel::High,
            true,
        ),
        (
            "llm_provider.update",
            "更新 LLM Provider",
            "修改模型 Provider 配置",
            RiskLevel::High,
            true,
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
        "history.search" | "history.clear" => {
            let _ = history_scope_kind_arg(arguments)?;
            let _ = string_arg(arguments, "scope_id")?;
        }
        "settings.get" | "llm_provider.list" | "sessions.list" => {}
        "sftp.delete" => {
            let _ = string_arg(arguments, "saved_session_id")?;
            let _ = string_arg(arguments, "path")?;
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

fn assess_risk(tool: &AiToolDefinition, arguments: &Value) -> AssessedRisk {
    if tool.id == "terminal.write" {
        let command = arguments
            .get("data")
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

fn requires_confirmation(approval_mode: AiApprovalMode, risk_level: RiskLevel) -> bool {
    match approval_mode {
        AiApprovalMode::RequestApproval => true,
        AiApprovalMode::Safe => risk_level != RiskLevel::Low,
        AiApprovalMode::FullAccess => false,
    }
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
        "risk_level": audit.risk_level.as_str()
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
