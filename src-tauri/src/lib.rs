// Author: Liz
use std::env;

use tauri::Manager;

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
    tauri::Builder::default()
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
            commands::terminal_profile::terminal_profile_list,
            commands::terminal_profile::terminal_profile_detect,
            commands::terminal_profile::terminal_profile_set_default,
            commands::command_completion::command_completion_suggest,
            commands::history::history_search,
            commands::history::history_clear,
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
    let paths = paths::AppPaths::default_for_install()?;
    paths.ensure_dirs()?;
    let storage = storage::sqlite::SqliteStore::open(paths.db_path())?;
    let state = state::AppState::new_with_app_handle(storage, app.handle().clone());
    let _ = state
        .external_launch_service()
        .register_from_args(env::args())
        .map_err(|error| {
            eprintln!(
                "external launch ignored: {}",
                security::redaction::redact_sensitive(&error.to_string())
            );
            error
        });
    app.manage(state);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn crate_metadata_matches_project() {
        assert_eq!(env!("CARGO_PKG_NAME"), "zterm");
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.1.3");
    }
}
