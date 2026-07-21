// Author: Liz
use std::{
    collections::HashMap,
    fmt,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};

use russh_sftp::{
    client::fs::File as SftpFile,
    client::Config as SftpClientConfig,
    client::SftpSession as RusshSftpSession,
    protocol::{FileAttributes, FileType, OpenFlags},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Mutex as AsyncMutex,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        session::{AuthMode, SavedSession, SessionType},
        sftp::{
            FileEntry, FileKind, LocalPathInfo, TransferConflict, TransferConflictCheckItem,
            TransferConflictPolicy, TransferDirection, TransferKind,
        },
    },
    services::{
        credential_service::read_system_secret,
        ssh_command_service::{
            build_ssh_command_execution, connect_chain, reusable_connection_key_for_execution,
            reusable_connection_metadata_for_execution, SshCommandSecretResolver,
            SshConnectionChain, SshReusableConnectionMetadata,
        },
        transfer_queue::TransferRunControl,
    },
};

const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const SFTP_MAX_INFLIGHT_REQUESTS: usize = 64;
const SFTP_CACHE_IDLE_TTL: Duration = Duration::from_secs(90);
const SFTP_CACHE_PRUNE_INTERVAL: Duration = Duration::from_secs(30);
const SFTP_CACHE_MAX_ENTRIES: usize = 8;
const SFTP_LIST_MAX_ATTEMPTS: usize = 2;
const SFTP_LIST_RETRY_DELAY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferProgressUpdate {
    pub total_bytes: Option<u64>,
    pub transferred_bytes: u64,
}

fn progress_update(transferred_bytes: u64, total_bytes: Option<u64>) -> TransferProgressUpdate {
    TransferProgressUpdate {
        total_bytes,
        transferred_bytes,
    }
}

fn bulk_transfer_sftp_config() -> SftpClientConfig {
    SftpClientConfig {
        max_concurrent_writes: SFTP_MAX_INFLIGHT_REQUESTS,
        ..Default::default()
    }
}

async fn transfer_checkpoint(control: Option<&TransferRunControl>) -> AppResult<()> {
    if let Some(control) = control {
        control.checkpoint().await?;
    }
    Ok(())
}

struct TransferProgressWriter<'a, W, F> {
    inner: &'a mut W,
    control: Option<&'a TransferRunControl>,
    on_progress: &'a mut F,
    pause_wait: Option<Pin<Box<dyn Future<Output = ()> + Send + 'static>>>,
    transferred_bytes: u64,
}

impl<'a, W, F> TransferProgressWriter<'a, W, F> {
    fn new(
        inner: &'a mut W,
        transferred_bytes: u64,
        control: Option<&'a TransferRunControl>,
        on_progress: &'a mut F,
    ) -> Self {
        Self {
            inner,
            control,
            on_progress,
            pause_wait: None,
            transferred_bytes,
        }
    }

    fn transferred_bytes(&self) -> u64 {
        self.transferred_bytes
    }

    fn poll_control(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let Some(control) = self.control else {
            return Poll::Ready(Ok(()));
        };
        loop {
            if control.is_cancelled() {
                return Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "传输已取消",
                )));
            }
            if !control.is_paused() {
                self.pause_wait = None;
                return Poll::Ready(Ok(()));
            }

            let wait = self
                .pause_wait
                .get_or_insert_with(|| control.wait_for_state_change());
            match wait.as_mut().poll(cx) {
                Poll::Ready(()) => self.pause_wait = None,
                Poll::Pending if !control.is_paused() => self.pause_wait = None,
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl<W, F> AsyncWrite for TransferProgressWriter<'_, W, F>
where
    W: AsyncWrite + Unpin,
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.poll_control(cx) {
            Poll::Ready(Ok(())) => {}
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Pending => return Poll::Pending,
        }

        match Pin::new(&mut *self.inner).poll_write(cx, buffer) {
            Poll::Ready(Ok(written)) => {
                self.transferred_bytes = self.transferred_bytes.saturating_add(written as u64);
                let update = progress_update(self.transferred_bytes, None);
                if let Err(error) = (self.on_progress)(update) {
                    return Poll::Ready(Err(io::Error::other(error.to_string())));
                }
                Poll::Ready(Ok(written))
            }
            other => other,
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(cx)
    }
}

#[derive(Clone)]
pub struct SftpService {
    cache: Arc<SftpSessionCache>,
}

impl Default for SftpService {
    fn default() -> Self {
        Self::new()
    }
}

