// Author: Liz
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

#[path = "completion_refresh.rs"]
mod refresh;

use crate::{
    error::{AppError, AppResult},
    models::{
        command_completion::{
            CommandCompletionCandidate, CommandCompletionCwdRequest, CommandCompletionProvider,
            CommandCompletionReplacementRange, CommandCompletionRequest,
        },
        history::{HistoryScopeKind, HistorySearchOptions},
        session::{SavedSession, SessionType},
        sftp::{FileEntry, FileKind},
        terminal::RuntimeSessionKind,
    },
    services::{
        credential_service::CredentialService,
        sftp_service::SftpService,
        ssh_command_service::{
            build_ssh_command_execution, reusable_connection_key_for_execution,
            SshCommandSecretResolver, SshCommandService,
        },
    },
    storage::{
        history::{search_command_history, search_command_history_prefix},
        sessions::{get_session, list_sessions},
        sqlite::SqliteStore,
    },
};

const DEFAULT_LIMIT: usize = 8;
const MAX_LIMIT: usize = 20;
const HISTORY_SCAN_LIMIT: usize = 500;
const MAX_INPUT_CHARS: usize = 4096;
const LOCAL_COMMAND_TTL: Duration = Duration::from_secs(300);
const REMOTE_COMMAND_TTL: Duration = Duration::from_secs(300);
const REMOTE_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const REMOTE_PATH_TTL: Duration = Duration::from_secs(15);
const REMOTE_PATH_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PATH_ENTRIES: usize = 200;
const MAX_LOCAL_PATH_SCAN_ENTRIES: usize = 10_000;
const MAX_REMOTE_PATH_CACHE_KEYS: usize = 128;
const MAX_REMOTE_COMMAND_CACHE_KEYS: usize = 128;
const REMOTE_COMMAND_STALE: Duration = Duration::from_secs(300);
const REMOTE_PATH_STALE: Duration = Duration::from_secs(30);
const MAX_SYSTEM_COMMANDS: usize = 1500;
const REMOTE_COMMAND_DISCOVERY_SCRIPT: &str = r#"
PATH_VALUE=${PATH:-}
OLD_IFS=$IFS
IFS=:
for dir in $PATH_VALUE; do
  [ -d "$dir" ] || continue
  for item in "$dir"/*; do
    [ -f "$item" ] && [ -x "$item" ] && printf '%s\n' "${item##*/}"
  done
done
IFS=$OLD_IFS
"#;

const LOCAL_BUILTINS: &[&str] = &[
    "cat", "cd", "clear", "cls", "copy", "cp", "del", "dir", "echo", "exit", "git", "ls", "mkdir",
    "move", "mv", "npm", "pwd", "rm", "rmdir", "set", "type", "where",
];

const POSIX_BUILTINS: &[&str] = &[
    "alias", "bg", "break", "cd", "command", "continue", "echo", "eval", "exec", "exit", "export",
    "false", "fg", "jobs", "kill", "printf", "pwd", "read", "return", "set", "shift", "test",
    "times", "trap", "true", "type", "ulimit", "umask", "unalias", "unset", "wait",
];
const PATH_OPERAND_COMMANDS: &[&str] = &[
    "cmp", "cp", "diff", "du", "file", "ln", "ls", "mv", "readlink", "realpath", "rm", "stat",
    "touch", "vi", "vim", "wc",
];
const FILE_OPERAND_COMMANDS: &[&str] = &["cat", "head", "less", "more", "nano", "tail"];
const DIRECTORY_OPERAND_COMMANDS: &[&str] = &["cd", "mkdir", "rmdir"];

#[derive(Clone, Default)]
pub struct CommandCompletionService {
    inner: Arc<CommandCompletionState>,
}

#[derive(Default)]
struct CommandCompletionState {
    local_commands: Mutex<Option<CachedCommands>>,
    remote_commands: Mutex<HashMap<String, CachedCommands>>,
    remote_paths: Mutex<HashMap<String, CachedPathEntries>>,
    refresh: Arc<refresh::Scheduler>,
    runtimes: Mutex<HashMap<String, RuntimeCompletionContext>>,
}

#[derive(Clone)]
struct RuntimeCompletionContext {
    kind: RuntimeSessionKind,
    saved_session_id: Option<String>,
    history_scope_kind: Option<HistoryScopeKind>,
    history_scope_id: Option<String>,
}

#[derive(Clone)]
struct CachedCommands {
    commands: Vec<String>,
    expires_at: Instant,
    stale_until: Instant,
    route: Option<refresh::Route>,
}

#[derive(Clone)]
struct CachedPathEntries {
    entries: Vec<FileEntry>,
    expires_at: Instant,
    stale_until: Instant,
    route: Option<refresh::Route>,
}

struct FingerprintSecrets;

impl SshCommandSecretResolver for FingerprintSecrets {
    fn secret_for(&self, _: &str) -> AppResult<String> {
        Ok(String::new())
    }
}

fn route_fingerprint(session: &SavedSession, all_sessions: &[SavedSession]) -> AppResult<String> {
    let execution =
        build_ssh_command_execution(session, all_sessions, "true".into(), &FingerprintSecrets)?;
    Ok(
        reusable_connection_key_for_execution("completion", &execution)
            .as_str()
            .to_owned(),
    )
}

