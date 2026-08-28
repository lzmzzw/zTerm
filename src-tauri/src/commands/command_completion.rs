// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::command_completion::{
        CommandCompletionCandidate, CommandCompletionCwdRequest, CommandCompletionRequest,
    },
    state::AppState,
};

#[tauri::command]
pub fn command_completion_suggest(
    state: State<'_, AppState>,
    request: CommandCompletionRequest,
) -> AppResult<Vec<CommandCompletionCandidate>> {
    let completion = state.command_completion_service();
    completion.refresh_remote_commands_for_runtime(
        state.storage(),
        state.ssh_command_service(),
        state.credential_service(),
        &request.runtime_session_id,
    );
    completion.refresh_remote_paths_for_request(
        state.storage(),
        state.sftp_service(),
        state.credential_service(),
        &request,
    );
    completion.suggest(state.storage().as_ref(), request)
}

#[tauri::command]
pub async fn command_completion_resolve_cwd(
    state: State<'_, AppState>,
    request: CommandCompletionCwdRequest,
) -> AppResult<Option<String>> {
    state
        .command_completion_service()
        .resolve_cwd(
            state.storage(),
            state.sftp_service(),
            state.credential_service(),
            request,
        )
        .await
}