impl SftpService {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(SftpSessionCache::new()),
        }
    }

    pub fn evict_cached_sessions_for_session(&self, session_id: &str) {
        self.cache
            .remove_matching(|metadata| metadata.matches_session_id(session_id));
    }

    pub fn evict_cached_sessions_for_credential(&self, credential_ref: &str) {
        self.cache
            .remove_matching(|metadata| metadata.matches_credential_ref(credential_ref));
    }

    pub async fn list(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        path: &str,
    ) -> AppResult<Vec<FileEntry>> {
        let path = required_remote_path(path)?;
        for attempt in 0..SFTP_LIST_MAX_ATTEMPTS {
            match self.list_once(session, all_sessions, secrets, &path).await {
                Ok(entries) => return Ok(entries),
                Err(error)
                    if attempt + 1 < SFTP_LIST_MAX_ATTEMPTS
                        && should_retry_sftp_list_error(&error) =>
                {
                    tokio::time::sleep(SFTP_LIST_RETRY_DELAY).await;
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("SFTP directory listing must return from the retry loop")
    }

    async fn list_once(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        path: &str,
    ) -> AppResult<Vec<FileEntry>> {
        let lease = self
            .cached_sftp_session(session, all_sessions, secrets)
            .await?;
        let sftp = lease.entry.sftp.lock().await;
        let mut entries = sftp
            .read_dir(path)
            .await
            .map_err(|error| {
                self.cache.remove_key_if_entry(&lease.key, &lease.entry);
                AppError::sftp(error.to_string())
            })?
            .map(|entry| {
                let metadata = entry.metadata();
                file_entry(entry.file_name(), entry.path(), metadata)
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn create_dir(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        path: &str,
    ) -> AppResult<()> {
        let path = validate_destructive_remote_path(path)?;
        let lease = self
            .cached_sftp_session(session, all_sessions, secrets)
            .await?;
        let sftp = lease.entry.sftp.lock().await;
        create_remote_dir_all(&sftp, &path).await.inspect_err(|_| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
        })
    }

    pub async fn exists(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        path: &str,
    ) -> AppResult<bool> {
        let path = required_remote_path(path)?;
        let lease = self
            .cached_sftp_session(session, all_sessions, secrets)
            .await?;
        let sftp = lease.entry.sftp.lock().await;
        sftp.try_exists(path).await.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            AppError::sftp(error.to_string())
        })
    }

    pub async fn rename(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        from: &str,
        to: &str,
    ) -> AppResult<()> {
        let from = validate_destructive_remote_path(from)?;
        let to = validate_destructive_remote_path(to)?;
        let lease = self
            .cached_sftp_session(session, all_sessions, secrets)
            .await?;
        let sftp = lease.entry.sftp.lock().await;
        sftp.rename(from, to).await.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            AppError::sftp(error.to_string())
        })
    }

    pub async fn delete(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        path: &str,
        recursive: bool,
    ) -> AppResult<()> {
        let path = validate_destructive_remote_path(path)?;
        let lease = self
            .cached_sftp_session(session, all_sessions, secrets)
            .await?;
        let sftp = lease.entry.sftp.lock().await;
        let metadata = sftp.symlink_metadata(path.clone()).await.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            AppError::sftp(error.to_string())
        })?;
        let is_directory = metadata.file_type().is_dir();
        validate_delete_request(&path, is_directory, recursive)?;
        let result = if is_directory {
            if recursive {
                remove_remote_dir_recursive(&sftp, &path).await
            } else {
                sftp.remove_dir(path)
                    .await
                    .map_err(|error| AppError::sftp(error.to_string()))
            }
        } else {
            sftp.remove_file(path)
                .await
                .map_err(|error| AppError::sftp(error.to_string()))
        };
        result.inspect_err(|_| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upload_path<F>(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        local_path: &str,
        remote_path: &str,
        _kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        control: Option<TransferRunControl>,
        mut on_progress: F,
    ) -> AppResult<()>
    where
        F: FnMut(TransferProgressUpdate) -> AppResult<()>,
    {
        let local_path = PathBuf::from(required_path(local_path)?);
        let remote_path = validate_destructive_remote_path(remote_path)?;
        let metadata = fs::metadata(&local_path).await?;
        let connection = connect_sftp(session, all_sessions, secrets).await?;
        let sftp = &connection.sftp;
        let mut transferred = 0_u64;
        transfer_checkpoint(control.as_ref()).await?;

        if metadata.is_dir() {
            let total_bytes = local_path_total_bytes(local_path.to_string_lossy().as_ref()).await?;
            let Some(remote_root) =
                prepare_remote_directory_root(sftp, &remote_path, conflict_policy).await?
            else {
                transferred = transferred.saturating_add(total_bytes);
                on_progress(progress_update(transferred, None))?;
                connection.close("sftp upload completed").await;
                return Ok(());
            };
            let mut stack = vec![(local_path, remote_root)];
            while let Some((local_dir, remote_dir)) = stack.pop() {
                transfer_checkpoint(control.as_ref()).await?;
                let mut entries = fs::read_dir(&local_dir).await?;
                while let Some(entry) = entries.next_entry().await? {
                    transfer_checkpoint(control.as_ref()).await?;
                    let entry_path = entry.path();
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    let remote_entry = join_remote_path(&remote_dir, &entry_name);
                    let entry_metadata = entry.metadata().await?;
                    if entry_metadata.is_dir() {
                        ensure_remote_directory(sftp, &remote_entry).await?;
                        stack.push((entry_path, remote_entry));
                    } else {
                        transferred = upload_file(
                            sftp,
                            &entry_path,
                            &remote_entry,
                            conflict_policy,
                            transferred,
                            control.as_ref(),
                            &mut on_progress,
                        )
                        .await?;
                    }
                }
            }
        } else {
            transferred = upload_file(
                sftp,
                &local_path,
                &remote_path,
                conflict_policy,
                transferred,
                control.as_ref(),
                &mut on_progress,
            )
            .await?;
        }

        on_progress(progress_update(transferred, None))?;
        connection.close("sftp upload completed").await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn download_path<F>(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        remote_path: &str,
        local_path: &str,
        _kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        control: Option<TransferRunControl>,
        mut on_progress: F,
    ) -> AppResult<()>
    where
        F: FnMut(TransferProgressUpdate) -> AppResult<()>,
    {
        let remote_path = required_remote_path(remote_path)?;
        let local_path = PathBuf::from(required_path(local_path)?);
        let connection = connect_sftp(session, all_sessions, secrets).await?;
        let sftp = &connection.sftp;
        transfer_checkpoint(control.as_ref()).await?;
        let metadata = sftp
            .symlink_metadata(remote_path.clone())
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        let mut transferred = 0_u64;

        if metadata.file_type().is_dir() {
            let Some(local_root) =
                prepare_local_directory_root(&local_path, conflict_policy).await?
            else {
                connection.close("sftp download completed").await;
                return Ok(());
            };
            let mut stack = vec![(remote_path, local_root)];
            while let Some((remote_dir, local_dir)) = stack.pop() {
                transfer_checkpoint(control.as_ref()).await?;
                fs::create_dir_all(&local_dir).await?;
                let entries = sftp
                    .read_dir(remote_dir.clone())
                    .await
                    .map_err(|error| AppError::sftp(error.to_string()))?;
                for entry in entries {
                    transfer_checkpoint(control.as_ref()).await?;
                    let remote_entry = entry.path();
                    let local_entry = local_dir.join(entry.file_name());
                    if entry.metadata().file_type().is_dir() {
                        stack.push((remote_entry, local_entry));
                    } else {
                        transferred = download_file(
                            sftp,
                            &remote_entry,
                            &local_entry,
                            conflict_policy,
                            transferred,
                            control.as_ref(),
                            &mut on_progress,
                        )
                        .await?;
                    }
                }
            }
        } else {
            transferred = download_file(
                sftp,
                &remote_path,
                &local_path,
                conflict_policy,
                transferred,
                control.as_ref(),
                &mut on_progress,
            )
            .await?;
        }

        on_progress(progress_update(transferred, None))?;
        connection.close("sftp download completed").await;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn copy_remote_to_remote_path<F>(
        &self,
        source_session: &SavedSession,
        source_all_sessions: &[SavedSession],
        source_path: &str,
        destination_session: &SavedSession,
        destination_all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        destination_path: &str,
        _kind: Option<TransferKind>,
        conflict_policy: TransferConflictPolicy,
        control: Option<TransferRunControl>,
        mut on_progress: F,
    ) -> AppResult<()>
    where
        F: FnMut(TransferProgressUpdate) -> AppResult<()>,
    {
        let source_path = required_remote_path(source_path)?;
        let destination_path = validate_destructive_remote_path(destination_path)?;
        let source_connection = connect_sftp(source_session, source_all_sessions, secrets).await?;
        let destination_connection =
            connect_sftp(destination_session, destination_all_sessions, secrets).await?;
        let source_sftp = &source_connection.sftp;
        let destination_sftp = &destination_connection.sftp;
        transfer_checkpoint(control.as_ref()).await?;
        let metadata = source_sftp
            .symlink_metadata(source_path.clone())
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        let mut transferred = 0_u64;

        if metadata.file_type().is_dir() {
            let Some(destination_root) =
                prepare_remote_directory_root(destination_sftp, &destination_path, conflict_policy)
                    .await?
            else {
                source_connection.close("sftp remote copy completed").await;
                destination_connection
                    .close("sftp remote copy completed")
                    .await;
                return Ok(());
            };
            let mut stack = vec![(source_path, destination_root)];
            while let Some((source_dir, destination_dir)) = stack.pop() {
                transfer_checkpoint(control.as_ref()).await?;
                let entries = source_sftp
                    .read_dir(source_dir.clone())
                    .await
                    .map_err(|error| AppError::sftp(error.to_string()))?;
                for entry in entries {
                    transfer_checkpoint(control.as_ref()).await?;
                    let source_entry = entry.path();
                    let destination_entry = join_remote_path(&destination_dir, &entry.file_name());
                    if entry.metadata().file_type().is_dir() {
                        ensure_remote_directory(destination_sftp, &destination_entry).await?;
                        stack.push((source_entry, destination_entry));
                    } else {
                        transferred = copy_remote_file(
                            source_sftp,
                            destination_sftp,
                            &source_entry,
                            &destination_entry,
                            conflict_policy,
                            transferred,
                            control.as_ref(),
                            &mut on_progress,
                        )
                        .await?;
                    }
                }
            }
        } else {
            transferred = copy_remote_file(
                source_sftp,
                destination_sftp,
                &source_path,
                &destination_path,
                conflict_policy,
                transferred,
                control.as_ref(),
                &mut on_progress,
            )
            .await?;
        }

        on_progress(progress_update(transferred, None))?;
        source_connection.close("sftp remote copy completed").await;
        destination_connection
            .close("sftp remote copy completed")
            .await;
        Ok(())
    }

    pub async fn check_transfer_conflicts(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
        items: Vec<TransferConflictCheckItem>,
    ) -> AppResult<Vec<TransferConflict>> {
        if items.is_empty() {
            return Ok(Vec::new());
        }

        let mut conflicts = Vec::new();
        let upload_items = items
            .iter()
            .filter(|item| item.direction == TransferDirection::Upload)
            .collect::<Vec<_>>();
        if !upload_items.is_empty() {
            let lease = self
                .cached_sftp_session(session, all_sessions, secrets)
                .await?;
            let sftp = lease.entry.sftp.lock().await;
            for item in upload_items {
                let remote_path = required_remote_path(&item.remote_path)?;
                match sftp.try_exists(remote_path.clone()).await {
                    Ok(true) => conflicts.push(TransferConflict {
                        direction: item.direction,
                        path: remote_path,
                    }),
                    Ok(false) => {}
                    Err(error) => {
                        self.cache.remove_key_if_entry(&lease.key, &lease.entry);
                        return Err(AppError::sftp(error.to_string()));
                    }
                }
            }
        }

        for item in items
            .iter()
            .filter(|item| item.direction == TransferDirection::Download)
        {
            let local_path = PathBuf::from(required_path(&item.local_path)?);
            if local_path.exists() {
                conflicts.push(TransferConflict {
                    direction: item.direction,
                    path: local_path.to_string_lossy().into_owned(),
                });
            }
        }

        Ok(conflicts)
    }

    async fn cached_sftp_session(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        secrets: &dyn SshCommandSecretResolver,
    ) -> AppResult<CachedSftpLease> {
        let execution =
            build_ssh_command_execution(session, all_sessions, "true".to_string(), secrets)?;
        let key = SftpCacheKey(
            reusable_connection_key_for_execution("sftp", &execution)
                .as_str()
                .to_string(),
        );
        let metadata = SftpSessionMetadata::from_execution(&execution);
        self.cache.prune_if_due();
        if let Some(entry) = self.cache.get(&key) {
            entry.touch();
            return Ok(CachedSftpLease { key, entry });
        }

        let connection = connect_sftp_execution(execution).await?;
        let entry = Arc::new(CachedSftpSession::new(metadata, connection));
        self.cache.insert(key.clone(), Arc::clone(&entry));
        Ok(CachedSftpLease { key, entry })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SftpOperationKind {
    CreateDir,
    Delete,
    Download,
    List,
    Rename,
    Upload,
}

pub fn sftp_uses_cached_session_for(operation: SftpOperationKind) -> bool {
    matches!(
        operation,
        SftpOperationKind::CreateDir
            | SftpOperationKind::Delete
            | SftpOperationKind::List
            | SftpOperationKind::Rename
    )
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SftpCacheKey(String);

impl SftpCacheKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SftpCacheKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SftpCacheKey")
            .field(&self.0)
            .finish()
    }
}

pub fn build_sftp_cache_key(session: &SavedSession) -> AppResult<SftpCacheKey> {
    if !matches!(session.session_type, SessionType::Ssh | SessionType::Sftp) {
        return Err(AppError::unsupported("SFTP 只支持 SSH/SFTP 会话"));
    }
    let host = required_path(&session.host)?;
    let username = required_path(&session.username)?;
    let ssh_options = session.ssh_options.as_ref();
    let mut fields = vec![
        sftp_cache_field("session_id", &session.id),
        sftp_cache_field("updated_at_ms", &session.updated_at_ms.to_string()),
        sftp_cache_field("host", &host),
        sftp_cache_field("port", &session.port.to_string()),
        sftp_cache_field("username", &username),
        sftp_cache_field("auth_mode", session.auth_mode.as_str()),
        sftp_cache_field(
            "credential_ref",
            session.credential_ref.as_deref().unwrap_or(""),
        ),
        sftp_cache_field(
            "identity_file",
            ssh_options
                .and_then(|options| options.identity_file.as_deref())
                .unwrap_or(""),
        ),
        sftp_cache_field(
            "connect_timeout_ms",
            &ssh_options
                .and_then(|options| options.connect_timeout_ms)
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        sftp_cache_field(
            "keepalive_interval_ms",
            &ssh_options
                .and_then(|options| options.keepalive_interval_ms)
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
    ];
    if let Some(options) = ssh_options {
        for (index, jump_host) in options.jump_hosts.iter().enumerate() {
            fields.push(sftp_cache_field(&format!("jump_{index}"), jump_host));
        }
        fields.push(sftp_cache_field(
            "proxy_command",
            options.proxy_command.as_deref().unwrap_or(""),
        ));
    }
    Ok(SftpCacheKey(fields.join("\u{1f}")))
}

fn sftp_cache_field(label: &str, value: &str) -> String {
    format!("{label}:{}:{value}", value.len())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SftpSessionMetadata {
    ssh: SshReusableConnectionMetadata,
}

impl SftpSessionMetadata {
    fn from_execution(
        execution: &crate::services::ssh_command_service::SshCommandExecution,
    ) -> Self {
        Self {
            ssh: reusable_connection_metadata_for_execution(execution),
        }
    }

    fn matches_credential_ref(&self, credential_ref: &str) -> bool {
        self.ssh.matches_credential_ref(credential_ref)
    }

    fn matches_session_id(&self, session_id: &str) -> bool {
        self.ssh.matches_session_id(session_id)
    }
}

struct SftpSessionCache {
    entries: Mutex<HashMap<SftpCacheKey, Arc<CachedSftpSession>>>,
    last_pruned: Mutex<Instant>,
}

impl SftpSessionCache {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            last_pruned: Mutex::new(Instant::now()),
        }
    }

    fn get(&self, key: &SftpCacheKey) -> Option<Arc<CachedSftpSession>> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(key).cloned())
    }

    fn insert(&self, key: SftpCacheKey, entry: Arc<CachedSftpSession>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key, entry);
            prune_sftp_entries(&mut entries, Instant::now());
        }
    }

    fn prune_if_due(&self) {
        let Ok(mut last_pruned) = self.last_pruned.lock() else {
            return;
        };
        if last_pruned.elapsed() < SFTP_CACHE_PRUNE_INTERVAL {
            return;
        }
        *last_pruned = Instant::now();
        drop(last_pruned);

        if let Ok(mut entries) = self.entries.lock() {
            prune_sftp_entries(&mut entries, Instant::now());
        }
    }

    fn remove_key_if_entry(&self, key: &SftpCacheKey, entry: &Arc<CachedSftpSession>) {
        if let Ok(mut entries) = self.entries.lock() {
            if entries
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                entries.remove(key);
            }
        }
    }

    fn remove_matching(&self, mut predicate: impl FnMut(&SftpSessionMetadata) -> bool) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, entry| !predicate(&entry.metadata));
        }
    }
}

