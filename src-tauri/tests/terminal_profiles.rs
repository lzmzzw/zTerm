// Author: Liz
use std::{fs, path::PathBuf};

use zterm_lib::{
    models::terminal_profile::TerminalProfileDraft,
    services::terminal_profile_service::{
        default_profile, detect_terminal_profiles_in_dirs, terminal_profile_candidates,
        TerminalProfileCandidate,
    },
    storage::{
        sqlite::SqliteStore,
        terminal_profiles::{
            list_terminal_profiles, set_default_terminal_profile, upsert_detected_terminal_profiles,
        },
    },
};

#[test]
fn terminal_profile_detection_uses_priority_order_and_default() {
    let temp_dir = test_dir("terminal-profile-detect");
    fs::create_dir_all(&temp_dir).expect("temp dir should create");
    touch(temp_dir.join("cmd.exe"));
    touch(temp_dir.join("pwsh.exe"));

    let candidates = [
        TerminalProfileCandidate {
            id: "pwsh",
            name: "PowerShell 7",
            executable: "pwsh.exe",
            args: &[],
            windows_paths: &[],
        },
        TerminalProfileCandidate {
            id: "cmd",
            name: "Command Prompt",
            executable: "cmd.exe",
            args: &[],
            windows_paths: &[],
        },
    ];
    let profiles = detect_terminal_profiles_in_dirs(std::slice::from_ref(&temp_dir), &candidates)
        .expect("profiles should detect from supplied dirs");

    assert_eq!(
        profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>(),
        ["pwsh", "cmd"]
    );
    assert!(profiles[0].is_default);
    assert!(profiles[0].path.ends_with("pwsh.exe"));

    let _ = fs::remove_dir_all(temp_dir);
}

#[test]
fn terminal_profile_detection_recognizes_git_bash_with_login_args() {
    let git_bin_dir = test_dir("terminal-profile-git").join("Git").join("bin");
    fs::create_dir_all(&git_bin_dir).expect("git bin dir should create");
    touch(git_bin_dir.join("bash.exe"));

    let profiles = detect_terminal_profiles_in_dirs(
        std::slice::from_ref(&git_bin_dir),
        terminal_profile_candidates(),
    )
    .expect("profiles should detect git bash from supplied dir");
    let git_bash = profiles
        .iter()
        .find(|profile| profile.id == "git-bash")
        .expect("git bash should be detected as its own profile");

    assert_eq!(git_bash.name, "Git Bash");
    assert_eq!(git_bash.args, ["--login", "-i"]);
    assert!(git_bash.path.ends_with("Git\\bin\\bash.exe"));

    let temp_root = git_bin_dir
        .ancestors()
        .nth(2)
        .expect("test temp root should exist")
        .to_path_buf();
    let _ = fs::remove_dir_all(temp_root);
}

#[test]
fn terminal_profile_default_can_be_persisted() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");

    set_default_terminal_profile(
        &store,
        TerminalProfileDraft {
            id: "cmd".to_string(),
            name: "Command Prompt".to_string(),
            path: "C:\\Windows\\System32\\cmd.exe".to_string(),
            args: vec![],
            detected: true,
            is_default: true,
        },
    )
    .expect("default terminal profile should save");

    let profiles = list_terminal_profiles(&store).expect("profiles should list");
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].id, "cmd");
    assert!(profiles[0].is_default);
}

#[test]
fn terminal_profile_default_skips_missing_saved_executable() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let temp_dir = test_dir("terminal-profile-default-fallback");
    fs::create_dir_all(&temp_dir).expect("temp dir should create");
    let usable_cmd = temp_dir.join("cmd.exe");
    touch(usable_cmd.clone());

    upsert_detected_terminal_profiles(
        &store,
        vec![
            TerminalProfileDraft {
                id: "git-bash".to_string(),
                name: "Git Bash".to_string(),
                path: temp_dir
                    .join("missing-bash.exe")
                    .to_string_lossy()
                    .to_string(),
                args: vec!["--login".to_string(), "-i".to_string()],
                detected: true,
                is_default: true,
            },
            TerminalProfileDraft {
                id: "cmd".to_string(),
                name: "Command Prompt".to_string(),
                path: usable_cmd.to_string_lossy().to_string(),
                args: vec![],
                detected: true,
                is_default: false,
            },
        ],
    )
    .expect("profiles should save");

    let profile = default_profile(&store)
        .expect("default lookup should succeed")
        .expect("usable fallback profile should be selected");

    assert_eq!(profile.id, "cmd");

    let _ = fs::remove_dir_all(temp_dir);
}

fn touch(path: PathBuf) {
    fs::write(path, b"").expect("fake executable should write");
}

fn test_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("zterm-{name}-{}", uuid::Uuid::new_v4()))
}
