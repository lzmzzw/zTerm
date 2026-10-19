// Author: Liz
import type { PaneTerminalTab } from "./types";
export function isReusableConnectionTab(tab: PaneTerminalTab): boolean {
  return !tab.runtime_session_id && !tab.saved_session_id && tab.connection_source !== "missing"
    && tab.restore_status !== "pending" && tab.restore_status !== "queued";
}
