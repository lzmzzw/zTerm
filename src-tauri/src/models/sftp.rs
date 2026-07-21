// Author: Liz
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    pub modified_at_ms: Option<i64>,
    pub permissions: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

impl TransferDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Download => "download",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "upload" => Some(Self::Upload),
            "download" => Some(Self::Download),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    File,
    Directory,
}

impl TransferKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "file" => Some(Self::File),
            "directory" => Some(Self::Directory),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferConflictPolicy {
    Overwrite,
    Skip,
    Rename,
}

impl TransferConflictPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overwrite => "overwrite",
            Self::Skip => "skip",
            Self::Rename => "rename",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "overwrite" => Some(Self::Overwrite),
            "skip" => Some(Self::Skip),
            "rename" => Some(Self::Rename),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferStatus {
    Queued,
    Running,
    Paused,
    Done,
    Failed,
    Cancelled,
}

impl TransferStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferTaskOrigin {
    SftpPanel,
    FileTransfer,
}

impl TransferTaskOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SftpPanel => "sftp_panel",
            Self::FileTransfer => "file_transfer",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "sftp_panel" => Some(Self::SftpPanel),
            "file_transfer" => Some(Self::FileTransfer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferEndpointKind {
    Local,
    #[serde(rename = "saved_session", alias = "ssh")]
    SavedSession,
}

impl TransferEndpointKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::SavedSession => "ssh",
        }
    }

    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "ssh" | "saved_session" => Some(Self::SavedSession),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferEndpoint {
    pub kind: TransferEndpointKind,
    pub saved_session_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferTask {
    pub id: String,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub saved_session_id: String,
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub kind: Option<TransferKind>,
    pub conflict_policy: TransferConflictPolicy,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub status: TransferStatus,
    pub error_message: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub task_origin: TransferTaskOrigin,
    pub source_endpoint: TransferEndpoint,
    pub destination_endpoint: TransferEndpoint,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SftpDeleteResult {
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SftpRenameResult {
    pub renamed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SftpMkdirResult {
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalPathInfo {
    pub path: String,
    pub kind: TransferKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferConflictCheckItem {
    pub direction: TransferDirection,
    pub local_path: String,
    pub remote_path: String,
    pub kind: TransferKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferConflict {
    pub direction: TransferDirection,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransferEndpointConflict {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEndpointConflictCheckItem {
    pub destination: TransferEndpoint,
    pub kind: TransferKind,
}
