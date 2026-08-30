// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    SshPassword,
    SshKeyPassphrase,
    RdpPassword,
}

impl CredentialKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SshPassword => "ssh_password",
            Self::SshKeyPassphrase => "ssh_key_passphrase",
            Self::RdpPassword => "rdp_password",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "ssh_password" => Some(Self::SshPassword),
            "ssh_key_passphrase" => Some(Self::SshKeyPassphrase),
            "rdp_password" => Some(Self::RdpPassword),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CredentialRecord {
    pub id: String,
    pub name: String,
    pub kind: CredentialKind,
    pub credential_ref: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CredentialDraft {
    pub id: Option<String>,
    pub name: String,
    pub kind: CredentialKind,
    pub secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CredentialSecret {
    pub secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CredentialTestResult {
    pub ok: bool,
    pub message: String,
}
