use serde::{Deserialize, Serialize};

/// 单一当前布局；仅允许持久化重启后仍有意义的连接引用与显示结构。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TerminalLayoutSnapshot {
    pub active_tab_id: String,
    pub tabs: Vec<TerminalLayoutTab>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TerminalLayoutTab {
    pub id: String,
    pub title: String,
    pub active_pane_id: String,
    pub root: PaneNode,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalLayoutConnection {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub saved_session_id: Option<String>,
    #[serde(default)]
    pub connection_source: Option<String>,
    #[serde(default)]
    pub container_target: Option<ContainerTarget>,
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContainerTarget {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PaneNode {
    Leaf {
        id: String,
        #[serde(default)]
        saved_session_id: Option<String>,
        title: String,
        #[serde(default)]
        active_terminal_tab_id: Option<String>,
        #[serde(default)]
        terminal_tabs: Vec<TerminalLayoutConnection>,
    },
    Split {
        id: String,
        direction: String,
        ratio: f64,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}
