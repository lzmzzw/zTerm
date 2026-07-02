// Author: Liz
use std::{
    collections::HashMap,
    fmt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use russh::{
    client,
    keys::{
        self, agent::AgentIdentity, load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKey,
    },
    ChannelMsg,
};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex as AsyncMutex,
};

use crate::{
    error::{AppError, AppResult},
    models::session::{AuthMode, SavedSession, SessionType},
    services::credential_service::CredentialService,
};

const DEFAULT_TIMEOUT_SECONDS: u64 = 15;
const MIN_TIMEOUT_SECONDS: u64 = 1;
const MAX_TIMEOUT_SECONDS: u64 = 60;
const DEFAULT_OUTPUT_BYTES: usize = 128 * 1024;
const MIN_OUTPUT_BYTES: usize = 256;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;
const MAX_SCRIPT_CHARS: usize = 16 * 1024;
const REUSABLE_CONNECTION_IDLE_TTL: Duration = Duration::from_secs(90);
const REUSABLE_CONNECTION_PRUNE_INTERVAL: Duration = Duration::from_secs(30);
const REUSABLE_CONNECTION_MAX_ENTRIES: usize = 8;

pub trait SshCommandSecretResolver: Send + Sync {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String>;
}

impl SshCommandSecretResolver for CredentialService {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
        self.read_secret(credential_ref)
    }
}

#[derive(Clone)]
pub struct SshCommandService {
    reusable_cache: Arc<ReusableSshConnectionCache>,
}

impl Default for SshCommandService {
    fn default() -> Self {
        Self::new()
    }
}

impl SshCommandService {
    pub fn new() -> Self {
        Self {
            reusable_cache: Arc::new(ReusableSshConnectionCache::new()),
        }
    }

    pub async fn execute(
        &self,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        script: String,
        secrets: &dyn SshCommandSecretResolver,
    ) -> AppResult<SshCommandOutput> {
        let execution = build_ssh_command_execution(session, all_sessions, script, secrets)?;
        execute_ssh_command_execution(execution).await
    }

    pub async fn execute_reusable(
        &self,
        scope: &str,
        session: &SavedSession,
        all_sessions: &[SavedSession],
        script: String,
        secrets: &dyn SshCommandSecretResolver,
    ) -> AppResult<SshCommandOutput> {
        let execution = build_ssh_command_execution(session, all_sessions, script, secrets)?;
        self.execute_reusable_ssh_command_execution(scope, execution)
            .await
    }

    pub fn evict_reusable_connections_for_session(&self, session_id: &str) {
        self.reusable_cache
            .remove_matching(|metadata| metadata.matches_session_id(session_id));
    }

    pub fn evict_reusable_connections_for_credential(&self, credential_ref: &str) {
        self.reusable_cache
            .remove_matching(|metadata| metadata.matches_credential_ref(credential_ref));
    }

    async fn execute_reusable_ssh_command_execution(
        &self,
        scope: &str,
        execution: SshCommandExecution,
    ) -> AppResult<SshCommandOutput> {
        let started = Instant::now();
        let timeout = Duration::from_secs(execution.timeout_seconds);
        let key = reusable_connection_key_for_execution(scope, &execution);
        let metadata = reusable_connection_metadata_for_execution(&execution);
        let result = tokio::time::timeout(
            timeout,
            self.execute_reusable_ssh_command_inner(key.clone(), metadata, execution),
        )
        .await;

        match result {
            Ok(Ok(mut output)) => {
                output.duration_ms = started.elapsed().as_millis();
                Ok(output)
            }
            Ok(Err(error)) => Err(error),
            Err(_) => {
                self.reusable_cache.remove_key(&key);
                Err(AppError::ssh(format!(
                    "远程命令执行超时（{} 秒）",
                    timeout.as_secs()
                )))
            }
        }
    }

