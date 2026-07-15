// Author: Liz
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

export interface AiConversationPreviewState {
  loading: boolean;
  error: string | null;
  messages: AiConversationMessage[] | null;
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
  requires_secret_input?: boolean;
  secret_input_label?: string | null;
  status: AiToolInvocationStatus;
  created_at_ms?: number;
  conversation_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  reason?: string | null;
  requested_by?: string | null;
}

interface AiChatStreamStartResult {
  chat_id: string;
  conversation_id: string;
}

interface AiChatStreamCancelResult {
  cancelled: boolean;
}

interface AiChatStreamChunkEvent {
  chat_id: string;
  conversation_id: string;
  delta: string;
}

interface AiChatStreamDoneEvent {
  chat_id: string;
  conversation_id: string;
  message: string;
  pending_invocations: AiToolPendingInvocation[];
  executed_invocations: AiToolAuditRecord[];
  context_used: boolean;
  generated_at_ms: number;
}

interface AiChatStreamErrorEvent {
  chat_id: string;
  message: string;
}

interface AiChatStreamCancelledEvent {
  chat_id: string;
  conversation_id: string;
}

type PendingAiChatStreamEvent =
  | { kind: "chunk"; payload: AiChatStreamChunkEvent }
  | { kind: "done"; payload: AiChatStreamDoneEvent }
  | { kind: "error"; payload: AiChatStreamErrorEvent }
  | { kind: "cancelled"; payload: AiChatStreamCancelledEvent };

export interface AiToolAuditRecord {
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
  affected_domains?: string[];
  created_at_ms: number;
  completed_at_ms: number;
}

type AffectedDomainsHandler = (domains: string[]) => Promise<void> | void;

export interface AiToolSecretInputs {
  api_key?: string;
  password?: string;
}

interface AiState {
  conversations: AiConversationSummary[];
  activeConversationId: string | null;
  approvalMode: AiApprovalMode;
  messages: AiConversationMessage[];
  conversationPreviews: Record<string, AiConversationPreviewState>;
  pendingInvocations: AiToolPendingInvocation[];
  contextSnapshot: AiTerminalContextSnapshot | null;
  loading: boolean;
  error: string | null;
  loadConversations: () => Promise<void>;
  loadPendingInvocations: () => Promise<void>;
  captureContext: (context: AiTerminalContextSnapshot) => Promise<void>;
  sendChat: (message: string, context: AiTerminalContextSnapshot | null) => Promise<void>;
  cancelChat: () => void;
  setApprovalMode: (mode: AiApprovalMode) => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  loadConversationPreview: (conversationId: string) => Promise<void>;
  newConversation: () => void;
  deleteConversation: (conversationId: string) => Promise<void>;
  confirmTool: (invocationId: string, approved: boolean, secretInputs?: AiToolSecretInputs) => Promise<void>;
}

let contextCaptureRequestId = 0;
let aiChatRequestId = 0;
let activeChatRequestId: number | null = null;
let activeChatId: string | null = null;
let activeAssistantMessageId: string | null = null;
let chatStarting = false;
let pendingAiChatEvents: PendingAiChatStreamEvent[] = [];
let aiChatEventListenersPromise: Promise<UnlistenFn[]> | null = null;
let affectedDomainsHandler: AffectedDomainsHandler | null = null;

export function setAiAffectedDomainsHandler(handler: AffectedDomainsHandler | null) {
  affectedDomainsHandler = handler;
}

