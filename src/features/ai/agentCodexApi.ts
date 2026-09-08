// Author: Liz
import { invokeTauri } from "../../lib/tauriClient";

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
  return invokeTauri<AgentCodexSession>("agent_codex_open", request);
}

export async function closeAgentCodex(session: AgentCodexSession) {
  await invokeTauri("agent_codex_close", {
    agentSessionId: session.agent_session_id,
    runtimeSessionId: session.runtime.runtime_session_id,
  });
}

export async function setActiveAgentTerminal(runtimeSessionId: string | null) {
  await invokeTauri("agent_set_active_terminal", { runtimeSessionId });
}

export type AgentPendingInvocation = McpToolPendingInvocation;