    async fn execute_reusable_ssh_command_inner(
        &self,
        key: SshReusableConnectionKey,
        metadata: SshReusableConnectionMetadata,
        execution: SshCommandExecution,
    ) -> AppResult<SshCommandOutput> {
        self.reusable_cache.prune_if_due();
        if let Some(entry) = self.reusable_cache.get(&key) {
            return match self
                .execute_with_cached_entry(Arc::clone(&entry), &execution)
                .await
            {
                Ok(output) => Ok(output),
                Err(error) => {
                    self.reusable_cache.remove_key_if_entry(&key, &entry);
                    Err(error)
                }
            };
        }

        let connection = connect_chain(&execution).await?;
        let entry = Arc::new(CachedSshConnection::new(metadata, connection));
        self.reusable_cache.insert(key.clone(), Arc::clone(&entry));
        match self
            .execute_with_cached_entry(Arc::clone(&entry), &execution)
            .await
        {
            Ok(output) => Ok(output),
            Err(error) => {
                self.reusable_cache.remove_key_if_entry(&key, &entry);
                Err(error)
            }
        }
    }

    async fn execute_with_cached_entry(
        &self,
        entry: Arc<CachedSshConnection>,
        execution: &SshCommandExecution,
    ) -> AppResult<SshCommandOutput> {
        entry.touch();
        let mut connection = entry.connection.lock().await;
        match execute_on_connection(&connection, execution).await {
            Ok(output) => Ok(output),
            Err(SshCommandRunError::BeforeWrite(_)) => {
                let replacement = connect_chain(execution).await?;
                let old_connection = std::mem::replace(&mut *connection, replacement);
                disconnect_chain(old_connection, "replaced").await;
                entry.touch();
                execute_on_connection(&connection, execution)
                    .await
                    .map_err(SshCommandRunError::into_app_error)
            }
            Err(error) => Err(error.into_app_error()),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SshReusableConnectionKey(String);

impl SshReusableConnectionKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SshReusableConnectionKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SshReusableConnectionKey")
            .field(&self.0)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshReusableConnectionMetadata {
    credential_refs: Vec<String>,
    session_ids: Vec<String>,
}

impl SshReusableConnectionMetadata {
    pub fn matches_credential_ref(&self, credential_ref: &str) -> bool {
        let credential_ref = credential_ref.trim();
        !credential_ref.is_empty()
            && self
                .credential_refs
                .iter()
                .any(|candidate| candidate == credential_ref)
    }

    pub fn matches_session_id(&self, session_id: &str) -> bool {
        let session_id = session_id.trim();
        !session_id.is_empty()
            && self
                .session_ids
                .iter()
                .any(|candidate| candidate == session_id)
    }
}

struct ReusableSshConnectionCache {
    entries: Mutex<HashMap<SshReusableConnectionKey, Arc<CachedSshConnection>>>,
    last_pruned: Mutex<Instant>,
}

impl ReusableSshConnectionCache {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            last_pruned: Mutex::new(Instant::now()),
        }
    }

    fn get(&self, key: &SshReusableConnectionKey) -> Option<Arc<CachedSshConnection>> {
        self.entries
            .lock()
            .ok()
            .and_then(|entries| entries.get(key).cloned())
    }

    fn insert(&self, key: SshReusableConnectionKey, entry: Arc<CachedSshConnection>) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.insert(key, entry);
            prune_ssh_entries(&mut entries, Instant::now());
        }
    }

    fn prune_if_due(&self) {
        let Ok(mut last_pruned) = self.last_pruned.lock() else {
            return;
        };
        if last_pruned.elapsed() < REUSABLE_CONNECTION_PRUNE_INTERVAL {
            return;
        }
        *last_pruned = Instant::now();
        drop(last_pruned);

        if let Ok(mut entries) = self.entries.lock() {
            prune_ssh_entries(&mut entries, Instant::now());
        }
    }

    fn remove_key(&self, key: &SshReusableConnectionKey) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.remove(key);
        }
    }

    fn remove_key_if_entry(
        &self,
        key: &SshReusableConnectionKey,
        entry: &Arc<CachedSshConnection>,
    ) {
        if let Ok(mut entries) = self.entries.lock() {
            if entries
                .get(key)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
            {
                entries.remove(key);
            }
        }
    }

    fn remove_matching(&self, mut predicate: impl FnMut(&SshReusableConnectionMetadata) -> bool) {
        if let Ok(mut entries) = self.entries.lock() {
            entries.retain(|_, entry| !predicate(&entry.metadata));
        }
    }
}

struct CachedSshConnection {
    connection: AsyncMutex<SshConnectionChain>,
    last_used: Mutex<Instant>,
    metadata: SshReusableConnectionMetadata,
}