struct CachedSftpLease {
    entry: Arc<CachedSftpSession>,
    key: SftpCacheKey,
}

struct CachedSftpSession {
    _connection: SshConnectionChain,
    last_used: Mutex<Instant>,
    metadata: SftpSessionMetadata,
    sftp: AsyncMutex<RusshSftpSession>,
}

impl CachedSftpSession {
    fn new(metadata: SftpSessionMetadata, connection: ConnectedSftpSession) -> Self {
        Self {
            _connection: connection.connection,
            last_used: Mutex::new(Instant::now()),
            metadata,
            sftp: AsyncMutex::new(connection.sftp),
        }
    }

    fn last_used(&self) -> Instant {
        self.last_used
            .lock()
            .map(|last_used| *last_used)
            .unwrap_or_else(|_| Instant::now())
    }

    fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }
}

fn prune_sftp_entries(entries: &mut HashMap<SftpCacheKey, Arc<CachedSftpSession>>, now: Instant) {
    entries.retain(|_, entry| now.duration_since(entry.last_used()) <= SFTP_CACHE_IDLE_TTL);
    if entries.len() <= SFTP_CACHE_MAX_ENTRIES {
        return;
    }

    let mut ranked = entries
        .iter()
        .map(|(key, entry)| (key.clone(), entry.last_used()))
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(_, last_used)| *last_used);
    let remove_count = entries.len() - SFTP_CACHE_MAX_ENTRIES;
    for (key, _) in ranked.into_iter().take(remove_count) {
        entries.remove(&key);
    }
}

