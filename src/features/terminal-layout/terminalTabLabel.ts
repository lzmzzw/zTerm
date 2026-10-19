import type { PaneTerminalTab } from "./types";

export function terminalTabLabel(tab: PaneTerminalTab, sessionLabels?: Record<string, string>): string {
  const host = sessionLabels?.[tab.saved_session_id ?? ""];
  if (!host) return tab.title;
  if (tab.connection_source === "ssh_container") {
    const container = tab.container_target?.name || tab.container_target?.id.slice(0, 12) || tab.title;
    return `${host} · ${container}`;
  }
  return host + (tab.title.match(/\s\(\d+\)$/)?.[0] ?? "");
}
