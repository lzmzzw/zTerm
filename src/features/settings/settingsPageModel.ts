// Author: Liz
import type { I18nKey } from "./i18n";
import type {
  AppLanguage,
  AppSettings,
  AppTheme,
  ShortcutBinding,
  WorkspaceRestoreStrategy,
} from "./settingsStore";

export type SettingsTab = "general" | "shortcuts" | "terminal" | "about";

export const fallbackSettings: AppSettings = {
  language: "zhCN",
  theme: "dark",
  ui_font_size: 13,
  terminal_font_size: 13,
  default_right_tool: null,
  workspace_restore_strategy: "visible_first",
  shortcuts: [],
};

export const settingsTabs: SettingsTab[] = ["general", "shortcuts", "terminal", "about"];

export const languageOptions: Array<{ value: AppLanguage; labelKey: I18nKey }> = [
  { value: "zhCN", labelKey: "chinese" },
  { value: "enUS", labelKey: "english" },
];

export const themeOptions: Array<{ value: AppTheme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

export const workspaceRestoreStrategyOptions: Array<{
  value: WorkspaceRestoreStrategy;
  labelKey: I18nKey;
}> = [
  { value: "visible_first", labelKey: "restoreVisibleFirst" },
  { value: "connect_all", labelKey: "restoreConnectAll" },
  { value: "layout_only", labelKey: "restoreLayoutOnly" },
];

export function settingsShortcutPatchFor(
  actionId: string,
  currentActionId: string,
  patch: Partial<ShortcutBinding>,
) {
  return actionId === currentActionId ? patch : {};
}
