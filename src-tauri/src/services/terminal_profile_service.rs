// Author: Liz
use std::{
    env,
    path::{Path, PathBuf},
};

use crate::{
    error::AppResult,
    models::terminal_profile::{TerminalProfile, TerminalProfileDraft},
    storage::{
        sqlite::SqliteStore,
        terminal_profiles::{
            list_terminal_profiles, set_default_terminal_profile, upsert_detected_terminal_profiles,
        },
    },
};

#[derive(Debug, Clone, Copy)]
pub struct TerminalProfileCandidate {
    pub id: &'static str,
    pub name: &'static str,
    pub executable: &'static str,
    pub args: &'static [&'static str],
    pub windows_paths: &'static [&'static str],
}

pub fn terminal_profile_candidates() -> &'static [TerminalProfileCandidate] {
    &[
        TerminalProfileCandidate {
            id: "pwsh",
            name: "PowerShell 7",
            executable: "pwsh.exe",
            args: &[],
            windows_paths: &[],
        },
        TerminalProfileCandidate {
            id: "powershell",
            name: "Windows PowerShell",
            executable: "powershell.exe",
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
        TerminalProfileCandidate {
            id: "git-bash",
            name: "Git Bash",
            executable: "bash.exe",
            args: &["--login", "-i"],
            windows_paths: &[
                "%ProgramFiles%\\Git\\bin\\bash.exe",
                "%ProgramFiles(x86)%\\Git\\bin\\bash.exe",
                "%LocalAppData%\\Programs\\Git\\bin\\bash.exe",
            ],
        },
        TerminalProfileCandidate {
            id: "bash",
            name: "Bash",
            executable: "bash.exe",
            args: &[],
            windows_paths: &[],
        },
        TerminalProfileCandidate {
            id: "wsl",
            name: "WSL",
            executable: "wsl.exe",
            args: &[],
            windows_paths: &[],
        },
    ]
}

pub fn detect_terminal_profiles() -> AppResult<Vec<TerminalProfileDraft>> {
    let dirs = path_dirs();
    detect_terminal_profiles_in_dirs(&dirs, terminal_profile_candidates())
}

pub fn detect_terminal_profiles_in_dirs(
    dirs: &[PathBuf],
    candidates: &[TerminalProfileCandidate],
) -> AppResult<Vec<TerminalProfileDraft>> {
    let mut profiles = Vec::new();
    for candidate in candidates {
        if let Some(path) = find_candidate_executable(dirs, candidate) {
            profiles.push(TerminalProfileDraft {
                id: candidate.id.to_string(),
                name: candidate.name.to_string(),
                path: path.to_string_lossy().to_string(),
                args: candidate
                    .args
                    .iter()
                    .map(|arg| (*arg).to_string())
                    .collect(),
                detected: true,
                is_default: profiles.is_empty(),
            });
        }
    }
    Ok(profiles)
}

pub fn detect_and_save_terminal_profiles(store: &SqliteStore) -> AppResult<Vec<TerminalProfile>> {
    let detected = detect_terminal_profiles()?;
    if detected.is_empty() {
        return list_terminal_profiles(store);
    }
    upsert_detected_terminal_profiles(store, detected)?;
    list_terminal_profiles(store)
}

pub fn list_or_detect_terminal_profiles(store: &SqliteStore) -> AppResult<Vec<TerminalProfile>> {
    let existing = list_terminal_profiles(store)?;
    if existing.is_empty() {
        return detect_and_save_terminal_profiles(store);
    }
    Ok(existing)
}

pub fn set_default_profile(
    store: &SqliteStore,
    draft: TerminalProfileDraft,
) -> AppResult<TerminalProfile> {
    set_default_terminal_profile(store, draft)
}

pub fn default_profile(store: &SqliteStore) -> AppResult<Option<TerminalProfile>> {
    let existing = list_terminal_profiles(store)?;
    if let Some(profile) = select_usable_default_profile(existing) {
        return Ok(Some(profile));
    }
    let detected = detect_and_save_terminal_profiles(store)?;
    Ok(select_usable_default_profile(detected))
}

fn select_usable_default_profile(profiles: Vec<TerminalProfile>) -> Option<TerminalProfile> {
    profiles
        .iter()
        .find(|profile| profile.is_default && terminal_profile_path_exists(profile))
        .cloned()
        .or_else(|| profiles.into_iter().find(terminal_profile_path_exists))
}

fn terminal_profile_path_exists(profile: &TerminalProfile) -> bool {
    Path::new(&profile.path).is_file()
}

fn path_dirs() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default()
}

fn find_executable(dirs: &[PathBuf], executable: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(executable))
        .find(|path| path.is_file())
}

fn find_candidate_executable(
    dirs: &[PathBuf],
    candidate: &TerminalProfileCandidate,
) -> Option<PathBuf> {
    candidate
        .windows_paths
        .iter()
        .filter_map(|path| expand_windows_path(path))
        .find(|path| path.is_file())
        .or_else(|| {
            if candidate.id == "git-bash" {
                find_git_bash_on_path(dirs, candidate.executable)
            } else {
                find_executable(dirs, candidate.executable)
            }
        })
}

fn find_git_bash_on_path(dirs: &[PathBuf], executable: &str) -> Option<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(executable))
        .find(|path| path.is_file() && looks_like_git_bash_path(path))
}

fn looks_like_git_bash_path(path: &std::path::Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    normalized.contains("\\git\\bin\\bash.exe") || normalized.contains("\\git\\usr\\bin\\bash.exe")
}

fn expand_windows_path(path: &str) -> Option<PathBuf> {
    let mut expanded = path.to_string();
    for (name, value) in env::vars() {
        let token = format!("%{name}%");
        if expanded.contains(&token) {
            expanded = expanded.replace(&token, &value);
        }
    }
    if expanded.contains('%') {
        None
    } else {
        Some(PathBuf::from(expanded))
    }
}
