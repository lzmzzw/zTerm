// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::session::{
        DeleteResult, SavedSession, SavedSessionDraft, SessionGroup, SessionGroupDraft,
        SessionTestResult, SessionType, SessionsList,
    },
    state::AppState,
    storage::sessions::{
        delete_session, delete_session_group, list_sessions, save_session, save_session_group,
    },
};

#[tauri::command]
pub fn sessions_list(state: State<'_, AppState>) -> AppResult<SessionsList> {
    let storage = state.storage();
    list_sessions(storage.as_ref())
}

#[tauri::command]
pub fn sessions_save_group(
    state: State<'_, AppState>,
    draft: SessionGroupDraft,
) -> AppResult<SessionGroup> {
    let storage = state.storage();
    save_session_group(storage.as_ref(), draft)
}

#[tauri::command]
pub fn sessions_delete_group(state: State<'_, AppState>, id: String) -> AppResult<DeleteResult> {
    let storage = state.storage();
    delete_session_group(storage.as_ref(), &id)
}

#[tauri::command]
pub fn sessions_save_session(
    state: State<'_, AppState>,
    draft: SavedSessionDraft,
) -> AppResult<SavedSession> {
    let storage = state.storage();
    let session = save_session(storage.as_ref(), draft)?;
    state
        .ssh_command_service()
        .evict_reusable_connections_for_session(&session.id);
    state
        .sftp_service()
        .evict_cached_sessions_for_session(&session.id);
    Ok(session)
}

#[tauri::command]
pub fn sessions_delete_session(state: State<'_, AppState>, id: String) -> AppResult<DeleteResult> {
    let storage = state.storage();
    let result = delete_session(storage.as_ref(), &id)?;
    state
        .ssh_command_service()
        .evict_reusable_connections_for_session(&id);
    state.sftp_service().evict_cached_sessions_for_session(&id);
    Ok(result)
}

#[tauri::command]
pub fn sessions_test_connection(
    state: State<'_, AppState>,
    draft: SavedSessionDraft,
) -> AppResult<SessionTestResult> {
    match draft.session_type {
        SessionType::Ssh => {
            let session = save_preview_session(draft)?;
            crate::services::ssh_terminal_service::build_ssh_arguments(&session)?;
            Ok(SessionTestResult {
                ok: true,
                message: "SSH 参数校验通过，可发起连接".to_string(),
            })
        }
        SessionType::Rdp => {
            let session = save_preview_session(draft)?;
            let command = crate::services::rdp_service::build_mstsc_arguments(&session)?;
            Ok(SessionTestResult {
                ok: true,
                message: format!(
                    "RDP 参数校验通过：{} {}",
                    command.program,
                    command.args.join(" ")
                ),
            })
        }
        SessionType::Local => {
            let storage = state.storage();
            let profiles =
                crate::services::terminal_profile_service::list_or_detect_terminal_profiles(
                    storage.as_ref(),
                )?;
            if profiles.is_empty() {
                return Ok(SessionTestResult {
                    ok: false,
                    message: "未检测到可用本机终端".to_string(),
                });
            }
            Ok(SessionTestResult {
                ok: true,
                message: "本机终端配置可用".to_string(),
            })
        }
    }
}

fn save_preview_session(draft: SavedSessionDraft) -> AppResult<SavedSession> {
    Ok(SavedSession {
        id: draft.id.unwrap_or_else(|| "preview".to_string()),
        name: draft.name,
        session_type: draft.session_type,
        group_id: draft.group_id,
        host: if draft.host.trim().is_empty() {
            "localhost".to_string()
        } else {
            draft.host
        },
        port: draft.port,
        username: draft.username,
        auth_mode: draft.auth_mode,
        credential_ref: draft.credential_ref,
        description: draft.description,
        tags: draft.tags,
        sort_order: draft.sort_order,
        created_at_ms: 0,
        updated_at_ms: 0,
        last_used_at_ms: None,
        ssh_options: draft.ssh_options,
        rdp_options: draft.rdp_options,
        local_options: draft.local_options,
    })
}