impl CommandCompletionService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_runtime(
        &self,
        runtime_session_id: &str,
        kind: RuntimeSessionKind,
        saved_session_id: Option<String>,
        history_scope_kind: Option<HistoryScopeKind>,
        history_scope_id: Option<String>,
    ) {
        if runtime_session_id.trim().is_empty() {
            return;
        }
        if let Ok(mut runtimes) = self.inner.runtimes.lock() {
            runtimes.insert(
                runtime_session_id.to_string(),
                RuntimeCompletionContext {
                    kind,
                    saved_session_id,
                    history_scope_kind,
                    history_scope_id,
                },
            );
        }
    }

    pub fn unregister_runtime(&self, runtime_session_id: &str) {
        if let Ok(mut runtimes) = self.inner.runtimes.lock() {
            runtimes.remove(runtime_session_id);
        }
    }

    pub fn suggest(
        &self,
        store: &SqliteStore,
        request: CommandCompletionRequest,
    ) -> AppResult<Vec<CommandCompletionCandidate>> {
        let request = NormalizedCompletionRequest::try_from(request)?;
        if request.prefix.trim().is_empty() {
            return Ok(Vec::new());
        }
        let context = self.runtime_context(&request.runtime_session_id)?;
        if context.kind == RuntimeSessionKind::Ssh {
            if let Some(session_id) = context.saved_session_id.as_deref() {
                if self.prepare_remote_route(store, session_id).is_err() {
                    self.inner.refresh.invalidate(session_id);
                }
            }
        }
        let mut candidates = Vec::new();
        let mut seen_replacements = HashSet::new();
        let local = context.kind == RuntimeSessionKind::Local;
        let path_context = matches!(
            context.kind,
            RuntimeSessionKind::Local | RuntimeSessionKind::Ssh
        ) && (path_query(&request.prefix, request.cwd.as_deref(), local)
            .is_some()
            || path_command_waiting_for_argument(&request.prefix));

        self.push_path_candidates(&request, &context, &mut seen_replacements, &mut candidates)?;
        if path_context {
            self.boost_path_candidates_with_history(
                store,
                &request,
                context.history_scope_kind,
                context.history_scope_id.as_deref(),
                &mut candidates,
            )?;
            candidates.sort_by(|left, right| {
                right
                    .score
                    .partial_cmp(&left.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| left.replacement_text.cmp(&right.replacement_text))
            });
            candidates.truncate(request.limit);
            return Ok(candidates);
        }
        self.push_history_candidates(
            store,
            &request,
            context.history_scope_kind,
            context.history_scope_id.as_deref(),
            0.78,
            "当前会话历史",
            &mut seen_replacements,
            &mut candidates,
        )?;
        if candidates.len() < request.limit {
            self.push_system_candidates(
                &request,
                &context,
                &mut seen_replacements,
                &mut candidates,
            )?;
        }
        if candidates.len() < request.limit {
            self.push_history_candidates(
                store,
                &request,
                None,
                None,
                0.54,
                "全局历史",
                &mut seen_replacements,
                &mut candidates,
            )?;
        }

        candidates.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.replacement_text.cmp(&right.replacement_text))
        });
        candidates.truncate(request.limit);
        Ok(candidates)
    }

    pub fn refresh_remote_commands(
        &self,
        store: Arc<SqliteStore>,
        ssh_commands: SshCommandService,
        credential_service: CredentialService,
        saved_session_id: String,
    ) {
        let Ok((session, all_sessions, route)) =
            self.prepare_remote_route(store.as_ref(), &saved_session_id)
        else {
            self.inner.refresh.invalidate(&saved_session_id);
            return;
        };
        if self.remote_cache_is_fresh(&saved_session_id) {
            return;
        }
        let host = format!("{}:{}", session.host.to_ascii_lowercase(), session.port);
        let Some(mut probe) = self.inner.refresh.start(&route, &host, "commands") else {
            return;
        };
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result: AppResult<Vec<String>> = async {
                let output = tokio::time::timeout(
                    REMOTE_COMMAND_TIMEOUT,
                    ssh_commands.execute(
                        &session,
                        &all_sessions,
                        REMOTE_COMMAND_DISCOVERY_SCRIPT.to_string(),
                        &credential_service,
                    ),
                )
                .await
                .map_err(|_| AppError::ssh("远端命令探测超时"))??;
                if output.success && !output.stdout_truncated {
                    Ok(parse_remote_command_output(
                        &output.stdout,
                        MAX_SYSTEM_COMMANDS,
                    ))
                } else {
                    Err(AppError::ssh("远端命令探测失败"))
                }
            }
            .await;

            if let Ok(commands) = result {
                if service.route_still_current(store.as_ref(), &saved_session_id, &route) {
                    service.inner.refresh.publish(&route, || {
                        service.store_remote_commands_for_route(
                            &saved_session_id,
                            commands,
                            Some(route.clone()),
                        )
                    });
                    probe.succeeded();
                }
            }
        });
    }

    pub fn refresh_remote_commands_for_runtime(
        &self,
        store: Arc<SqliteStore>,
        ssh_commands: SshCommandService,
        credential_service: CredentialService,
        runtime_session_id: &str,
    ) {
        let context = self
            .inner
            .runtimes
            .lock()
            .ok()
            .and_then(|runtimes| runtimes.get(runtime_session_id).cloned());
        let Some(context) = context else {
            return;
        };
        if context.kind != RuntimeSessionKind::Ssh {
            return;
        }
        let Some(saved_session_id) = context.saved_session_id else {
            return;
        };
        self.refresh_remote_commands(store, ssh_commands, credential_service, saved_session_id);
    }

    pub fn refresh_remote_paths_for_request(
        &self,
        store: Arc<SqliteStore>,
        sftp: SftpService,
        credential_service: CredentialService,
        request: &CommandCompletionRequest,
    ) {
        let Ok(normalized) = NormalizedCompletionRequest::try_from(request.clone()) else {
            return;
        };
        let Ok(context) = self.runtime_context(&normalized.runtime_session_id) else {
            return;
        };
        if context.kind != RuntimeSessionKind::Ssh {
            return;
        }
        let Some(saved_session_id) = context.saved_session_id else {
            return;
        };
        let Some(query) = path_query(&normalized.prefix, normalized.cwd.as_deref(), false) else {
            return;
        };
        let lookup = query.lookup_directory;
        let Ok((session, all_sessions, route)) =
            self.prepare_remote_route(store.as_ref(), &saved_session_id)
        else {
            self.inner.refresh.invalidate(&saved_session_id);
            return;
        };
        let provisional_key = remote_path_cache_key(&saved_session_id, &lookup);
        if self.remote_path_cache_is_fresh(&provisional_key) {
            return;
        }
        let host = format!("{}:{}", session.host.to_ascii_lowercase(), session.port);
        let Some(mut probe) = self
            .inner
            .refresh
            .start(&route, &host, &format!("path:{lookup}"))
        else {
            return;
        };

        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result: AppResult<(String, Vec<FileEntry>)> = async {
                let canonical_input = if lookup == "~" || lookup.starts_with("~/") {
                    let home = tokio::time::timeout(
                        REMOTE_PATH_TIMEOUT,
                        sftp.canonicalize(&session, &all_sessions, &credential_service, "."),
                    )
                    .await
                    .map_err(|_| AppError::sftp("远端主目录解析超时"))??;
                    format!("{}{}", home.trim_end_matches('/'), &lookup[1..])
                } else {
                    lookup.clone()
                };
                let canonical = tokio::time::timeout(
                    REMOTE_PATH_TIMEOUT,
                    sftp.canonicalize(
                        &session,
                        &all_sessions,
                        &credential_service,
                        &canonical_input,
                    ),
                )
                .await
                .map_err(|_| AppError::sftp("远端路径解析超时"))??;
                let entries = tokio::time::timeout(
                    REMOTE_PATH_TIMEOUT,
                    sftp.list_for_completion(
                        &session,
                        &all_sessions,
                        &credential_service,
                        &canonical,
                    ),
                )
                .await
                .map_err(|_| AppError::sftp("远端目录读取超时"))??;
                Ok((canonical, entries))
            }
            .await;

            if let Ok((canonical, entries)) = result {
                if service.route_still_current(store.as_ref(), &saved_session_id, &route) {
                    service.inner.refresh.publish(&route, || {
                        service.store_remote_path_entries_for_route(
                            &saved_session_id,
                            &lookup,
                            &canonical,
                            entries,
                            Some(route.clone()),
                        )
                    });
                    probe.succeeded();
                }
            }
        });
    }

    pub async fn resolve_cwd(
        &self,
        store: Arc<SqliteStore>,
        sftp: SftpService,
        credential_service: CredentialService,
        request: CommandCompletionCwdRequest,
    ) -> AppResult<Option<String>> {
        let runtime_session_id = request.runtime_session_id.trim();
        if runtime_session_id.is_empty() {
            return Err(AppError::validation("运行会话 ID 不能为空"));
        }
        if request
            .current_cwd
            .as_deref()
            .is_some_and(invalid_cwd_value)
            || request.target.as_deref().is_some_and(invalid_cwd_value)
        {
            return Err(AppError::validation("工作目录参数无效"));
        }
        let context = self.runtime_context(runtime_session_id)?;
        match context.kind {
            RuntimeSessionKind::Local => Ok(resolve_local_cwd(
                request.current_cwd.as_deref(),
                request.target.as_deref(),
            )),
            RuntimeSessionKind::Ssh => {
                let Some(saved_session_id) = context.saved_session_id else {
                    return Ok(None);
                };
                let session = get_session(store.as_ref(), &saved_session_id)?;
                let all_sessions = list_sessions(store.as_ref())?.sessions;
                let target = request.target.as_deref();
                let home = if target.is_none()
                    || target.is_some_and(|value| value == "~" || value.starts_with("~/"))
                {
                    Some(
                        tokio::time::timeout(
                            REMOTE_PATH_TIMEOUT,
                            sftp.canonicalize(&session, &all_sessions, &credential_service, "."),
                        )
                        .await
                        .map_err(|_| AppError::sftp("远端主目录解析超时"))??,
                    )
                } else {
                    None
                };
                let candidate = resolve_remote_cwd_candidate(
                    request.current_cwd.as_deref(),
                    target,
                    home.as_deref(),
                )?;
                let canonical = tokio::time::timeout(
                    REMOTE_PATH_TIMEOUT,
                    sftp.canonicalize(&session, &all_sessions, &credential_service, &candidate),
                )
                .await
                .map_err(|_| AppError::sftp("远端工作目录解析超时"))??;
                tokio::time::timeout(
                    REMOTE_PATH_TIMEOUT,
                    sftp.list_for_completion(
                        &session,
                        &all_sessions,
                        &credential_service,
                        &canonical,
                    ),
                )
                .await
                .map_err(|_| AppError::sftp("远端工作目录验证超时"))??;
                Ok(Some(canonical))
            }
            RuntimeSessionKind::SshContainer | RuntimeSessionKind::RdpPlaceholder => Ok(None),
        }
    }

    fn route_still_current(
        &self,
        store: &SqliteStore,
        saved_session_id: &str,
        route: &refresh::Route,
    ) -> bool {
        match self.prepare_remote_route(store, saved_session_id) {
            Ok((_, _, current)) => current == *route,
            Err(_) => {
                self.inner.refresh.invalidate(saved_session_id);
                false
            }
        }
    }

    fn prepare_remote_route(
        &self,
        store: &SqliteStore,
        saved_session_id: &str,
    ) -> AppResult<(SavedSession, Vec<SavedSession>, refresh::Route)> {
        let session = get_session(store, saved_session_id)?;
        if session.session_type != SessionType::Ssh {
            return Err(AppError::validation("远端补全只支持 SSH 会话"));
        }
        let all_sessions = list_sessions(store)?.sessions;
        let fingerprint = route_fingerprint(&session, &all_sessions)?;
        let route = self
            .inner
            .refresh
            .bind(saved_session_id, fingerprint)
            .ok_or_else(|| AppError::terminal("补全路由锁不可用"))?;
        Ok((session, all_sessions, route))
    }

    fn runtime_context(&self, runtime_session_id: &str) -> AppResult<RuntimeCompletionContext> {
        let runtimes = self.runtime_contexts()?;
        runtimes
            .get(runtime_session_id)
            .cloned()
            .ok_or_else(|| AppError::validation("运行会话不存在或不支持补全"))
    }

    fn runtime_contexts(
        &self,
    ) -> AppResult<MutexGuard<'_, HashMap<String, RuntimeCompletionContext>>> {
        self.inner
            .runtimes
            .lock()
            .map_err(|_| AppError::terminal("command completion runtime lock was poisoned"))
    }

    #[allow(clippy::too_many_arguments)]
    fn push_history_candidates(
        &self,
        store: &SqliteStore,
        request: &NormalizedCompletionRequest,
        scope_kind: Option<HistoryScopeKind>,
        scope_id: Option<&str>,
        base_score: f64,
        source_label: &str,
        seen_replacements: &mut HashSet<String>,
        candidates: &mut Vec<CommandCompletionCandidate>,
    ) -> AppResult<()> {
        let entries = search_command_history_prefix(
            store,
            &request.prefix,
            scope_kind,
            scope_id,
            Some(HISTORY_SCAN_LIMIT),
        )?;
        for (index, entry) in entries.into_iter().enumerate() {
            if candidates.len() >= request.limit {
                break;
            }
            let command = entry.command.trim();
            if command == request.prefix
                || !command.starts_with(&request.prefix)
                || is_sensitive_command(command)
            {
                continue;
            }
            if !seen_replacements.insert(command.to_string()) {
                continue;
            }
            let Some(suffix) = command.strip_prefix(&request.prefix) else {
                continue;
            };
            candidates.push(CommandCompletionCandidate {
                provider: CommandCompletionProvider::History,
                replacement_text: command.to_string(),
                suffix: suffix.to_string(),
                replacement_range: CommandCompletionReplacementRange {
                    start: 0,
                    end: request.cursor,
                },
                score: (base_score + recency_bonus(index)).min(1.0),
                source_label: source_label.to_string(),
            });
        }
        Ok(())
    }

    fn push_system_candidates(
        &self,
        request: &NormalizedCompletionRequest,
        context: &RuntimeCompletionContext,
        seen_replacements: &mut HashSet<String>,
        candidates: &mut Vec<CommandCompletionCandidate>,
    ) -> AppResult<()> {
        let Some(token) = command_token(&request.prefix) else {
            return Ok(());
        };
        if token.name.is_empty() {
            return Ok(());
        }

        let commands = match context.kind {
            RuntimeSessionKind::Local => self.local_commands()?,
            RuntimeSessionKind::Ssh => {
                let mut commands = POSIX_BUILTINS
                    .iter()
                    .map(|command| (*command).to_string())
                    .collect::<Vec<_>>();
                if let Some(saved_session_id) = context.saved_session_id.as_deref() {
                    commands.extend(self.remote_commands(saved_session_id)?);
                }
                normalize_command_names(commands, MAX_SYSTEM_COMMANDS)
            }
            RuntimeSessionKind::SshContainer => POSIX_BUILTINS
                .iter()
                .map(|command| (*command).to_string())
                .collect(),
            RuntimeSessionKind::RdpPlaceholder => Vec::new(),
        };

        for (index, command) in commands.into_iter().enumerate() {
            if candidates.len() >= request.limit {
                break;
            }
            if command == token.name || !command_starts_with(&command, &token.name) {
                continue;
            }
            let replacement_text =
                format!("{}{}", char_prefix(&request.prefix, token.start), command);
            if replacement_text == request.prefix || !replacement_text.starts_with(&request.prefix)
            {
                continue;
            }
            if !seen_replacements.insert(replacement_text.clone()) {
                continue;
            }
            let Some(suffix) = replacement_text
                .strip_prefix(&request.prefix)
                .map(ToOwned::to_owned)
            else {
                continue;
            };
            candidates.push(CommandCompletionCandidate {
                provider: CommandCompletionProvider::System,
                replacement_text,
                suffix,
                replacement_range: CommandCompletionReplacementRange {
                    start: token.start,
                    end: request.cursor,
                },
                score: (0.64 + recency_bonus(index)).min(0.9),
                source_label: match context.kind {
                    RuntimeSessionKind::Local => "系统命令".to_string(),
                    RuntimeSessionKind::Ssh => "远端系统命令".to_string(),
                    RuntimeSessionKind::SshContainer => "容器内建命令".to_string(),
                    RuntimeSessionKind::RdpPlaceholder => "系统命令".to_string(),
                },
            });
        }
        Ok(())
    }

    fn push_path_candidates(
        &self,
        request: &NormalizedCompletionRequest,
        context: &RuntimeCompletionContext,
        seen_replacements: &mut HashSet<String>,
        candidates: &mut Vec<CommandCompletionCandidate>,
    ) -> AppResult<()> {
        if !matches!(
            context.kind,
            RuntimeSessionKind::Local | RuntimeSessionKind::Ssh
        ) {
            return Ok(());
        }
        let local = context.kind == RuntimeSessionKind::Local;
        let Some(query) = path_query(&request.prefix, request.cwd.as_deref(), local) else {
            return Ok(());
        };
        let entries = if local {
            list_local_path_entries(&query.lookup_directory)
        } else if let Some(saved_session_id) = context.saved_session_id.as_deref() {
            self.remote_path_entries(saved_session_id, &query.lookup_directory)?
        } else {
            Vec::new()
        };

        for (index, entry) in entries.into_iter().enumerate() {
            if candidates.len() >= request.limit {
                break;
            }
            if !query.entry_filter.accepts(entry.kind) {
                continue;
            }
            if query.name_prefix.is_empty() && entry.name.starts_with('.') {
                continue;
            }
            if !path_name_starts_with(&entry.name, &query.name_prefix, local) {
                continue;
            }
            if !is_safe_path_component(&entry.name) {
                continue;
            }
            let token_value = format!(
                "{}{}{}",
                query.display_directory,
                entry.name,
                if entry.kind == FileKind::Directory {
                    query.separator
                } else {
                    ""
                }
            );
            let rendered = render_path_token(&token_value, query.quote, query.quote_closed, local);
            let replacement_text = format!(
                "{}{}",
                char_prefix(&request.prefix, query.token_start),
                rendered
            );
            if replacement_text == request.prefix
                || !seen_replacements.insert(replacement_text.clone())
            {
                continue;
            }
            candidates.push(CommandCompletionCandidate {
                provider: CommandCompletionProvider::Path,
                suffix: format!(
                    "{}{}",
                    entry
                        .name
                        .strip_prefix(&query.name_prefix)
                        .unwrap_or(&entry.name),
                    if entry.kind == FileKind::Directory {
                        query.separator
                    } else {
                        ""
                    }
                ),
                replacement_text,
                replacement_range: CommandCompletionReplacementRange {
                    start: query.token_start,
                    end: request.cursor,
                },
                score: (0.88 + recency_bonus(index)).min(0.99),
                source_label: if local {
                    "本机路径".to_string()
                } else {
                    "远端路径".to_string()
                },
            });
        }
        Ok(())
    }

    fn boost_path_candidates_with_history(
        &self,
        store: &SqliteStore,
        request: &NormalizedCompletionRequest,
        scope_kind: Option<HistoryScopeKind>,
        scope_id: Option<&str>,
        candidates: &mut [CommandCompletionCandidate],
    ) -> AppResult<()> {
        if candidates.is_empty() {
            return Ok(());
        }
        let (Some(scope_kind), Some(scope_id)) = (scope_kind, scope_id) else {
            return Ok(());
        };
        let history = search_command_history(
            store,
            HistorySearchOptions {
                query: Some(request.prefix.clone()),
                scope_kind: Some(scope_kind),
                scope_id: Some(scope_id.to_string()),
                limit: Some(HISTORY_SCAN_LIMIT),
                deduplicate: Some(true),
            },
        )?;
        for candidate in candidates {
            if history.iter().any(|entry| {
                historical_command_uses_path(&entry.command, &candidate.replacement_text)
            }) {
                candidate.score = (candidate.score + 0.02).min(0.99);
                candidate.source_label = format!("{} · 历史常用", candidate.source_label);
            }
        }
        Ok(())
    }

    fn remote_path_entries(
        &self,
        saved_session_id: &str,
        lookup_directory: &str,
    ) -> AppResult<Vec<FileEntry>> {
        let key = remote_path_cache_key(saved_session_id, lookup_directory);
        let cached = self
            .inner
            .remote_paths
            .lock()
            .map_err(|_| AppError::terminal("command completion path cache lock was poisoned"))?
            .get(&key)
            .cloned();
        if let Some(entry) = cached.filter(|entry| {
            entry.stale_until > Instant::now()
                && entry
                    .route
                    .as_ref()
                    .is_none_or(|route| self.inner.refresh.current(route))
        }) {
            return Ok(entry.entries.clone());
        }
        Ok(Vec::new())
    }

    fn remote_path_cache_is_fresh(&self, key: &str) -> bool {
        self.inner
            .remote_paths
            .lock()
            .ok()
            .and_then(|cache| cache.get(key).cloned())
            .is_some_and(|entry| {
                entry.expires_at > Instant::now()
                    && entry
                        .route
                        .as_ref()
                        .is_none_or(|route| self.inner.refresh.current(route))
            })
    }

    #[cfg(test)]
    fn store_remote_path_entries(
        &self,
        saved_session_id: &str,
        requested_directory: &str,
        canonical_directory: &str,
        entries: Vec<FileEntry>,
    ) {
        self.store_remote_path_entries_for_route(
            saved_session_id,
            requested_directory,
            canonical_directory,
            entries,
            None,
        );
    }

    fn store_remote_path_entries_for_route(
        &self,
        saved_session_id: &str,
        requested_directory: &str,
        canonical_directory: &str,
        mut entries: Vec<FileEntry>,
        route: Option<refresh::Route>,
    ) {
        sort_path_entries(&mut entries);
        entries.truncate(MAX_PATH_ENTRIES);
        let cached = CachedPathEntries {
            entries,
            expires_at: Instant::now() + REMOTE_PATH_TTL,
            stale_until: Instant::now() + REMOTE_PATH_TTL + REMOTE_PATH_STALE,
            route,
        };
        if let Ok(mut cache) = self.inner.remote_paths.lock() {
            cache.retain(|_, entry| entry.stale_until > Instant::now());
            while cache.len() >= MAX_REMOTE_PATH_CACHE_KEYS {
                let Some(key) = cache.keys().next().cloned() else {
                    break;
                };
                cache.remove(&key);
            }
            cache.insert(
                remote_path_cache_key(saved_session_id, requested_directory),
                cached.clone(),
            );
            cache.insert(
                remote_path_cache_key(saved_session_id, canonical_directory),
                cached,
            );
            while cache.len() > MAX_REMOTE_PATH_CACHE_KEYS {
                let Some(key) = cache.keys().next().cloned() else {
                    break;
                };
                cache.remove(&key);
            }
        }
    }

    fn local_commands(&self) -> AppResult<Vec<String>> {
        let now = Instant::now();
        {
            let cache = self.local_command_cache()?;
            if let Some(entry) = cache.as_ref().filter(|entry| entry.expires_at > now) {
                return Ok(entry.commands.clone());
            }
        }

        let commands = scan_local_commands();
        let mut cache = self.local_command_cache()?;
        *cache = Some(CachedCommands {
            commands: commands.clone(),
            expires_at: now + LOCAL_COMMAND_TTL,
            stale_until: now + LOCAL_COMMAND_TTL,
            route: None,
        });
        Ok(commands)
    }

    fn local_command_cache(&self) -> AppResult<MutexGuard<'_, Option<CachedCommands>>> {
        self.inner
            .local_commands
            .lock()
            .map_err(|_| AppError::terminal("command completion local cache lock was poisoned"))
    }

    fn remote_commands(&self, saved_session_id: &str) -> AppResult<Vec<String>> {
        let cached = self.remote_command_cache()?.get(saved_session_id).cloned();
        if let Some(entry) = cached.filter(|entry| {
            entry.stale_until > Instant::now()
                && entry
                    .route
                    .as_ref()
                    .is_none_or(|route| self.inner.refresh.current(route))
        }) {
            return Ok(entry.commands.clone());
        }
        Ok(Vec::new())
    }

    fn remote_cache_is_fresh(&self, saved_session_id: &str) -> bool {
        self.inner
            .remote_commands
            .lock()
            .ok()
            .and_then(|cache| cache.get(saved_session_id).cloned())
            .is_some_and(|entry| {
                entry.expires_at > Instant::now()
                    && entry
                        .route
                        .as_ref()
                        .is_none_or(|route| self.inner.refresh.current(route))
            })
    }

    #[cfg(test)]
    fn store_remote_commands(&self, saved_session_id: &str, commands: Vec<String>) {
        self.store_remote_commands_for_route(saved_session_id, commands, None);
    }

    fn store_remote_commands_for_route(
        &self,
        saved_session_id: &str,
        commands: Vec<String>,
        route: Option<refresh::Route>,
    ) {
        let commands = normalize_command_names(commands, MAX_SYSTEM_COMMANDS);
        if let Ok(mut cache) = self.inner.remote_commands.lock() {
            cache.retain(|_, entry| entry.stale_until > Instant::now());
            if !cache.contains_key(saved_session_id) && cache.len() >= MAX_REMOTE_COMMAND_CACHE_KEYS
            {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, entry)| entry.expires_at)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&oldest);
                }
            }
            cache.insert(
                saved_session_id.to_string(),
                CachedCommands {
                    commands,
                    expires_at: Instant::now() + REMOTE_COMMAND_TTL,
                    stale_until: Instant::now() + REMOTE_COMMAND_TTL + REMOTE_COMMAND_STALE,
                    route,
                },
            );
        }
    }

    fn remote_command_cache(&self) -> AppResult<MutexGuard<'_, HashMap<String, CachedCommands>>> {
        self.inner
            .remote_commands
            .lock()
            .map_err(|_| AppError::terminal("command completion remote cache lock was poisoned"))
    }
}

