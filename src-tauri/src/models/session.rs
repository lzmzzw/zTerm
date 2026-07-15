// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionType {
    Ssh,
    Local,
    Rdp,
    Ftp,
    Sftp,
}

impl SessionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::Local => "local",
            Self::Rdp => "rdp",
            Self::Ftp => "ftp",
            Self::Sftp => "sftp",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "ssh" => Some(Self::Ssh),
            "local" => Some(Self::Local),
            "rdp" => Some(Self::Rdp),
            "ftp" => Some(Self::Ftp),
            "sftp" => Some(Self::Sftp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    Password,
    Key,
    Agent,
    None,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
            Self::Agent => "agent",
            Self::None => "none",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "password" => Some(Self::Password),
            "key" => Some(Self::Key),
            "agent" => Some(Self::Agent),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshOptions {
    #[serde(default)]
    pub connect_timeout_ms: Option<u64>,
    #[serde(default)]
    pub keepalive_interval_ms: Option<u64>,
    #[serde(default)]
    pub proxy_command: Option<String>,
    #[serde(default)]
    pub identity_file: Option<String>,
    #[serde(default)]
    pub jump_hosts: Vec<String>,
    #[serde(default)]
    pub tunnels: Vec<SshTunnel>,
    #[serde(default)]
    pub container: Option<SshContainerOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshContainerOptions {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_container_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub container: String,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub workdir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SshTunnelKind {
    Local,
    Remote,
    Dynamic,
    RemoteDynamic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SshTunnel {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    pub kind: SshTunnelKind,
    #[serde(default = "default_true")]
    pub auto_open: bool,
    #[serde(default)]
    pub bind_address: Option<String>,
    #[serde(default)]
    pub local_port: Option<u16>,
    #[serde(default)]
    pub remote_host: Option<String>,
    #[serde(default)]
    pub remote_port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RdpOptions {
    pub domain: Option<String>,
    pub width: u32,
    pub height: u32,
    pub color_depth: u16,
    pub redirect_clipboard: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalOptions {
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub environment: Vec<LocalEnvironmentVariable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalEnvironmentVariable {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FtpOptions {
    #[serde(default)]
    pub connect_timeout_ms: Option<u64>,
    #[serde(default)]
    pub initial_directory: Option<String>,
    #[serde(default = "default_true")]
    pub passive_mode: bool,
    #[serde(default)]
    pub anonymous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionGroup {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub expanded: bool,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionGroupDraft {
    pub id: Option<String>,
    pub parent_id: Option<String>,
    pub name: String,
    pub expanded: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub session_type: SessionType,
    pub group_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_mode: AuthMode,
    pub credential_ref: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_used_at_ms: Option<i64>,
    pub ssh_options: Option<SshOptions>,
    pub rdp_options: Option<RdpOptions>,
    pub local_options: Option<LocalOptions>,
    pub ftp_options: Option<FtpOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedSessionDraft {
    pub id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub session_type: SessionType,
    pub group_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_mode: AuthMode,
    pub credential_ref: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub sort_order: i64,
    pub ssh_options: Option<SshOptions>,
    pub rdp_options: Option<RdpOptions>,
    pub local_options: Option<LocalOptions>,
    pub ftp_options: Option<FtpOptions>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionsList {
    pub groups: Vec<SessionGroup>,
    pub sessions: Vec<SavedSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteResult {
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTestResult {
    pub ok: bool,
    pub message: String,
}

fn default_true() -> bool {
    true
}

fn default_container_runtime() -> String {
    "docker".to_string()
}
