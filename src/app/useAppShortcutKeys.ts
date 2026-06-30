// Author: Liz
import { useEffect, useRef } from "react";

import { resolveAppShortcutAction } from "./appShortcutActions";
import type { RightTool } from "./rightTools";
import { shortcutMatches } from "../features/settings/shortcutManager";
import type { ShortcutBinding } from "../features/settings/settingsStore";
import type { PaneSplitDirection } from "../features/workspace/types";

interface AppShortcutKeyContext {
  activePaneId: string | null;
  activePaneTabId: string | null;
  newTabPaneId: string | null;
}

interface AppShortcutKeyHandlers {
  onOpenSettings: () => void;
  onAddTerminalTab: (paneId: string) => void;
  onCloseTerminalTab: (paneId: string, paneTabId: string) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onToggleRightTool: (tool: RightTool) => void;
}

export function useAppShortcutKeys(
  bindings: ShortcutBinding[],
  context: AppShortcutKeyContext,
  handlers: AppShortcutKeyHandlers,
) {
  const bindingsRef = useRef(bindings);
  const contextRef = useRef(context);
  const handlersRef = useRef(handlers);

  bindingsRef.current = bindings;
  contextRef.current = context;
  handlersRef.current = handlers;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const matched = bindingsRef.current.find((binding) => shortcutMatches(event, binding.accelerator));
      if (!matched) return;
      event.preventDefault();
      const command = resolveAppShortcutAction(matched.action_id, contextRef.current);
      const activeHandlers = handlersRef.current;
      if (command.kind === "open_settings") {
        activeHandlers.onOpenSettings();
      } else if (command.kind === "add_terminal_tab") {
        activeHandlers.onAddTerminalTab(command.paneId);
      } else if (command.kind === "close_terminal_tab") {
        activeHandlers.onCloseTerminalTab(command.paneId, command.paneTabId);
      } else if (command.kind === "split_pane") {
        activeHandlers.onSplitPane(command.direction);
      } else if (command.kind === "toggle_right_tool") {
        activeHandlers.onToggleRightTool(command.tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