struct NormalizedCompletionRequest {
    cursor: usize,
    limit: usize,
    prefix: String,
    runtime_session_id: String,
    cwd: Option<String>,
}

impl TryFrom<CommandCompletionRequest> for NormalizedCompletionRequest {
    type Error = AppError;

    fn try_from(request: CommandCompletionRequest) -> Result<Self, Self::Error> {
        let runtime_session_id = request.runtime_session_id.trim().to_string();
        if runtime_session_id.is_empty() {
            return Err(AppError::validation("运行会话 ID 不能为空"));
        }
        if request.input.chars().count() > MAX_INPUT_CHARS {
            return Err(AppError::validation("补全输入过长"));
        }
        let cursor = request.cursor.min(request.input.chars().count());
        Ok(Self {
            cursor,
            limit: request.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
            prefix: char_prefix(&request.input, cursor),
            runtime_session_id,
            cwd: request
                .cwd
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty() && value.chars().count() <= MAX_INPUT_CHARS),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
struct PathQuery {
    token_start: usize,
    lookup_directory: String,
    display_directory: String,
    name_prefix: String,
    quote: Option<char>,
    quote_closed: bool,
    separator: &'static str,
    entry_filter: PathEntryFilter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PathEntryFilter {
    Any,
    Directories,
    Files,
}

impl PathEntryFilter {
    fn accepts(self, kind: FileKind) -> bool {
        match self {
            Self::Any | Self::Files => true,
            Self::Directories => kind == FileKind::Directory,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PathArgumentTarget {
    entry_filter: PathEntryFilter,
    inline_value_offset: usize,
}

impl PathArgumentTarget {
    const fn new(entry_filter: PathEntryFilter) -> Self {
        Self {
            entry_filter,
            inline_value_offset: 0,
        }
    }

    const fn inline(entry_filter: PathEntryFilter, inline_value_offset: usize) -> Self {
        Self {
            entry_filter,
            inline_value_offset,
        }
    }
}

#[derive(Clone, Debug)]
struct ShellToken {
    start: usize,
    value: String,
    quote: Option<char>,
    quote_closed: bool,
}

fn path_query(prefix: &str, cwd: Option<&str>, local: bool) -> Option<PathQuery> {
    let segment_start = command_segment_start(prefix);
    let segment = prefix.chars().skip(segment_start).collect::<String>();
    let tokens = shell_tokens(&segment, segment_start);
    let ends_with_space = prefix.chars().last().is_some_and(char::is_whitespace);
    let target = path_argument_target(&tokens, ends_with_space)?;
    let mut token = if ends_with_space {
        ShellToken {
            start: prefix.chars().count(),
            value: String::new(),
            quote: None,
            quote_closed: false,
        }
    } else {
        tokens.last()?.to_owned()
    };
    if target.inline_value_offset > 0 {
        token.start += target.inline_value_offset;
        token.value = token
            .value
            .chars()
            .skip(target.inline_value_offset)
            .collect();
        token.quote = None;
        token.quote_closed = false;
    }
    if token.start == tokens[0].start || contains_unsafe_path_expression(&token.value) {
        return None;
    }
    let separator = if local && cfg!(windows) { "\\" } else { "/" };
    let (display_directory, name_prefix) = split_path_token(&token.value, local);
    if !local
        && cwd.is_none()
        && !display_directory.starts_with('/')
        && display_directory != "~"
        && !display_directory.starts_with("~/")
    {
        return None;
    }
    let cwd = cwd
        .map(str::to_string)
        .or_else(|| {
            if local {
                env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| ".".to_string());
    let lookup_directory = resolve_lookup_directory(&cwd, &display_directory, local);
    Some(PathQuery {
        token_start: token.start,
        lookup_directory,
        display_directory,
        name_prefix,
        quote: token.quote,
        quote_closed: token.quote_closed,
        separator,
        entry_filter: target.entry_filter,
    })
}

fn path_argument_target(
    tokens: &[ShellToken],
    ends_with_space: bool,
) -> Option<PathArgumentTarget> {
    let command = tokens.first()?.value.to_ascii_lowercase();
    let current_index = if ends_with_space {
        tokens.len()
    } else {
        tokens.len().checked_sub(1)?
    };
    if current_index == 0 {
        return None;
    }
    let current = tokens
        .get(current_index)
        .map(|token| token.value.as_str())
        .unwrap_or("");
    let previous = current_index
        .checked_sub(1)
        .and_then(|index| tokens.get(index))
        .map(|token| token.value.as_str());

    if DIRECTORY_OPERAND_COMMANDS.contains(&command.as_str()) {
        return (!current.starts_with('-'))
            .then_some(PathArgumentTarget::new(PathEntryFilter::Directories));
    }
    if FILE_OPERAND_COMMANDS.contains(&command.as_str()) {
        return (!current.starts_with('-'))
            .then_some(PathArgumentTarget::new(PathEntryFilter::Files));
    }
    if PATH_OPERAND_COMMANDS.contains(&command.as_str()) {
        return (!current.starts_with('-'))
            .then_some(PathArgumentTarget::new(PathEntryFilter::Any));
    }
    match command.as_str() {
        "tar" => tar_path_argument_target(current, previous, current_index == 2),
        "zip" => zip_path_argument_target(tokens, current_index, current, previous),
        "unzip" => unzip_path_argument_target(tokens, current_index, current, previous),
        "docker"
            if tokens
                .get(1)
                .is_some_and(|token| token.value.eq_ignore_ascii_case("compose")) =>
        {
            docker_compose_path_argument_target(current, previous)
        }
        "docker-compose" => docker_compose_path_argument_target(current, previous),
        _ => None,
    }
}

fn tar_path_argument_target(
    current: &str,
    previous: Option<&str>,
    previous_is_initial_option_bundle: bool,
) -> Option<PathArgumentTarget> {
    if let Some(target) = inline_path_option(
        current,
        &[
            ("--file", PathEntryFilter::Files),
            ("--files-from", PathEntryFilter::Files),
            ("--exclude-from", PathEntryFilter::Files),
            ("--directory", PathEntryFilter::Directories),
        ],
    ) {
        return Some(target);
    }
    match previous {
        Some("-C" | "--directory") => {
            return Some(PathArgumentTarget::new(PathEntryFilter::Directories));
        }
        Some("-f" | "--file" | "-T" | "--files-from" | "-X" | "--exclude-from") => {
            return Some(PathArgumentTarget::new(PathEntryFilter::Files));
        }
        Some(option) if previous_is_initial_option_bundle && tar_short_archive_option(option) => {
            return Some(PathArgumentTarget::new(PathEntryFilter::Files));
        }
        Some("--exclude" | "--transform" | "--mtime" | "--owner" | "--group" | "--mode") => {
            return None;
        }
        _ => {}
    }
    (!current.starts_with('-')).then_some(PathArgumentTarget::new(PathEntryFilter::Any))
}

fn zip_path_argument_target(
    tokens: &[ShellToken],
    current_index: usize,
    current: &str,
    previous: Option<&str>,
) -> Option<PathArgumentTarget> {
    match previous {
        Some("-b" | "--temp-path") => {
            return Some(PathArgumentTarget::new(PathEntryFilter::Directories));
        }
        Some("-x" | "--exclude" | "-i" | "--include") => return None,
        _ => {}
    }
    if current.starts_with('-') {
        return None;
    }
    let positional_count = tokens[1..current_index.min(tokens.len())]
        .iter()
        .filter(|token| !token.value.starts_with('-'))
        .count();
    Some(PathArgumentTarget::new(if positional_count == 0 {
        PathEntryFilter::Files
    } else {
        PathEntryFilter::Any
    }))
}

fn unzip_path_argument_target(
    tokens: &[ShellToken],
    current_index: usize,
    current: &str,
    previous: Option<&str>,
) -> Option<PathArgumentTarget> {
    if previous == Some("-d") {
        return Some(PathArgumentTarget::new(PathEntryFilter::Directories));
    }
    if current.starts_with('-') || unzip_archive_seen(tokens, current_index) {
        return None;
    }
    Some(PathArgumentTarget::new(PathEntryFilter::Files))
}

fn docker_compose_path_argument_target(
    current: &str,
    previous: Option<&str>,
) -> Option<PathArgumentTarget> {
    if let Some(target) = inline_path_option(
        current,
        &[
            ("--file", PathEntryFilter::Files),
            ("--env-file", PathEntryFilter::Files),
            ("--project-directory", PathEntryFilter::Directories),
        ],
    ) {
        return Some(target);
    }
    match previous {
        Some("-f" | "--file" | "--env-file") => {
            Some(PathArgumentTarget::new(PathEntryFilter::Files))
        }
        Some("--project-directory") => Some(PathArgumentTarget::new(PathEntryFilter::Directories)),
        _ => None,
    }
}

fn inline_path_option(
    current: &str,
    options: &[(&str, PathEntryFilter)],
) -> Option<PathArgumentTarget> {
    let lowercase = current.to_ascii_lowercase();
    options.iter().find_map(|(option, entry_filter)| {
        let prefix = format!("{option}=");
        lowercase
            .starts_with(&prefix)
            .then_some(PathArgumentTarget::inline(
                *entry_filter,
                prefix.chars().count(),
            ))
    })
}

fn tar_short_archive_option(option: &str) -> bool {
    let option = option.strip_prefix('-').unwrap_or(option);
    option.len() > 1
        && option.ends_with('f')
        && option
            .chars()
            .all(|character| character.is_ascii_alphabetic())
}

fn unzip_archive_seen(tokens: &[ShellToken], current_index: usize) -> bool {
    let mut skip_next = false;
    for token in tokens.iter().take(current_index).skip(1) {
        if skip_next {
            skip_next = false;
            continue;
        }
        if matches!(token.value.as_str(), "-P" | "-d") {
            skip_next = true;
            continue;
        }
        if !token.value.starts_with('-') {
            return true;
        }
    }
    false
}

fn path_command_waiting_for_argument(prefix: &str) -> bool {
    let segment_start = command_segment_start(prefix);
    let segment = prefix.chars().skip(segment_start).collect::<String>();
    let tokens = shell_tokens(&segment, segment_start);
    let Some(command) = tokens.first().map(|token| token.value.to_ascii_lowercase()) else {
        return false;
    };
    if tokens.len() == 1 {
        return DIRECTORY_OPERAND_COMMANDS.contains(&command.as_str())
            || FILE_OPERAND_COMMANDS.contains(&command.as_str())
            || PATH_OPERAND_COMMANDS.contains(&command.as_str())
            || matches!(command.as_str(), "tar" | "zip" | "unzip");
    }
    let last = tokens.last().map(|token| token.value.as_str());
    match command.as_str() {
        "tar" => last.is_some_and(|option| {
            matches!(
                option,
                "-C" | "--directory"
                    | "-f"
                    | "--file"
                    | "-T"
                    | "--files-from"
                    | "-X"
                    | "--exclude-from"
            ) || tar_short_archive_option(option)
        }),
        "zip" => last.is_some_and(|option| matches!(option, "-b" | "--temp-path")),
        "unzip" => last == Some("-d"),
        "docker"
            if tokens
                .get(1)
                .is_some_and(|token| token.value.eq_ignore_ascii_case("compose")) =>
        {
            last.is_some_and(is_docker_compose_path_option)
        }
        "docker-compose" => last.is_some_and(is_docker_compose_path_option),
        _ => false,
    }
}

fn is_docker_compose_path_option(option: &str) -> bool {
    matches!(
        option,
        "-f" | "--file" | "--env-file" | "--project-directory"
    )
}

fn shell_tokens(value: &str, offset: usize) -> Vec<ShellToken> {
    let chars = value.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let start = index;
        let quote = matches!(chars[index], '\'' | '"').then_some(chars[index]);
        if quote.is_some() {
            index += 1;
        }
        let mut decoded = String::new();
        let mut active_quote = quote;
        let mut quote_closed = false;
        while index < chars.len() {
            let character = chars[index];
            if active_quote == Some(character) {
                active_quote = None;
                quote_closed = true;
                index += 1;
                continue;
            }
            if active_quote.is_none() && matches!(character, '\'' | '"') {
                active_quote = Some(character);
                index += 1;
                continue;
            }
            if active_quote.is_none() && character.is_whitespace() {
                break;
            }
            if character == '\\' && index + 1 < chars.len() && !local_path_backslash(&chars, index)
            {
                index += 1;
                decoded.push(chars[index]);
            } else {
                decoded.push(character);
            }
            index += 1;
        }
        tokens.push(ShellToken {
            start: offset + start,
            value: decoded,
            quote,
            quote_closed,
        });
    }
    tokens
}

fn local_path_backslash(chars: &[char], index: usize) -> bool {
    cfg!(windows)
        && (index == 2 && chars.get(1) == Some(&':')
            || chars
                .get(index + 1)
                .is_some_and(|next| !next.is_whitespace()))
}

fn contains_unsafe_path_expression(value: &str) -> bool {
    value.chars().any(char::is_control)
        || value.contains("$(")
        || value.contains('`')
        || value.contains('*')
        || value.contains('?')
        || value.contains("${")
        || value
            .chars()
            .any(|character| matches!(character, ';' | '&' | '|'))
}

fn split_path_token(value: &str, local: bool) -> (String, String) {
    let split = value
        .char_indices()
        .filter(|(_, character)| *character == '/' || (local && *character == '\\'))
        .map(|(index, character)| index + character.len_utf8())
        .next_back()
        .unwrap_or(0);
    (value[..split].to_string(), value[split..].to_string())
}

fn resolve_lookup_directory(cwd: &str, display_directory: &str, local: bool) -> String {
    if local {
        let expanded = expand_local_home(display_directory);
        let path = PathBuf::from(&expanded);
        if path.is_absolute() {
            return path.to_string_lossy().to_string();
        }
        return PathBuf::from(cwd).join(path).to_string_lossy().to_string();
    }
    if display_directory.starts_with('/') || display_directory.starts_with('~') {
        return display_directory.trim_end_matches('/').to_string();
    }
    let base = cwd.trim_end_matches('/');
    let relative = display_directory.trim_end_matches('/');
    if relative.is_empty() {
        base.to_string()
    } else {
        format!("{base}/{relative}")
    }
}

fn expand_local_home(value: &str) -> String {
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")) {
            return format!("{}{}", home.to_string_lossy(), &value[1..]);
        }
    }
    value.to_string()
}

fn invalid_cwd_value(value: &str) -> bool {
    value.is_empty()
        || value.chars().count() > MAX_INPUT_CHARS
        || value.chars().any(char::is_control)
}

fn resolve_local_cwd(current_cwd: Option<&str>, target: Option<&str>) -> Option<String> {
    let current = current_cwd
        .map(PathBuf::from)
        .or_else(|| env::current_dir().ok())?;
    let candidate = match target {
        None => current,
        Some(target) => {
            let expanded = PathBuf::from(expand_local_home(target));
            if expanded.is_absolute() {
                expanded
            } else {
                current.join(expanded)
            }
        }
    };
    let canonical = fs::canonicalize(candidate).ok()?;
    canonical
        .is_dir()
        .then(|| canonical.to_string_lossy().to_string())
}

fn resolve_remote_cwd_candidate(
    current_cwd: Option<&str>,
    target: Option<&str>,
    home: Option<&str>,
) -> AppResult<String> {
    match target {
        None => home
            .map(str::to_string)
            .ok_or_else(|| AppError::sftp("远端主目录不可用")),
        Some(target) if target == "~" || target.starts_with("~/") => home
            .map(|home| format!("{}{}", home.trim_end_matches('/'), &target[1..]))
            .ok_or_else(|| AppError::sftp("远端主目录不可用")),
        Some(target) if target.starts_with('/') => Ok(target.to_string()),
        Some(target) => Ok(current_cwd
            .map(|current| format!("{}/{}", current.trim_end_matches('/'), target))
            .unwrap_or_else(|| target.to_string())),
    }
}

fn list_local_path_entries(directory: &str) -> Vec<FileEntry> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut result = entries
        .flatten()
        .take(MAX_LOCAL_PATH_SCAN_ENTRIES)
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            Some(FileEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                kind: if file_type.is_dir() {
                    FileKind::Directory
                } else if file_type.is_file() {
                    FileKind::File
                } else if file_type.is_symlink() {
                    FileKind::Symlink
                } else {
                    FileKind::Other
                },
                size: 0,
                modified_at_ms: None,
                permissions: None,
            })
        })
        .collect::<Vec<_>>();
    sort_path_entries(&mut result);
    result
}

fn sort_path_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|left, right| {
        path_kind_rank(left.kind)
            .cmp(&path_kind_rank(right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
}

fn path_kind_rank(kind: FileKind) -> u8 {
    if kind == FileKind::Directory {
        0
    } else {
        1
    }
}

fn path_name_starts_with(name: &str, prefix: &str, local: bool) -> bool {
    if local && cfg!(windows) {
        name.to_lowercase().starts_with(&prefix.to_lowercase())
    } else {
        name.starts_with(prefix)
    }
}

fn is_safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.starts_with('~')
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    ';' | '&'
                        | '|'
                        | '$'
                        | '('
                        | ')'
                        | '`'
                        | '<'
                        | '>'
                        | '*'
                        | '?'
                        | '['
                        | ']'
                        | '{'
                        | '}'
                        | '!'
                        | '#'
                        | '^'
                        | '%'
                        | '@'
                )
                || matches!(character, '\'' | '"')
        })
}

