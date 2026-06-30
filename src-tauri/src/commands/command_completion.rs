// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::command_completion::{CommandCompletionCandidate, CommandCompletionRequest},
    state::AppState,
};

#[tauri::command]
pub fn command_completion_suggest(
    state: State<'_, AppState>,
    request: CommandCompletionRequest,
) -> AppResult<Vec<CommandCompletionCandidate>> {
    state
        .command_completion_service()
        .suggest(state.storage().as_ref(), request)
}
