// Author: Liz
use std::{
    fs,
    io::Read,
    path::PathBuf,
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use zterm_lib::{
    models::{session::LocalOptions, terminal_profile::TerminalProfile},
    services::terminal_manager::{AgentCodexPtyOptions, TerminalManager},
};

#[cfg(windows)]
#[test]
fn agent_codex_pty_overrides_inherited_dumb_terminal_environment() {
    let manager = TerminalManager::default();
    let opened = manager
        .open_agent_codex_session(AgentCodexPtyOptions {
            command_path: "cmd.exe".to_string(),
            args: vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                "echo TERM=%TERM% COLORTERM=%COLORTERM% TERM_PROGRAM=%TERM_PROGRAM% & echo WT_SESSION=%WT_SESSION%".to_string(),
            ],
            cwd: std::env::temp_dir(),
            environment: vec![
                ("TERM".to_string(), "xterm-256color".to_string()),
                ("COLORTERM".to_string(), "truecolor".to_string()),
                ("TERM_PROGRAM".to_string(), "zTerm".to_string()),
                ("WT_SESSION".to_string(), "zterm-agent-conpty".to_string()),
            ],
            pane_id: "agent:terminal-env-smoke".to_string(),
            title: "Codex terminal environment smoke".to_string(),
            cols: 80,
            rows: 30,
        })
        .expect("agent Codex PTY should open");
    let runtime_id = opened.info.runtime_session_id.clone();
    let reader = opened.reader;
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    thread::spawn(move || read_terminal(reader, sender));
    let mut output = String::new();
    let mut cursor_queries = CursorPositionQueries::default();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(chunk)) => {
                cursor_queries.answer(&manager, &runtime_id, &chunk);
                output.push_str(&chunk);
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("agent PTY reader channel failed: {error}"),
        }
    }
    let _ = manager.close(&runtime_id);

    assert!(
        output.contains("TERM=xterm-256color COLORTERM=truecolor TERM_PROGRAM=zTerm"),
        "agent Codex PTY did not receive terminal capability overrides: {}",
        terminal_tail(&output)
    );
    assert!(!output.contains("TERM=dumb"));
    assert!(
        output.contains("WT_SESSION=zterm-agent-conpty"),
        "Agent ConPTY child must receive the full-screen history compatibility marker"
    );
}

