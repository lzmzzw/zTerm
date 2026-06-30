// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { unknownErrorMessage } from "../../lib/unknownErrorMessage";

type RiskLevel = "low" | "medium" | "high" | "critical";
export type AiApprovalMode = "request_approval" | "safe" | "full_access";

type AiMessageRole = "user" | "assistant" | "system" | "tool";
type AiToolInvocationStatus = "pending" | "rejected" | "succeeded" | "failed";

export interface AiConversationSummary {
  id: string;
  title: string;
  scope_kind?: string;
  scope_ref_json?: string;
  approval_mode?: AiApprovalMode;
  status?: string;
  created_at_ms?: number;
  updated_at_ms: number;
}

export interface AiConversationMessage {
  id: string;
  conversation_id: string;
  role: AiMessageRole;
  content: string;
  status: string;
  metadata_json?: string | null;
  created_at_ms?: number;
}

interface AiConversation {
  id: string;
  title: string;
  scope_kind: string;
  scope_ref_json: string;
  approval_mode: AiApprovalMode;
  status: string;
  created_at_ms: number;
  updated_at_ms: number;
  messages: AiConversationMessage[];
}

export interface AiTerminalContextSnapshot {
  runtime_session_id?: string | null;
  saved_session_id?: string | null;
  pane_id?: string | null;
  title?: string | null;
  cwd?: string | null;
  target_summary?: string | null;
  recent_output?: string | null;
  recent_output_tail?: string | null;
  selected_text?: string | null;
  input_buffer?: string | null;
  active_tool?: string | null;
  generated_at_ms?: number;
}

export interface AiToolPendingInvocation {
  id: string;
  tool_id: string;
  tool_title: string;
  risk_level: RiskLevel;
  arguments_summary: string;
  target_summary?: string | null;
  risk_summary?: string | null;
  requires_confirmation: boolean;
  status: AiToolInvocationStatus;
  created_at_ms?: number;
  conversation_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  reason?: string | null;
  requested_by?: string | null;
}

interface AiChatResponse {
  conversation_id: string;
  provider_id: string;
  provider_name: string;
  model: string;
  message: string;
  pending_invocations: AiToolPendingInvocation[];
  executed_invocations: AiToolAuditRecord[];
  response_redacted: boolean;
  context_used: boolean;
  tool_count: number;
  generated_at_ms: number;
}

interface AiToolAuditRecord {
  id: string;
  invocation_id: string;
  tool_id: string;
  tool_title: string;
  risk_level: RiskLevel;
  arguments_summary: string;
  risk_summary?: string | null;
  status: AiToolInvocationStatus;
  result_summary?: string | null;
  error?: string | null;
  audit_context_json?: string | null;
  created_at_ms: number;
  completed_at_ms: number;
}

interface AiState {
  conversations: AiConversationSummary[];
  activeConversationId: string | null;
  approvalMode: AiApprovalMode;
  messages: AiConversationMessage[];
  pendingInvocations: AiToolPendingInvocation[];
  contextSnapshot: AiTerminalContextSnapshot | null;
  loading: boolean;
  error: string | null;
  loadConversations: () => Promise<void>;
  loadPendingInvocations: () => Promise<void>;
  captureContext: (context: AiTerminalContextSnapshot) => Promise<void>;
  sendChat: (message: string, context: AiTerminalContextSnapshot | null) => Promise<void>;
  setApprovalMode: (mode: AiApprovalMode) => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (conversationId: string) => Promise<void>;
  confirmTool: (invocationId: string, approved: boolean) => Promise<void>;
}

let contextCaptureRequestId = 0;

