// Author: Liz
import { describe, expect, it } from "vitest";

import {
  fallbackSettings,
  languageOptions,
  settingsShortcutPatchFor,
  settingsTabs,
  themeOptions,
} from "./settingsPageModel";

describe("settingsPageModel", () => {
  it("keeps the settings page fallback state and tab order stable", () => {
    expect(fallbackSettings).toEqual({
      language: "zhCN",
      theme: "dark",
      ui_font_size: 13,
      terminal_font_size: 13,
      default_right_tool: null,
      mcp: { enabled: false, port: null },
      shortcuts: [],
    });
    expect(settingsTabs).toEqual(["general", "shortcuts", "terminal", "mcp", "about"]);
  });

  it("keeps option values and label keys stable", () => {
    expect(languageOptions).toEqual([
      { value: "zhCN", labelKey: "chinese" },
      { value: "enUS", labelKey: "english" },
    ]);
    expect(themeOptions).toEqual([
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "system", label: "System" },
    ]);
  });

  it("only applies a shortcut binding patch to the requested action", () => {
    const patch = { accelerator: "Ctrl+Shift+K" };

    expect(settingsShortcutPatchFor("new-terminal", "new-terminal", patch)).toBe(patch);
    expect(settingsShortcutPatchFor("new-terminal", "settings", patch)).toEqual({});
  });
});
