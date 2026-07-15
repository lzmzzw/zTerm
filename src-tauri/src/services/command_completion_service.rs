// Author: Liz
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use crate::{
    error::{AppError, AppResult},
    models::{
        command_completion::{
            CommandCompletionCandidate, CommandCompletionProvider,
            CommandCompletionReplacementRange, CommandCompletionRequest,
        },
        history::{HistoryScopeKind, HistorySearchOptions},
        session::SessionType,
        terminal::RuntimeSessionKind,
    },
    services::{credential_service::CredentialService, ssh_command_service::SshCommandService},
    storage::{
        history::{search_command_history, search_global_command_history},
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

#[derive(Clone, Default)]
pub struct CommandCompletionService {
    inner: Arc<CommandCompletionState>,
}

#[derive(Default)]
struct CommandCompletionState {
    local_commands: Mutex<Option<CachedCommands>>,
    remote_commands: Mutex<HashMap<String, CachedCommands>>,
    remote_refresh_inflight: Mutex<HashSet<String>>,
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
        let mut candidates = Vec::new();
        let mut seen_replacements = HashSet::new();

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
        if saved_session_id.trim().is_empty() || self.remote_cache_is_fresh(&saved_session_id) {
            return;
        }
        if !self.try_mark_remote_refresh(&saved_session_id) {
            return;
        }
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result: AppResult<Vec<String>> = async {
                let session = get_session(store.as_ref(), &saved_session_id)?;
                if session.session_type != SessionType::Ssh {
                    return Ok(Vec::new());
                }
                let all_sessions = list_sessions(store.as_ref())?.sessions;
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
                if output.success {
                    Ok(parse_remote_command_output(
                        &output.stdout,
                        MAX_SYSTEM_COMMANDS,
                    ))
                } else {
                    Ok(Vec::new())
                }
            }
            .await;

            if let Ok(commands) = result {
                service.store_remote_commands(&saved_session_id, commands);
            }
            service.finish_remote_refresh(&saved_session_id);
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
        let entries = match (scope_kind, scope_id) {
            (Some(scope_kind), Some(scope_id)) => search_command_history(
                store,
                HistorySearchOptions {
                    query: Some(request.prefix.clone()),
                    scope_kind: Some(scope_kind),
                    scope_id: Some(scope_id.to_string()),
                    limit: Some(HISTORY_SCAN_LIMIT),
                    deduplicate: Some(true),
                },
            )?,
            (None, None) => search_global_command_history(
                store,
                Some(request.prefix.clone()),
                Some(HISTORY_SCAN_LIMIT),
                Some(true),
            )?,
            _ => return Err(AppError::validation("历史作用域类型和 ID 必须同时提供")),
        };
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
        let mut cache = self.remote_command_cache()?;
        if let Some(entry) = cache
            .get(saved_session_id)
            .filter(|entry| entry.expires_at > Instant::now())
        {
            return Ok(entry.commands.clone());
        }
        cache.remove(saved_session_id);
        Ok(Vec::new())
    }

    fn remote_cache_is_fresh(&self, saved_session_id: &str) -> bool {
        self.inner
            .remote_commands
            .lock()
            .ok()
            .and_then(|cache| cache.get(saved_session_id).cloned())
            .is_some_and(|entry| entry.expires_at > Instant::now())
    }

    fn try_mark_remote_refresh(&self, saved_session_id: &str) -> bool {
        let Ok(mut inflight) = self.inner.remote_refresh_inflight.lock() else {
            return false;
        };
        if inflight.contains(saved_session_id) {
            return false;
        }
        inflight.insert(saved_session_id.to_string());
        true
    }

    fn finish_remote_refresh(&self, saved_session_id: &str) {
        if let Ok(mut inflight) = self.inner.remote_refresh_inflight.lock() {
            inflight.remove(saved_session_id);
        }
    }

    fn store_remote_commands(&self, saved_session_id: &str, commands: Vec<String>) {
        let commands = normalize_command_names(commands, MAX_SYSTEM_COMMANDS);
        if let Ok(mut cache) = self.inner.remote_commands.lock() {
            cache.insert(
                saved_session_id.to_string(),
                CachedCommands {
                    commands,
                    expires_at: Instant::now() + REMOTE_COMMAND_TTL,
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
        })
    }
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

fn char_prefix(value: &str, chars: usize) -> String {
    value.chars().take(chars).collect()
}

fn recency_bonus(index: usize) -> f64 {
    (100usize.saturating_sub(index).min(100) as f64) / 1000.0
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::{
        models::{
            command_completion::{CommandCompletionProvider, CommandCompletionRequest},
            history::{CommandHistoryDraft, HistoryScopeKind},
            session::{AuthMode, SavedSessionDraft, SessionType},
            terminal::RuntimeSessionKind,
        },
        services::command_completion_service::{
            command_token, parse_remote_command_output, CommandCompletionService,
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
    fn command_completion_deduplicates_remote_refresh_inflight_by_session() {
        let service = CommandCompletionService::new();

        assert!(service.try_mark_remote_refresh("session-1"));
        assert!(!service.try_mark_remote_refresh("session-1"));
        assert!(service.try_mark_remote_refresh("session-2"));

        service.finish_remote_refresh("session-1");

        assert!(service.try_mark_remote_refresh("session-1"));
    }
}