impl CachedSshConnection {
    fn new(metadata: SshReusableConnectionMetadata, connection: SshConnectionChain) -> Self {
        Self {
            connection: AsyncMutex::new(connection),
            last_used: Mutex::new(Instant::now()),
            metadata,
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

fn prune_ssh_entries(
    entries: &mut HashMap<SshReusableConnectionKey, Arc<CachedSshConnection>>,
    now: Instant,
) {
    entries
        .retain(|_, entry| now.duration_since(entry.last_used()) <= REUSABLE_CONNECTION_IDLE_TTL);
    if entries.len() <= REUSABLE_CONNECTION_MAX_ENTRIES {
        return;
    }

    let mut ranked = entries
        .iter()
        .map(|(key, entry)| (key.clone(), entry.last_used()))
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(_, last_used)| *last_used);
    let remove_count = entries.len() - REUSABLE_CONNECTION_MAX_ENTRIES;
    for (key, _) in ranked.into_iter().take(remove_count) {
        entries.remove(&key);
    }
}

#[derive(Clone)]
pub struct SshCommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub success: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u128,
}

#[derive(Clone)]
pub struct SshCommandExecution {
    pub jumps: Vec<SshCommandHop>,
    pub max_output_bytes: usize,
    pub script: String,
    pub target: SshCommandHop,
    pub timeout_seconds: u64,
}

impl fmt::Debug for SshCommandExecution {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshCommandExecution")
            .field("jumps", &self.jumps)
            .field("max_output_bytes", &self.max_output_bytes)
            .field("script", &self.script)
            .field("target", &self.target)
            .field("timeout_seconds", &self.timeout_seconds)
            .finish()
    }
}

#[derive(Clone)]
pub struct SshCommandHop {
    auth: SshCommandAuth,
    auth_mode: AuthMode,
    connect_timeout_ms: Option<u64>,
    credential_ref: Option<String>,
    pub host: String,
    identity_file: Option<PathBuf>,
    keepalive_interval_ms: Option<u64>,
    pub port: u16,
    proxy_command: Option<String>,
    session_id: String,
    updated_at_ms: i64,
    pub username: String,
}

impl fmt::Debug for SshCommandHop {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SshCommandHop")
            .field("auth", &self.auth)
            .field("auth_mode", &self.auth_mode)
            .field("connect_timeout_ms", &self.connect_timeout_ms)
            .field("credential_ref", &self.credential_ref)
            .field("host", &self.host)
            .field("identity_file", &self.identity_file)
            .field("keepalive_interval_ms", &self.keepalive_interval_ms)
            .field("port", &self.port)
            .field("proxy_command", &self.proxy_command)
            .field("session_id", &self.session_id)
            .field("updated_at_ms", &self.updated_at_ms)
            .field("username", &self.username)
            .finish()
    }
}

#[derive(Clone)]
enum SshCommandAuth {
    Agent,
    None,
    Password(String),
    PrivateKey {
        identity_file: PathBuf,
        passphrase: Option<String>,
    },
}

impl fmt::Debug for SshCommandAuth {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Agent => formatter.write_str("Agent"),
            Self::None => formatter.write_str("None"),
            Self::Password(_) => formatter.write_str("Password(<redacted>)"),
            Self::PrivateKey {
                identity_file,
                passphrase,
            } => formatter
                .debug_struct("PrivateKey")
                .field("identity_file", identity_file)
                .field(
                    "passphrase",
                    &passphrase
                        .as_ref()
                        .map(|_| "<redacted>")
                        .unwrap_or("<none>"),
                )
                .finish(),
        }
    }
}

#[derive(Debug)]
struct SshCommandHandler;

impl client::Handler for SshCommandHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub(crate) struct SshConnectionChain {
    jumps: Vec<client::Handle<SshCommandHandler>>,
    target: client::Handle<SshCommandHandler>,
}

impl SshConnectionChain {
    pub(crate) async fn open_session_channel(&self) -> AppResult<russh::Channel<client::Msg>> {
        self.target
            .channel_open_session()
            .await
            .map_err(russh_error)
    }

    pub(crate) async fn disconnect(self, message: &str) {
        disconnect_chain(self, message).await;
    }
}

pub fn reusable_connection_key_for_execution(
    scope: &str,
    execution: &SshCommandExecution,
) -> SshReusableConnectionKey {
    let mut fields = vec![
        cache_field("scope", scope),
        cache_field("timeout_seconds", &execution.timeout_seconds.to_string()),
    ];
    for (index, hop) in execution.jumps.iter().enumerate() {
        append_hop_cache_fields(&mut fields, &format!("jump_{index}"), hop);
    }
    append_hop_cache_fields(&mut fields, "target", &execution.target);
    SshReusableConnectionKey(fields.join("\u{1f}"))
}