fn render_path_token(value: &str, quote: Option<char>, quote_closed: bool, local: bool) -> String {
    if let Some(quote) = quote {
        return format!(
            "{quote}{value}{}",
            if quote_closed {
                quote.to_string()
            } else {
                String::new()
            }
        );
    }
    if value.chars().any(char::is_whitespace) {
        let quote = if local && cfg!(windows) { '"' } else { '\'' };
        return format!("{quote}{value}{quote}");
    }
    value.to_string()
}

fn remote_path_cache_key(saved_session_id: &str, lookup_directory: &str) -> String {
    format!("{saved_session_id}\0{lookup_directory}")
}

struct CommandToken {
    name: String,
    start: usize,
}

fn command_token(prefix: &str) -> Option<CommandToken> {
    let segment_start = command_segment_start(prefix);
    let segment = prefix.chars().skip(segment_start).collect::<String>();
    let trimmed_start = segment
        .chars()
        .take_while(|character| character.is_whitespace())
        .count();
    let command_start = segment_start + trimmed_start;
    let command = segment.chars().skip(trimmed_start).collect::<String>();
    if command.chars().any(|character| character.is_whitespace()) {
        return None;
    }
    if command.contains('/')
        || command.contains('\\')
        || command.contains('"')
        || command.contains('\'')
    {
        return None;
    }
    Some(CommandToken {
        name: command,
        start: command_start,
    })
}

