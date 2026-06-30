// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { WorkspaceDefinition, WorkspaceDefinitionDraft, WorkspaceSummary } from "./types";

export async function workspaceList(): Promise<WorkspaceSummary[]> {
  return invoke<WorkspaceSummary[]>("workspace_list");
}

export async function workspaceGet(workspaceId: string): Promise<WorkspaceDefinition> {
  return invoke<WorkspaceDefinition>("workspace_get", { workspaceId });
}

export async function workspaceSave(draft: WorkspaceDefinitionDraft): Promise<WorkspaceDefinition> {
  return invoke<WorkspaceDefinition>("workspace_save", { draft });
}

export async function workspaceDelete(workspaceId: string): Promise<void> {
  await invoke("workspace_delete", { workspaceId });
}

export async function workspaceRemove(workspaceId: string): Promise<void> {
  await invoke("workspace_remove", { workspaceId });
}
