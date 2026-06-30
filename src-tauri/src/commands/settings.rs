// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::settings::{shortcut_registry, AppSettings, SettingsSection, ShortcutDefinition},
    state::AppState,
    storage::settings::{get_app_settings, reset_app_settings_section, save_app_settings},
};

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppResult<AppSettings> {
    let storage = state.storage();
    get_app_settings(storage.as_ref())
}

#[tauri::command]
pub fn settings_save(state: State<'_, AppState>, settings: AppSettings) -> AppResult<AppSettings> {
    let storage = state.storage();
    save_app_settings(storage.as_ref(), settings)
}

#[tauri::command]
pub fn settings_reset(
    state: State<'_, AppState>,
    section: SettingsSection,
) -> AppResult<AppSettings> {
    let storage = state.storage();
    reset_app_settings_section(storage.as_ref(), section)
}

#[tauri::command]
pub fn shortcut_registry_list() -> AppResult<Vec<ShortcutDefinition>> {
    Ok(shortcut_registry())
}