fn command_segment_start(prefix: &str) -> usize {
    let mut segment_start = 0;
    let mut escaped = false;
    for (index, character) in prefix.chars().enumerate() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if matches!(character, '|' | ';' | '&') {
            segment_start = index + 1;
        }
    }
    segment_start
}

fn scan_local_commands() -> Vec<String> {
    let dirs = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    let pathext = path_extensions();
    let mut commands = LOCAL_BUILTINS
        .iter()
        .map(|command| (*command).to_string())
        .collect::<Vec<_>>();
    commands.extend(scan_commands_in_dirs(&dirs, &pathext));
    normalize_command_names(commands, MAX_SYSTEM_COMMANDS)
}

fn path_extensions() -> Vec<String> {
    let mut extensions = env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .map(|part| part.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if extensions.is_empty() {
        extensions = vec!["exe", "cmd", "bat", "com"]
            .into_iter()
            .map(String::from)
            .collect();
    }
    extensions
}

fn scan_commands_in_dirs(dirs: &[PathBuf], pathext: &[String]) -> Vec<String> {
    let mut commands = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Some(command) = command_name_for_path(&path, pathext) {
                commands.push(command);
            }
        }
    }
    commands
}

fn command_name_for_path(path: &Path, pathext: &[String]) -> Option<String> {
    let file_name = path.file_name()?.to_string_lossy();
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase());
    if extension
        .as_deref()
        .is_some_and(|extension| pathext.iter().any(|candidate| candidate == extension))
    {
        return path
            .file_stem()
            .map(|value| value.to_string_lossy().to_string());
    }
    if cfg!(windows) {
        None
    } else {
        Some(file_name.to_string())
    }
}

