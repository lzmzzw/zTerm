// Author: Liz
use std::{
    collections::HashMap,
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use russh::{client, keys::ssh_key, ChannelId};
use russh_sftp::{
    client::SftpSession as RusshSftpSession,
    protocol::{FileAttributes, FileType},
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex as AsyncMutex,
};

use crate::{
    error::{AppError, AppResult},
    models::{
        session::{AuthMode, SavedSession, SessionType},
        sftp::{FileEntry, FileKind},
    },
    services::credential_service::read_system_secret,
};

const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const SFTP_CACHE_IDLE_TTL: Duration = Duration::from_secs(90);
const SFTP_CACHE_PRUNE_INTERVAL: Duration = Duration::from_secs(30);
const SFTP_CACHE_MAX_ENTRIES: usize = 8;

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

    pub async fn list(&self, session: &SavedSession, path: &str) -> AppResult<Vec<FileEntry>> {
        let path = required_path(path)?;
        let lease = self.cached_sftp_session(session).await?;
        let sftp = lease.entry.sftp.lock().await;
        let mut entries = sftp
            .read_dir(path.clone())
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

    pub async fn create_dir(&self, session: &SavedSession, path: &str) -> AppResult<()> {
        let path = required_path(path)?;
        let lease = self.cached_sftp_session(session).await?;
        let sftp = lease.entry.sftp.lock().await;
        create_remote_dir_all(&sftp, &path).await.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            error
        })
    }

    pub async fn rename(&self, session: &SavedSession, from: &str, to: &str) -> AppResult<()> {
        let from = required_path(from)?;
        let to = required_path(to)?;
        let lease = self.cached_sftp_session(session).await?;
        let sftp = lease.entry.sftp.lock().await;
        sftp.rename(from, to).await.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            AppError::sftp(error.to_string())
        })
    }

    pub async fn delete(
        &self,
        session: &SavedSession,
        path: &str,
        recursive: bool,
    ) -> AppResult<()> {
        let path = required_path(path)?;
        let lease = self.cached_sftp_session(session).await?;
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
        result.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            error
        })
    }

    pub async fn upload_path<F>(
        &self,
        session: &SavedSession,
        local_path: &str,
        remote_path: &str,
        mut on_progress: F,
    ) -> AppResult<()>
    where
        F: FnMut(u64) -> AppResult<()>,
    {
        let local_path = PathBuf::from(required_path(local_path)?);
        let remote_path = required_path(remote_path)?;
        let metadata = fs::metadata(&local_path).await?;
        let sftp = connect_sftp(session).await?;
        let mut transferred = 0_u64;

        if metadata.is_dir() {
            create_remote_dir_all(&sftp, &remote_path).await?;
            let mut stack = vec![(local_path, remote_path)];
            while let Some((local_dir, remote_dir)) = stack.pop() {
                let mut entries = fs::read_dir(&local_dir).await?;
                while let Some(entry) = entries.next_entry().await? {
                    let entry_path = entry.path();
                    let entry_name = entry.file_name().to_string_lossy().to_string();
                    let remote_entry = join_remote_path(&remote_dir, &entry_name);
                    let entry_metadata = entry.metadata().await?;
                    if entry_metadata.is_dir() {
                        create_remote_dir_all(&sftp, &remote_entry).await?;
                        stack.push((entry_path, remote_entry));
                    } else {
                        transferred = upload_file(
                            &sftp,
                            &entry_path,
                            &remote_entry,
                            transferred,
                            &mut on_progress,
                        )
                        .await?;
                    }
                }
            }
        } else {
            transferred = upload_file(
                &sftp,
                &local_path,
                &remote_path,
                transferred,
                &mut on_progress,
            )
            .await?;
        }

        on_progress(transferred)?;
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn download_path<F>(
        &self,
        session: &SavedSession,
        remote_path: &str,
        local_path: &str,
        mut on_progress: F,
    ) -> AppResult<()>
    where
        F: FnMut(u64) -> AppResult<()>,
    {
        let remote_path = required_path(remote_path)?;
        let local_path = PathBuf::from(required_path(local_path)?);
        let sftp = connect_sftp(session).await?;
        let metadata = sftp
            .symlink_metadata(remote_path.clone())
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        let mut transferred = 0_u64;

        if metadata.file_type().is_dir() {
            fs::create_dir_all(&local_path).await?;
            let mut stack = vec![(remote_path, local_path)];
            while let Some((remote_dir, local_dir)) = stack.pop() {
                fs::create_dir_all(&local_dir).await?;
                let entries = sftp
                    .read_dir(remote_dir.clone())
                    .await
                    .map_err(|error| AppError::sftp(error.to_string()))?;
                for entry in entries {
                    let remote_entry = entry.path();
                    let local_entry = local_dir.join(entry.file_name());
                    if entry.metadata().file_type().is_dir() {
                        stack.push((remote_entry, local_entry));
                    } else {
                        transferred = download_file(
                            &sftp,
                            &remote_entry,
                            &local_entry,
                            transferred,
                            &mut on_progress,
                        )
                        .await?;
                    }
                }
            }
        } else {
            transferred = download_file(
                &sftp,
                &remote_path,
                &local_path,
                transferred,
                &mut on_progress,
            )
            .await?;
        }

        on_progress(transferred)?;
        let _ = sftp.close().await;
        Ok(())
    }

    async fn cached_sftp_session(&self, session: &SavedSession) -> AppResult<CachedSftpLease> {
        let key = build_sftp_cache_key(session)?;
        self.cache.prune_if_due();
        if let Some(entry) = self.cache.get(&key) {
            entry.touch();
            return Ok(CachedSftpLease { key, entry });
        }

        let sftp = connect_sftp(session).await?;
        let entry = Arc::new(CachedSftpSession::new(
            SftpSessionMetadata::from_session(session),
            sftp,
        ));
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
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported("SFTP 只支持 SSH 会话"));
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
    credential_ref: Option<String>,
    session_id: String,
}

