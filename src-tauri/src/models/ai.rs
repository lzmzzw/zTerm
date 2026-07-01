// Author: Liz
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiApprovalMode {
    RequestApproval,
    Safe,
    FullAccess,
}

impl Default for AiApprovalMode {
    fn default() -> Self {
        Self::Safe
    }
}

impl AiApprovalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RequestApproval => "request_approval",
            Self::Safe => "safe",
            Self::FullAccess => "full_access",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "request_approval" => Some(Self::RequestApproval),
            "safe" => Some(Self::Safe),
            "full_access" => Some(Self::FullAccess),
            _ => None,
        }
    }
}

impl RiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "critical" => Some(Self::Critical),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiMessageRole {
    User,
    Assistant,
    System,
    Tool,
}

impl AiMessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
            Self::Tool => "tool",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "system" => Some(Self::System),
            "tool" => Some(Self::Tool),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConversationSummary {
    pub id: String,
    pub title: String,
    pub scope_kind: String,
    pub scope_ref_json: String,
    pub approval_mode: AiApprovalMode,
    pub status: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub scope_kind: String,
    pub scope_ref_json: String,
    pub approval_mode: AiApprovalMode,
    pub status: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub messages: Vec<AiConversationMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConversationMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: AiMessageRole,
    pub content: String,
    pub status: String,
    pub metadata_json: Option<String>,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConversationCreateRequest {
    pub title: Option<String>,
    pub scope_kind: String,
    pub scope_ref_json: Option<String>,
    pub approval_mode: Option<AiApprovalMode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConversationApprovalModeUpdateRequest {
    pub conversation_id: String,
    pub approval_mode: AiApprovalMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConversationMessageAppendRequest {
    pub conversation_id: String,
    pub role: AiMessageRole,
    pub content: String,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AiConversationListRequest {
    pub query: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AiTerminalContextRequest {
    pub runtime_session_id: Option<String>,
    pub saved_session_id: Option<String>,
    pub pane_id: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub recent_output: Option<String>,
    pub recent_output_tail: Option<String>,
    pub selected_text: Option<String>,
    pub input_buffer: Option<String>,
    pub active_tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiTerminalContextSnapshot {
    pub runtime_session_id: Option<String>,
    pub saved_session_id: Option<String>,
    pub pane_id: Option<String>,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub target_summary: Option<String>,
    pub recent_output_tail: Option<String>,
    pub selected_text: Option<String>,
    pub input_buffer: Option<String>,
    pub active_tool: Option<String>,
    pub generated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiChatHistoryMessage {
    pub role: AiMessageRole,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub conversation_id: Option<String>,
    pub message: String,
    pub approval_mode: Option<AiApprovalMode>,
    #[serde(default)]
    pub history: Vec<AiChatHistoryMessage>,
    pub terminal_context: Option<AiTerminalContextRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiChatResponse {
    pub conversation_id: String,
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub message: String,
    pub pending_invocations: Vec<AiToolPendingInvocation>,
    pub executed_invocations: Vec<AiToolAuditRecord>,
    pub response_redacted: bool,
    pub context_used: bool,
    pub tool_count: usize,
    pub generated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiChatStreamStartResult {
    pub chat_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiChatStreamCancelResult {
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiChatStreamChunkEvent {
    pub chat_id: String,
    pub conversation_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiChatStreamDoneEvent {
    pub chat_id: String,
    pub conversation_id: String,
    pub message: String,
    pub pending_invocations: Vec<AiToolPendingInvocation>,
    pub executed_invocations: Vec<AiToolAuditRecord>,
    pub context_used: bool,
    pub generated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiChatStreamErrorEvent {
    pub chat_id: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AiChatStreamCancelledEvent {
    pub chat_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiToolInvocationStatus {
    Pending,
    Rejected,
    Succeeded,
    Failed,
}

impl AiToolInvocationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Rejected => "rejected",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "rejected" => Some(Self::Rejected),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolDefinition {
    pub id: String,
    pub title: String,
    pub description: String,
    pub risk_level: RiskLevel,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolPrepareRequest {
    pub tool_id: String,
    #[serde(default)]
    pub arguments: Value,
    pub reason: Option<String>,
    pub requested_by: Option<String>,
    pub conversation_id: Option<String>,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolConfirmRequest {
    pub invocation_id: String,
    pub approved: bool,
    pub audit_context_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolPendingInvocation {
    pub id: String,
    pub tool_id: String,
    pub tool_title: String,
    pub risk_level: RiskLevel,
    pub arguments_summary: String,
    pub target_summary: Option<String>,
    pub risk_summary: Option<String>,
    pub requires_confirmation: bool,
    pub status: AiToolInvocationStatus,
    pub created_at_ms: i64,
    pub conversation_id: Option<String>,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
    pub reason: Option<String>,
    pub requested_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolAuditRecord {
    pub id: String,
    pub invocation_id: String,
    pub tool_id: String,
    pub tool_title: String,
    pub risk_level: RiskLevel,
    pub arguments_summary: String,
    pub risk_summary: Option<String>,
    pub status: AiToolInvocationStatus,
    pub result_summary: Option<String>,
    pub error: Option<String>,
    pub audit_context_json: Option<String>,
    pub created_at_ms: i64,
    pub completed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AiToolAuditListRequest {
    pub limit: Option<usize>,
}