export const useAiStore = create<AiState>((set, get) => ({
  conversations: [],
  activeConversationId: null,
  approvalMode: "safe",
  messages: [],
  conversationPreviews: {},
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
    await ensureAiChatEventListeners();
    const requestId = aiChatRequestId + 1;
    aiChatRequestId = requestId;
    activeChatRequestId = requestId;
    activeChatId = null;
    chatStarting = true;
    pendingAiChatEvents = [];
    const pendingConversationId = get().activeConversationId ?? `pending-conversation-${requestId}`;
    const optimisticUserMessage: AiConversationMessage = {
      id: `pending-user-${requestId}`,
      conversation_id: pendingConversationId,
      role: "user",
      content: redactSensitiveForDisplay(content),
      status: "complete",
      created_at_ms: Date.now(),
    };
    const streamingAssistantMessage: AiConversationMessage = {
      id: `pending-assistant-${requestId}`,
      conversation_id: pendingConversationId,
      role: "assistant",
      content: "",
      status: "streaming",
      created_at_ms: Date.now(),
    };
    activeAssistantMessageId = streamingAssistantMessage.id;
    set((state) => ({
      loading: true,
      error: null,
      messages: [...state.messages, optimisticUserMessage, streamingAssistantMessage],
    }));
    try {
      const response = await invoke<AiChatStreamStartResult>("ai_chat_stream", {
        request: {
          conversation_id: useAiStore.getState().activeConversationId,
          message: content,
          approval_mode: useAiStore.getState().approvalMode,
          history: [],
          terminal_context: context,
        },
      });
      if (activeChatRequestId !== requestId) {
        void invoke<AiChatStreamCancelResult>("ai_chat_cancel", { chatId: response.chat_id });
        return;
      }
      activeChatId = response.chat_id;
      set((state) => ({
        activeConversationId: response.conversation_id,
        messages: state.messages.map((item) =>
          item.id === optimisticUserMessage.id || item.id === streamingAssistantMessage.id
            ? { ...item, conversation_id: response.conversation_id }
            : item,
        ),
      }));
      replayPendingAiChatEvents(response.chat_id);
    } catch (error) {
      if (activeChatRequestId === requestId) {
        chatStarting = false;
        activeChatRequestId = null;
        activeChatId = null;
        activeAssistantMessageId = null;
        pendingAiChatEvents = [];
        set((state) => ({
          loading: false,
          error: unknownErrorMessage(error, "AI Agent 操作失败"),
          messages: state.messages.filter((message) => message.id !== streamingAssistantMessage.id),
        }));
      }
    } finally {
      if (activeChatRequestId === requestId) {
        chatStarting = false;
      }
    }
  },
  cancelChat() {
    const chatId = activeChatId;
    aiChatRequestId += 1;
    activeChatRequestId = null;
    activeChatId = null;
    activeAssistantMessageId = null;
    chatStarting = false;
    pendingAiChatEvents = [];
    if (chatId) {
      void invoke<AiChatStreamCancelResult>("ai_chat_cancel", { chatId });
    }
    set((state) => ({
      loading: false,
      messages: state.messages.filter((message) => message.status !== "streaming"),
    }));
  },
  async selectConversation(conversationId) {
    cancelActiveChatWithoutStoreMutation();
    try {
      const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId });
      set((state) => ({
        activeConversationId: conversation.id,
        approvalMode: conversation.approval_mode ?? "safe",
        messages: conversation.messages,
        conversationPreviews: withConversationPreview(state.conversationPreviews, conversation),
        error: null,
      }));
    } catch (error) {
      set({ error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
  async loadConversationPreview(conversationId) {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;
    const existing = get().conversationPreviews[normalizedConversationId];
    if (existing?.loading || existing?.messages) return;
    set((state) => ({
      conversationPreviews: {
        ...state.conversationPreviews,
        [normalizedConversationId]: {
          loading: true,
          error: null,
          messages: existing?.messages ?? null,
        },
      },
    }));
    try {
      const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId: normalizedConversationId });
      set((state) => ({
        conversationPreviews: withConversationPreview(state.conversationPreviews, conversation),
      }));
    } catch (error) {
      set((state) => ({
        conversationPreviews: {
          ...state.conversationPreviews,
          [normalizedConversationId]: {
            loading: false,
            error: unknownErrorMessage(error, "AI 会话预览加载失败"),
            messages: null,
          },
        },
      }));
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
    cancelActiveChatWithoutStoreMutation();
    set({ activeConversationId: null, approvalMode: "safe", messages: [], error: null });
  },
  async deleteConversation(conversationId) {
    cancelActiveChatWithoutStoreMutation();
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
        conversationPreviews: withoutConversationPreview(state.conversationPreviews, conversationId),
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
  async confirmTool(invocationId, approved, secretInputs) {
    cancelActiveChatWithoutStoreMutation();
    set({ loading: true, error: null });
    try {
      const audit = await invoke<AiToolAuditRecord>("ai_tool_confirm", {
        request: {
          invocation_id: invocationId,
          approved,
          audit_context_json: null,
          secret_inputs: secretInputs ?? null,
        },
      });
      await notifyAffectedDomains([audit]);
      const pendingInvocations = await invoke<AiToolPendingInvocation[]>("ai_tool_pending");
      const activeConversationId = useAiStore.getState().activeConversationId;
      if (activeConversationId) {
        const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId: activeConversationId });
        set((state) => ({
          pendingInvocations,
          messages: conversation.messages,
          conversationPreviews: withConversationPreview(state.conversationPreviews, conversation),
          loading: false,
        }));
      } else {
        set({ pendingInvocations, loading: false });
      }
    } catch (error) {
      set({ loading: false, error: unknownErrorMessage(error, "AI Agent 操作失败") });
    }
  },
}));

