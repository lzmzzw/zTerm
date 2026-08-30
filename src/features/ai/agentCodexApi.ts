// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { McpApprovalMode, McpToolPendingInvocation } from "./mcpStore";
import type { RuntimeSessionInfo } from "../terminal/terminalStore";

export interface AgentCodexSession {
  agent_session_id: string;
  target_runtime_session_id: string;
  target_saved_session_id: string | null;
  target_label: string;
  approval_mode: McpApprovalMode;
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

export async function closeAgentCodex(session: AgentCodexSession) {
  await invoke("agent_codex_close", {
    agentSessionId: session.agent_session_id,
    runtimeSessionId: session.runtime.runtime_session_id,
  });
}

export type AgentPendingInvocation = McpToolPendingInvocation;
