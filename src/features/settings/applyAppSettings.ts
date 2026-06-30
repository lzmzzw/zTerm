// Author: Liz
import type { AppSettings } from "./settingsStore";

export function applyAppSettings(settings: AppSettings) {
  const root = document.documentElement;
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const theme = settings.theme === "system" ? systemTheme : settings.theme;
  root.dataset.ztTheme = theme;
  root.style.setProperty("--zt-font-size-ui", `${settings.ui_font_size}px`);
  root.style.setProperty("--zt-terminal-font-size", `${settings.terminal_font_size}px`);
}
