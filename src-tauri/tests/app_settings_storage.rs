// Author: Liz
use zterm_lib::{
    models::settings::{
        AppLanguage, AppSettings, AppTheme, ShortcutBinding, ShortcutDefinition, ShortcutScope,
        WorkspaceRestoreStrategy,
    },
    storage::{
        settings::{get_app_settings, save_app_settings},
        sqlite::SqliteStore,
    },
};

#[test]
fn app_settings_have_expected_defaults() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");

    let settings = get_app_settings(&store).expect("settings should load");

    assert_eq!(settings.language, AppLanguage::ZhCn);
    assert_eq!(settings.theme, AppTheme::Dark);
    assert_eq!(settings.ui_font_size, 13);
    assert_eq!(settings.terminal_font_size, 13);
    assert_eq!(settings.default_right_tool.as_deref(), Some("agent"));
    assert_eq!(
        settings.workspace_restore_strategy,
        WorkspaceRestoreStrategy::VisibleFirst
    );
    assert!(settings
        .shortcuts
        .iter()
        .any(|binding| binding.action_id == "terminal.new_tab"
            && binding.accelerator == "Ctrl+Shift+T"));
}

#[test]
fn app_settings_round_trip_custom_shortcuts_and_theme() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let settings = AppSettings {
        language: AppLanguage::EnUs,
        theme: AppTheme::Light,
        ui_font_size: 14,
        terminal_font_size: 15,
        default_right_tool: Some("history".to_string()),
        workspace_restore_strategy: WorkspaceRestoreStrategy::LayoutOnly,
        shortcuts: vec![ShortcutBinding {
            action_id: "settings.open".to_string(),
            accelerator: "Ctrl+,".to_string(),
            scope: ShortcutScope::App,
        }],
    };

    save_app_settings(&store, settings.clone()).expect("settings should save");
    let loaded = get_app_settings(&store).expect("settings should reload");

    assert_eq!(loaded.language, settings.language);
    assert_eq!(loaded.theme, settings.theme);
    assert_eq!(loaded.ui_font_size, settings.ui_font_size);
    assert_eq!(loaded.terminal_font_size, settings.terminal_font_size);
    assert_eq!(loaded.default_right_tool, settings.default_right_tool);
    assert_eq!(
        loaded.workspace_restore_strategy,
        WorkspaceRestoreStrategy::LayoutOnly
    );
    assert!(loaded.shortcuts.iter().any(|binding| {
        binding.action_id == "settings.open" && binding.accelerator == "Ctrl+,"
    }));
    assert!(loaded
        .shortcuts
        .iter()
        .any(|binding| binding.action_id == "terminal.new_tab"));
}

#[test]
fn shortcut_registry_rejects_conflicting_default_bindings() {
    let definitions = vec![
        ShortcutDefinition::new("settings.open", "Open Settings", "Ctrl+,"),
        ShortcutDefinition::new("terminal.new_tab", "New Terminal Tab", "Ctrl+,"),
    ];

    let conflicts = AppSettings::detect_shortcut_conflicts(&definitions);

    assert_eq!(
        conflicts,
        vec![("settings.open".to_string(), "terminal.new_tab".to_string())]
    );
}