function redactSensitiveForDisplay(value: string) {
  return redactAssignments(redactUrlPasswords(value));
}

function redactUrlPasswords(value: string) {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/[^/?#\s:@]+:)([^@/?#\s]+)(@)/gi, "$1<redacted-secret>$3");
}

function redactAssignments(value: string) {
  return value.replace(
    /\b(password|passwd|api_key|apikey|token|secret)\s*([=:])\s*([^\s;,"']+)/gi,
    (_match, key: string, separator: string) => `${key}${separator}<redacted-secret>`,
  );
}

async function ensureAiChatEventListeners() {
  if (aiChatEventListenersPromise) return aiChatEventListenersPromise;
  aiChatEventListenersPromise = Promise.all([
    listen<AiChatStreamChunkEvent>("ai-chat:chunk", (event) => {
      enqueueOrApplyAiChatEvent({ kind: "chunk", payload: event.payload });
    }),
    listen<AiChatStreamDoneEvent>("ai-chat:done", (event) => {
      enqueueOrApplyAiChatEvent({ kind: "done", payload: event.payload });
    }),
    listen<AiChatStreamErrorEvent>("ai-chat:error", (event) => {
      enqueueOrApplyAiChatEvent({ kind: "error", payload: event.payload });
    }),
    listen<AiChatStreamCancelledEvent>("ai-chat:cancelled", (event) => {
      enqueueOrApplyAiChatEvent({ kind: "cancelled", payload: event.payload });
    }),
  ]);
  return aiChatEventListenersPromise;
}

function enqueueOrApplyAiChatEvent(event: PendingAiChatStreamEvent) {
  if (activeChatId === event.payload.chat_id) {
    applyAiChatEvent(event);
    return;
  }
  if (chatStarting && activeChatId === null) {
    pendingAiChatEvents.push(event);
  }
}

function replayPendingAiChatEvents(chatId: string) {
  const pendingEvents = pendingAiChatEvents;
  pendingAiChatEvents = pendingEvents.filter((event) => event.payload.chat_id !== chatId);
  pendingEvents
    .filter((event) => event.payload.chat_id === chatId)
    .forEach((event) => {
      applyAiChatEvent(event);
    });
}

function applyAiChatEvent(event: PendingAiChatStreamEvent) {
  if (activeChatId !== event.payload.chat_id) return;
  if (event.kind === "chunk") {
    appendAiChatDelta(event.payload.delta);
    return;
  }
  if (event.kind === "done") {
    void finishAiChatStream(event.payload);
    return;
  }
  if (event.kind === "error") {
    failAiChatStream(event.payload.message);
    return;
  }
  cancelAiChatStreamFromBackend();
}

function appendAiChatDelta(delta: string) {
  const assistantMessageId = activeAssistantMessageId;
  if (!assistantMessageId) return;
  useAiStore.setState((state) => ({
    messages: state.messages.map((message) =>
      message.id === assistantMessageId
        ? { ...message, content: `${message.content}${delta}`, status: "streaming" }
        : message,
    ),
  }));
}

async function finishAiChatStream(payload: AiChatStreamDoneEvent) {
  const chatId = payload.chat_id;
  const conversationId = payload.conversation_id;
  const assistantMessageId = activeAssistantMessageId;
  const requestId = activeChatRequestId;
  activeChatId = null;
  activeAssistantMessageId = null;
  chatStarting = false;
  useAiStore.setState((state) => ({
    activeConversationId: conversationId,
    loading: false,
    pendingInvocations: payload.pending_invocations.length > 0 ? payload.pending_invocations : state.pendingInvocations,
    messages: state.messages.map((message) =>
      assistantMessageId && message.id === assistantMessageId
        ? { ...message, conversation_id: conversationId, content: payload.message, status: "complete" }
        : message,
    ),
  }));
  try {
    await notifyAffectedDomains(payload.executed_invocations);
    const conversation = await invoke<AiConversation>("ai_conversation_get", { conversationId });
    const conversations = await invoke<AiConversationSummary[]>("ai_conversation_list", {});
    const pendingInvocations = await invoke<AiToolPendingInvocation[]>("ai_tool_pending");
    if (requestId !== null && activeChatRequestId === requestId && activeChatId === null) {
      useAiStore.setState((state) => ({
        activeConversationId: conversation.id,
        messages: conversation.messages,
        approvalMode: conversation.approval_mode ?? state.approvalMode,
        conversationPreviews: withConversationPreview(state.conversationPreviews, conversation),
        conversations,
        pendingInvocations,
      }));
      activeChatRequestId = null;
    }
  } catch (refreshError) {
    if (requestId !== null && activeChatRequestId === requestId) {
      useAiStore.setState({ error: unknownErrorMessage(refreshError, "AI Agent 操作失败") });
      activeChatRequestId = null;
    }
  }
  if (activeChatId === chatId) {
    activeChatId = null;
  }
}

async function notifyAffectedDomains(records: AiToolAuditRecord[]) {
  if (!affectedDomainsHandler) return;
  const domains = [
    ...new Set(
      records
        .flatMap((record) => record.affected_domains ?? [])
        .map((domain) => domain.trim())
        .filter(Boolean),
    ),
  ];
  if (domains.length === 0) return;
  await affectedDomainsHandler(domains);
}

function failAiChatStream(message: string) {
  activeChatRequestId = null;
  activeChatId = null;
  activeAssistantMessageId = null;
  chatStarting = false;
  pendingAiChatEvents = [];
  useAiStore.setState((state) => ({
    loading: false,
    error: message,
    messages: state.messages.filter((item) => item.status !== "streaming"),
  }));
}

function cancelAiChatStreamFromBackend() {
  activeChatRequestId = null;
  activeChatId = null;
  activeAssistantMessageId = null;
  chatStarting = false;
  pendingAiChatEvents = [];
  useAiStore.setState((state) => ({
    loading: false,
    messages: state.messages.filter((item) => item.status !== "streaming"),
  }));
}

function cancelActiveChatWithoutStoreMutation() {
  const chatId = activeChatId;
  activeChatRequestId = null;
  activeChatId = null;
  activeAssistantMessageId = null;
  chatStarting = false;
  pendingAiChatEvents = [];
  if (chatId) {
    void invoke<AiChatStreamCancelResult>("ai_chat_cancel", { chatId });
  }
}

function withConversationPreview(
  previews: Record<string, AiConversationPreviewState>,
  conversation: AiConversation,
): Record<string, AiConversationPreviewState> {
  return {
    ...previews,
    [conversation.id]: {
      loading: false,
      error: null,
      messages: conversation.messages,
    },
  };
}

function withoutConversationPreview(
  previews: Record<string, AiConversationPreviewState>,
  conversationId: string,
): Record<string, AiConversationPreviewState> {
  const next = { ...previews };
  delete next[conversationId];
  return next;
}