fn should_retry_sftp_list_error(error: &AppError) -> bool {
    matches!(error, AppError::Ssh(_) | AppError::Sftp(_))
}

pub fn validate_delete_request(path: &str, is_directory: bool, recursive: bool) -> AppResult<()> {
    let _ = validate_destructive_remote_path(path)?;
    if is_directory && !recursive {
        return Err(AppError::validation(
            "删除文件夹必须显式传入 recursive=true",
        ));
    }
    Ok(())
}

pub fn validate_destructive_remote_path(path: &str) -> AppResult<String> {
    let path = required_remote_path(path)?;
    if path == "/" {
        return Err(AppError::validation("不允许对远程根目录执行该操作"));
    }
    Ok(path)
}

pub fn classify_local_paths(paths: Vec<String>) -> AppResult<Vec<LocalPathInfo>> {
    if paths.is_empty() {
        return Err(AppError::validation("请至少选择一个本地路径"));
    }
    paths
        .into_iter()
        .map(|path| {
            let path = required_path(&path)?;
            let metadata = std::fs::metadata(&path)?;
            let kind = if metadata.is_file() {
                TransferKind::File
            } else if metadata.is_dir() {
                TransferKind::Directory
            } else {
                return Err(AppError::validation(format!(
                    "暂不支持该本地路径类型: {path}"
                )));
            };
            Ok(LocalPathInfo { path, kind })
        })
        .collect()
}

