// Author: Liz
import type { I18nKey } from "../features/settings/i18n";

export type RightTool = "agent" | "files" | "history" | "monitor";

export const rightToolRailOrder: RightTool[] = ["files", "history", "monitor", "agent"];

const rightToolLabelKeys: Record<RightTool, I18nKey> = {
  agent: "agent",
  files: "sftpFiles",
  history: "history",
  monitor: "resourceMonitor",
};

const rightToolShortcutActions = {
  "right_tool.files": "files",
  "right_tool.history": "history",
  "right_tool.monitor": "monitor",
} as const satisfies Record<string, RightTool>;

export function rightToolLabelKey(tool: RightTool): I18nKey {
  return rightToolLabelKeys[tool];
}

export function rightToolFromShortcutActionId(actionId: string): RightTool | null {
  return rightToolShortcutActions[actionId as keyof typeof rightToolShortcutActions] ?? null;
}
