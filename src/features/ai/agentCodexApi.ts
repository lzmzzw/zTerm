// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { AiApprovalMode, AiToolPendingInvocation } from "./aiStore";
import type { RuntimeSessionInfo } from "../terminal/terminalStore";

export interface AgentCodexSession {
  agent_session_id: string;
  target_runtime_session_id: string;
  target_saved_session_id: string | null;
  target_label: string;
  approval_mode: AiApprovalMode;
  runtime: RuntimeSessionInfo;
}

export async function openAgentCodex(request: {
  tabId: string;
  targetRuntimeSessionId: string;
  targetSavedSessionId: string | null;
  targetLabel: string;
}) {
  return invoke<AgentCodexSession>("agent_codex_open", request);
}

export async function unbindAgentCodex(agentSessionId: string) {
  await invoke("agent_codex_unbind", { agentSessionId });
}

export type AgentPendingInvocation = AiToolPendingInvocation;
