// Author: Liz
use std::{
    collections::HashMap,
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use russh::keys::{load_secret_key, PrivateKey, PrivateKeyWithHashAlg};
use russh::{client, keys::ssh_key, ChannelId};
use russh_sftp::{
    client::fs::File as SftpFile,
    client::SftpSession as RusshSftpSession,
    protocol::{FileAttributes, FileType, OpenFlags},
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
        sftp::{
            FileEntry, FileKind, LocalPathInfo, TransferConflict, TransferConflictCheckItem,
            TransferConflictPolicy, TransferDirection, TransferKind,
        },
    },
    services::{credential_service::read_system_secret, transfer_queue::TransferRunControl},
};

const TRANSFER_BUFFER_SIZE: usize = 64 * 1024;
const SFTP_CACHE_IDLE_TTL: Duration = Duration::from_secs(90);
const SFTP_CACHE_PRUNE_INTERVAL: Duration = Duration::from_secs(30);
const SFTP_CACHE_MAX_ENTRIES: usize = 8;

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

async fn transfer_checkpoint(control: Option<&TransferRunControl>) -> AppResult<()> {
    if let Some(control) = control {
        control.checkpoint().await?;
    }
    Ok(())
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

    pub async fn list(&self, session: &SavedSession, path: &str) -> AppResult<Vec<FileEntry>> {
        let path = required_remote_path(path)?;
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
        let path = validate_destructive_remote_path(path)?;
        let lease = self.cached_sftp_session(session).await?;
        let sftp = lease.entry.sftp.lock().await;
        create_remote_dir_all(&sftp, &path).await.map_err(|error| {
            self.cache.remove_key_if_entry(&lease.key, &lease.entry);
            error
        })
    }

    pub async fn rename(&self, session: &SavedSession, from: &str, to: &str) -> AppResult<()> {
        let from = validate_destructive_remote_path(from)?;
        let to = validate_destructive_remote_path(to)?;
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
        let path = validate_destructive_remote_path(path)?;
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
        let sftp = connect_sftp(session).await?;
        let mut transferred = 0_u64;
        transfer_checkpoint(control.as_ref()).await?;

        if metadata.is_dir() {
            let total_bytes = local_path_total_bytes(local_path.to_string_lossy().as_ref()).await?;
            let Some(remote_root) =
                prepare_remote_directory_root(&sftp, &remote_path, conflict_policy).await?
            else {
                transferred = transferred.saturating_add(total_bytes);
                on_progress(progress_update(transferred, None))?;
                let _ = sftp.close().await;
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
                        ensure_remote_directory(&sftp, &remote_entry).await?;
                        stack.push((entry_path, remote_entry));
                    } else {
                        transferred = upload_file(
                            &sftp,
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
                &sftp,
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
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn download_path<F>(
        &self,
        session: &SavedSession,
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
        let sftp = connect_sftp(session).await?;
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
                let _ = sftp.close().await;
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
                            &sftp,
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
                &sftp,
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
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn check_transfer_conflicts(
        &self,
        session: &SavedSession,
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
            let lease = self.cached_sftp_session(session).await?;
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
    let auth_material = build_sftp_auth_material(session)?;
    let authenticated = match auth_material {
        SftpAuthMaterial::Password(password) => handle
            .authenticate_password(session.username.clone(), password)
            .await
            .map_err(|error| AppError::credential(error.to_string()))?
            .success(),
        SftpAuthMaterial::None => handle
            .authenticate_none(session.username.clone())
            .await
            .map_err(|error| AppError::credential(error.to_string()))?
            .success(),
        SftpAuthMaterial::PrivateKey {
            identity_file,
            passphrase,
        } => {
            let key = load_secret_key(&identity_file, passphrase.as_deref())
                .map_err(|error| AppError::credential(format!("SSH 私钥解析失败: {error}")))?;
            authenticate_private_key(handle, session.username.clone(), key).await?
        }
    };

    if !authenticated {
        return Err(AppError::credential("SSH 认证失败"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SftpAuthMaterial {
    None,
    Password(String),
    PrivateKey {
        identity_file: PathBuf,
        passphrase: Option<String>,
    },
}

pub fn build_sftp_auth_material(session: &SavedSession) -> AppResult<SftpAuthMaterial> {
    if let Some(options) = session.ssh_options.as_ref() {
        if options
            .proxy_command
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(AppError::unsupported("SFTP 暂不支持 ProxyCommand"));
        }
        if options
            .jump_hosts
            .iter()
            .any(|host| !host.trim().is_empty())
        {
            return Err(AppError::unsupported("SFTP 暂不支持跳板机"));
        }
    }

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
        AuthMode::Agent => Err(AppError::unsupported("SFTP 暂不支持 agent 认证")),
    }
}

async fn authenticate_private_key(
    handle: &mut client::Handle<AcceptAnyServerKey>,
    username: String,
    key: PrivateKey,
) -> AppResult<bool> {
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|error| AppError::sftp(error.to_string()))?
        .flatten();
    handle
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(|error| AppError::credential(error.to_string()))
        .map(|result| result.success())
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
    let mut buffer = vec![0_u8; TRANSFER_BUFFER_SIZE];
    loop {
        transfer_checkpoint(control).await?;
        let read = remote
            .read(&mut buffer)
            .await
            .map_err(|error| AppError::sftp(error.to_string()))?;
        if read == 0 {
            break;
        }
        transfer_checkpoint(control).await?;
        local.write_all(&buffer[..read]).await?;
        transferred = transferred.saturating_add(read as u64);
        on_progress(progress_update(transferred, None))?;
    }
    transfer_checkpoint(control).await?;
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
