// Author: Liz
use serde::Serialize;
use thiserror::Error;

use crate::security::redaction::redact_sensitive;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error)]
#[serde(tag = "code", content = "message", rename_all = "snake_case")]
pub enum AppError {
    #[error("validation error: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("storage error: {0}")]
    Storage(String),
    #[error("credential error: {0}")]
    Credential(String),
    #[error("terminal error: {0}")]
    Terminal(String),
    #[error("ssh error: {0}")]
    Ssh(String),
    #[error("sftp error: {0}")]
    Sftp(String),
    #[error("ai error: {0}")]
    Ai(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
}

impl AppError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(redact_sensitive(&message.into()))
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(redact_sensitive(&message.into()))
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::Storage(redact_sensitive(&message.into()))
    }

    pub fn credential(message: impl Into<String>) -> Self {
        Self::Credential(redact_sensitive(&message.into()))
    }

    pub fn terminal(message: impl Into<String>) -> Self {
        Self::Terminal(redact_sensitive(&message.into()))
    }

    pub fn ssh(message: impl Into<String>) -> Self {
        Self::Ssh(redact_sensitive(&message.into()))
    }

    pub fn sftp(message: impl Into<String>) -> Self {
        Self::Sftp(redact_sensitive(&message.into()))
    }

    pub fn ai(message: impl Into<String>) -> Self {
        Self::Ai(redact_sensitive(&message.into()))
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::Unsupported(redact_sensitive(&message.into()))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::storage(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::storage(error.to_string())
    }
}