pub fn reusable_connection_metadata_for_execution(
    execution: &SshCommandExecution,
) -> SshReusableConnectionMetadata {
    let mut session_ids = Vec::new();
    let mut credential_refs = Vec::new();
    for hop in execution
        .jumps
        .iter()
        .chain(std::iter::once(&execution.target))
    {
        push_unique(&mut session_ids, hop.session_id.clone());
        if let Some(credential_ref) = hop.credential_ref.as_ref() {
            push_unique(&mut credential_refs, credential_ref.clone());
        }
    }
    SshReusableConnectionMetadata {
        credential_refs,
        session_ids,
    }
}

fn append_hop_cache_fields(fields: &mut Vec<String>, prefix: &str, hop: &SshCommandHop) {
    fields.push(cache_field(
        &format!("{prefix}.session_id"),
        &hop.session_id,
    ));
    fields.push(cache_field(
        &format!("{prefix}.updated_at_ms"),
        &hop.updated_at_ms.to_string(),
    ));
    fields.push(cache_field(&format!("{prefix}.host"), &hop.host));
    fields.push(cache_field(
        &format!("{prefix}.port"),
        &hop.port.to_string(),
    ));
    fields.push(cache_field(&format!("{prefix}.username"), &hop.username));
    fields.push(cache_field(
        &format!("{prefix}.auth_mode"),
        hop.auth_mode.as_str(),
    ));
    fields.push(cache_field(
        &format!("{prefix}.credential_ref"),
        hop.credential_ref.as_deref().unwrap_or(""),
    ));
    fields.push(cache_field(
        &format!("{prefix}.identity_file"),
        &hop.identity_file
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
    ));
    fields.push(cache_field(
        &format!("{prefix}.connect_timeout_ms"),
        &hop.connect_timeout_ms
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ));
    fields.push(cache_field(
        &format!("{prefix}.keepalive_interval_ms"),
        &hop.keepalive_interval_ms
            .map(|value| value.to_string())
            .unwrap_or_default(),
    ));
    fields.push(cache_field(
        &format!("{prefix}.proxy_command"),
        hop.proxy_command.as_deref().unwrap_or(""),
    ));
}

fn cache_field(label: &str, value: &str) -> String {
    format!("{label}:{}:{value}", value.len())
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !values.iter().any(|candidate| candidate == &value) {
        values.push(value);
    }
}

pub fn build_ssh_command_execution(
    session: &SavedSession,
    all_sessions: &[SavedSession],
    script: String,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshCommandExecution> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported("资源监控只支持 SSH 会话"));
    }
    let script = normalize_script(script)?;
    let mut jumps = Vec::new();
    if let Some(options) = session.ssh_options.as_ref() {
        for jump_host in &options.jump_hosts {
            if let Some(jump_session) = matching_jump_session(jump_host, all_sessions, &session.id)
            {
                jumps.push(build_hop(jump_session, secrets)?);
            } else if !jump_host.trim().is_empty() {
                return Err(AppError::validation(format!(
                    "未找到匹配的跳板机会话: {}",
                    jump_host.trim()
                )));
            }
        }
    }

    Ok(SshCommandExecution {
        jumps,
        max_output_bytes: DEFAULT_OUTPUT_BYTES,
        script,
        target: build_hop(session, secrets)?,
        timeout_seconds: session
            .ssh_options
            .as_ref()
            .and_then(|options| options.connect_timeout_ms)
            .map(|value| value.div_ceil(1000))
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS),
    })
}

