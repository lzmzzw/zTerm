// Author: Liz
import { describe, expect, it } from "vitest";

import {
  fallbackSettings,
  languageOptions,
  rightToolOptions,
  settingsShortcutPatchFor,
  settingsTabs,
  themeOptions,
  workspaceRestoreStrategyOptions,
} from "./settingsPageModel";

describe("settingsPageModel", () => {
  it("keeps the settings page fallback state and tab order stable", () => {
    expect(fallbackSettings).toEqual({
      language: "zhCN",
      theme: "dark",
      ui_font_size: 13,
      terminal_font_size: 13,
      default_right_tool: null,
      workspace_restore_strategy: "visible_first",
      shortcuts: [],
    });
    expect(settingsTabs).toEqual(["general", "shortcuts", "terminal", "about"]);
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
    expect(rightToolOptions).toEqual([
      { value: "agent", label: "Agent" },
      { value: "files", label: "SFTP" },
      { value: "history", label: "History" },
      { value: "transfer", label: "Transfer" },
    ]);
    expect(workspaceRestoreStrategyOptions).toEqual([
      { value: "visible_first", labelKey: "restoreVisibleFirst" },
      { value: "connect_all", labelKey: "restoreConnectAll" },
      { value: "layout_only", labelKey: "restoreLayoutOnly" },
    ]);
  });

  it("only applies a shortcut binding patch to the requested action", () => {
    const patch = { accelerator: "Ctrl+Shift+K" };

    expect(settingsShortcutPatchFor("new-terminal", "new-terminal", patch)).toBe(patch);
    expect(settingsShortcutPatchFor("new-terminal", "settings", patch)).toEqual({});
  });
});
