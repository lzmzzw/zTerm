// Author: Liz
import type { I18nKey } from "./i18n";
import type {
  AppLanguage,
  AppSettings,
  AppTheme,
  ShortcutBinding,
} from "./settingsStore";

export type SettingsTab = "general" | "shortcuts" | "terminal" | "mcp" | "about";

export const fallbackSettings: AppSettings = {
  language: "zhCN",
  theme: "dark",
  ui_font_size: 13,
  terminal_font_size: 13,
  default_right_tool: null,
  mcp: { enabled: false, port: null },
  shortcuts: [],
};

export const settingsTabs: SettingsTab[] = ["general", "shortcuts", "terminal", "mcp", "about"];

export const languageOptions: Array<{ value: AppLanguage; labelKey: I18nKey }> = [
  { value: "zhCN", labelKey: "chinese" },
  { value: "enUS", labelKey: "english" },
];

export const themeOptions: Array<{ value: AppTheme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];


export function settingsShortcutPatchFor(
  actionId: string,
  currentActionId: string,
  patch: Partial<ShortcutBinding>,
) {
  return actionId === currentActionId ? patch : {};
}
