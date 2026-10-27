use ring::digest::{Context, SHA256};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeek, AsyncSeekExt};

use crate::{
    error::{AppError, AppResult},
    services::sftp_service::SFTP_PUBLISH_OUTCOME_UNKNOWN,
    storage::{
        sqlite::SqliteStore,
        transfer_resume::{self, TransferResumeManifest},
    },
};

#[derive(Clone)]
pub struct TransferResumeContext {
    store: Arc<SqliteStore>,
    task_id: String,
}

impl TransferResumeContext {
    pub fn new(store: Arc<SqliteStore>, task_id: impl Into<String>) -> Self {
        Self {
            store,
            task_id: task_id.into(),
        }
    }

    pub fn ensure_retryable(&self) -> AppResult<()> {
        if transfer_resume::phase(&self.store, &self.task_id)?.as_deref() == Some("publishing") {
            return Err(AppError::sftp(format!(
                "{SFTP_PUBLISH_OUTCOME_UNKNOWN}: 发布阶段未确认，请先核对目标，不能重放传输"
            )));
        }
        Ok(())
    }

    pub fn clear(&self) -> AppResult<()> {
        transfer_resume::clear(&self.store, &self.task_id)
    }

    pub(crate) fn load(&self) -> AppResult<Option<TransferResumeManifest>> {
        self.ensure_retryable()?;
        transfer_resume::load(&self.store, &self.task_id)
    }

    pub(crate) fn save(&self, manifest: &TransferResumeManifest) -> AppResult<()> {
        transfer_resume::save(&self.store, &self.task_id, manifest)
    }

    pub(crate) fn mark_publishing(&self) -> AppResult<()> {
        transfer_resume::mark_publishing(&self.store, &self.task_id)
    }
}

pub(crate) fn digest_hex(context: Context) -> String {
    context
        .finish()
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn binding(parts: &[&str]) -> String {
    let mut hash = Context::new(&SHA256);
    for part in parts {
        hash.update(&(part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    digest_hex(hash)
}

pub(crate) async fn hash_prefix<R: AsyncRead + AsyncSeek + Unpin>(
    reader: &mut R,
    bytes: u64,
    control: Option<&crate::services::transfer_queue::TransferRunControl>,
) -> AppResult<Context> {
    reader.seek(std::io::SeekFrom::Start(0)).await?;
    let mut remaining = bytes;
    let mut buffer = vec![0; 64 * 1024];
    let mut hash = Context::new(&SHA256);
    while remaining > 0 {
        if let Some(control) = control {
            control.checkpoint().await?;
        }
        let size = remaining.min(buffer.len() as u64) as usize;
        let read = loop {
            let state_change: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
                match control {
                    Some(control) => control.wait_for_state_change(),
                    None => Box::pin(std::future::pending()),
                };
            tokio::select! {
                result = tokio::time::timeout(std::time::Duration::from_secs(60), reader.read(&mut buffer[..size])) => {
                    break result.map_err(|_| AppError::sftp("文件校验读取 timeout"))??;
                },
                _ = state_change => { if let Some(control) = control { control.checkpoint().await?; } }
            }
        };
        if read == 0 {
            return Err(AppError::sftp("续传校验长度不足"));
        }
        hash.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(hash)
}

pub(crate) fn valid_manifest(
    manifest: &TransferResumeManifest,
    expected_binding: &str,
    source_size: u64,
    source_hash: &str,
) -> bool {
    manifest.version == 1
        && manifest.binding == expected_binding
        && manifest.total_bytes == source_size
        && manifest.source_sha256 == source_hash
        && manifest.confirmed_offset <= source_size
        && manifest.prefix_sha256.len() == 64
        && manifest
            .prefix_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn recoverable_io_error(error: &AppError) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    [
        "connection reset",
        "connection lost",
        "no connection",
        "sender dropped",
        "broken pipe",
        "connection closed",
        "channel closed",
        "session closed",
        "timeout",
        "timed out",
        "unexpected eof",
        "长时间无响应",
    ]
    .iter()
    .any(|text| message.contains(text))
}
