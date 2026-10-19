use tauri::State;

use crate::{
    error::AppResult,
    models::terminal_layout::TerminalLayoutSnapshot,
    state::AppState,
    storage::terminal_layout::{get_terminal_layout, save_terminal_layout},
};

#[tauri::command]
pub fn terminal_layout_get(
    state: State<'_, AppState>,
) -> AppResult<Option<TerminalLayoutSnapshot>> {
    get_terminal_layout(state.storage().as_ref())
}

#[tauri::command]
pub fn terminal_layout_save(
    state: State<'_, AppState>,
    snapshot: TerminalLayoutSnapshot,
) -> AppResult<TerminalLayoutSnapshot> {
    save_terminal_layout(state.storage().as_ref(), snapshot)
}