pub fn parse_remote_command_output(stdout: &str, limit: usize) -> Vec<String> {
    normalize_command_names(
        stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
        limit,
    )
}

fn normalize_command_names(commands: Vec<String>, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = commands
        .into_iter()
        .map(|command| command.trim().to_string())
        .filter(|command| is_cacheable_command_name(command))
        .filter(|command| seen.insert(command.to_ascii_lowercase()))
        .collect::<Vec<_>>();
    normalized.sort_by_key(|command| command.to_ascii_lowercase());
    normalized.truncate(limit);
    normalized
}

fn is_cacheable_command_name(command: &str) -> bool {
    !command.is_empty()
        && command.chars().count() <= 128
        && command.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':' | '+')
        })
}

fn is_sensitive_command(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    normalized.contains("authorization:")
        || normalized.contains(" bearer ")
        || normalized.contains("api_key")
        || normalized.contains("apikey")
        || normalized.contains("password")
        || normalized.contains("passwd")
        || normalized.contains("secret")
        || normalized.contains("token=")
        || normalized.contains("private_key")
}

fn command_starts_with(command: &str, prefix: &str) -> bool {
    if cfg!(windows) {
        command
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
    } else {
        command.starts_with(prefix)
    }
}

fn historical_command_uses_path(command: &str, candidate: &str) -> bool {
    let command = command.trim();
    let candidate = candidate.trim();
    let directory_candidate = candidate.ends_with('/') || candidate.ends_with('\\');
    let candidate_without_separator = candidate.trim_end_matches(['/', '\\']);
    if command == candidate_without_separator {
        return true;
    }
    if directory_candidate && command.starts_with(candidate) {
        return true;
    }
    command.strip_prefix(candidate).is_some_and(|remainder| {
        remainder.is_empty() || remainder.chars().next().is_some_and(char::is_whitespace)
    })
}

fn char_prefix(value: &str, chars: usize) -> String {
    value.chars().take(chars).collect()
}

