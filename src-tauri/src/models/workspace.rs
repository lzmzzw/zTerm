// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceStatus {
    Running,
    Closed,
}

impl WorkspaceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Closed => "closed",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceTerminalTab {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub runtime_session_id: Option<String>,
    #[serde(default)]
    pub saved_session_id: Option<String>,
    #[serde(default)]
    pub connection_source: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default)]
    pub restore_status: Option<String>,
    #[serde(default)]
    pub restore_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PaneNode {
    Leaf {
        id: String,
        #[serde(default)]
        runtime_session_id: Option<String>,
        #[serde(default)]
        saved_session_id: Option<String>,
        title: String,
        #[serde(default)]
        active_terminal_tab_id: Option<String>,
        #[serde(default)]
        terminal_tabs: Vec<WorkspaceTerminalTab>,
    },
    Split {
        id: String,
        direction: String,
        ratio: f64,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceTab {
    pub id: String,
    pub title: String,
    pub active_pane_id: String,
    pub root: PaneNode,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceTabDraft {
    pub id: String,
    pub title: String,
    pub active_pane_id: String,
    pub root: PaneNode,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceDefinition {
    pub id: String,
    pub name: String,
    pub status: WorkspaceStatus,
    pub active_tab_id: String,
    pub tabs: Vec<WorkspaceTab>,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceDefinitionDraft {
    pub id: Option<String>,
    pub name: String,
    pub status: WorkspaceStatus,
    pub active_tab_id: String,
    pub tabs: Vec<WorkspaceTabDraft>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub id: String,
    pub name: String,
    pub status: WorkspaceStatus,
    pub active_tab_id: String,
    pub tab_count: i64,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
