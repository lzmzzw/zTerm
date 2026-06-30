// Author: Liz
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppLanguage {
    #[serde(rename = "zhCN")]
    ZhCn,
    #[serde(rename = "enUS")]
    EnUs,
}

impl Default for AppLanguage {
    fn default() -> Self {
        Self::ZhCn
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppTheme {
    Dark,
    Light,
    System,
}

impl Default for AppTheme {
    fn default() -> Self {
        Self::Dark
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRestoreStrategy {
    VisibleFirst,
    ConnectAll,
    LayoutOnly,
}

impl Default for WorkspaceRestoreStrategy {
    fn default() -> Self {
        Self::VisibleFirst
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutScope {
    App,
}

impl Default for ShortcutScope {
    fn default() -> Self {
        Self::App
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingsSection {
    General,
    Shortcuts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutBinding {
    pub action_id: String,
    pub accelerator: String,
    #[serde(default)]
    pub scope: ShortcutScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutDefinition {
    pub action_id: String,
    pub label: String,
    pub default_accelerator: String,
    pub scope: ShortcutScope,
}

impl ShortcutDefinition {
    pub fn new(
        action_id: impl Into<String>,
        label: impl Into<String>,
        default_accelerator: impl Into<String>,
    ) -> Self {
        Self {
            action_id: action_id.into(),
            label: label.into(),
            default_accelerator: default_accelerator.into(),
            scope: ShortcutScope::App,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub language: AppLanguage,
    #[serde(default)]
    pub theme: AppTheme,
    #[serde(default = "default_ui_font_size")]
    pub ui_font_size: u16,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u16,
    #[serde(default = "default_right_tool")]
    pub default_right_tool: Option<String>,
    #[serde(default)]
    pub workspace_restore_strategy: WorkspaceRestoreStrategy,
    #[serde(default = "default_shortcuts")]
    pub shortcuts: Vec<ShortcutBinding>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: AppLanguage::default(),
            theme: AppTheme::default(),
            ui_font_size: default_ui_font_size(),
            terminal_font_size: default_terminal_font_size(),
            default_right_tool: default_right_tool(),
            workspace_restore_strategy: WorkspaceRestoreStrategy::default(),
            shortcuts: default_shortcuts(),
        }
    }
}

impl AppSettings {
    pub fn reset_section(mut self, section: SettingsSection) -> Self {
        let defaults = Self::default();
        match section {
            SettingsSection::General => {
                self.language = defaults.language;
                self.theme = defaults.theme;
                self.ui_font_size = defaults.ui_font_size;
                self.terminal_font_size = defaults.terminal_font_size;
                self.default_right_tool = defaults.default_right_tool;
                self.workspace_restore_strategy = defaults.workspace_restore_strategy;
            }
            SettingsSection::Shortcuts => {
                self.shortcuts = defaults.shortcuts;
            }
        }
        self
    }

    pub fn detect_shortcut_conflicts(definitions: &[ShortcutDefinition]) -> Vec<(String, String)> {
        let mut seen: HashMap<String, String> = HashMap::new();
        let mut conflicts = Vec::new();
        for definition in definitions {
            let accelerator = normalize_accelerator(&definition.default_accelerator);
            if accelerator.is_empty() {
                continue;
            }
            if let Some(previous) = seen.insert(accelerator, definition.action_id.clone()) {
                conflicts.push((previous, definition.action_id.clone()));
            }
        }
        conflicts
    }

    pub fn merged_with_registry(mut self) -> Self {
        let known: HashSet<String> = self
            .shortcuts
            .iter()
            .map(|binding| binding.action_id.clone())
            .collect();
        for definition in shortcut_registry() {
            if !known.contains(&definition.action_id) {
                self.shortcuts.push(ShortcutBinding {
                    action_id: definition.action_id,
                    accelerator: definition.default_accelerator,
                    scope: definition.scope,
                });
            }
        }
        self
    }
}

pub fn shortcut_registry() -> Vec<ShortcutDefinition> {
    vec![
        ShortcutDefinition::new("settings.open", "打开设置", "Ctrl+,"),
        ShortcutDefinition::new("terminal.new_tab", "新建终端标签", "Ctrl+N"),
        ShortcutDefinition::new("terminal.close_tab", "关闭终端标签", "Ctrl+W"),
        ShortcutDefinition::new(
            "terminal.split_horizontal",
            "水平分屏",
            "Ctrl+Shift+Arrowright",
        ),
        ShortcutDefinition::new(
            "terminal.split_vertical",
            "垂直分屏",
            "Ctrl+Shift+Arrowdown",
        ),
        ShortcutDefinition::new("right_tool.files", "打开 SFTP", "Ctrl+Shift+S"),
        ShortcutDefinition::new("right_tool.history", "打开历史命令", "Ctrl+H"),
    ]
}

fn default_ui_font_size() -> u16 {
    13
}

fn default_terminal_font_size() -> u16 {
    13
}

fn default_right_tool() -> Option<String> {
    Some("agent".to_string())
}

fn default_shortcuts() -> Vec<ShortcutBinding> {
    shortcut_registry()
        .into_iter()
        .map(|definition| ShortcutBinding {
            action_id: definition.action_id,
            accelerator: definition.default_accelerator,
            scope: definition.scope,
        })
        .collect()
}

fn normalize_accelerator(value: &str) -> String {
    value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn customized_settings() -> AppSettings {
        AppSettings {
            language: AppLanguage::EnUs,
            theme: AppTheme::Light,
            ui_font_size: 17,
            terminal_font_size: 21,
            default_right_tool: Some("history".to_string()),
            workspace_restore_strategy: WorkspaceRestoreStrategy::LayoutOnly,
            shortcuts: vec![ShortcutBinding {
                action_id: "settings.open".to_string(),
                accelerator: "Alt+S".to_string(),
                scope: ShortcutScope::App,
            }],
        }
    }

    #[test]
    fn reset_general_restores_general_defaults_and_preserves_shortcuts() {
        let current = customized_settings();
        let shortcuts = current.shortcuts.clone();
        let reset = current.reset_section(SettingsSection::General);

        assert_eq!(reset.language, AppLanguage::default());
        assert_eq!(reset.theme, AppTheme::default());
        assert_eq!(reset.ui_font_size, 13);
        assert_eq!(reset.terminal_font_size, 13);
        assert_eq!(reset.default_right_tool, Some("agent".to_string()));
        assert_eq!(
            reset.workspace_restore_strategy,
            WorkspaceRestoreStrategy::VisibleFirst
        );
        assert_eq!(reset.shortcuts, shortcuts);
    }

    #[test]
    fn reset_shortcuts_restores_shortcut_defaults_and_preserves_general_settings() {
        let current = customized_settings();
        let reset = current.clone().reset_section(SettingsSection::Shortcuts);

        assert_eq!(reset.language, current.language);
        assert_eq!(reset.theme, current.theme);
        assert_eq!(reset.ui_font_size, current.ui_font_size);
        assert_eq!(reset.terminal_font_size, current.terminal_font_size);
        assert_eq!(reset.default_right_tool, current.default_right_tool);
        assert_eq!(
            reset.workspace_restore_strategy,
            current.workspace_restore_strategy
        );
        assert_eq!(reset.shortcuts, AppSettings::default().shortcuts);
    }

    #[test]
    fn shortcut_registry_matches_application_defaults() {
        let defaults = shortcut_registry()
            .into_iter()
            .map(|definition| (definition.action_id, definition.default_accelerator))
            .collect::<Vec<_>>();

        assert_eq!(
            defaults,
            vec![
                ("settings.open".to_string(), "Ctrl+,".to_string()),
                ("terminal.new_tab".to_string(), "Ctrl+N".to_string()),
                ("terminal.close_tab".to_string(), "Ctrl+W".to_string()),
                (
                    "terminal.split_horizontal".to_string(),
                    "Ctrl+Shift+Arrowright".to_string()
                ),
                (
                    "terminal.split_vertical".to_string(),
                    "Ctrl+Shift+Arrowdown".to_string()
                ),
                ("right_tool.files".to_string(), "Ctrl+Shift+S".to_string()),
                ("right_tool.history".to_string(), "Ctrl+H".to_string()),
            ]
        );
    }

    #[test]
    fn app_settings_default_visible_first_when_old_json_has_no_restore_strategy() {
        let value = serde_json::from_str::<AppSettings>(
            r#"{
              "language": "zhCN",
              "theme": "dark",
              "ui_font_size": 13,
              "terminal_font_size": 13,
              "default_right_tool": "agent",
              "shortcuts": []
            }"#,
        )
        .expect("old settings json should deserialize");

        assert_eq!(
            value.workspace_restore_strategy,
            WorkspaceRestoreStrategy::VisibleFirst
        );
    }
}
