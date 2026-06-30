// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CommandCompletionRequest {
    pub runtime_session_id: String,
    pub input: String,
    pub cursor: usize,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandCompletionCandidate {
    pub provider: CommandCompletionProvider,
    pub replacement_text: String,
    pub suffix: String,
    pub replacement_range: CommandCompletionReplacementRange,
    pub score: f64,
    pub source_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandCompletionProvider {
    History,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandCompletionReplacementRange {
    pub start: usize,
    pub end: usize,
}
