// Author: Liz
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, OptionalExtension};

use crate::{
    error::{AppError, AppResult},
    models::settings::{AppSettings, SettingsSection},
    storage::sqlite::SqliteStore,
};

pub const APP_SETTINGS_TABLE: &str = "app_settings";

pub fn get_app_settings(store: &SqliteStore) -> AppResult<AppSettings> {
    store.with_connection(|connection| {
        let settings_json = connection
            .query_row(
                "select settings_json from app_settings where id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match settings_json {
            Some(value) => serde_json::from_str::<AppSettings>(&value)
                .map(|settings| settings.merged_with_registry())
                .map_err(|error| AppError::storage(error.to_string())),
            None => Ok(AppSettings::default()),
        }
    })
}

pub fn save_app_settings(store: &SqliteStore, settings: AppSettings) -> AppResult<AppSettings> {
    validate_settings(&settings)?;
    let now = now_ms();
    let settings_json =
        serde_json::to_string(&settings).map_err(|error| AppError::storage(error.to_string()))?;

    store.write_transaction(|transaction| {
        let created_at_ms = transaction
            .query_row(
                "select created_at_ms from app_settings where id = 1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(now);
        transaction.execute(
            "
            insert into app_settings (id, settings_json, created_at_ms, updated_at_ms)
            values (1, ?1, ?2, ?3)
            on conflict(id) do update set
              settings_json = excluded.settings_json,
              updated_at_ms = excluded.updated_at_ms
            ",
            params![settings_json, created_at_ms, now],
        )?;
        Ok(settings)
    })
}

pub fn reset_app_settings_section(
    store: &SqliteStore,
    section: SettingsSection,
) -> AppResult<AppSettings> {
    let settings = get_app_settings(store)?;
    save_app_settings(store, settings.reset_section(section))
}

fn validate_settings(settings: &AppSettings) -> AppResult<()> {
    if !(11..=18).contains(&settings.ui_font_size) {
        return Err(AppError::validation("UI 字号必须在 11 到 18 之间"));
    }
    if !(9..=24).contains(&settings.terminal_font_size) {
        return Err(AppError::validation("终端字号必须在 9 到 24 之间"));
    }
    if settings.mcp.port == Some(0) {
        return Err(AppError::validation("MCP 端口不能为 0"));
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::settings::{
            AppLanguage, AppTheme, McpSettings, ShortcutBinding, ShortcutScope,
            WorkspaceRestoreStrategy,
        },
        storage::sqlite::SqliteStore,
    };

    fn custom_settings() -> AppSettings {
        AppSettings {
            language: AppLanguage::EnUs,
            theme: AppTheme::Light,
            ui_font_size: 17,
            terminal_font_size: 21,
            default_right_tool: Some("history".to_string()),
            workspace_restore_strategy: WorkspaceRestoreStrategy::ConnectAll,
            mcp: McpSettings {
                enabled: true,
                port: Some(39001),
            },
            shortcuts: vec![ShortcutBinding {
                action_id: "settings.open".to_string(),
                accelerator: "Alt+S".to_string(),
                scope: ShortcutScope::App,
            }],
        }
    }

    #[test]
    fn reset_app_settings_general_section_persists_defaults_without_changing_shortcuts() {
        let store = SqliteStore::open_in_memory().expect("store should open");
        save_app_settings(&store, custom_settings()).expect("settings should save");
        let current = get_app_settings(&store).expect("settings should load");
        let reset = reset_app_settings_section(&store, SettingsSection::General)
            .expect("settings should reset");

        assert_eq!(reset.language, AppLanguage::default());
        assert_eq!(reset.theme, AppTheme::default());
        assert_eq!(reset.ui_font_size, 13);
        assert_eq!(reset.terminal_font_size, 13);
        assert_eq!(reset.default_right_tool, Some("agent".to_string()));
        assert_eq!(
            reset.workspace_restore_strategy,
            WorkspaceRestoreStrategy::VisibleFirst
        );
        assert_eq!(reset.mcp, McpSettings::default());
        assert_eq!(reset.shortcuts, current.shortcuts);
        assert_eq!(
            get_app_settings(&store).expect("settings should load"),
            reset
        );
    }

    #[test]
    fn reset_app_settings_shortcuts_section_persists_shortcut_defaults_without_changing_general() {
        let store = SqliteStore::open_in_memory().expect("store should open");
        let current = save_app_settings(&store, custom_settings()).expect("settings should save");
        let reset = reset_app_settings_section(&store, SettingsSection::Shortcuts)
            .expect("settings should reset");

        assert_eq!(reset.language, current.language);
        assert_eq!(reset.theme, current.theme);
        assert_eq!(reset.ui_font_size, current.ui_font_size);
        assert_eq!(reset.terminal_font_size, current.terminal_font_size);
        assert_eq!(reset.default_right_tool, current.default_right_tool);
        assert_eq!(
            reset.workspace_restore_strategy,
            current.workspace_restore_strategy
        );
        assert_eq!(reset.mcp, current.mcp);
        assert_eq!(reset.shortcuts, AppSettings::default().shortcuts);
        assert_eq!(
            get_app_settings(&store).expect("settings should load"),
            reset
        );
    }

    #[test]
    fn unknown_workspace_restore_strategy_is_rejected_by_deserialization() {
        let result = serde_json::from_str::<AppSettings>(
            r#"{
              "language": "zhCN",
              "theme": "dark",
              "ui_font_size": 13,
              "terminal_font_size": 13,
              "default_right_tool": "agent",
              "workspace_restore_strategy": "eager_everything",
              "shortcuts": []
            }"#,
        );

        assert!(result.is_err());
    }
}
