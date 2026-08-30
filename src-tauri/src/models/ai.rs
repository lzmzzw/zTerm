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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiApprovalMode {
    RequestApproval,
    #[default]
    Safe,
    FullAccess,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConnectionApprovalPolicy {
    pub saved_session_id: String,
    pub approval_mode: AiApprovalMode,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiConnectionApprovalPolicyUpdateRequest {
    pub saved_session_id: String,
    pub approval_mode: AiApprovalMode,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiToolFrontendActionEvent {
    pub action: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub affected_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolPrepareRequest {
    pub tool_id: String,
    #[serde(default)]
    pub arguments: Value,
    pub reason: Option<String>,
    pub requested_by: Option<String>,
    pub run_id: Option<String>,
    pub step_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub struct AiToolSecretInputs {
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiToolConfirmRequest {
    pub invocation_id: String,
    pub approved: bool,
    pub audit_context_json: Option<String>,
    #[serde(default)]
    pub secret_inputs: Option<AiToolSecretInputs>,
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
    #[serde(default)]
    pub requires_secret_input: bool,
    #[serde(default)]
    pub secret_input_label: Option<String>,
    pub status: AiToolInvocationStatus,
    pub created_at_ms: i64,
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
    #[serde(default)]
    pub affected_domains: Vec<String>,
    pub created_at_ms: i64,
    pub completed_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct AiToolAuditListRequest {
    pub limit: Option<usize>,
}