pub async fn local_path_total_bytes(path: &str) -> AppResult<u64> {
    let path = PathBuf::from(required_path(path)?);
    let metadata = fs::metadata(&path).await?;
    if metadata.is_file() {
        return Ok(metadata.len());
    }

    let mut total = 0_u64;
    let mut stack = vec![path];
    while let Some(dir) = stack.pop() {
        let mut entries = fs::read_dir(dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let metadata = entry.metadata().await?;
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

pub fn default_local_directory() -> AppResult<String> {
    dirs::home_dir()
        .or_else(dirs::download_dir)
        .unwrap_or_else(std::env::temp_dir)
        .to_str()
        .map(|value| value.to_string())
        .ok_or_else(|| AppError::validation("无法解析默认本地目录"))
}

pub fn local_root_directories() -> AppResult<Vec<String>> {
    #[cfg(windows)]
    {
        let roots = (b'A'..=b'Z')
            .map(char::from)
            .map(|letter| format!("{letter}:\\"))
            .filter(|root| Path::new(root).is_dir())
            .collect();
        Ok(roots)
    }

    #[cfg(not(windows))]
    {
        Ok(vec!["/".to_string()])
    }
}

pub async fn list_local_directory(path: &str) -> AppResult<Vec<FileEntry>> {
    let path = if path.trim().is_empty() {
        default_local_directory()?
    } else {
        required_path(path)?
    };
    let mut entries = fs::read_dir(PathBuf::from(&path)).await?;
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        let symlink_metadata = fs::symlink_metadata(entry.path()).await.ok();
        let file_type = symlink_metadata
            .as_ref()
            .map(|metadata| metadata.file_type())
            .unwrap_or_else(|| metadata.file_type());
        let modified_at_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|duration| i64::try_from(duration.as_millis()).ok());
        result.push(FileEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            kind: local_file_kind(file_type),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_at_ms,
            permissions: None,
        });
    }
    result.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(result)
}

pub async fn rename_local_path(from: &str, to: &str) -> AppResult<()> {
    let from = validate_destructive_local_path(from)?;
    let to = validate_destructive_local_path(to)?;
    if from.parent() != to.parent() {
        return Err(AppError::validation("重命名后的路径必须位于原目录"));
    }
    fs::rename(from, to).await?;
    Ok(())
}

pub async fn delete_local_path(path: &str, recursive: bool) -> AppResult<()> {
    let path = validate_destructive_local_path(path)?;
    let metadata = fs::symlink_metadata(&path).await?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).await?;
    } else if recursive {
        fs::remove_dir_all(path).await?;
    } else {
        fs::remove_dir(path).await?;
    }
    Ok(())
}

fn validate_destructive_local_path(path: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(required_path(path)?);
    if !path.is_absolute() {
        return Err(AppError::validation("本机文件操作必须使用绝对路径"));
    }
    if path.parent().is_none() {
        return Err(AppError::validation("不允许对本机根目录执行该操作"));
    }
    Ok(path)
}

