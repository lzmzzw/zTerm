// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";
import { DEFAULT_TERMINAL_LAYOUT_ID } from "./terminalLayoutConstants";
import type { TerminalLayoutDefinition, TerminalLayoutDefinitionDraft, PaneNode, PaneTerminalTab } from "./types";

type TerminalLayoutSnapshot = Pick<TerminalLayoutDefinitionDraft, "active_tab_id" | "tabs">;
export async function loadTerminalLayout(): Promise<TerminalLayoutDefinition | null> {
  const snapshot = await invokeTauri<TerminalLayoutSnapshot | null>("terminal_layout_get");
  if (!snapshot || snapshot.tabs.length === 0) return null;
  const now = Date.now();
  return { ...snapshot, id: DEFAULT_TERMINAL_LAYOUT_ID, name: "终端布局", status: "running", sort_order: 0,
    created_at_ms: now, updated_at_ms: now, tabs: snapshot.tabs.map(tab => ({ ...tab, created_at_ms: now, updated_at_ms: now })) };
}
export function terminalLayoutSnapshot(draft: TerminalLayoutDefinitionDraft): TerminalLayoutSnapshot {
  const current = draft.tabs.find(tab => tab.id === draft.active_tab_id) ?? draft.tabs[0];
  return { active_tab_id: current?.id ?? "", tabs: current ? [{ ...current, root: snapshotRoot(current.root) }] : [] };
}
function snapshotRoot(root: PaneNode): PaneNode {
  if (root.kind === "split") return { ...root, first: snapshotRoot(root.first), second: snapshotRoot(root.second) };
  const cleanTab = (tab: PaneTerminalTab): PaneTerminalTab => ({ id: tab.id, title: tab.title,
    runtime_session_id: null, saved_session_id: tab.saved_session_id, connection_source: tab.connection_source,
    container_target: tab.container_target, path: tab.path });
  return { ...root, runtime_session_id: null, terminal_tabs: root.terminal_tabs?.map(cleanTab) };
}
let saveQueue: Promise<unknown> = Promise.resolve();
export async function saveTerminalLayout(draft: TerminalLayoutDefinitionDraft): Promise<void> {
  const snapshot = terminalLayoutSnapshot(draft);
  const pending = saveQueue.catch(() => undefined).then(() => invokeTauri("terminal_layout_save", { snapshot }));
  saveQueue = pending;
  await pending;
}
