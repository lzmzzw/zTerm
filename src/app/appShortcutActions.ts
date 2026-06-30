// Author: Liz
import type { PaneSplitDirection } from "../features/workspace/types";
import { rightToolFromShortcutActionId, type RightTool } from "./rightTools";

interface AppShortcutContext {
  activePaneId: string | null;
  activePaneTabId: string | null;
  newTabPaneId: string | null;
}

type AppShortcutCommand =
  | { kind: "open_settings" }
  | { kind: "add_terminal_tab"; paneId: string }
  | { kind: "close_terminal_tab"; paneId: string; paneTabId: string }
  | { kind: "split_pane"; direction: PaneSplitDirection }
  | { kind: "toggle_right_tool"; tool: RightTool }
  | { kind: "noop" };

export function resolveAppShortcutAction(actionId: string, context: AppShortcutContext): AppShortcutCommand {
  if (actionId === "settings.open") {
    return { kind: "open_settings" };
  }
  if (actionId === "terminal.new_tab") {
    return context.newTabPaneId ? { kind: "add_terminal_tab", paneId: context.newTabPaneId } : { kind: "noop" };
  }
  if (actionId === "terminal.close_tab") {
    return context.activePaneId && context.activePaneTabId
      ? { kind: "close_terminal_tab", paneId: context.activePaneId, paneTabId: context.activePaneTabId }
      : { kind: "noop" };
  }
  if (actionId === "terminal.split_horizontal") {
    return { kind: "split_pane", direction: "horizontal" };
  }
  if (actionId === "terminal.split_vertical") {
    return { kind: "split_pane", direction: "vertical" };
  }
  const rightTool = rightToolFromShortcutActionId(actionId);
  if (rightTool) {
    return { kind: "toggle_right_tool", tool: rightTool };
  }
  return { kind: "noop" };
}
