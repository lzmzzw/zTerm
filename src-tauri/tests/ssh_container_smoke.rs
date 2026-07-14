// Author: Liz
use std::{
    env,
    io::Read,
    sync::{mpsc, Arc},
    thread,
    time::{Duration, Instant},
};

use zterm_lib::{
    models::session::SavedSession,
    paths::AppPaths,
    services::{
        credential_service::CredentialService,
        ssh_command_service::SshCommandService,
        ssh_container_service::{
            build_container_list_script, enabled_container_options, parse_container_ps_output,
        },
        terminal_manager::TerminalManager,
    },
    storage::{sessions::list_sessions, sqlite::SqliteStore},
};

#[tokio::test]
#[ignore = "requires ZTERM_SMOKE_USE_CONFIGURED_SSH_CONTAINER=1, a configured SSH session, keyring secret, and a running container"]
async fn configured_ssh_container_lists_and_enters_running_container() {
    if env::var("ZTERM_SMOKE_USE_CONFIGURED_SSH_CONTAINER")
        .ok()
        .as_deref()
        != Some("1")
    {
        eprintln!(
            "skipping configured SSH container smoke; set ZTERM_SMOKE_USE_CONFIGURED_SSH_CONTAINER=1"
        );
        return;
    }

    let paths = AppPaths::default_for_install().expect("app data path should resolve");
    let store = Arc::new(
        SqliteStore::open(paths.db_path()).expect("configured zTerm database should open"),
    );
    let all_sessions = list_sessions(store.as_ref())
        .expect("configured sessions should load")
        .sessions;
    let session = configured_container_session(&all_sessions).unwrap_or_else(|| {
        panic!("configured SSH container smoke requires a matching SSH session")
    });
    let container_options =
        enabled_container_options(&session).expect("target SSH session should enable containers");
    let script = build_container_list_script(&container_options.runtime)
        .expect("container list script should build");
    let credential_service = CredentialService::new(Arc::clone(&store));
    let output = SshCommandService::new()
        .execute(&session, &all_sessions, script, &credential_service)
        .await
        .expect("container list command should execute over SSH");

    assert!(
        output.success,
        "container list command failed: {}",
        first_non_empty(&output.stderr, &output.stdout)
    );

    let containers = parse_container_ps_output(&output.stdout);
    let container = containers
        .iter()
        .find(|container| container.running)
        .unwrap_or_else(|| {
            panic!(
                "configured SSH container smoke requires at least one running container; stdout={:?}; stderr={:?}",
                output.stdout, output.stderr
            )
        });

    let container_name = if container.name.trim().is_empty() {
        None
    } else {
        Some(container.name.as_str())
    };
    let output = enter_container_smoke(&session, &container.id, container_name)
        .unwrap_or_else(|error| panic!("container terminal smoke should complete: {error}"));
    assert!(
        output.contains("ZTERM_CONTAINER_SMOKE_OK:"),
        "container smoke output did not contain marker"
    );
}

fn configured_container_session(sessions: &[SavedSession]) -> Option<SavedSession> {
    let target_id = env::var("ZTERM_SMOKE_SSH_CONTAINER_SESSION_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let target_host = env::var("ZTERM_SMOKE_SSH_CONTAINER_HOST")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "172.16.41.180".to_string());

    sessions
        .iter()
        .find(|session| {
            target_id
                .as_deref()
                .map(|id| session.id == id)
                .unwrap_or_else(|| session.host == target_host)
        })
        .cloned()
}

fn enter_container_smoke(
    session: &SavedSession,
    container_id: &str,
    container_name: Option<&str>,
) -> Result<String, String> {
    let manager = TerminalManager::default();
    let opened = manager
        .open_ssh_container_session(
            session,
            "pane-container-smoke".to_string(),
            container_id.to_string(),
            container_name.map(ToOwned::to_owned),
            100,
            30,
        )
        .map_err(|error| error.to_string())?;
    let runtime_id = opened.info.runtime_session_id.clone();
    let auth_secret = opened.auth_secret.clone();
    let (sender, receiver) = mpsc::channel::<Option<String>>();

    thread::spawn(move || read_terminal(opened.reader, sender));

    let mut output = String::new();
    let mut answered_auth = false;
    let mut sent_marker = false;
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
                if !sent_marker && shell_prompt_is_visible(&output) {
                    sent_marker = true;
                    manager
                        .write(
                            &runtime_id,
                            "printf 'ZTERM_CONTAINER_SMOKE_OK:%s:%s\\n' \"$(whoami)\" \"$PWD\"\rexit\r",
                        )
                        .map_err(|error| error.to_string())?;
                }
                if output.contains("ZTERM_CONTAINER_SMOKE_OK:") {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if output.contains("ZTERM_CONTAINER_SMOKE_OK:") {
                    let _ = manager.close(&runtime_id);
                    return Ok(output);
                }
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let _ = manager.close(&runtime_id);
    Err(format!(
        "container smoke timed out before marker was observed; tail={}",
        terminal_tail(&output)
    ))
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

fn first_non_empty<'a>(left: &'a str, right: &'a str) -> &'a str {
    if left.trim().is_empty() {
        right.trim()
    } else {
        left.trim()
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
