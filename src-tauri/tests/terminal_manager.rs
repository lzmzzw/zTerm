// Author: Liz
use std::{
    io::Read,
    path::PathBuf,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use zterm_lib::{
    models::{session::LocalOptions, terminal_profile::TerminalProfile},
    services::terminal_manager::TerminalManager,
};

#[test]
fn local_cmd_runtime_executes_basic_command() {
    let manager = TerminalManager::default();
    let profile = cmd_profile();
    let opened = manager
        .open_local_session(
            &profile,
            Some(&LocalOptions {
                profile_id: Some(profile.id.clone()),
                working_directory: None,
                environment: Vec::new(),
            }),
            "pane-local-smoke".to_string(),
            None,
            profile.name.clone(),
            100,
            30,
        )
        .expect("local cmd runtime should open");
    let runtime_id = opened.info.runtime_session_id.clone();
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    thread::spawn(move || read_terminal(opened.reader, sender));

    assert_eq!(opened.info.kind.as_str(), "local");
    assert_eq!(opened.info.history_scope_id.as_deref(), Some("cmd"));

    let marker = "ZTERM_LOCAL_CMD_SMOKE_OK";
    let mut output = String::new();
    let mut answered_cpr = false;
    let mut sent_command = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(chunk)) => {
                if !answered_cpr && chunk.contains("\u{1b}[6n") {
                    answered_cpr = true;
                    manager
                        .write(&runtime_id, "\u{1b}[1;1R")
                        .expect("local cmd runtime should accept CPR response");
                }
                output.push_str(&chunk);
                if !sent_command && (answered_cpr || output.contains('>')) {
                    sent_command = true;
                    manager
                        .write(&runtime_id, &format!("echo {marker}\r\nexit\r\n"))
                        .expect("local cmd runtime should accept input");
                }
                if output.contains(marker) {
                    let _ = manager.close(&runtime_id);
                    return;
                }
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("local cmd reader channel failed: {error}"),
        }
    }

    let _ = manager.close(&runtime_id);
    panic!(
        "local cmd runtime did not produce marker; tail={}",
        terminal_tail(&output)
    );
}

#[test]
fn local_git_bash_runtime_executes_basic_command_when_available() {
    let Some(profile) = git_bash_profile() else {
        eprintln!("Git Bash is not installed in a known path; skipping local Git Bash smoke");
        return;
    };
    let manager = TerminalManager::default();
    let opened = manager
        .open_local_session(
            &profile,
            Some(&LocalOptions {
                profile_id: Some(profile.id.clone()),
                working_directory: None,
                environment: Vec::new(),
            }),
            "pane-git-bash-smoke".to_string(),
            None,
            profile.name.clone(),
            100,
            30,
        )
        .expect("local Git Bash runtime should open");
    let runtime_id = opened.info.runtime_session_id.clone();
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    thread::spawn(move || read_terminal(opened.reader, sender));

    assert_eq!(opened.info.kind.as_str(), "local");
    assert_eq!(opened.info.history_scope_id.as_deref(), Some("git-bash"));

    let marker = "ZTERM_LOCAL_GIT_BASH_SMOKE_OK";
    let mut output = String::new();
    let mut answered_cpr = false;
    let mut sent_command = false;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(chunk)) => {
                output.push_str(&chunk);
                if !answered_cpr && chunk.contains("\u{1b}[6n") {
                    answered_cpr = true;
                    manager
                        .write(&runtime_id, "\u{1b}[1;1R")
                        .expect("local Git Bash runtime should accept CPR response");
                }
                if !sent_command && answered_cpr {
                    sent_command = true;
                    manager
                        .write(&runtime_id, &format!("echo {marker}\r\nexit\r\n"))
                        .expect("local Git Bash runtime should accept input");
                }
                if output.contains(marker) {
                    let _ = manager.close(&runtime_id);
                    return;
                }
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("local Git Bash reader channel failed: {error}"),
        }
    }

    let _ = manager.close(&runtime_id);
    panic!(
        "local Git Bash runtime did not produce marker; tail={}",
        terminal_tail(&output)
    );
}

#[test]
fn rdp_open_creates_placeholder_runtime_without_pty() {
    let manager = TerminalManager::default();

    let info = manager
        .open_rdp_placeholder(
            "saved-rdp".to_string(),
            "pane-1".to_string(),
            "办公 RDP".to_string(),
        )
        .expect("rdp placeholder should open");

    assert_eq!(info.saved_session_id.as_deref(), Some("saved-rdp"));
    assert_eq!(info.pane_id, "pane-1");
    assert_eq!(info.title, "办公 RDP");
    assert_eq!(info.kind.as_str(), "rdp_placeholder");
    assert_eq!(manager.runtime_count(), 1);
}

#[test]
fn closing_placeholder_runtime_removes_it_from_manager() {
    let manager = TerminalManager::default();
    let info = manager
        .open_rdp_placeholder(
            "saved-rdp".to_string(),
            "pane-1".to_string(),
            "办公 RDP".to_string(),
        )
        .expect("rdp placeholder should open");

    let closed = manager
        .close(&info.runtime_session_id)
        .expect("placeholder should close");

    assert!(closed.closed);
    assert_eq!(manager.runtime_count(), 0);
}

#[test]
fn placeholder_runtime_rejects_raw_byte_writes() {
    let manager = TerminalManager::default();
    let info = manager
        .open_rdp_placeholder(
            "saved-rdp".to_string(),
            "pane-1".to_string(),
            "办公 RDP".to_string(),
        )
        .expect("rdp placeholder should open");

    let error = manager
        .write_bytes(&info.runtime_session_id, &[0, 255, b'Z'])
        .expect_err("placeholder should reject raw terminal bytes");

    assert!(error.to_string().contains("RDP placeholder"));
}

fn cmd_profile() -> TerminalProfile {
    let path = std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
    assert!(
        path.is_file(),
        "cmd.exe is required for local terminal smoke: {}",
        path.display()
    );

    TerminalProfile {
        id: "cmd".to_string(),
        name: "Command Prompt".to_string(),
        path: path.to_string_lossy().to_string(),
        args: vec!["/Q".to_string()],
        detected: true,
        is_default: true,
        created_at_ms: 0,
        updated_at_ms: 0,
    }
}

fn git_bash_profile() -> Option<TerminalProfile> {
    let candidates = [
        PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default()
            .join(r"Programs\Git\bin\bash.exe"),
    ];
    let path = candidates.into_iter().find(|path| path.is_file())?;
    Some(TerminalProfile {
        id: "git-bash".to_string(),
        name: "Git Bash".to_string(),
        path: path.to_string_lossy().to_string(),
        args: vec!["--login".to_string(), "-i".to_string()],
        detected: true,
        is_default: true,
        created_at_ms: 0,
        updated_at_ms: 0,
    })
}

fn read_terminal(mut reader: Box<dyn Read + Send>, sender: mpsc::Sender<Option<String>>) {
    let mut buffer = [0_u8; 4096];
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

fn terminal_tail(output: &str) -> String {
    let mut chars = output.chars().rev().take(400).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
}