#[cfg(windows)]
#[test]
fn closing_pty_runtime_reaps_its_child_within_the_bounded_close_path() {
    let manager = TerminalManager::default();
    let pid_path = std::env::temp_dir().join(format!(
        "zterm-pty-reap-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after Unix epoch")
            .as_nanos()
    ));
    let quoted_pid_path = pid_path.to_string_lossy().replace('\'', "''");
    let command = format!(
        "$PID | Set-Content -NoNewline -LiteralPath '{quoted_pid_path}'; Start-Sleep -Seconds 30"
    );
    let opened = manager
        .open_agent_codex_session(AgentCodexPtyOptions {
            command_path: "powershell.exe".to_string(),
            args: vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                command,
            ],
            cwd: std::env::temp_dir(),
            environment: Vec::new(),
            pane_id: "pty-reap-test".to_string(),
            title: "PTY reap test".to_string(),
            cols: 80,
            rows: 24,
        })
        .expect("PTY child should start");
    let runtime_id = opened.info.runtime_session_id.clone();
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    thread::spawn(move || read_terminal(opened.reader, sender));

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut output = String::new();
    let mut cursor_queries = CursorPositionQueries::default();
    while !pid_path.is_file() && Instant::now() < deadline {
        if let Ok(Some(chunk)) = receiver.recv_timeout(Duration::from_millis(20)) {
            cursor_queries.answer(&manager, &runtime_id, &chunk);
            output.push_str(&chunk);
        }
    }
    if !pid_path.is_file() {
        let _ = manager.close(&runtime_id);
        panic!(
            "PTY child should write its process ID; terminal output: {}",
            terminal_tail(&output)
        );
    }
    let process_id = fs::read_to_string(&pid_path)
        .expect("PTY child should write its process ID")
        .trim()
        .parse::<u32>()
        .expect("PTY child process ID should be a positive integer");

    manager
        .close(&runtime_id)
        .expect("PTY runtime should close");

    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let status = Command::new("tasklist.exe")
            .args(["/FI", &format!("PID eq {process_id}"), "/NH"])
            .output()
            .expect("tasklist should run");
        assert!(
            status.status.success(),
            "tasklist should complete successfully"
        );
        let output = String::from_utf8_lossy(&status.stdout);
        if !output.contains(&process_id.to_string()) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "PTY child process still exists after close: {output}"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let _ = fs::remove_file(pid_path);
}

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
    let mut cursor_queries = CursorPositionQueries::default();
    let mut answered_cpr = false;
    let mut sent_command = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(chunk)) => {
                answered_cpr |= cursor_queries.answer(&manager, &runtime_id, &chunk);
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
    let mut cursor_queries = CursorPositionQueries::default();
    let mut answered_cpr = false;
    let mut sent_command = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(chunk)) => {
                output.push_str(&chunk);
                answered_cpr |= cursor_queries.answer(&manager, &runtime_id, &chunk);
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
fn local_powershell_history_hook_reports_recalled_commands_when_available() {
    let Some(profile) = pwsh_profile() else {
        eprintln!("pwsh.exe is not installed; skipping PowerShell history integration smoke");
        return;
    };
    let manager = TerminalManager::default();
    let opened = manager
        .open_local_session(
            &profile,
            None,
            "pane-pwsh-history-smoke".to_string(),
            None,
            profile.name.clone(),
            100,
            30,
        )
        .expect("local PowerShell runtime should open");
    assert!(opened.shell_history_integration);
    let runtime_id = opened.info.runtime_session_id.clone();
    let (sender, receiver) = mpsc::channel::<Option<String>>();
    thread::spawn(move || read_terminal(opened.reader, sender));

    let command = "Write-Output ZTERM_PWSH_HISTORY_RECALL_OK";
    let history_marker = "\u{1b}]633;ZTermCommand;";
    let mut output = String::new();
    let mut cursor_queries = CursorPositionQueries::default();
    let mut sent_command = false;
    let mut recalled_command = false;
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(chunk)) => {
                output.push_str(&chunk);
                cursor_queries.answer(&manager, &runtime_id, &chunk);
                if !sent_command && output.contains("PS ") && output.contains('>') {
                    assert!(
                        !output.contains(r"Microsoft.PowerShell.Core\FileSystem::"),
                        "PowerShell prompt exposed its provider-qualified path: {}",
                        terminal_tail(&output)
                    );
                    assert!(
                        !output.contains(r"\\?\"),
                        "PowerShell prompt exposed a verbatim Windows path: {}",
                        terminal_tail(&output)
                    );
                    sent_command = true;
                    manager
                        .write(&runtime_id, &format!("{command}\r"))
                        .expect("PowerShell runtime should accept the first command");
                }
                if sent_command && !recalled_command && output.matches(history_marker).count() >= 1
                {
                    recalled_command = true;
                    manager
                        .write(&runtime_id, "\u{1b}[A\r")
                        .expect("PowerShell runtime should accept recalled command input");
                }
                if output.matches(history_marker).count() >= 2 {
                    let _ = manager.close(&runtime_id);
                    return;
                }
            }
            Ok(None) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(error) => panic!("PowerShell reader channel failed: {error}"),
        }
    }

    let _ = manager.close(&runtime_id);
    panic!(
        "PowerShell history hook did not report the recalled command twice; tail={}",
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
fn closing_external_process_runtime_terminates_its_child() {
    let manager = TerminalManager::default();
    let mut command = Command::new("cmd.exe");
    command.args(["/C", "ping", "127.0.0.1", "-n", "30", ">", "NUL"]);
    let child = command.spawn().expect("test child should start");
    let process_id = child.id();
    let info = manager
        .open_rdp_session(
            "saved-rdp".to_string(),
            "pane-1".to_string(),
            "办公 RDP".to_string(),
            child,
            None,
        )
        .expect("external process runtime should open");

    manager
        .close(&info.runtime_session_id)
        .expect("external process runtime should close");

    let status = Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {process_id}"), "/NH"])
        .output()
        .expect("tasklist should run");
    let output = String::from_utf8_lossy(&status.stdout);
    assert!(
        !output.contains(&process_id.to_string()),
        "child process still exists: {output}"
    );
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

fn pwsh_profile() -> Option<TerminalProfile> {
    let path = Command::new("where.exe")
        .arg("pwsh.exe")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(PathBuf::from)
        })?;
    Some(TerminalProfile {
        id: "pwsh".to_string(),
        name: "PowerShell 7".to_string(),
        path: path.to_string_lossy().to_string(),
        args: vec!["-NoLogo".to_string()],
        detected: true,
        is_default: true,
        created_at_ms: 0,
        updated_at_ms: 0,
    })
}

