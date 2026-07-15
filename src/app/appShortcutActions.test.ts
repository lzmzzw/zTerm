// Author: Liz
import { describe, expect, it } from "vitest";

import { resolveAppShortcutAction } from "./appShortcutActions";

describe("resolveAppShortcutAction", () => {
  const readyContext = {
    activePaneId: "pane-1",
    activePaneTabId: "pane-tab-1",
    newTabPaneId: "pane-1",
  };

  it("maps settings and terminal tab actions to executable commands", () => {
    expect(resolveAppShortcutAction("settings.open", readyContext)).toEqual({ kind: "open_settings" });
    expect(resolveAppShortcutAction("terminal.new_tab", readyContext)).toEqual({
      kind: "add_terminal_tab",
      paneId: "pane-1",
    });
    expect(resolveAppShortcutAction("terminal.close_tab", readyContext)).toEqual({
      kind: "close_terminal_tab",
      paneId: "pane-1",
      paneTabId: "pane-tab-1",
    });
    expect(resolveAppShortcutAction("sync_channel.open", readyContext)).toEqual({ kind: "open_sync_channel" });
  });

  it("keeps tab actions inert when the required active pane context is missing", () => {
    expect(
      resolveAppShortcutAction("terminal.new_tab", {
        ...readyContext,
        newTabPaneId: null,
      }),
    ).toEqual({ kind: "noop" });
    expect(
      resolveAppShortcutAction("terminal.close_tab", {
        ...readyContext,
        activePaneTabId: null,
      }),
    ).toEqual({ kind: "noop" });
  });

  it("maps split pane actions without requiring terminal tab context", () => {
    expect(resolveAppShortcutAction("terminal.split_horizontal", readyContext)).toEqual({
      kind: "split_pane",
      direction: "horizontal",
    });
    expect(resolveAppShortcutAction("terminal.split_vertical", readyContext)).toEqual({
      kind: "split_pane",
      direction: "vertical",
    });
  });

  it("maps right tool actions and ignores unknown action ids", () => {
    expect(resolveAppShortcutAction("right_tool.files", readyContext)).toEqual({
      kind: "toggle_right_tool",
      tool: "files",
    });
    expect(resolveAppShortcutAction("right_tool.history", readyContext)).toEqual({
      kind: "toggle_right_tool",
      tool: "history",
    });
    expect(resolveAppShortcutAction("right_tool.monitor", readyContext)).toEqual({
      kind: "toggle_right_tool",
      tool: "monitor",
    });
    expect(resolveAppShortcutAction("unknown.action", readyContext)).toEqual({ kind: "noop" });
  });
});