fn build_hop(
    session: &SavedSession,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshCommandHop> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::validation("跳板机必须是 SSH 会话"));
    }
    let host = required_text("主机", &session.host)?;
    let username = required_text("用户名", &session.username)?;
    if session.port == 0 {
        return Err(AppError::validation("端口必须大于 0"));
    }
    let mut credential_ref = None;
    let mut identity_file_for_key = None;
    let auth = match session.auth_mode {
        AuthMode::Password => {
            let required = required_credential_ref(session, "密码认证需要凭据引用")?;
            credential_ref = Some(required.to_string());
            SshCommandAuth::Password(secrets.secret_for(required)?)
        }
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
            identity_file_for_key = Some(PathBuf::from(identity_file));
            let passphrase = session
                .credential_ref
                .as_deref()
                .map(|credential_ref| credential_ref.to_string());
            credential_ref = passphrase.clone();
            let passphrase = session
                .credential_ref
                .as_deref()
                .map(|credential_ref| secrets.secret_for(credential_ref))
                .transpose()?;
            SshCommandAuth::PrivateKey {
                identity_file: PathBuf::from(identity_file),
                passphrase,
            }
        }
        AuthMode::Agent => SshCommandAuth::Agent,
        AuthMode::None => SshCommandAuth::None,
    };
    let ssh_options = session.ssh_options.as_ref();
    let proxy_command = ssh_options
        .and_then(|options| options.proxy_command.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    Ok(SshCommandHop {
        auth,
        auth_mode: session.auth_mode,
        connect_timeout_ms: ssh_options.and_then(|options| options.connect_timeout_ms),
        credential_ref,
        host,
        identity_file: identity_file_for_key,
        keepalive_interval_ms: ssh_options.and_then(|options| options.keepalive_interval_ms),
        port: session.port,
        proxy_command,
        session_id: session.id.clone(),
        updated_at_ms: session.updated_at_ms,
        username,
    })
}

fn required_credential_ref<'a>(session: &'a SavedSession, message: &str) -> AppResult<&'a str> {
    session
        .credential_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation(message))
}

fn required_text(label: &str, value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn normalize_script(script: String) -> AppResult<String> {
    if script.contains('\0') {
        return Err(AppError::validation("远程命令不能包含 NUL 字符"));
    }
    let normalized = script.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("远程命令不能为空"));
    }
    if trimmed.chars().count() > MAX_SCRIPT_CHARS {
        return Err(AppError::validation("远程命令长度超过限制"));
    }
    Ok(format!("{trimmed}\n"))
}

fn matching_jump_session<'a>(
    jump_host: &str,
    all_sessions: &'a [SavedSession],
    current_session_id: &str,
) -> Option<&'a SavedSession> {
    let normalized = normalize_auth_target(jump_host);
    if normalized.is_empty() {
        return None;
    }
    all_sessions.iter().find(|candidate| {
        candidate.session_type == SessionType::Ssh
            && candidate.id != current_session_id
            && (normalized == normalize_auth_target(&ssh_prompt_target(candidate))
                || normalized == normalize_auth_target(&ssh_jump_target(candidate))
                || normalized == normalize_auth_target(&candidate.id))
    })
}

fn ssh_prompt_target(session: &SavedSession) -> String {
    if session.username.trim().is_empty() {
        session.host.trim().to_string()
    } else {
        format!("{}@{}", session.username.trim(), session.host.trim())
    }
}

fn ssh_jump_target(session: &SavedSession) -> String {
    let target = ssh_prompt_target(session);
    if session.port == 22 {
        target
    } else {
        format!("{target}:{}", session.port)
    }
}