fn recency_bonus(index: usize) -> f64 {
    (100usize.saturating_sub(index).min(100) as f64) / 1000.0
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc, time::SystemTime};

    use crate::{
        models::{
            command_completion::{CommandCompletionProvider, CommandCompletionRequest},
            history::{CommandHistoryDraft, HistoryScopeKind},
            session::{AuthMode, SavedSessionDraft, SessionType},
            sftp::{FileEntry, FileKind},
            terminal::RuntimeSessionKind,
        },
        services::command_completion_service::{
            command_token, list_local_path_entries, parse_remote_command_output,
            path_command_waiting_for_argument, path_query, remote_path_cache_key,
            resolve_local_cwd, resolve_remote_cwd_candidate, CommandCompletionService,
            PathEntryFilter,
        },
        storage::{history::insert_command_history, sessions::save_session, sqlite::SqliteStore},
    };

    fn ssh_draft(name: &str) -> SavedSessionDraft {
        SavedSessionDraft {
            id: None,
            name: name.to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "example.test".to_string(),
            port: 22,
            username: "ops".to_string(),
            auth_mode: AuthMode::Agent,
            credential_ref: None,
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            ssh_options: None,
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        }
    }

    #[test]
    fn command_completion_prioritizes_current_history_and_filters_sensitive_commands() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let session_a = save_session(store.as_ref(), ssh_draft("A")).expect("session a");
        let session_b = save_session(store.as_ref(), ssh_draft("B")).expect("session b");

        for (session_id, runtime_id, command, started_at_ms) in [
            (Some(session_b.id.clone()), "runtime-b", "git branch", 10),
            (
                Some(session_a.id.clone()),
                "runtime-a",
                "git status --short",
                20,
            ),
            (
                Some(session_a.id.clone()),
                "runtime-a",
                "git status --short",
                30,
            ),
            (
                Some(session_a.id.clone()),
                "runtime-a",
                "curl -H 'Authorization: Bearer token'",
                40,
            ),
        ] {
            let scope_id = session_id
                .clone()
                .expect("test history should have a saved session");
            insert_command_history(
                store.as_ref(),
                CommandHistoryDraft {
                    scope_kind: Some(HistoryScopeKind::SavedSession),
                    scope_id: Some(scope_id),
                    runtime_session_id: runtime_id.to_string(),
                    command: command.to_string(),
                    cwd: None,
                    exit_code: None,
                    started_at_ms,
                    finished_at_ms: None,
                },
            )
            .expect("history insert");
        }

        let service = CommandCompletionService::new();
        service.register_runtime(
            "runtime-a",
            RuntimeSessionKind::Ssh,
            Some(session_a.id.clone()),
            Some(HistoryScopeKind::SavedSession),
            Some(session_a.id.clone()),
        );

        let candidates = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "git s".to_string(),
                    cursor: 5,
                    limit: Some(5),
                    cwd: None,
                },
            )
            .expect("completion should suggest");

        assert_eq!(candidates[0].replacement_text, "git status --short");
        assert_eq!(candidates[0].provider, CommandCompletionProvider::History);
        assert_eq!(candidates[0].suffix, "tatus --short");
        assert!(!candidates
            .iter()
            .any(|candidate| candidate.replacement_text.contains("Bearer")));
        assert_eq!(
            candidates
                .iter()
                .filter(|candidate| candidate.replacement_text == "git status --short")
                .count(),
            1
        );
    }

    #[test]
    fn command_completion_history_prefix_survives_substring_scan_limit() {
        let store = SqliteStore::open_in_memory().expect("store should open");
        let insert = |scope_id: &str, command: &str, started_at_ms| {
            insert_command_history(
                &store,
                CommandHistoryDraft {
                    scope_kind: Some(HistoryScopeKind::SavedSession),
                    scope_id: Some(scope_id.to_string()),
                    runtime_session_id: "runtime-prefix".to_string(),
                    command: command.to_string(),
                    cwd: None,
                    exit_code: None,
                    started_at_ms,
                    finished_at_ms: None,
                },
            )
            .expect("history insert");
        };
        insert("current", "zcustom current", 1);
        insert("other", "zcustom current", 2);
        insert("current", "zcustom current", 3);
        insert("other", "zcustom global", 4);
        for index in 0..550 {
            insert(
                "current",
                &format!("echo zcustom distraction-{index}"),
                100 + index,
            );
        }
        insert("current", "ZCUSTOM uppercase", 1000);
        let service = CommandCompletionService::new();
        service.register_runtime(
            "runtime-prefix",
            RuntimeSessionKind::Ssh,
            Some("current".to_string()),
            Some(HistoryScopeKind::SavedSession),
            Some("current".to_string()),
        );
        let candidates = service
            .suggest(
                &store,
                CommandCompletionRequest {
                    runtime_session_id: "runtime-prefix".to_string(),
                    input: "zcustom ".to_string(),
                    cursor: 8,
                    limit: Some(8),
                    cwd: None,
                },
            )
            .expect("prefix completion should suggest");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].replacement_text, "zcustom current");
        assert_eq!(candidates[0].suffix, "current");
        assert_eq!(candidates[0].source_label, "当前会话历史");
        assert_eq!(candidates[1].replacement_text, "zcustom global");
        assert_eq!(candidates[1].source_label, "全局历史");
        assert!(candidates[0].score > candidates[1].score);
    }

    #[test]
    fn command_completion_uses_system_commands_only_at_command_position() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let service = CommandCompletionService::new();
        service.register_runtime(
            "runtime-local",
            RuntimeSessionKind::Local,
            None,
            Some(HistoryScopeKind::LocalProfile),
            Some("pwsh".to_string()),
        );

        let command_position = command_token("git | ec").expect("token should exist");
        assert_eq!(command_position.name, "ec");
        assert_eq!(command_position.start, 6);
        assert!(command_token("git status").is_none());

        let candidates = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-local".to_string(),
                    input: "ec".to_string(),
                    cursor: 2,
                    limit: Some(5),
                    cwd: None,
                },
            )
            .expect("completion should suggest");

        assert!(candidates.iter().any(|candidate| {
            candidate.provider == CommandCompletionProvider::System
                && candidate.replacement_text == "echo"
        }));
    }

    #[test]
    fn command_completion_parses_remote_command_output_with_dedup_and_limits() {
        let commands = parse_remote_command_output(
            "git\nssh\nbad command\nkubectl\ngit\nsecret=bad\ncargo\n",
            3,
        );

        assert_eq!(commands, vec!["cargo", "git", "kubectl"]);
    }

    #[test]
    fn completion_refresh_caches_have_bounded_stale_and_generation_visibility() {
        let service = CommandCompletionService::new();
        let route = service
            .inner
            .refresh
            .bind("session", "route1".into())
            .unwrap();
        service.store_remote_commands_for_route(
            "session",
            vec!["example".into()],
            Some(route.clone()),
        );
        service.store_remote_path_entries_for_route(
            "session",
            "/tmp",
            "/tmp",
            vec![path_entry("example", FileKind::File)],
            Some(route.clone()),
        );
        {
            let mut commands = service.inner.remote_commands.lock().unwrap();
            commands.get_mut("session").unwrap().expires_at =
                std::time::Instant::now() - std::time::Duration::from_secs(1);
            let mut paths = service.inner.remote_paths.lock().unwrap();
            paths
                .get_mut(&remote_path_cache_key("session", "/tmp"))
                .unwrap()
                .expires_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
        }
        assert!(!service.remote_cache_is_fresh("session"));
        assert!(!service.remote_path_cache_is_fresh(&remote_path_cache_key("session", "/tmp")));
        assert_eq!(service.remote_commands("session").unwrap(), vec!["example"]);
        assert_eq!(
            service
                .remote_path_entries("session", "/tmp")
                .unwrap()
                .len(),
            1
        );
        service
            .inner
            .remote_paths
            .lock()
            .unwrap()
            .get_mut(&remote_path_cache_key("session", "/tmp"))
            .unwrap()
            .stale_until = std::time::Instant::now();
        assert!(service
            .remote_path_entries("session", "/tmp")
            .unwrap()
            .is_empty());
        let current = service
            .inner
            .refresh
            .bind("session", "route2".into())
            .unwrap();
        assert!(service.remote_commands("session").unwrap().is_empty());
        assert!(service
            .remote_path_entries("session", "/tmp")
            .unwrap()
            .is_empty());
        assert!(!service
            .inner
            .refresh
            .publish(&route, || panic!("obsolete result")));
        assert!(service.inner.refresh.publish(&current, || service
            .store_remote_commands_for_route(
                "session",
                vec!["current".into()],
                Some(current.clone())
            )));
        service
            .inner
            .remote_commands
            .lock()
            .unwrap()
            .get_mut("session")
            .unwrap()
            .stale_until = std::time::Instant::now();
        assert!(service.remote_commands("session").unwrap().is_empty());
    }

    #[test]
    fn completion_refresh_command_and_path_caches_are_bounded() {
        let service = CommandCompletionService::new();
        for index in 0..140 {
            service.store_remote_commands(&index.to_string(), vec!["example".into()]);
            service.store_remote_path_entries(
                &index.to_string(),
                "/tmp",
                "/canonical",
                vec![path_entry("example", FileKind::File)],
            );
        }
        assert!(service.inner.remote_commands.lock().unwrap().len() <= 128);
        assert!(service.inner.remote_paths.lock().unwrap().len() <= 128);
    }

    #[test]
    fn completion_refresh_rereads_changed_target_and_jump_routes_before_publish() {
        let store = SqliteStore::open_in_memory().unwrap();
        let mut target_draft = ssh_draft("target");
        let jump = save_session(&store, ssh_draft("jump")).unwrap();
        target_draft.ssh_options = Some(crate::models::session::SshOptions {
            jump_hosts: vec![jump.id.clone()],
            ..crate::models::session::SshOptions::default()
        });
        let target = save_session(&store, target_draft).unwrap();
        let service = CommandCompletionService::new();
        let (_, _, old_route) = service.prepare_remote_route(&store, &target.id).unwrap();
        let mut changed_jump = ssh_draft("jump");
        changed_jump.id = Some(jump.id);
        changed_jump.host = "changed.invalid".into();
        save_session(&store, changed_jump).unwrap();
        assert!(!service.route_still_current(&store, &target.id, &old_route));
        assert!(!service
            .inner
            .refresh
            .publish(&old_route, || panic!("old jump route")));
        let (_, _, new_route) = service.prepare_remote_route(&store, &target.id).unwrap();
        assert!(service.route_still_current(&store, &target.id, &new_route));
        let mut changed_target = ssh_draft("target");
        changed_target.id = Some(target.id.clone());
        changed_target.port = 2222;
        save_session(&store, changed_target).unwrap();
        assert!(!service.route_still_current(&store, &target.id, &new_route));
    }

    #[test]
    fn command_completion_deduplicates_remote_refresh_inflight_by_session() {
        let service = CommandCompletionService::new();
        let first = service
            .inner
            .refresh
            .bind("session-1", "route1".into())
            .unwrap();
        let second = service
            .inner
            .refresh
            .bind("session-2", "route2".into())
            .unwrap();
        let mut probe = service
            .inner
            .refresh
            .start(&first, "host1", "commands")
            .unwrap();
        assert!(service
            .inner
            .refresh
            .start(&first, "host1", "commands")
            .is_none());
        assert!(service
            .inner
            .refresh
            .start(&second, "host2", "commands")
            .is_some());
        probe.succeeded();
        drop(probe);
        assert!(service
            .inner
            .refresh
            .start(&first, "host1", "commands")
            .is_some());
    }

    #[test]
    fn path_query_supports_relative_absolute_home_and_quoted_paths() {
        assert!(path_query("cat lo", None, false).is_none());

        let relative = path_query("cp ../lo", Some("/srv/app"), false).expect("relative path");
        assert_eq!(relative.lookup_directory, "/srv/app/..");
        assert_eq!(relative.display_directory, "../");
        assert_eq!(relative.name_prefix, "lo");

        let absolute = path_query("ls /var/lo", Some("/srv/app"), false).expect("absolute path");
        assert_eq!(absolute.lookup_directory, "/var");
        assert_eq!(absolute.display_directory, "/var/");

        let absolute_without_cwd =
            path_query("ls /var/lo", None, false).expect("absolute path without cwd");
        assert_eq!(absolute_without_cwd.lookup_directory, "/var");

        let home = path_query("cat ~/Do", Some("/srv/app"), false).expect("home path");
        assert_eq!(home.lookup_directory, "~");
        assert_eq!(home.name_prefix, "Do");
        assert!(path_query("cat ~/Do", None, false).is_some());

        let quoted = path_query("mv \"My Fi", Some("/srv/app"), false).expect("quoted path");
        assert_eq!(quoted.name_prefix, "My Fi");
        assert_eq!(quoted.quote, Some('"'));
        assert!(!quoted.quote_closed);

        let closed = path_query("cd 'lo'", Some("/srv/app"), false).expect("closed quote");
        assert_eq!(closed.name_prefix, "lo");
        assert_eq!(closed.quote, Some('\''));
        assert!(closed.quote_closed);
    }

    #[test]
    fn path_query_understands_archive_and_docker_compose_argument_positions() {
        let tar_archive = path_query("tar -czf ar", Some("/srv"), false).expect("tar archive");
        assert_eq!(tar_archive.entry_filter, PathEntryFilter::Files);
        assert_eq!(tar_archive.name_prefix, "ar");

        let tar_directory =
            path_query("tar --directory=sr", Some("/srv"), false).expect("tar directory");
        assert_eq!(tar_directory.entry_filter, PathEntryFilter::Directories);
        assert_eq!(tar_directory.name_prefix, "sr");
        assert_eq!(
            tar_directory.token_start,
            "tar --directory=".chars().count()
        );

        let zip_archive = path_query("zip ar", Some("/srv"), false).expect("zip archive");
        assert_eq!(zip_archive.entry_filter, PathEntryFilter::Files);
        let zip_source = path_query("zip archive.zip sr", Some("/srv"), false).expect("zip source");
        assert_eq!(zip_source.entry_filter, PathEntryFilter::Any);

        let unzip_archive = path_query("unzip ar", Some("/srv"), false).expect("unzip archive");
        assert_eq!(unzip_archive.entry_filter, PathEntryFilter::Files);
        assert!(path_query("unzip archive.zip member", Some("/srv"), false).is_none());
        let unzip_destination =
            path_query("unzip archive.zip -d sr", Some("/srv"), false).expect("unzip target");
        assert_eq!(unzip_destination.entry_filter, PathEntryFilter::Directories);

        let compose_file =
            path_query("docker compose -f co", Some("/srv"), false).expect("compose file");
        assert_eq!(compose_file.entry_filter, PathEntryFilter::Files);
        let compose_inline = path_query("docker compose --file=co", Some("/srv"), false)
            .expect("inline compose file");
        assert_eq!(compose_inline.name_prefix, "co");
        assert_eq!(
            compose_inline.token_start,
            "docker compose --file=".chars().count()
        );
        let project_directory =
            path_query("docker compose --project-directory sr", Some("/srv"), false)
                .expect("compose project directory");
        assert_eq!(project_directory.entry_filter, PathEntryFilter::Directories);

        assert!(path_command_waiting_for_argument("tar -czf"));
        assert!(path_command_waiting_for_argument("docker compose --file"));
        assert!(!path_command_waiting_for_argument("docker compose"));
    }

    #[test]
    fn remote_path_cache_is_scoped_and_commands_filter_entry_kinds() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let service = CommandCompletionService::new();
        service.register_runtime(
            "runtime-a",
            RuntimeSessionKind::Ssh,
            Some("session-a".to_string()),
            None,
            None,
        );
        service.store_remote_path_entries(
            "session-a",
            "/srv",
            "/srv",
            vec![
                path_entry("logs", FileKind::Directory),
                path_entry("local.txt", FileKind::File),
            ],
        );

        let cd = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "cd lo".to_string(),
                    cursor: 5,
                    limit: Some(8),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("cd completion");
        assert!(cd
            .iter()
            .any(|candidate| candidate.replacement_text == "cd logs/"));
        assert!(!cd
            .iter()
            .any(|candidate| candidate.replacement_text.contains("local.txt")));

        let cat = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "cat lo".to_string(),
                    cursor: 6,
                    limit: Some(8),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("cat completion");
        assert!(cat
            .iter()
            .any(|candidate| candidate.replacement_text == "cat logs/"));
        assert!(cat
            .iter()
            .any(|candidate| candidate.replacement_text == "cat local.txt"));

        let less = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "less lo".to_string(),
                    cursor: 7,
                    limit: Some(8),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("less completion");
        assert!(less
            .iter()
            .any(|candidate| candidate.replacement_text == "less logs/"));
        assert!(less
            .iter()
            .any(|candidate| candidate.replacement_text == "less local.txt"));

        let mkdir = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "mkdir lo".to_string(),
                    cursor: 8,
                    limit: Some(8),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("mkdir completion");
        assert_eq!(mkdir.len(), 1);
        assert_eq!(mkdir[0].replacement_text, "mkdir logs/");
        let closed_quote = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "cd 'lo'".to_string(),
                    cursor: 7,
                    limit: Some(8),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("closed quote completion");
        assert!(closed_quote
            .iter()
            .any(|candidate| candidate.replacement_text == "cd 'logs/'"));

        service.store_remote_path_entries(
            "session-a",
            "/srv",
            "/srv",
            vec![
                path_entry("safe file", FileKind::File),
                path_entry("bad;touch pwn", FileKind::File),
                path_entry("bad$(touch pwn)", FileKind::File),
                path_entry("bad`id`", FileKind::File),
                path_entry("bad\r\ncommand", FileKind::File),
                path_entry("bad'quote", FileKind::File),
            ],
        );
        let safe = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-a".to_string(),
                    input: "cat ".to_string(),
                    cursor: 4,
                    limit: Some(20),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("safe path completion");
        assert!(safe
            .iter()
            .any(|candidate| candidate.replacement_text == "cat 'safe file'"));
        assert!(!safe.iter().any(|candidate| {
            candidate.replacement_text.contains("touch")
                || candidate.replacement_text.contains("`id`")
                || candidate.replacement_text.contains("command")
                || candidate.replacement_text.contains("quote")
        }));
        assert!(service
            .remote_path_entries("session-b", "/srv")
            .expect("session-b cache")
            .is_empty());
        let route = service
            .inner
            .refresh
            .bind("session-a", "route".into())
            .unwrap();
        let _probe = service
            .inner
            .refresh
            .start(&route, "host-a", "path:/tmp")
            .unwrap();
        assert!(service
            .inner
            .refresh
            .start(&route, "host-a", "path:/tmp")
            .is_none());

        for index in 0..200 {
            let directory = format!("/cache-{index}");
            service.store_remote_path_entries(
                "session-a",
                &directory,
                &directory,
                vec![path_entry("entry", FileKind::File)],
            );
        }
        assert!(service.inner.remote_paths.lock().expect("path cache").len() <= 128);
    }

    #[test]
    fn path_commands_never_fall_back_to_history_when_the_directory_has_no_match() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let session = save_session(store.as_ref(), ssh_draft("path context")).expect("session");
        insert_command_history(
            store.as_ref(),
            CommandHistoryDraft {
                scope_kind: Some(HistoryScopeKind::SavedSession),
                scope_id: Some(session.id.clone()),
                runtime_session_id: "runtime-path".to_string(),
                command: "cd config".to_string(),
                cwd: Some("/root".to_string()),
                exit_code: Some(0),
                started_at_ms: 10,
                finished_at_ms: Some(11),
            },
        )
        .expect("history insert");
        insert_command_history(
            store.as_ref(),
            CommandHistoryDraft {
                scope_kind: Some(HistoryScopeKind::SavedSession),
                scope_id: Some(session.id.clone()),
                runtime_session_id: "runtime-path".to_string(),
                command: "cd ssh".to_string(),
                cwd: Some("/root".to_string()),
                exit_code: Some(0),
                started_at_ms: 20,
                finished_at_ms: Some(21),
            },
        )
        .expect("frequent path history insert");

        let service = CommandCompletionService::new();
        service.register_runtime(
            "runtime-path",
            RuntimeSessionKind::Ssh,
            Some(session.id.clone()),
            Some(HistoryScopeKind::SavedSession),
            Some(session.id.clone()),
        );
        service.store_remote_path_entries(
            &session.id,
            "/root",
            "/root",
            vec![
                path_entry(".cache", FileKind::Directory),
                path_entry("snap", FileKind::Directory),
                path_entry("ssh", FileKind::Directory),
                path_entry(".vim", FileKind::Directory),
            ],
        );

        for input in ["cd", "cd c"] {
            let candidates = service
                .suggest(
                    store.as_ref(),
                    CommandCompletionRequest {
                        runtime_session_id: "runtime-path".to_string(),
                        input: input.to_string(),
                        cursor: input.chars().count(),
                        limit: Some(8),
                        cwd: Some("/root".to_string()),
                    },
                )
                .expect("path completion");
            assert!(candidates.is_empty(), "unexpected candidates for {input:?}");
        }

        let visible = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-path".to_string(),
                    input: "cd s".to_string(),
                    cursor: 4,
                    limit: Some(8),
                    cwd: Some("/root".to_string()),
                },
            )
            .expect("visible path completion");
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0].replacement_text, "cd ssh/");
        assert_eq!(visible[0].source_label, "远端路径 · 历史常用");
        assert!(visible
            .iter()
            .all(|candidate| candidate.provider == CommandCompletionProvider::Path));
        assert!(visible
            .iter()
            .any(|candidate| candidate.replacement_text == "cd snap/"));
        assert!(visible
            .iter()
            .any(|candidate| candidate.replacement_text == "cd ssh/"));

        let root = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-path".to_string(),
                    input: "cd ".to_string(),
                    cursor: 3,
                    limit: Some(8),
                    cwd: Some("/root".to_string()),
                },
            )
            .expect("root path completion");
        assert!(root
            .iter()
            .all(|candidate| !candidate.replacement_text.contains(".cache")
                && !candidate.replacement_text.contains(".vim")));

        let hidden = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-path".to_string(),
                    input: "cd .".to_string(),
                    cursor: 4,
                    limit: Some(8),
                    cwd: Some("/root".to_string()),
                },
            )
            .expect("hidden path completion");
        assert!(hidden
            .iter()
            .any(|candidate| candidate.replacement_text == "cd .cache/"));
    }

    #[test]
    fn archive_and_compose_commands_keep_matching_navigation_directories() {
        let store = Arc::new(SqliteStore::open_in_memory().expect("store should open"));
        let service = CommandCompletionService::new();
        service.register_runtime(
            "runtime-tools",
            RuntimeSessionKind::Ssh,
            Some("session-tools".to_string()),
            None,
            None,
        );
        service.store_remote_path_entries(
            "session-tools",
            "/srv",
            "/srv",
            vec![
                path_entry("archive.zip", FileKind::File),
                path_entry("compose.yaml", FileKind::File),
                path_entry("config", FileKind::Directory),
                path_entry("src", FileKind::Directory),
            ],
        );

        for (input, expected) in [
            ("tar -xf ar", "tar -xf archive.zip"),
            ("unzip ar", "unzip archive.zip"),
            ("zip archive.zip s", "zip archive.zip src/"),
            ("tar -czf backup.tar s", "tar -czf backup.tar src/"),
            ("docker compose -f co", "docker compose -f compose.yaml"),
            (
                "docker compose --file=co",
                "docker compose --file=compose.yaml",
            ),
            (
                "docker compose --project-directory c",
                "docker compose --project-directory config/",
            ),
        ] {
            let candidates = service
                .suggest(
                    store.as_ref(),
                    CommandCompletionRequest {
                        runtime_session_id: "runtime-tools".to_string(),
                        input: input.to_string(),
                        cursor: input.chars().count(),
                        limit: Some(8),
                        cwd: Some("/srv".to_string()),
                    },
                )
                .expect("tool path completion");
            assert!(
                candidates
                    .iter()
                    .all(|candidate| candidate.provider == CommandCompletionProvider::Path),
                "unexpected provider for {input:?}"
            );
            assert!(
                candidates
                    .iter()
                    .any(|candidate| candidate.replacement_text == expected),
                "missing expected candidate for {input:?}"
            );
        }

        let compose_files = service
            .suggest(
                store.as_ref(),
                CommandCompletionRequest {
                    runtime_session_id: "runtime-tools".to_string(),
                    input: "docker compose -f ".to_string(),
                    cursor: 18,
                    limit: Some(8),
                    cwd: Some("/srv".to_string()),
                },
            )
            .expect("compose files");
        assert!(compose_files
            .iter()
            .any(|candidate| candidate.replacement_text.ends_with("config/")));
    }

    #[test]
    fn local_path_listing_scans_past_two_hundred_entries_before_sorting() {
        let unique = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("zterm-completion-{}-{unique}", std::process::id()));
        fs::create_dir(&directory).expect("create test directory");
        for index in 0..205 {
            fs::write(directory.join(format!("entry-{index:03}")), b"").expect("create entry");
        }
        fs::write(directory.join("zzz-match"), b"").expect("create matching entry");

        let entries = list_local_path_entries(&directory.to_string_lossy());

        assert!(entries.iter().any(|entry| entry.name == "zzz-match"));
        fs::remove_dir_all(&directory).expect("remove test directory");
    }

    #[test]
    fn cwd_resolution_keeps_local_no_arg_rejects_missing_and_remote_no_arg_uses_home() {
        let current = std::env::current_dir().expect("current directory");
        assert_eq!(
            resolve_local_cwd(Some(&current.to_string_lossy()), None),
            Some(
                fs::canonicalize(&current)
                    .expect("canonical current directory")
                    .to_string_lossy()
                    .to_string()
            )
        );
        assert!(resolve_local_cwd(
            Some(&current.to_string_lossy()),
            Some("definitely-missing-zterm-directory")
        )
        .is_none());
        assert_eq!(
            resolve_remote_cwd_candidate(Some("/srv"), None, Some("/home/ops"))
                .expect("remote home"),
            "/home/ops"
        );
    }

    fn path_entry(name: &str, kind: FileKind) -> FileEntry {
        FileEntry {
            name: name.to_string(),
            path: format!("/srv/{name}"),
            kind,
            size: 0,
            modified_at_ms: None,
            permissions: None,
        }
    }
}
