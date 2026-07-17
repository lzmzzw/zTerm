// Author: Liz
import type { I18nKey } from "../features/settings/i18n";

export type RightTool = "agent" | "files" | "history" | "monitor" | "tunnels" | "containers";
export type ActiveConnectionKind =
  | "none"
  | "local"
  | "ssh"
  | "ssh_transient_multi"
  | "ssh_transient_restricted";

export const rightToolRailOrder: RightTool[] = ["monitor", "history", "files", "containers", "tunnels", "agent"];

const rightToolLabelKeys: Record<RightTool, I18nKey> = {
  agent: "agent",
  containers: "sshContainers",
  files: "sftpFiles",
  history: "history",
  monitor: "resourceMonitor",
  tunnels: "sshTunnels",
};

const rightToolShortcutActions = {
  "right_tool.files": "files",
  "right_tool.history": "history",
  "right_tool.monitor": "monitor",
} as const satisfies Record<string, RightTool>;

export function rightToolLabelKey(tool: RightTool): I18nKey {
  return rightToolLabelKeys[tool];
}

export function visibleRightTools(connectionKind: ActiveConnectionKind): RightTool[] {
  return rightToolRailOrder.filter((tool) => {
    if (tool === "monitor" || tool === "agent") return true;
    if (tool === "history") return connectionKind !== "none";
    return connectionKind === "ssh" || connectionKind === "ssh_transient_multi";
  });
}

export function rightToolFromShortcutActionId(actionId: string): RightTool | null {
  return rightToolShortcutActions[actionId as keyof typeof rightToolShortcutActions] ?? null;
}