fn normalize_auth_target(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

async fn execute_ssh_command_execution(
    execution: SshCommandExecution,
) -> AppResult<SshCommandOutput> {
    let started = Instant::now();
    let timeout = Duration::from_secs(execution.timeout_seconds);
    match tokio::time::timeout(timeout, execute_ssh_command_inner(execution)).await {
        Ok(result) => result.map(|mut output| {
            output.duration_ms = started.elapsed().as_millis();
            output
        }),
        Err(_) => Err(AppError::ssh(format!(
            "远程命令执行超时（{} 秒）",
            timeout.as_secs()
        ))),
    }
}

async fn execute_ssh_command_inner(execution: SshCommandExecution) -> AppResult<SshCommandOutput> {
    let connection = connect_chain(&execution).await?;
    let result = execute_on_connection(&connection, &execution)
        .await
        .map_err(SshCommandRunError::into_app_error);
    disconnect_chain(connection, "command completed").await;
    result
}

enum SshCommandRunError {
    AfterWrite(AppError),
    BeforeWrite(AppError),
}

impl SshCommandRunError {
    fn into_app_error(self) -> AppError {
        match self {
            Self::AfterWrite(error) | Self::BeforeWrite(error) => error,
        }
    }
}

async fn execute_on_connection(
    connection: &SshConnectionChain,
    execution: &SshCommandExecution,
) -> Result<SshCommandOutput, SshCommandRunError> {
    let mut channel = connection
        .target
        .channel_open_session()
        .await
        .map_err(|error| SshCommandRunError::BeforeWrite(russh_error(error)))?;
    channel
        .exec(true, "sh -s")
        .await
        .map_err(|error| SshCommandRunError::BeforeWrite(russh_error(error)))?;
    channel
        .data_bytes(execution.script.as_bytes().to_vec())
        .await
        .map_err(|error| SshCommandRunError::AfterWrite(russh_error(error)))?;
    channel
        .eof()
        .await
        .map_err(|error| SshCommandRunError::AfterWrite(russh_error(error)))?;

    let mut stdout = LimitedOutputBuffer::new(execution.max_output_bytes);
    let mut stderr = LimitedOutputBuffer::new(execution.max_output_bytes);
    let mut exit_code = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => stdout.push(data.as_ref()),
            ChannelMsg::ExtendedData { data, .. } => stderr.push(data.as_ref()),
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            ChannelMsg::ExitSignal {
                signal_name,
                error_message,
                ..
            } => {
                if !error_message.trim().is_empty() {
                    stderr.push(error_message.as_bytes());
                    stderr.push(b"\n");
                }
                stderr.push(
                    format!("remote process terminated by signal: {signal_name:?}\n").as_bytes(),
                );
            }
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let _ = channel.close().await;

    let stdout = stdout.finish();
    let stderr = stderr.finish();
    Ok(SshCommandOutput {
        stdout: stdout.text,
        stderr: stderr.text,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
        exit_code,
        success: exit_code == Some(0),
        duration_ms: 0,
    })
}

pub(crate) async fn connect_chain(
    execution: &SshCommandExecution,
) -> AppResult<SshConnectionChain> {
    if execution.jumps.is_empty() {
        let mut target = connect_hop(&execution.target, execution.timeout_seconds).await?;
        authenticate(&mut target, &execution.target).await?;
        return Ok(SshConnectionChain {
            jumps: Vec::new(),
            target,
        });
    }

    let mut jumps = Vec::new();
    let mut upstream = connect_hop(&execution.jumps[0], execution.timeout_seconds).await?;
    authenticate(&mut upstream, &execution.jumps[0]).await?;
    for jump in execution.jumps.iter().skip(1) {
        let mut next = connect_hop_through(&upstream, jump, execution.timeout_seconds).await?;
        authenticate(&mut next, jump).await?;
        jumps.push(upstream);
        upstream = next;
    }
    let mut target =
        connect_hop_through(&upstream, &execution.target, execution.timeout_seconds).await?;
    authenticate(&mut target, &execution.target).await?;
    jumps.push(upstream);
    Ok(SshConnectionChain { jumps, target })
}

async fn connect_hop(
    hop: &SshCommandHop,
    timeout_seconds: u64,
) -> AppResult<client::Handle<SshCommandHandler>> {
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(timeout_seconds)),
        keepalive_interval: hop.keepalive_interval_ms.map(Duration::from_millis),
        ..Default::default()
    };
    let config = Arc::new(config);
    if let Some(proxy_command) = hop.proxy_command.as_ref() {
        let stream = start_proxy_command(proxy_command, hop)?;
        client::connect_stream(config, stream, SshCommandHandler)
            .await
            .map_err(russh_error)
    } else {
        client::connect(config, (hop.host.as_str(), hop.port), SshCommandHandler)
            .await
            .map_err(russh_error)
    }
}

async fn connect_hop_through(
    upstream: &client::Handle<SshCommandHandler>,
    hop: &SshCommandHop,
    timeout_seconds: u64,
) -> AppResult<client::Handle<SshCommandHandler>> {
    let channel = upstream
        .channel_open_direct_tcpip(hop.host.clone(), u32::from(hop.port), "127.0.0.1", 0)
        .await
        .map_err(russh_error)?;
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(timeout_seconds)),
        keepalive_interval: hop.keepalive_interval_ms.map(Duration::from_millis),
        ..Default::default()
    };
    client::connect_stream(Arc::new(config), channel.into_stream(), SshCommandHandler)
        .await
        .map_err(russh_error)
}

