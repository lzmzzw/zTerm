// Author: Liz
use std::{env, process::Command, sync::Mutex};

use tauri::{Emitter, Manager};

const EXTERNAL_SSH_LAUNCH_EVENT: &str = "zterm:external-ssh-launch";
const ALLOW_MULTI_INSTANCE_ENV: &str = "ZTERM_ALLOW_MULTI_INSTANCE";
static EARLY_SECOND_INSTANCE_ARGS: Mutex<Vec<Vec<String>>> = Mutex::new(Vec::new());

pub mod commands;
pub mod error;
pub mod models;
pub mod paths;
pub mod security;
pub mod services;
pub mod state;
pub mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let allow_multi_instance = env::var_os(ALLOW_MULTI_INSTANCE_ENV).is_some();
    env::remove_var(ALLOW_MULTI_INSTANCE_ENV);

    let mut builder = tauri::Builder::default();
    if !allow_multi_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(handle_second_instance));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(updater_plugin())
        .setup(setup_app_state)
        .invoke_handler(tauri::generate_handler![
            commands::sessions::sessions_list,
            commands::sessions::sessions_save_group,
            commands::sessions::sessions_delete_group,
            commands::sessions::sessions_save_session,
            commands::sessions::sessions_delete_session,
            commands::sessions::sessions_test_connection,
            commands::settings::settings_get,
            commands::settings::settings_save,
            commands::settings::settings_reset,
            commands::settings::shortcut_registry_list,
            commands::mcp::mcp_server_status,
            commands::mcp::mcp_server_set_enabled,
            commands::mcp::mcp_server_rotate_token,
            commands::mcp::mcp_tool_catalog_list,
            commands::terminal_profile::terminal_profile_list,
            commands::terminal_profile::terminal_profile_detect,
            commands::terminal_profile::terminal_profile_set_default,
            commands::command_completion::command_completion_suggest,
            commands::history::history_search,
            commands::history::history_clear,
            commands::history::history_delete_entries,
            commands::history::history_command_group_list,
            commands::history::history_command_group_save,
            commands::history::history_command_group_delete,
            commands::credential::credentials_list,
            commands::credential::credentials_save,
            commands::credential::credentials_read_secret,
            commands::credential::credentials_delete,
            commands::credential::credentials_test,
            commands::credential::llm_provider_list,
            commands::credential::llm_provider_save,
            commands::credential::llm_provider_delete,
            commands::credential::llm_provider_test,
            commands::credential::llm_provider_test_draft,
            commands::credential::llm_provider_test_draft_stream,
            commands::credential::llm_provider_test_draft_cancel,
            commands::external_launch::external_launch_take_pending,
            commands::external_launch::external_launch_get_ssh_options,
            commands::external_launch::external_launch_update_ssh_options,
            commands::ai::ai_chat,
            commands::ai::ai_chat_stream,
            commands::ai::ai_chat_cancel,
            commands::ai::ai_terminal_context_snapshot,
            commands::ai::ai_tool_registry_list,
            commands::ai::ai_tool_prepare,
            commands::ai::ai_tool_confirm,
            commands::ai::ai_tool_pending,
            commands::ai::ai_tool_audit,
            commands::ai::ai_conversation_create,
            commands::ai::ai_conversation_list,
            commands::ai::ai_conversation_get,
            commands::ai::ai_conversation_delete,
            commands::ai::ai_set_conversation_approval_mode,
            commands::ai::ai_conversation_message_append,
            commands::sftp::sftp_list,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::sftp_classify_local_paths,
            commands::sftp::sftp_check_transfer_conflicts,
            commands::sftp::sftp_delete,
            commands::sftp::sftp_rename,
            commands::sftp::file_transfer_default_local_path,
            commands::sftp::file_transfer_local_roots,
            commands::sftp::file_transfer_list_endpoint,
            commands::sftp::file_transfer_rename_endpoint,
            commands::sftp::file_transfer_delete_endpoint,
            commands::sftp::file_transfer_check_conflicts,
            commands::sftp::file_transfer_enqueue,
            commands::sftp::file_transfer_list,
            commands::sftp::transfer_list,
            commands::sftp::transfer_retry,
            commands::sftp::transfer_pause,
            commands::sftp::transfer_resume,
            commands::sftp::transfer_cancel,
            commands::sftp::transfer_delete,
            commands::server_info::server_info_snapshot,
            commands::ssh_container::ssh_container_enter_runtime,
            commands::ssh_container::ssh_container_list,
            commands::workspace::workspace_list,
            commands::workspace::workspace_get,
            commands::workspace::workspace_save,
            commands::workspace::workspace_save_default_snapshot,
            commands::workspace::workspace_delete,
            commands::workspace::workspace_remove,
            commands::terminal::terminal_open,
            commands::terminal::terminal_open_ssh_container,
            commands::terminal::terminal_open_default_local,
            commands::terminal::terminal_write,
            commands::terminal::terminal_write_bytes,
            commands::terminal::terminal_zmodem_read_files,
            commands::terminal::terminal_zmodem_save_file,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run zTerm");
}

fn handle_second_instance(app: &tauri::AppHandle, args: Vec<String>, cwd: String) {
    if should_spawn_additional_instance(&args) {
        if let Err(error) = spawn_additional_instance(&cwd) {
            eprintln!("failed to start additional zTerm instance: {error}");
        }
        return;
    }

    let Ok(mut early_args) = EARLY_SECOND_INSTANCE_ARGS.lock() else {
        eprintln!("external launch ignored: early launch lock was poisoned");
        return;
    };
    let Some(state) = app.try_state::<state::AppState>() else {
        early_args.push(args);
        return;
    };
    drop(early_args);
    register_second_instance_args(app, state.external_launch_service(), args);

    focus_main_window(app);
}

fn should_spawn_additional_instance(args: &[String]) -> bool {
    args.len() <= 1
}

fn spawn_additional_instance(cwd: &str) -> std::io::Result<()> {
    let executable = env::current_exe()?;
    let mut command = Command::new(executable);
    command.env(ALLOW_MULTI_INSTANCE_ENV, "1");
    if !cwd.trim().is_empty() {
        command.current_dir(cwd);
    }
    command.spawn()?;
    Ok(())
}

fn register_second_instance_args(
    app: &tauri::AppHandle,
    service: services::external_launch_service::ExternalLaunchService,
    args: Vec<String>,
) {
    let parent_command_line = forwarded_instance_parent_command_line(&args);
    let registration = service.register_from_forwarded_args(args, parent_command_line);
    match registration {
        Ok(Some(_)) => {
            if let Err(error) = app.emit(EXTERNAL_SSH_LAUNCH_EVENT, ()) {
                eprintln!("failed to notify external launch: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!(
            "external launch ignored: {}",
            security::redaction::redact_sensitive(&error.to_string())
        ),
    }
}

#[cfg(all(windows, not(test)))]
fn forwarded_instance_parent_command_line(args: &[String]) -> Option<String> {
    use std::{os::windows::process::CommandExt, process::Command};

    if !args
        .iter()
        .any(|arg| arg.trim().to_ascii_lowercase().ends_with(".moba"))
    {
        return None;
    }
    let executable_path = std::env::current_exe().ok()?;
    let process_name = executable_path.file_name()?.to_str()?.to_string();
    if !process_name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
    {
        return None;
    }

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = format!(
        "$p=Get-CimInstance Win32_Process -Filter \"Name = '{process_name}'\" | \
         Where-Object {{ $_.ProcessId -ne {} -and $_.ExecutablePath -eq $env:ZTERM_SECOND_INSTANCE_EXE }} | \
         Sort-Object CreationDate -Descending | Select-Object -First 1; \
         if ($p) {{ \
           $pp=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $p.ParentProcessId); \
           if ($pp) {{ [Console]::Out.Write($pp.CommandLine) }} \
         }}",
        std::process::id()
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .env("ZTERM_SECOND_INSTANCE_EXE", executable_path)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(any(not(windows), test))]
fn forwarded_instance_parent_command_line(_args: &[String]) -> Option<String> {
    None
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn updater_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry, tauri_plugin_updater::Config> {
    let mut builder = tauri_plugin_updater::Builder::new();
    if let Ok(pubkey) = env::var("ZTERM_UPDATER_PUBKEY") {
        let pubkey = pubkey.trim();
        if !pubkey.is_empty() {
            builder = builder.pubkey(pubkey);
        }
    }
    builder.build()
}

fn setup_app_state(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let mut early_args = EARLY_SECOND_INSTANCE_ARGS
        .lock()
        .map_err(|_| "early external launch lock was poisoned")?;
    let paths = paths::AppPaths::default_for_install()?;
    paths.ensure_dirs()?;
    let storage = storage::sqlite::SqliteStore::open(paths.db_path())?;
    let state = state::AppState::new_with_app_handle(storage, app.handle().clone());
    let _ = state
        .external_launch_service()
        .register_from_args(env::args())
        .inspect_err(|error| {
            eprintln!(
                "external launch ignored: {}",
                security::redaction::redact_sensitive(&error.to_string())
            );
        });
    for args in early_args.drain(..) {
        let _ = state
            .external_launch_service()
            .register_from_args(args)
            .inspect_err(|error| {
                eprintln!(
                    "external launch ignored: {}",
                    security::redaction::redact_sensitive(&error.to_string())
                );
            });
    }
    if let Err(error) = tauri::async_runtime::block_on(commands::mcp::start_mcp_if_enabled(
        state.storage(),
        state.ai_tool_service(),
        state.mcp_service(),
    )) {
        eprintln!(
            "MCP autostart failed: {}",
            security::redaction::redact_sensitive(&error.to_string())
        );
    }
    app.manage(state);
    drop(early_args);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_spawn_additional_instance;

    #[test]
    fn crate_metadata_matches_project() {
        assert_eq!(env!("CARGO_PKG_NAME"), "zterm");
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.2.2");
    }

    #[test]
    fn plain_launch_spawns_an_additional_instance_but_external_launch_stays_forwarded() {
        assert!(should_spawn_additional_instance(&["zterm.exe".to_string()]));
        assert!(!should_spawn_additional_instance(&[
            "zterm.exe".to_string(),
            "--external-ssh".to_string(),
            "--host".to_string(),
            "example.test".to_string(),
        ]));
        assert!(!should_spawn_additional_instance(&[
            "zterm.exe".to_string(),
            "session.moba".to_string(),
        ]));
    }
}
