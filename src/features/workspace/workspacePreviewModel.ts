// Author: Liz
import type {
  WorkspaceDefinition,
  WorkspaceDefinitionDraft,
  WorkspaceTab,
} from "./types";

export function definitionFromDraft(
  draft: WorkspaceDefinitionDraft,
  source?: Pick<WorkspaceDefinition, "created_at_ms" | "updated_at_ms">,
): WorkspaceDefinition {
  const now = Date.now();
  return {
    id: draft.id?.trim() || "workspace-preview",
    name: draft.name,
    status: draft.status,
    active_tab_id: draft.active_tab_id,
    tabs: draft.tabs.map((tab) => workspaceTabFromDraft(tab, source, now)),
    sort_order: draft.sort_order,
    created_at_ms: source?.created_at_ms ?? now,
    updated_at_ms: source?.updated_at_ms ?? now,
  };
}

function workspaceTabFromDraft(
  tab: WorkspaceDefinitionDraft["tabs"][number],
  source: Pick<WorkspaceDefinition, "created_at_ms" | "updated_at_ms"> | undefined,
  now: number,
): WorkspaceTab {
  return {
    ...tab,
    created_at_ms: source?.created_at_ms ?? now,
    updated_at_ms: source?.updated_at_ms ?? now,
  };
}