async fn authenticate(
    handle: &mut client::Handle<SshCommandHandler>,
    hop: &SshCommandHop,
) -> AppResult<()> {
    let username = hop.username.clone();
    let authenticated = match &hop.auth {
        SshCommandAuth::Password(password) => handle
            .authenticate_password(username, password.clone())
            .await
            .map_err(russh_error)?
            .success(),
        SshCommandAuth::PrivateKey {
            identity_file,
            passphrase,
        } => {
            let key = load_secret_key(identity_file, passphrase.as_deref()).map_err(key_error)?;
            authenticate_private_key(handle, username, key).await?
        }
        SshCommandAuth::Agent => authenticate_agent(handle, username).await?,
        SshCommandAuth::None => handle
            .authenticate_none(username)
            .await
            .map_err(russh_error)?
            .success(),
    };
    if authenticated {
        Ok(())
    } else {
        Err(AppError::credential(format!(
            "SSH 认证失败: {}@{}:{}",
            hop.username, hop.host, hop.port
        )))
    }
}

async fn authenticate_private_key(
    handle: &mut client::Handle<SshCommandHandler>,
    username: String,
    key: PrivateKey,
) -> AppResult<bool> {
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(russh_error)?
        .flatten();
    handle
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(russh_error)
        .map(|result| result.success())
}

async fn authenticate_agent(
    handle: &mut client::Handle<SshCommandHandler>,
    username: String,
) -> AppResult<bool> {
    let mut agent = connect_agent().await?;
    let identities = agent.request_identities().await.map_err(agent_error)?;
    for identity in identities {
        let key = match &identity {
            AgentIdentity::PublicKey { key, .. } => key.clone(),
            AgentIdentity::Certificate { .. } => identity.public_key().into_owned(),
        };
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(russh_error)?
            .flatten();
        let result = handle
            .authenticate_publickey_with(username.clone(), key, hash, &mut agent)
            .await
            .map_err(|error| AppError::credential(format!("SSH agent 认证失败: {error}")))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(unix)]
async fn connect_agent() -> AppResult<
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
> {
    keys::agent::client::AgentClient::connect_env()
        .await
        .map(|client| client.dynamic())
        .map_err(agent_error)
}

#[cfg(windows)]
async fn connect_agent() -> AppResult<
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
> {
    const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

    match keys::agent::client::AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE).await {
        Ok(client) => Ok(client.dynamic()),
        Err(openssh_error) => keys::agent::client::AgentClient::connect_pageant()
            .await
            .map(|client| client.dynamic())
            .map_err(|pageant_error| {
                AppError::credential(format!(
                    "SSH agent 连接失败: OpenSSH agent ({OPENSSH_AGENT_PIPE}) {openssh_error}; Pageant {pageant_error}"
                ))
            }),
    }
}

#[cfg(not(any(unix, windows)))]
async fn connect_agent() -> AppResult<
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
> {
    Err(AppError::unsupported("当前平台不支持 SSH agent 认证"))
}

async fn disconnect_chain(connection: SshConnectionChain, message: &str) {
    let _ = connection
        .target
        .disconnect(russh::Disconnect::ByApplication, message, "")
        .await;
    for jump in connection.jumps.into_iter().rev() {
        let _ = jump
            .disconnect(russh::Disconnect::ByApplication, message, "")
            .await;
    }
}

struct ProxyCommandStream {
    _child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

impl Unpin for ProxyCommandStream {}

impl AsyncRead for ProxyCommandStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(context, buffer)
    }
}

impl AsyncWrite for ProxyCommandStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(context)
    }
}

impl Drop for ProxyCommandStream {
    fn drop(&mut self) {
        let _ = self._child.start_kill();
    }
}

fn start_proxy_command(template: &str, hop: &SshCommandHop) -> AppResult<ProxyCommandStream> {
    let command_line = expand_proxy_command(template, hop);
    let mut command = shell_command(&command_line);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| AppError::ssh(format!("ProxyCommand 启动失败: {error}")))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::ssh("ProxyCommand stdin 不可用"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::ssh("ProxyCommand stdout 不可用"))?;
    Ok(ProxyCommandStream {
        _child: child,
        stdin,
        stdout,
    })
}

fn expand_proxy_command(template: &str, hop: &SshCommandHop) -> String {
    let mut expanded = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        match chars.next() {
            Some('%') => expanded.push('%'),
            Some('h') => expanded.push_str(&hop.host),
            Some('p') => expanded.push_str(&hop.port.to_string()),
            Some('r') => expanded.push_str(&hop.username),
            Some(other) => {
                expanded.push('%');
                expanded.push(other);
            }
            None => expanded.push('%'),
        }
    }
    expanded
}