impl SftpSessionMetadata {
    fn from_session(session: &SavedSession) -> Self {
        Self {
            credential_ref: session.credential_ref.clone(),
            session_id: session.id.clone(),
        }
    }

    fn matches_credential_ref(&self, credential_ref: &str) -> bool {
        let credential_ref = credential_ref.trim();
        !credential_ref.is_empty() && self.credential_ref.as_deref() == Some(credential_ref)
    }

    fn matches_session_id(&self, session_id: &str) -> bool {
        let session_id = session_id.trim();
        !session_id.is_empty() && self.session_id == session_id
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
    last_used: Mutex<Instant>,
    metadata: SftpSessionMetadata,
    sftp: AsyncMutex<RusshSftpSession>,
}

impl CachedSftpSession {
    fn new(metadata: SftpSessionMetadata, sftp: RusshSftpSession) -> Self {
        Self {
            last_used: Mutex::new(Instant::now()),
            metadata,
            sftp: AsyncMutex::new(sftp),
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

pub fn validate_delete_request(path: &str, is_directory: bool, recursive: bool) -> AppResult<()> {
    let _ = required_path(path)?;
    if is_directory && !recursive {
        return Err(AppError::validation(
            "删除文件夹必须显式传入 recursive=true",
        ));
    }
    Ok(())
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

async fn connect_sftp(session: &SavedSession) -> AppResult<RusshSftpSession> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported("SFTP 只支持 SSH 会话"));
    }

    let config = client::Config {
        inactivity_timeout: session
            .ssh_options
            .as_ref()
            .and_then(|options| options.connect_timeout_ms)
            .map(Duration::from_millis),
        keepalive_interval: session
            .ssh_options
            .as_ref()
            .and_then(|options| options.keepalive_interval_ms)
            .map(Duration::from_millis),
        ..Default::default()
    };

    let mut handle = client::connect(
        Arc::new(config),
        (session.host.as_str(), session.port),
        AcceptAnyServerKey,
    )
    .await
    .map_err(|error| AppError::sftp(error.to_string()))?;

    authenticate(&mut handle, session).await?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    RusshSftpSession::new(channel.into_stream())
        .await
        .map_err(|error| AppError::sftp(error.to_string()))
}

async fn authenticate(
    handle: &mut client::Handle<AcceptAnyServerKey>,
    session: &SavedSession,
) -> AppResult<()> {
    let authenticated = match session.auth_mode {
        AuthMode::Password => {
            let credential_ref = session
                .credential_ref
                .as_deref()
                .ok_or_else(|| AppError::credential("SSH 密码凭据引用不能为空"))?;
            let password = read_system_secret(credential_ref)?;
            handle
                .authenticate_password(session.username.clone(), password)
                .await
                .map_err(|error| AppError::credential(error.to_string()))?
                .success()
        }
        AuthMode::None => handle
            .authenticate_none(session.username.clone())
            .await
            .map_err(|error| AppError::credential(error.to_string()))?
            .success(),
        AuthMode::Key | AuthMode::Agent => {
            return Err(AppError::unsupported(
                "SFTP key/agent 认证将在凭据阶段补齐，请先使用 password 会话",
            ));
        }
    };

    if !authenticated {
        return Err(AppError::credential("SSH 认证失败"));
    }
    Ok(())
}

async fn upload_file<F>(
    sftp: &RusshSftpSession,
    local_path: &Path,
    remote_path: &str,
    mut transferred: u64,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(u64) -> AppResult<()>,
{
    let mut local = fs::File::open(local_path).await?;
    let mut remote = sftp
        .create(remote_path.to_string())
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    loop {
        let read = local.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        remote
            .write_all(&buffer[..read])
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        transferred = transferred.saturating_add(read as u64);
        on_progress(transferred)?;
    }
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
    mut transferred: u64,
    on_progress: &mut F,
) -> AppResult<u64>
where
    F: FnMut(u64) -> AppResult<()>,
{
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut remote = sftp
        .open(remote_path.to_string())
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?;
    let mut local = fs::File::create(local_path).await?;
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    loop {
        let read = remote
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        if read == 0 {
            break;
        }
        local.write_all(&buffer[..read]).await?;
        transferred = transferred.saturating_add(read as u64);
        on_progress(transferred)?;
    }
    local.flush().await?;
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

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn required_path(value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::validation("路径不能为空"));
    }
    Ok(value.replace('\\', "/"))
}

#[derive(Clone, Copy)]
struct AcceptAnyServerKey;

impl client::Handler for AcceptAnyServerKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        _data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}