async fn connect_sftp(
    session: &SavedSession,
    all_sessions: &[SavedSession],
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<ConnectedSftpSession> {
    if !matches!(session.session_type, SessionType::Ssh | SessionType::Sftp) {
        return Err(AppError::unsupported("SFTP 只支持 SSH/SFTP 会话"));
    }
    let execution =
        build_ssh_command_execution(session, all_sessions, "true".to_string(), secrets)?;
    connect_sftp_execution(execution).await
}

async fn connect_sftp_execution(
    execution: crate::services::ssh_command_service::SshCommandExecution,
) -> AppResult<ConnectedSftpSession> {
    let connection = connect_chain(&execution).await?;
    let channel = match connection.open_session_channel().await {
        Ok(channel) => channel,
        Err(error) => {
            connection.disconnect("sftp open session failed").await;
            return Err(error);
        }
    };
    if let Err(error) = channel.request_subsystem(true, "sftp").await {
        connection.disconnect("sftp subsystem failed").await;
        return Err(AppError::sftp(error.to_string()));
    }
    let sftp =
        match RusshSftpSession::new_with_config(channel.into_stream(), bulk_transfer_sftp_config())
            .await
        {
            Ok(sftp) => sftp,
            Err(error) => {
                connection.disconnect("sftp session failed").await;
                return Err(AppError::sftp(error.to_string()));
            }
        };
    Ok(ConnectedSftpSession { connection, sftp })
}

struct ConnectedSftpSession {
    connection: SshConnectionChain,
    sftp: RusshSftpSession,
}

impl ConnectedSftpSession {
    async fn close(self, message: &str) {
        let _ = self.sftp.close().await;
        self.connection.disconnect(message).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        bulk_transfer_sftp_config, delete_local_path, rename_local_path,
        should_retry_sftp_list_error, validate_destructive_local_path, TransferProgressWriter,
        SFTP_MAX_INFLIGHT_REQUESTS,
    };
    use crate::{error::AppError, services::transfer_queue::TransferRunControl};
    use std::{io::ErrorKind, time::Duration};
    use tokio::io::AsyncWriteExt;

    #[test]
    fn retries_only_transient_ssh_and_sftp_directory_errors() {
        assert!(should_retry_sftp_list_error(&AppError::ssh(
            "connection reset"
        )));
        assert!(should_retry_sftp_list_error(&AppError::sftp(
            "channel closed"
        )));
        assert!(!should_retry_sftp_list_error(&AppError::credential(
            "invalid password"
        )));
        assert!(!should_retry_sftp_list_error(&AppError::validation(
            "invalid path"
        )));
    }

    #[test]
    fn bulk_transfer_config_uses_a_large_sftp_request_window() {
        let config = bulk_transfer_sftp_config();

        assert_eq!(config.max_concurrent_writes, SFTP_MAX_INFLIGHT_REQUESTS);
        assert_eq!(config.max_concurrent_writes, 64);
    }

    #[tokio::test]
    async fn pipelined_writer_preserves_pause_resume_and_cancel() {
        let control = TransferRunControl::new();
        let mut output = tokio::io::sink();
        let mut updates = Vec::new();
        let mut on_progress = |update: super::TransferProgressUpdate| {
            updates.push(update.transferred_bytes);
            Ok(())
        };

        control.pause();
        let mut writer =
            TransferProgressWriter::new(&mut output, 0, Some(&control), &mut on_progress);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), writer.write_all(b"abc"))
                .await
                .is_err()
        );

        control.resume();
        writer.write_all(b"abc").await.expect("transfer resumes");
        control.cancel();
        let error = writer
            .write_all(b"d")
            .await
            .expect_err("cancelled transfer stops before another write");
        assert_eq!(error.kind(), ErrorKind::Interrupted);
        drop(writer);
        assert_eq!(updates, vec![3]);
    }

    #[tokio::test]
    async fn renames_and_deletes_local_files_and_directories() {
        let root =
            std::env::temp_dir().join(format!("zterm-local-file-ops-{}", uuid::Uuid::new_v4()));
        let original = root.join("original.txt");
        let renamed = root.join("renamed.txt");
        let directory = root.join("nested");
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("create test directory");
        tokio::fs::write(&original, b"data")
            .await
            .expect("create test file");
        tokio::fs::write(directory.join("child.txt"), b"data")
            .await
            .expect("create nested test file");

        rename_local_path(&original.to_string_lossy(), &renamed.to_string_lossy())
            .await
            .expect("rename local file");
        assert!(!original.exists());
        assert!(renamed.exists());

        delete_local_path(&renamed.to_string_lossy(), false)
            .await
            .expect("delete local file");
        assert!(!renamed.exists());
        assert!(delete_local_path(&directory.to_string_lossy(), false)
            .await
            .is_err());
        delete_local_path(&directory.to_string_lossy(), true)
            .await
            .expect("delete local directory recursively");
        assert!(!directory.exists());

        tokio::fs::remove_dir(root).await.expect("remove test root");
    }

    #[test]
    fn rejects_local_root_paths() {
        #[cfg(windows)]
        let root = r"C:\";
        #[cfg(not(windows))]
        let root = "/";
        assert!(validate_destructive_local_path(root).is_err());
        assert!(validate_destructive_local_path("relative/file.txt").is_err());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SftpAuthMaterial {
    Agent,
    None,
    Password(String),
    PrivateKey {
        identity_file: PathBuf,
        passphrase: Option<String>,
    },
}

pub fn build_sftp_auth_material(session: &SavedSession) -> AppResult<SftpAuthMaterial> {
    match session.auth_mode {
        AuthMode::Password => {
            let credential_ref = session
                .credential_ref
                .as_deref()
                .ok_or_else(|| AppError::credential("SSH 密码凭据引用不能为空"))?;
            Ok(SftpAuthMaterial::Password(read_system_secret(
                credential_ref,
            )?))
        }
        AuthMode::None => Ok(SftpAuthMaterial::None),
        AuthMode::Key => {
            let identity_file = session
                .ssh_options
                .as_ref()
                .and_then(|options| options.identity_file.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::validation("密钥认证需要 ssh_options.identity_file"))?;
            if identity_file.contains('\n')
                || identity_file.contains('\r')
                || identity_file.contains('\0')
            {
                return Err(AppError::validation("identity_file 不能包含控制字符"));
            }
            let passphrase = session
                .credential_ref
                .as_deref()
                .map(read_system_secret)
                .transpose()?;
            Ok(SftpAuthMaterial::PrivateKey {
                identity_file: PathBuf::from(identity_file),
                passphrase,
            })
        }
        AuthMode::Agent => Ok(SftpAuthMaterial::Agent),
    }
}

async fn upload_file<F>(
    sftp: &RusshSftpSession,
    local_path: &Path,
    remote_path: &str,
    conflict_policy: TransferConflictPolicy,
    mut transferred: u64,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    transfer_checkpoint(control).await?;
    let mut local = fs::File::open(local_path).await?;
    if let Some(parent) = remote_parent_path(remote_path) {
        create_remote_dir_all(sftp, &parent).await?;
    }
    let file_size = fs::metadata(local_path).await?.len();
    let Some(mut remote) = open_remote_write_target(sftp, remote_path, conflict_policy).await?
    else {
        transferred = transferred.saturating_add(file_size);
        on_progress(progress_update(transferred, None))?;
        return Ok(transferred);
    };
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    loop {
        transfer_checkpoint(control).await?;
        let read = local.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        transfer_checkpoint(control).await?;
        remote
            .write_all(&buffer[..read])
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        transferred = transferred.saturating_add(read as u64);
        on_progress(progress_update(transferred, None))?;
    }
    transfer_checkpoint(control).await?;
    remote
        .shutdown()
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    Ok(transferred)
}

async fn download_file<F>(
    sftp: &RusshSftpSession,
    remote_path: &str,
    local_path: &Path,
    conflict_policy: TransferConflictPolicy,
    mut transferred: u64,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    transfer_checkpoint(control).await?;
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut remote = sftp
        .open(remote_path.to_string())
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    let remote_size = remote
        .metadata()
        .await
        .ok()
        .and_then(|metadata| metadata.size);
    if let Some(remote_size) = remote_size {
        on_progress(progress_update(
            transferred,
            Some(transferred.saturating_add(remote_size)),
        ))?;
    }
    let Some(mut local) = open_local_write_target(local_path, conflict_policy).await? else {
        transferred = transferred.saturating_add(remote_size.unwrap_or(0));
        on_progress(progress_update(transferred, Some(transferred)))?;
        return Ok(transferred);
    };
    let mut writer = TransferProgressWriter::new(&mut local, transferred, control, on_progress);
    remote
        .read_to_writer_pipelined(&mut writer, SFTP_MAX_INFLIGHT_REQUESTS)
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    transferred = writer.transferred_bytes();
    drop(writer);
    transfer_checkpoint(control).await?;
    local.flush().await?;
    Ok(transferred)
}

#[allow(clippy::too_many_arguments)]
async fn copy_remote_file<F>(
    source_sftp: &RusshSftpSession,
    destination_sftp: &RusshSftpSession,
    source_path: &str,
    destination_path: &str,
    conflict_policy: TransferConflictPolicy,
    mut transferred: u64,
    control: Option<&TransferRunControl>,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(TransferProgressUpdate) -> AppResult<()>,
{
    transfer_checkpoint(control).await?;
    if let Some(parent) = remote_parent_path(destination_path) {
        create_remote_dir_all(destination_sftp, &parent).await?;
    }
    let mut source = source_sftp
        .open(source_path.to_string())
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    let remote_size = source
        .metadata()
        .await
        .ok()
        .and_then(|metadata| metadata.size);
    if let Some(remote_size) = remote_size {
        on_progress(progress_update(
            transferred,
            Some(transferred.saturating_add(remote_size)),
        ))?;
    }
    let Some(mut destination) =
        open_remote_write_target(destination_sftp, destination_path, conflict_policy).await?
    else {
        transferred = transferred.saturating_add(remote_size.unwrap_or(0));
        on_progress(progress_update(transferred, Some(transferred)))?;
        return Ok(transferred);
    };
    let mut writer =
        TransferProgressWriter::new(&mut destination, transferred, control, on_progress);
    source
        .read_to_writer_pipelined(&mut writer, SFTP_MAX_INFLIGHT_REQUESTS)
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    transferred = writer.transferred_bytes();
    drop(writer);
    transfer_checkpoint(control).await?;
    destination
        .shutdown()
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    Ok(transferred)
}

async fn remove_remote_dir_recursive(sftp: &RusshSftpSession, root: &str) -> AppResult<()> {
    let mut stack = vec![root.to_string()];
    let mut directories = vec![root.to_string()];
    while let Some(path) = stack.pop() {
        let entries = sftp
            .read_dir(path.clone())
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        for entry in entries {
            let entry_path = entry.path();
            if entry.metadata().file_type().is_dir() {
                directories.push(entry_path.clone());
                stack.push(entry_path);
            } else {
                sftp.remove_file(entry_path)
                    .await
                    .map_err(|error| AppError::sftp(error.to_string()))?;
            }
        }
    }

    for directory in directories.into_iter().rev() {
        sftp.remove_dir(directory)
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
    }
    Ok(())
}

async fn create_remote_dir_all(sftp: &RusshSftpSession, path: &str) -> AppResult<()> {
    let mut current = String::new();
    for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        current.push('/');
        current.push_str(segment);
        if !sftp
            .try_exists(current.clone())
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?
        {
            sftp.create_dir(current.clone())
                .await
                .map_err(|error| AppError::sftp(error.to_string()))?;
        }
    }
    Ok(())
}

async fn ensure_remote_directory(sftp: &RusshSftpSession, path: &str) -> AppResult<()> {
    match sftp.create_dir(path.to_string()).await {
        Ok(()) => Ok(()),
        Err(error) if is_already_exists_error(&error.to_string()) => Ok(()),
        Err(error) => Err(AppError::sftp(error.to_string())),
    }
}

async fn prepare_remote_directory_root(
    sftp: &RusshSftpSession,
    remote_path: &str,
    conflict_policy: TransferConflictPolicy,
) -> AppResult<Option<String>> {
    match conflict_policy {
        TransferConflictPolicy::Overwrite => {
            create_remote_dir_all(sftp, remote_path).await?;
            Ok(Some(remote_path.to_string()))
        }
        TransferConflictPolicy::Skip => match sftp.create_dir(remote_path.to_string()).await {
            Ok(()) => Ok(Some(remote_path.to_string())),
            Err(error) if is_already_exists_error(&error.to_string()) => Ok(None),
            Err(error) => Err(AppError::sftp(error.to_string())),
        },
        TransferConflictPolicy::Rename => {
            for candidate in remote_conflict_candidates(remote_path).take(1000) {
                match sftp.create_dir(candidate.clone()).await {
                    Ok(()) => return Ok(Some(candidate)),
                    Err(error) if is_already_exists_error(&error.to_string()) => continue,
                    Err(error) => return Err(AppError::sftp(error.to_string())),
                }
            }
            Err(AppError::sftp(format!(
                "无法为远程目录生成不冲突的名称: {remote_path}"
            )))
        }
    }
}

async fn prepare_local_directory_root(
    local_path: &Path,
    conflict_policy: TransferConflictPolicy,
) -> AppResult<Option<PathBuf>> {
    match conflict_policy {
        TransferConflictPolicy::Overwrite => {
            fs::create_dir_all(local_path).await?;
            Ok(Some(local_path.to_path_buf()))
        }
        TransferConflictPolicy::Skip if fs::try_exists(local_path).await? => Ok(None),
        TransferConflictPolicy::Skip => {
            fs::create_dir_all(local_path).await?;
            Ok(Some(local_path.to_path_buf()))
        }
        TransferConflictPolicy::Rename => {
            for candidate in local_conflict_candidates(local_path).take(1000) {
                match fs::create_dir(&candidate).await {
                    Ok(()) => return Ok(Some(candidate)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error.into()),
                }
            }
            Err(AppError::sftp(format!(
                "无法为本地目录生成不冲突的名称: {}",
                local_path.display()
            )))
        }
    }
}

async fn open_remote_write_target(
    sftp: &RusshSftpSession,
    remote_path: &str,
    conflict_policy: TransferConflictPolicy,
) -> AppResult<Option<SftpFile>> {
    match conflict_policy {
        TransferConflictPolicy::Overwrite => sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await
            .map(Some)
            .map_err(|error| AppError::sftp(error.to_string())),
        TransferConflictPolicy::Skip => match sftp
            .open_with_flags(
                remote_path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
        {
            Ok(file) => Ok(Some(file)),
            Err(error) if is_already_exists_error(&error.to_string()) => Ok(None),
            Err(error) => Err(AppError::sftp(error.to_string())),
        },
        TransferConflictPolicy::Rename => {
            for candidate in remote_conflict_candidates(remote_path).take(1000) {
                match sftp
                    .open_with_flags(
                        candidate,
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                    )
                    .await
                {
                    Ok(file) => return Ok(Some(file)),
                    Err(error) if is_already_exists_error(&error.to_string()) => continue,
                    Err(error) => return Err(AppError::sftp(error.to_string())),
                }
            }
            Err(AppError::sftp(format!(
                "无法为远程文件生成不冲突的名称: {remote_path}"
            )))
        }
    }
}

async fn open_local_write_target(
    local_path: &Path,
    conflict_policy: TransferConflictPolicy,
) -> AppResult<Option<fs::File>> {
    match conflict_policy {
        TransferConflictPolicy::Overwrite => fs::File::create(local_path)
            .await
            .map(Some)
            .map_err(Into::into),
        TransferConflictPolicy::Skip => match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(local_path)
            .await
        {
            Ok(file) => Ok(Some(file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(None),
            Err(error) => Err(error.into()),
        },
        TransferConflictPolicy::Rename => {
            for candidate in local_conflict_candidates(local_path).take(1000) {
                match fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(candidate)
                    .await
                {
                    Ok(file) => return Ok(Some(file)),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(error.into()),
                }
            }
            Err(AppError::sftp(format!(
                "无法为本地文件生成不冲突的名称: {}",
                local_path.display()
            )))
        }
    }
}

fn remote_conflict_candidates(remote_path: &str) -> impl Iterator<Item = String> + '_ {
    std::iter::once(remote_path.to_string()).chain((1..).map(move |index| {
        let parent = remote_parent_path(remote_path).unwrap_or_else(|| "/".to_string());
        let name = remote_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("file");
        join_remote_path(&parent, &numbered_conflict_candidate_name(name, index))
    }))
}

fn local_conflict_candidates(local_path: &Path) -> impl Iterator<Item = PathBuf> + '_ {
    std::iter::once(local_path.to_path_buf()).chain((1..).map(move |index| {
        let name = local_path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("file");
        let candidate = numbered_conflict_candidate_name(name, index);
        local_path
            .parent()
            .map(|parent| parent.join(&candidate))
            .unwrap_or_else(|| PathBuf::from(candidate))
    }))
}

pub fn numbered_conflict_candidate_name(name: &str, index: usize) -> String {
    let name = if name.trim().is_empty() {
        "file"
    } else {
        name.trim()
    };
    let Some(dot_index) = name.rfind('.') else {
        return format!("{name} ({index})");
    };
    if dot_index == 0 {
        return format!("{name} ({index})");
    }
    let (stem, extension) = name.split_at(dot_index);
    format!("{stem} ({index}){extension}")
}

fn file_entry(name: String, path: String, metadata: FileAttributes) -> FileEntry {
    FileEntry {
        name,
        path,
        kind: file_kind(metadata.file_type()),
        size: metadata.size.unwrap_or(0),
        modified_at_ms: metadata.mtime.map(|mtime| i64::from(mtime) * 1000),
        permissions: metadata
            .permissions
            .map(|mode| format!("{:03o}", mode & 0o777)),
    }
}

fn file_kind(file_type: FileType) -> FileKind {
    if file_type.is_dir() {
        FileKind::Directory
    } else if file_type.is_file() {
        FileKind::File
    } else if file_type.is_symlink() {
        FileKind::Symlink
    } else {
        FileKind::Other
    }
}

fn local_file_kind(file_type: std::fs::FileType) -> FileKind {
    if file_type.is_dir() {
        FileKind::Directory
    } else if file_type.is_file() {
        FileKind::File
    } else if file_type.is_symlink() {
        FileKind::Symlink
    } else {
        FileKind::Other
    }
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn remote_parent_path(path: &str) -> Option<String> {
    let normalized = path.trim_end_matches('/');
    let index = normalized.rfind('/')?;
    if index == 0 {
        Some("/".to_string())
    } else {
        Some(normalized[..index].to_string())
    }
}

fn is_already_exists_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("already exists")
        || message.contains("file exists")
        || message.contains("exists")
}

fn required_remote_path(value: &str) -> AppResult<String> {
    let mut value = required_path(value)?;
    while value.len() > 1 && value.ends_with('/') {
        value.pop();
    }
    if value.is_empty() {
        return Err(AppError::validation("路径不能为空"));
    }
    Ok(value)
}

fn required_path(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::validation("路径不能为空"));
    }
    Ok(value.replace('\\', "/"))
}