#[derive(Default)]
struct CursorPositionQueries {
    matched: usize,
}

impl CursorPositionQueries {
    fn consume(&mut self, chunk: &str) -> usize {
        const QUERY: &[u8] = b"\x1b[6n";
        let mut queries = 0;
        for byte in chunk.bytes() {
            if byte == QUERY[self.matched] {
                self.matched += 1;
                if self.matched == QUERY.len() {
                    queries += 1;
                    self.matched = 0;
                }
            } else {
                self.matched = usize::from(byte == QUERY[0]);
            }
        }
        queries
    }

    fn answer(&mut self, manager: &TerminalManager, runtime_id: &str, chunk: &str) -> bool {
        let queries = self.consume(chunk);
        for _ in 0..queries {
            manager
                .write(runtime_id, "\u{1b}[1;1R")
                .expect("headless PTY should accept CPR response");
        }
        queries > 0
    }
}

#[test]
fn cursor_position_queries_survive_every_chunk_boundary() {
    let query = "\u{1b}[6n";
    for split in 1..query.len() {
        let mut parser = CursorPositionQueries::default();
        assert_eq!(parser.consume(&query[..split]), 0);
        assert_eq!(parser.consume(&query[split..]), 1);
        assert_eq!(parser.consume("ordinary output"), 0);
    }
    let mut parser = CursorPositionQueries::default();
    let total: usize = query
        .bytes()
        .map(|byte| parser.consume(&(byte as char).to_string()))
        .sum();
    assert_eq!(total, 1);
}

#[test]
fn cursor_position_queries_answer_repeats_without_matching_other_sequences() {
    let mut parser = CursorPositionQueries::default();
    assert_eq!(parser.consume("\u{1b}[?9001h\u{1b}[6n\u{1b}[6n"), 2);
    assert_eq!(parser.consume("\u{1b}[6X\u{1b}["), 0);
    assert_eq!(parser.consume("\u{1b}[6n"), 1);
    assert_eq!(parser.consume("\u{1b}[1;1R"), 0);
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

#[cfg(windows)]
#[test]
fn saved_local_connections_keep_distinct_history_scopes_across_reopens() {
    use zterm_lib::models::history::HistoryScopeKind;
    let manager = TerminalManager::default();
    let profile = pwsh_profile().unwrap_or_else(cmd_profile);
    let first_dir = std::env::temp_dir();
    let second_dir = std::env::current_dir().expect("current directory");
    for (session_id, directory) in [
        ("local-a", &first_dir),
        ("local-b", &second_dir),
        ("local-a", &second_dir),
    ] {
        let opened = manager
            .open_local_session(
                &profile,
                Some(&LocalOptions {
                    profile_id: Some(profile.id.clone()),
                    working_directory: Some(directory.to_string_lossy().into_owned()),
                    environment: Vec::new(),
                }),
                "pane-scope-test".to_string(),
                Some(session_id.to_string()),
                profile.name.clone(),
                100,
                30,
            )
            .expect("saved local runtime should open");
        let info = opened.info;
        let (sender, _receiver) = mpsc::channel();
        thread::spawn(move || read_terminal(opened.reader, sender));
        manager
            .close(&info.runtime_session_id)
            .expect("runtime should close");
        assert_eq!(
            info.history_scope_kind,
            Some(HistoryScopeKind::SavedSession)
        );
        assert_eq!(info.history_scope_id.as_deref(), Some(session_id));
        assert_eq!(info.saved_session_id.as_deref(), Some(session_id));
    }
}
