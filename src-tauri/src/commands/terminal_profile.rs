// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::terminal_profile::{TerminalProfile, TerminalProfileDraft},
    services::terminal_profile_service::{
        detect_and_save_terminal_profiles, list_or_detect_terminal_profiles, set_default_profile,
    },
    state::AppState,
};

#[tauri::command]
pub fn terminal_profile_list(state: State<'_, AppState>) -> AppResult<Vec<TerminalProfile>> {
    let storage = state.storage();
    list_or_detect_terminal_profiles(storage.as_ref())
}

#[tauri::command]
pub fn terminal_profile_detect(state: State<'_, AppState>) -> AppResult<Vec<TerminalProfile>> {
    let storage = state.storage();
    detect_and_save_terminal_profiles(storage.as_ref())
}

#[tauri::command]
pub fn terminal_profile_set_default(
    state: State<'_, AppState>,
    draft: TerminalProfileDraft,
) -> AppResult<TerminalProfile> {
    let storage = state.storage();
    set_default_profile(storage.as_ref(), draft)
}
