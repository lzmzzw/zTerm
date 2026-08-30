// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

type RiskLevel = "low" | "medium" | "high" | "critical";
type McpToolInvocationStatus = "pending" | "rejected" | "succeeded" | "failed";

export type McpApprovalMode = "request_approval" | "safe" | "full_access";

interface McpConnectionApprovalPolicy {
  saved_session_id: string;
  approval_mode: McpApprovalMode;
  updated_at_ms: number;
}

export interface McpToolPendingInvocation {
  id: string;
  tool_id: string;
  tool_title: string;
  risk_level: RiskLevel;
  arguments_summary: string;
  target_summary?: string | null;
  risk_summary?: string | null;
  requires_confirmation: boolean;
  requires_secret_input?: boolean;
  secret_input_label?: string | null;
  status: McpToolInvocationStatus;
  created_at_ms?: number;
  run_id?: string | null;
  step_id?: string | null;
  reason?: string | null;
  requested_by?: string | null;
}

interface McpToolAuditRecord {
  affected_domains?: string[];
}

export interface McpToolSecretInputs {
  password?: string;
}

type AffectedDomainsHandler = (domains: string[]) => Promise<void> | void;

interface McpState {
  approvalMode: McpApprovalMode;
  approvalSessionId: string | null;
  pendingInvocations: McpToolPendingInvocation[];
  loading: boolean;
  error: string | null;
  loadPendingInvocations: () => Promise<void>;
  bindApprovalModeToSession: (savedSessionId: string | null) => Promise<void>;
  setApprovalMode: (mode: McpApprovalMode) => Promise<void>;
  confirmTool: (invocationId: string, approved: boolean, secretInputs?: McpToolSecretInputs) => Promise<void>;
}

let approvalBindingRequestId = 0;
let approvalUpdateRequestId = 0;
let affectedDomainsHandler: AffectedDomainsHandler | null = null;

export function setMcpAffectedDomainsHandler(handler: AffectedDomainsHandler | null) {
  affectedDomainsHandler = handler;
}

export const useMcpStore = create<McpState>((set, get) => ({
  approvalMode: "safe",
  approvalSessionId: null,
  pendingInvocations: [],
  loading: false,
  error: null,
  async loadPendingInvocations() {
    try {
      const pendingInvocations = await invoke<McpToolPendingInvocation[]>("mcp_tool_pending");
      set({ pendingInvocations, error: null });
    } catch (error) {
      set({ error: unknownErrorMessage(error, "MCP 工具状态加载失败") });
    }
  },
  async bindApprovalModeToSession(savedSessionId) {
    const normalizedSessionId = savedSessionId?.trim() || null;
    const requestId = approvalBindingRequestId + 1;
    approvalBindingRequestId = requestId;
    approvalUpdateRequestId += 1;
    if (!normalizedSessionId) {
      set({ approvalSessionId: null, approvalMode: "safe", error: null });
      return;
    }
    set({ approvalSessionId: normalizedSessionId, approvalMode: "safe", error: null });
    try {
      const policy = await invoke<McpConnectionApprovalPolicy>("mcp_connection_approval_mode_get", {
        savedSessionId: normalizedSessionId,
      });
      if (approvalBindingRequestId === requestId && get().approvalSessionId === normalizedSessionId) {
        set({ approvalMode: policy.approval_mode, error: null });
      }
    } catch (error) {
      if (approvalBindingRequestId === requestId && get().approvalSessionId === normalizedSessionId) {
        set({ approvalMode: "safe", error: unknownErrorMessage(error, "MCP 审批策略加载失败") });
      }
    }
  },
  async setApprovalMode(mode) {
    const approvalSessionId = get().approvalSessionId;
    if (!approvalSessionId) {
      set({ approvalMode: mode });
      return;
    }
    approvalBindingRequestId += 1;
    const requestId = approvalUpdateRequestId + 1;
    approvalUpdateRequestId = requestId;
    try {
      const policy = await invoke<McpConnectionApprovalPolicy>("mcp_connection_approval_mode_set", {
        request: {
          saved_session_id: approvalSessionId,
          approval_mode: mode,
        },
      });
      if (approvalUpdateRequestId === requestId && get().approvalSessionId === policy.saved_session_id) {
        set({ approvalMode: policy.approval_mode, error: null });
      }
    } catch (error) {
      if (approvalUpdateRequestId === requestId && get().approvalSessionId === approvalSessionId) {
        set({ error: unknownErrorMessage(error, "MCP 审批策略保存失败") });
      }
    }
  },
  async confirmTool(invocationId, approved, secretInputs) {
    set({ loading: true, error: null });
    try {
      const audit = await invoke<McpToolAuditRecord>("mcp_tool_confirm", {
        request: {
          invocation_id: invocationId,
          approved,
          audit_context_json: null,
          secret_inputs: secretInputs ?? null,
        },
      });
      await notifyAffectedDomains(audit);
      const pendingInvocations = await invoke<McpToolPendingInvocation[]>("mcp_tool_pending");
      set({ pendingInvocations, loading: false });
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "MCP 工具确认失败") });
    }
  },
}));

async function notifyAffectedDomains(record: McpToolAuditRecord) {
  if (!affectedDomainsHandler) return;
  const domains = [...new Set((record.affected_domains ?? []).map((domain) => domain.trim()).filter(Boolean))];
  if (domains.length > 0) await affectedDomainsHandler(domains);
}
