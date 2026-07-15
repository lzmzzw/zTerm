// Author: Liz
use std::{
    env,
    io::Read,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use uuid::Uuid;
use zterm_lib::{
    models::session::{AuthMode, SavedSession, SessionType},
    paths::AppPaths,
    services::{credential_service::read_system_secret, terminal_manager::TerminalManager},
    storage::{sessions::list_sessions, sqlite::SqliteStore},
};

const KEYRING_SERVICE: &str = "zTerm";

#[derive(Debug, Clone)]
struct PromptSecret {
    target: String,
    secret: String,
}

#[test]
#[ignore = "requires a controlled SSH host and ZTERM_SMOKE_SSH_* environment variables"]
fn ssh_password_runtime_executes_basic_commands() {
    let host = env::var("ZTERM_SMOKE_SSH_HOST").expect("ZTERM_SMOKE_SSH_HOST is required");
    let username = env::var("ZTERM_SMOKE_SSH_USER").expect("ZTERM_SMOKE_SSH_USER is required");
    let password =
        env::var("ZTERM_SMOKE_SSH_PASSWORD").expect("ZTERM_SMOKE_SSH_PASSWORD is required");
    let port = env::var("ZTERM_SMOKE_SSH_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(22);

    let credential_ref = format!("smoke-{}", Uuid::new_v4());
    let entry = keyring::Entry::new(KEYRING_SERVICE, &credential_ref)
        .expect("smoke keyring entry should open");
    entry
        .set_password(&password)
        .expect("smoke keyring password should save");

    let result = run_ssh_smoke(host.clone(), username.clone(), port, credential_ref.clone());
    let _ = entry.delete_credential();

    let output = result.unwrap_or_else(|error| {
        panic!(
            "ssh smoke should complete: {}",
            sanitize(&error, &host, &username, &password)
        )
    });
    assert!(
        output.contains("ZTERM_PWD:"),
        "ssh smoke output did not contain pwd marker"
    );
    assert!(
        output.contains(&format!("ZTERM_USER:{username}")),
        "ssh smoke output did not contain user marker"
    );
}

#[test]
#[ignore = "requires ZTERM_SMOKE_USE_CONFIGURED_SSH=1, configured SSH sessions, keyring secrets, and reachable hosts"]
fn configured_ssh_sessions_execute_basic_commands() {
    if env::var("ZTERM_SMOKE_USE_CONFIGURED_SSH").ok().as_deref() != Some("1") {
        eprintln!("skipping configured SSH smoke; set ZTERM_SMOKE_USE_CONFIGURED_SSH=1");
        return;
    }

    let paths = AppPaths::default_for_install().expect("app data path should resolve");
    let store = SqliteStore::open(paths.db_path()).expect("configured zTerm database should open");
    let all_sessions = list_sessions(&store)
        .expect("configured sessions should load")
        .sessions;
    let ssh_sessions = all_sessions
        .iter()
        .cloned()
        .filter(|session| session.session_type == SessionType::Ssh)
        .collect::<Vec<_>>();

    assert!(
        !ssh_sessions.is_empty(),
        "configured SSH smoke requires at least one saved SSH session"
    );

    let mut failures = Vec::new();
    for (index, session) in ssh_sessions.iter().cloned().enumerate() {
        let secret = session
            .credential_ref
            .as_deref()
            .and_then(|credential_ref| read_system_secret(credential_ref).ok())
            .unwrap_or_default();
        let (resolved_session, prompt_secrets) =
            resolve_configured_ssh_jump_context(&session, &all_sessions).unwrap_or_else(|error| {
                panic!(
                    "configured SSH smoke setup failed for session #{}: {error}",
                    index + 1
                )
            });
        let mut secrets_to_redact = prompt_secrets
            .iter()
            .map(|item| item.secret.clone())
            .collect::<Vec<_>>();
        if !secret.is_empty() {
            secrets_to_redact.push(secret);
        }
        match run_configured_ssh_smoke(resolved_session.clone(), prompt_secrets) {
            Ok(output) => {
                assert!(
                    output.contains("ZTERM_PWD:"),
                    "configured SSH smoke output for session #{} did not contain pwd marker",
                    index + 1
                );
                assert!(
                    output.contains("ZTERM_USER:"),
                    "configured SSH smoke output for session #{} did not contain user marker",
                    index + 1
                );
            }
            Err(error) => failures.push(format!(
                "#{} {}",
                index + 1,
                sanitize_with_secrets(&error, &session.host, &session.username, &secrets_to_redact)
            )),
        }
    }

    assert!(
        failures.is_empty(),
        "configured SSH smoke failures: {}",
        failures.join("; ")
    );
}

fn run_ssh_smoke(
    host: String,
    username: String,
    port: u16,
    credential_ref: String,
) -> Result<String, String> {
    let manager = TerminalManager::default();
    let session = SavedSession {
        id: "smoke-ssh".to_string(),
        name: "SSH Smoke".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host,
        port,
        username: username.clone(),
        auth_mode: AuthMode::Password,
        credential_ref: Some(credential_ref),
        description: None,
        tags: Vec::new(),
        sort_order: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
        last_used_at_ms: None,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
        ftp_options: None,
    };
    let opened = manager
        .open_ssh_session(&session, "pane-smoke".to_string(), 100, 30)
        .map_err(|error| error.to_string())?;
    let runtime_id = opened.info.runtime_session_id.clone();
    let auth_secret = opened.auth_secret.clone();
    let (sender, receiver) = mpsc::channel::<Option<String>>();

    thread::spawn(move || read_terminal(opened.reader, sender));

    let mut output = String::new();
    let mut answered_auth = false;
    let mut sent_commands = false;
    let mut saw_command_markers = false;
    let deadline = Instant::now() + Duration::from_secs(45);

    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(chunk)) => {
                if !answered_auth && should_answer_auth_prompt(&chunk) {
                    if let Some(secret) = auth_secret.as_deref() {
                        answered_auth = true;
                        manager
                            .write(&runtime_id, &format!("{secret}\r"))
                            .map_err(|error| error.to_string())?;
                    }
                }
                output.push_str(&chunk);
                if chunk.contains("\u{1b}[6n") {
                    manager
                        .write(&runtime_id, "\u{1b}[1;1R")
                        .map_err(|error| error.to_string())?;
                }
                if !sent_commands && shell_prompt_is_visible(&output) {
                    sent_commands = true;
                    manager
                        .write(
                            &runtime_id,
                            "printf 'ZTERM_PWD:%s\\n' \"$PWD\"\rprintf 'ZTERM_USER:%s\\n' \"$(whoami)\"\rexit\r",
                        )
                        .map_err(|error| error.to_string())?;
                }
                if output.contains("ZTERM_PWD:")
                    && output.contains(&format!("ZTERM_USER:{username}"))
                {
                    saw_command_markers = true;
                }
                if saw_command_markers
                    && manager
                        .try_wait_exit_code(&runtime_id)
                        .map_err(|error| error.to_string())?
                        .is_some()
                {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
            }
            Ok(None) => {
                if saw_command_markers {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if saw_command_markers
                    && manager
                        .try_wait_exit_code(&runtime_id)
                        .map_err(|error| error.to_string())?
                        .is_some()
                {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let _ = manager.close(&runtime_id);
    let reason = if saw_command_markers {
        "ssh smoke saw command markers but did not observe exit"
    } else {
        "ssh smoke timed out before command markers were observed"
    };
    Err(format!("{reason}; tail={}", terminal_tail(&output)))
}

fn run_configured_ssh_smoke(
    session: SavedSession,
    mut prompt_secrets: Vec<PromptSecret>,
) -> Result<String, String> {
    let manager = TerminalManager::default();
    let opened = manager
        .open_ssh_session(&session, "pane-configured-smoke".to_string(), 100, 30)
        .map_err(|error| error.to_string())?;
    let runtime_id = opened.info.runtime_session_id.clone();
    if let Some(secret) = opened.auth_secret.clone() {
        prompt_secrets.push(PromptSecret {
            target: ssh_prompt_target(&session),
            secret,
        });
    }
    let (sender, receiver) = mpsc::channel::<Option<String>>();

    thread::spawn(move || read_terminal(opened.reader, sender));

    let mut output = String::new();
    let mut sent_commands = false;
    let mut saw_command_markers = false;
    let mut used_prompt_secrets = vec![false; prompt_secrets.len()];
    let deadline = Instant::now() + Duration::from_secs(45);

    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(Some(chunk)) => {
                if should_answer_auth_prompt(&chunk) {
                    if let Some(index) =
                        select_prompt_secret_index(&chunk, &prompt_secrets, &used_prompt_secrets)
                    {
                        used_prompt_secrets[index] = true;
                        manager
                            .write(&runtime_id, &format!("{}\r", prompt_secrets[index].secret))
                            .map_err(|error| error.to_string())?;
                    }
                }
                output.push_str(&chunk);
                if chunk.contains("\u{1b}[6n") {
                    manager
                        .write(&runtime_id, "\u{1b}[1;1R")
                        .map_err(|error| error.to_string())?;
                }
                if !sent_commands && shell_prompt_is_visible(&output) {
                    sent_commands = true;
                    manager
                        .write(
                            &runtime_id,
                            "printf 'ZTERM_PWD:%s\\n' \"$PWD\"\rprintf 'ZTERM_USER:%s\\n' \"$(whoami)\"\rexit\r",
                        )
                        .map_err(|error| error.to_string())?;
                }
                if output.contains("ZTERM_PWD:") && output.contains("ZTERM_USER:") {
                    saw_command_markers = true;
                }
                if saw_command_markers
                    && manager
                        .try_wait_exit_code(&runtime_id)
                        .map_err(|error| error.to_string())?
                        .is_some()
                {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
            }
            Ok(None) => {
                if saw_command_markers {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if saw_command_markers
                    && manager
                        .try_wait_exit_code(&runtime_id)
                        .map_err(|error| error.to_string())?
                        .is_some()
                {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let _ = manager.close(&runtime_id);
    let reason = if saw_command_markers {
        "configured ssh smoke saw command markers but did not observe exit"
    } else {
        "configured ssh smoke timed out before command markers were observed"
    };
    Err(format!("{reason}; tail={}", terminal_tail(&output)))
}

fn resolve_configured_ssh_jump_context(
    session: &SavedSession,
    saved_sessions: &[SavedSession],
) -> Result<(SavedSession, Vec<PromptSecret>), String> {
    let Some(options) = session.ssh_options.as_ref() else {
        return Ok((session.clone(), Vec::new()));
    };
    if options.jump_hosts.is_empty() {
        return Ok((session.clone(), Vec::new()));
    }

    let mut resolved_session = session.clone();
    let mut resolved_jump_hosts = Vec::with_capacity(options.jump_hosts.len());
    let mut prompt_secrets = Vec::new();

    for jump_host in &options.jump_hosts {
        let Some(jump_session) = saved_sessions
            .iter()
            .find(|candidate| jump_host_matches_session(jump_host, candidate, &session.id))
        else {
            let normalized = jump_host.trim();
            if !normalized.is_empty() {
                resolved_jump_hosts.push(normalized.to_string());
            }
            continue;
        };

        resolved_jump_hosts.push(ssh_jump_target(jump_session));
        if let Some(secret) = prompt_secret_for_session(jump_session)? {
            prompt_secrets.push(secret);
        }
    }

    if let Some(options) = resolved_session.ssh_options.as_mut() {
        options.jump_hosts = resolved_jump_hosts;
    }

    Ok((resolved_session, prompt_secrets))
}

fn jump_host_matches_session(
    jump_host: &str,
    candidate: &SavedSession,
    current_session_id: &str,
) -> bool {
    if candidate.session_type != SessionType::Ssh || candidate.id == current_session_id {
        return false;
    }

    let normalized_jump_host = normalize_auth_target(jump_host);
    if normalized_jump_host.is_empty() {
        return false;
    }

    normalized_jump_host == normalize_auth_target(&ssh_prompt_target(candidate))
        || normalized_jump_host == normalize_auth_target(&ssh_jump_target(candidate))
}

fn prompt_secret_for_session(session: &SavedSession) -> Result<Option<PromptSecret>, String> {
    match session.auth_mode {
        AuthMode::Password | AuthMode::Key => session
            .credential_ref
            .as_deref()
            .map(read_system_secret)
            .transpose()
            .map(|secret| {
                secret.map(|value| PromptSecret {
                    target: ssh_prompt_target(session),
                    secret: value,
                })
            })
            .map_err(|error| error.to_string()),
        AuthMode::Agent | AuthMode::None => Ok(None),
    }
}

fn ssh_prompt_target(session: &SavedSession) -> String {
    let host = session.host.trim();
    let username = session.username.trim();
    if username.is_empty() {
        host.to_string()
    } else {
        format!("{username}@{host}")
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

fn select_prompt_secret_index(
    data: &str,
    prompt_secrets: &[PromptSecret],
    used_prompt_secrets: &[bool],
) -> Option<usize> {
    let normalized_data = data.to_ascii_lowercase();
    for (index, prompt_secret) in prompt_secrets.iter().enumerate() {
        if used_prompt_secrets.get(index).copied().unwrap_or(true) {
            continue;
        }
        let target = prompt_secret.target.to_ascii_lowercase();
        if !target.is_empty() && normalized_data.contains(&target) {
            return Some(index);
        }
    }

    let host_matches = prompt_secrets
        .iter()
        .enumerate()
        .filter(|(index, _)| !used_prompt_secrets.get(*index).copied().unwrap_or(true))
        .filter(|(_, prompt_secret)| {
            target_host(&prompt_secret.target)
                .map(|host| normalized_data.contains(&host.to_ascii_lowercase()))
                .unwrap_or(false)
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if host_matches.len() == 1 {
        return host_matches.first().copied();
    }
    if normalized_data.contains('@') || normalized_data.contains("'s password:") {
        return None;
    }

    let unused = prompt_secrets
        .iter()
        .enumerate()
        .filter(|(index, _)| !used_prompt_secrets.get(*index).copied().unwrap_or(true))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if unused.len() == 1 {
        return unused.first().copied();
    }

    None
}

fn target_host(target: &str) -> Option<&str> {
    let host = target
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(target);
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.split_once(':').map(|(host, _)| host).unwrap_or(host))
}

fn read_terminal(mut reader: Box<dyn Read + Send>, sender: mpsc::Sender<Option<String>>) {
    let mut buffer = [0_u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let _ = sender.send(None);
                return;
            }
            Ok(read) => {
                let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
                let _ = sender.send(Some(chunk));
            }
            Err(_) => {
                let _ = sender.send(None);
                return;
            }
        }
    }
}

fn should_answer_auth_prompt(data: &str) -> bool {
    let normalized = data.to_ascii_lowercase();
    normalized.contains("password:") || normalized.contains("passphrase for key")
}

fn shell_prompt_is_visible(output: &str) -> bool {
    let plain = strip_terminal_controls(output);
    plain.ends_with("$ ") || plain.ends_with("# ") || plain.contains("\r\n$ ")
}

fn terminal_tail(output: &str) -> String {
    let mut chars: Vec<char> = output.chars().rev().take(600).collect();
    chars.reverse();
    chars.into_iter().collect::<String>()
}

fn sanitize(text: &str, host: &str, username: &str, password: &str) -> String {
    sanitize_with_secrets(text, host, username, &[password.to_string()])
}

fn sanitize_with_secrets(text: &str, host: &str, username: &str, secrets: &[String]) -> String {
    let mut sanitized = text.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            sanitized = sanitized.replace(secret, "<redacted-secret>");
        }
    }
    if !host.is_empty() {
        sanitized = sanitized.replace(host, "<redacted-host>");
    }
    if !username.is_empty() {
        sanitized = sanitized.replace(username, "<redacted-user>");
    }
    redact_ipv4_addresses(&sanitized)
}

fn redact_ipv4_addresses(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if !ch.is_ascii_digit() {
            output.push(ch);
            continue;
        }

        let mut token = String::from(ch);
        while let Some(next) = chars.peek().copied() {
            if next.is_ascii_digit() || next == '.' {
                token.push(next);
                chars.next();
            } else {
                break;
            }
        }

        if looks_like_ipv4(&token) {
            output.push_str("<redacted-host>");
        } else {
            output.push_str(&token);
        }
    }
    output
}

fn looks_like_ipv4(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    parts.len() == 4 && parts.iter().all(|part| part.parse::<u8>().is_ok())
}

fn strip_terminal_controls(input: &str) -> String {
    let mut output = String::new();
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                for next in chars.by_ref() {
                    if next == '\u{7}' {
                        break;
                    }
                }
            }
            _ => {}
        }
    }

    output
}