export const useAiStore = create<AiState>((set) => ({
  conversations: [],
  activeConversationId: null,
  approvalMode: "safe",
  messages: [],
  pendingInvocations: [],
  contextSnapshot: null,
  loading: false,
  error: null,
  async loadConversations() {
    try {
      const conversations = await invoke<AiConversationSummary[]>("ai_conversation_list", {});
      set((state) => ({
        conversations,
        activeConversationId: state.activeConversationId ?? conversations[0]?.id ?? null,
        approvalMode:
          state.activeConversationId === null && conversations[0]?.approval_mode
            ? conversations[0].approval_mode
            : state.approvalMode,
      }));
      const activeId = useAiStore.getState().activeConversationId;
      if (activeId) {
        await useAiStore.getState().selectConversation(activeId);
      }
    } catch (error) {
      set({ error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  async loadPendingInvocations() {
    try {
      const pendingInvocations = await invoke<AiToolPendingInvocation[]>("ai_tool_pending");
      set({ pendingInvocations });
    } catch (error) {
      set({ error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  async captureContext(context) {
    const requestId = contextCaptureRequestId + 1;
    contextCaptureRequestId = requestId;
    try {
      const snapshot = await invoke<AiTerminalContextSnapshot>("ai_terminal_context_snapshot", { request: context });
      if (contextCaptureRequestId === requestId) {
        set({ contextSnapshot: snapshot });
      }
    } catch {
      if (contextCaptureRequestId === requestId) {
        set({ contextSnapshot: context });
      }
    }
  },
  async sendChat(message, context) {
    const content = message.trim();
    if (!content) return;
    set({ loading: true, error: null });
    try {
      const response = await invoke<AiChatResponse>("ai_chat", {
        request: {
          conversation_id: useAiStore.getState().activeConversationId,
          message: content,
          approval_mode: useAiStore.getState().approvalMode,
          history: [],
          terminal_context: context,
        },
      });
      const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId: response.conversation_id });
      set((state) => ({
        activeConversationId: response.conversation_id,
        messages: conversation.messages,
        approvalMode: conversation.approval_mode ?? state.approvalMode,
        pendingInvocations: response.pending_invocations.length > 0 ? response.pending_invocations : state.pendingInvocations,
        loading: false,
      }));
      await useAiStore.getState().loadConversations();
      await useAiStore.getState().loadPendingInvocations();
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  async selectConversation(conversationId) {
    try {
      const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId });
      set({
        activeConversationId: conversation.id,
        approvalMode: conversation.approval_mode ?? "safe",
        messages: conversation.messages,
        error: null,
      });
    } catch (error) {
      set({ error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  async setApprovalMode(mode) {
    const conversationId = useAiStore.getState().activeConversationId;
    if (!conversationId) {
      set({ approvalMode: mode });
      return;
    }
    try {
      const conversation = await invoke<AiConversation>("ai_set_conversation_approval_mode", {
        request: {
          conversation_id: conversationId,
          approval_mode: mode,
        },
      });
      set((state) => ({
        approvalMode: conversation.approval_mode,
        conversations: state.conversations.map((item) =>
          item.id === conversation.id ? { ...item, approval_mode: conversation.approval_mode } : item,
        ),
      }));
    } catch (error) {
      set({ error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  newConversation() {
    set({ activeConversationId: null, approvalMode: "safe", messages: [], error: null });
  },
  async deleteConversation(conversationId) {
    set({ loading: true, error: null });
    try {
      await invoke("ai_conversation_delete", { conversationId });
      const conversations = await invoke<AiConversationSummary[]>("ai_conversation_list", {});
      const currentConversationId = useAiStore.getState().activeConversationId;
      const currentStillExists = conversations.some((conversation) => conversation.id === currentConversationId);
      const nextConversationId =
        currentConversationId === conversationId || !currentStillExists
          ? conversations[0]?.id ?? null
          : currentConversationId;
      set((state) => ({
        conversations,
        activeConversationId: nextConversationId,
        approvalMode: nextConversationId ? state.approvalMode : "safe",
        messages: nextConversationId ? state.messages : [],
        pendingInvocations: state.pendingInvocations.filter((invocation) => invocation.conversation_id !== conversationId),
        loading: false,
      }));
      if (nextConversationId) {
        await useAiStore.getState().selectConversation(nextConversationId);
      }
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  async confirmTool(invocationId, approved) {
    set({ loading: true, error: null });
    try {
      await invoke("ai_tool_confirm", {
        request: {
          invocation_id: invocationId,
          approved,
          audit_context_json: null,
        },
      });
      const pendingInvocations = await invoke<AiToolPendingInvocation[]>("ai_tool_pending");
      const activeConversationId = useAiStore.getState().activeConversationId;
      if (activeConversationId) {
        const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId: activeConversationId });
        set({ pendingInvocations, messages: conversation.messages, loading: false });
      } else {
        set({ pendingInvocations, loading: false });
      }
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
}));
