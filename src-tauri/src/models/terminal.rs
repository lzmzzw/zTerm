// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeSessionKind {
    Local,
    Ssh,
    SshContainer,
    RdpPlaceholder,
}

impl RuntimeSessionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Ssh => "ssh",
            Self::SshContainer => "ssh_container",
            Self::RdpPlaceholder => "rdp_placeholder",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeSessionInfo {
    pub runtime_session_id: String,
    pub saved_session_id: Option<String>,
    pub history_scope_kind: Option<crate::models::history::HistoryScopeKind>,
    pub history_scope_id: Option<String>,
    pub pane_id: String,
    pub title: String,
    pub kind: RuntimeSessionKind,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalAccepted {
    pub accepted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalResized {
    pub resized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalClosed {
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalDataEvent {
    pub runtime_session_id: String,
    pub data: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalExitEvent {
    pub runtime_session_id: String,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
}
