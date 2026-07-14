// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryScopeKind {
    SavedSession,
    LocalProfile,
}

impl HistoryScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SavedSession => "saved_session",
            Self::LocalProfile => "local_profile",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "saved_session" => Some(Self::SavedSession),
            "local_profile" => Some(Self::LocalProfile),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandHistoryEntry {
    pub id: String,
    pub scope_kind: Option<HistoryScopeKind>,
    pub scope_id: Option<String>,
    pub runtime_session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandHistoryDraft {
    pub scope_kind: Option<HistoryScopeKind>,
    pub scope_id: Option<String>,
    pub runtime_session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorySearchOptions {
    pub query: Option<String>,
    pub scope_kind: Option<HistoryScopeKind>,
    pub scope_id: Option<String>,
    pub limit: Option<usize>,
    pub deduplicate: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearCommandHistoryResult {
    pub cleared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteCommandHistoryEntriesResult {
    pub deleted_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCommandGroupItem {
    pub id: String,
    pub group_id: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCommandGroup {
    pub id: String,
    pub saved_session_id: Option<String>,
    pub scope_kind: HistoryScopeKind,
    pub scope_id: String,
    pub name: String,
    pub items: Vec<SessionCommandGroupItem>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCommandGroupDraft {
    pub id: Option<String>,
    pub saved_session_id: Option<String>,
    pub scope_kind: HistoryScopeKind,
    pub scope_id: String,
    pub name: String,
    pub commands: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandGroupDeleted {
    pub deleted: bool,
}
