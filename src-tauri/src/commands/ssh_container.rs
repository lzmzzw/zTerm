// Author: Liz
use tauri::State;

use crate::{
    error::{AppError, AppResult},
    models::ssh_container::SshContainerInfo,
    services::ssh_container_service::{
        build_container_list_script, enabled_container_options, parse_container_ps_output,
    },
    state::AppState,
    storage::sessions::{get_session, list_sessions},
};

#[tauri::command]
pub async fn ssh_container_list(
    state: State<'_, AppState>,
    saved_session_id: String,
) -> AppResult<Vec<SshContainerInfo>> {
    let storage = state.storage();
    let session = get_session(storage.as_ref(), &saved_session_id)?;
    let container = enabled_container_options(&session)?;
    let script = build_container_list_script(&container.runtime)?;
    let all_sessions = list_sessions(storage.as_ref())?.sessions;
    let output = state
        .ssh_command_service()
        .execute(&session, &all_sessions, script, &state.credential_service())
        .await?;
    if !output.success {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        return Err(AppError::ssh(if detail.is_empty() {
            "容器列表获取失败".to_string()
        } else {
            detail.to_string()
        }));
    }
    Ok(parse_container_ps_output(&output.stdout))
}
