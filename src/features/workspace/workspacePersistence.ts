// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

import type { WorkspaceDefinition, WorkspaceDefinitionDraft, WorkspaceSummary } from "./types";

export async function workspaceList(): Promise<WorkspaceSummary[]> {
  return invokeTauri<WorkspaceSummary[]>("workspace_list");
}

export async function workspaceGet(workspaceId: string): Promise<WorkspaceDefinition> {
  return invokeTauri<WorkspaceDefinition>("workspace_get", { workspaceId });
}

export async function workspaceSave(draft: WorkspaceDefinitionDraft): Promise<WorkspaceDefinition> {
  return invokeTauri<WorkspaceDefinition>("workspace_save", { draft });
}

export async function workspaceSaveDefaultSnapshot(draft: WorkspaceDefinitionDraft): Promise<WorkspaceDefinition> {
  return invokeTauri<WorkspaceDefinition>("workspace_save_default_snapshot", { draft });
}

export async function workspaceRemove(workspaceId: string): Promise<void> {
  await invokeTauri("workspace_remove", { workspaceId });
}