#[cfg(windows)]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("cmd.exe");
    command.arg("/C").arg(command_line);
    command
}

#[cfg(not(windows))]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("sh");
    command.arg("-c").arg(command_line);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::session::SshOptions;

    struct StaticSecrets;

    impl SshCommandSecretResolver for StaticSecrets {
        fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
            Ok(format!("{credential_ref}-secret"))
        }
    }

    #[test]
    fn proxy_command_expands_open_ssh_host_port_user_tokens() {
        let hop = SshCommandHop {
            auth: SshCommandAuth::None,
            auth_mode: AuthMode::None,
            connect_timeout_ms: None,
            credential_ref: None,
            host: "files.example.test".to_string(),
            identity_file: None,
            keepalive_interval_ms: None,
            port: 2222,
            proxy_command: Some("ssh -W %h:%p %r@jump && printf %%".to_string()),
            session_id: "target".to_string(),
            updated_at_ms: 1,
            username: "deploy".to_string(),
        };

        assert_eq!(
            expand_proxy_command(hop.proxy_command.as_deref().expect("proxy command"), &hop),
            "ssh -W files.example.test:2222 deploy@jump && printf %"
        );
    }

    #[test]
    fn reusable_key_tracks_proxy_command_without_secret_values() {
        let mut target = ssh_session("target", "files.example.test", "deploy");
        target.credential_ref = Some("credential:target-password".to_string());
        target.ssh_options = Some(SshOptions {
            connect_timeout_ms: Some(15_000),
            keepalive_interval_ms: None,
            proxy_command: Some("ssh -W %h:%p jump-a".to_string()),
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: Vec::new(),
            container: None,
        });

        let execution = build_ssh_command_execution(
            &target,
            &[target.clone()],
            "true".to_string(),
            &StaticSecrets,
        )
        .expect("execution should build");
        let key = reusable_connection_key_for_execution("sftp", &execution);

        let mut changed_proxy = target.clone();
        changed_proxy
            .ssh_options
            .as_mut()
            .expect("options")
            .proxy_command = Some("ssh -W %h:%p jump-b".to_string());
        let changed_execution = build_ssh_command_execution(
            &changed_proxy,
            &[changed_proxy.clone()],
            "true".to_string(),
            &StaticSecrets,
        )
        .expect("execution should build");

        assert_ne!(
            key,
            reusable_connection_key_for_execution("sftp", &changed_execution)
        );
        let key_text = format!("{key:?} {}", key.as_str());
        assert!(key_text.contains("ssh -W %h:%p jump-a"));
        assert!(!key_text.contains("target-password-secret"));
    }

    fn ssh_session(id: &str, host: &str, username: &str) -> SavedSession {
        SavedSession {
            id: id.to_string(),
            name: id.to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: host.to_string(),
            port: 22,
            username: username.to_string(),
            auth_mode: AuthMode::Password,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_used_at_ms: None,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
        }
    }
}

#[derive(Debug)]
struct LimitedOutput {
    text: String,
    truncated: bool,
}

#[derive(Debug)]
struct LimitedOutputBuffer {
    captured: Vec<u8>,
    max_bytes: usize,
    total_bytes: usize,
}

impl LimitedOutputBuffer {
    fn new(max_bytes: usize) -> Self {
        Self {
            captured: Vec::with_capacity(max_bytes.min(8192)),
            max_bytes: max_bytes.clamp(MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
            total_bytes: 0,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        let remaining = self.max_bytes.saturating_sub(self.captured.len());
        if remaining > 0 {
            self.captured
                .extend_from_slice(&bytes[..bytes.len().min(remaining)]);
        }
    }

    fn finish(self) -> LimitedOutput {
        LimitedOutput {
            text: String::from_utf8_lossy(&self.captured).into_owned(),
            truncated: self.total_bytes > self.captured.len(),
        }
    }
}

fn russh_error(error: russh::Error) -> AppError {
    AppError::ssh(error.to_string())
}

fn key_error(error: keys::Error) -> AppError {
    AppError::credential(format!("SSH 私钥解析失败: {error}"))
}

fn agent_error(error: keys::Error) -> AppError {
    AppError::credential(format!("SSH agent 连接失败: {error}"))
}
