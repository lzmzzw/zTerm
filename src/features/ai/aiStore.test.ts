// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const eventListeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    eventListeners.set(eventName, handler);
    return () => {
      eventListeners.delete(eventName);
    };
  }),
}));

import { setAiAffectedDomainsHandler, useAiStore, type AiTerminalContextSnapshot } from "./aiStore";

function snapshot(runtimeSessionId: string): AiTerminalContextSnapshot {
  return {
    runtime_session_id: runtimeSessionId,
    saved_session_id: `saved-${runtimeSessionId}`,
    pane_id: `pane-${runtimeSessionId}`,
    title: runtimeSessionId,
    recent_output_tail: runtimeSessionId,
    active_tool: "agent",
    generated_at_ms: Date.now(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function emitAiChatEvent(eventName: string, payload: unknown) {
  eventListeners.get(eventName)?.({ payload });
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("aiStore", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    useAiStore.setState({
      conversations: [],
      activeConversationId: null,
      approvalMode: "safe",
      messages: [],
      conversationPreviews: {},
      pendingInvocations: [],
      contextSnapshot: null,
      loading: false,
      error: null,
    });
    setAiAffectedDomainsHandler(null);
  });

  it("does not let an older context capture overwrite the latest active terminal context", async () => {
    const stale = deferred<AiTerminalContextSnapshot>();
    const current = snapshot("runtime-current");
    invokeMock.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(current);

    const staleRequest = useAiStore.getState().captureContext(snapshot("runtime-old"));
    const currentRequest = useAiStore.getState().captureContext(current);

    await currentRequest;
    expect(useAiStore.getState().contextSnapshot?.runtime_session_id).toBe("runtime-current");

    stale.resolve(snapshot("runtime-old"));
    await staleRequest;

    expect(useAiStore.getState().contextSnapshot?.runtime_session_id).toBe("runtime-current");
  });

  it("shows the user message immediately and applies real backend stream chunks into the panel", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_chat_stream") return Promise.resolve({ chat_id: "chat-1", conversation_id: "conversation-1" });
      if (command === "ai_conversation_get") {
        return Promise.resolve({
          id: "conversation-1",
          title: "测试",
          scope_kind: "follow_focus",
          scope_ref_json: "{}",
          approval_mode: "safe",
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 2,
          messages: [
            { id: "persisted-user", conversation_id: "conversation-1", role: "user", content: "测试", status: "complete" },
            { id: "persisted-assistant", conversation_id: "conversation-1", role: "assistant", content: "收到", status: "complete" },
          ],
        });
      }
      if (command === "ai_conversation_list") {
        return Promise.resolve([{ id: "conversation-1", title: "测试", updated_at_ms: 2 }]);
      }
      if (command === "ai_tool_pending") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const request = useAiStore.getState().sendChat("测试", snapshot("runtime-1"));
    await request;

    expect(useAiStore.getState().loading).toBe(true);
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "测试", status: "complete" }),
      expect.objectContaining({ role: "assistant", content: "", status: "streaming" }),
    ]);
    expect(invokeMock).toHaveBeenCalledWith("ai_chat_stream", {
      request: expect.objectContaining({
        message: "测试",
        terminal_context: expect.objectContaining({ runtime_session_id: "runtime-1" }),
      }),
    });

    emitAiChatEvent("ai-chat:chunk", { chat_id: "chat-1", conversation_id: "conversation-1", delta: "收" });
    expect(useAiStore.getState().messages[1]).toEqual(expect.objectContaining({ content: "收", status: "streaming" }));

    emitAiChatEvent("ai-chat:chunk", { chat_id: "chat-1", conversation_id: "conversation-1", delta: "到" });
    expect(useAiStore.getState().messages[1]).toEqual(expect.objectContaining({ content: "收到", status: "streaming" }));

    emitAiChatEvent("ai-chat:done", {
      chat_id: "chat-1",
      conversation_id: "conversation-1",
      message: "收到",
      pending_invocations: [],
      executed_invocations: [],
      context_used: true,
      generated_at_ms: 2,
    });
    await flushPromises();

    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ id: "persisted-user", role: "user", content: "测试", status: "complete" }),
      expect.objectContaining({ id: "persisted-assistant", role: "assistant", content: "收到", status: "complete" }),
    ]);
    expect(useAiStore.getState().loading).toBe(false);
    expect(useAiStore.getState().conversationPreviews["conversation-1"]?.messages?.[1]).toEqual(
      expect.objectContaining({ content: "收到", status: "complete" }),
    );
  });

  it("redacts secrets in optimistic user messages without changing the backend request", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_chat_stream") return Promise.resolve({ chat_id: "chat-1", conversation_id: "conversation-1" });
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    const password = "ui-password!";
    const message = `帮我创建 ssh://ops:${password}@example.test:2200`;

    await useAiStore.getState().sendChat(message, snapshot("runtime-1"));

    expect(useAiStore.getState().messages[0]).toEqual(
      expect.objectContaining({
        role: "user",
        content: "帮我创建 ssh://ops:<redacted-secret>@example.test:2200",
      }),
    );
    expect(JSON.stringify(useAiStore.getState().messages)).not.toContain(password);
    expect(invokeMock).toHaveBeenCalledWith("ai_chat_stream", {
      request: expect.objectContaining({
        message,
      }),
    });
  });

  it("notifies affected domains after completed stream tool executions", async () => {
    const affectedHandler = vi.fn();
    setAiAffectedDomainsHandler(affectedHandler);
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_chat_stream") return Promise.resolve({ chat_id: "chat-1", conversation_id: "conversation-1" });
      if (command === "ai_conversation_get") {
        return Promise.resolve({
          id: "conversation-1",
          title: "测试",
          scope_kind: "follow_focus",
          scope_ref_json: "{}",
          approval_mode: "safe",
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 2,
          messages: [],
        });
      }
      if (command === "ai_conversation_list") {
        return Promise.resolve([{ id: "conversation-1", title: "测试", updated_at_ms: 2 }]);
      }
      if (command === "ai_tool_pending") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    await useAiStore.getState().sendChat("测试", snapshot("runtime-1"));
    emitAiChatEvent("ai-chat:done", {
      chat_id: "chat-1",
      conversation_id: "conversation-1",
      message: "done",
      pending_invocations: [],
      executed_invocations: [
        {
          id: "audit-1",
          invocation_id: "invocation-1",
          tool_id: "sessions.save",
          tool_title: "保存会话",
          risk_level: "medium",
          arguments_summary: "name=test",
          status: "succeeded",
          result_summary: "done",
          affected_domains: ["sessions", "workspace"],
          created_at_ms: 1,
          completed_at_ms: 2,
        },
      ],
      context_used: true,
      generated_at_ms: 2,
    });
    await flushPromises();

    expect(affectedHandler).toHaveBeenCalledWith(["sessions", "workspace"]);
  });

  it("notifies affected domains after confirming a pending tool", async () => {
    const affectedHandler = vi.fn();
    setAiAffectedDomainsHandler(affectedHandler);
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_tool_confirm") {
        return Promise.resolve({
          id: "audit-1",
          invocation_id: "invocation-1",
          tool_id: "workspace.delete",
          tool_title: "删除工作区",
          risk_level: "critical",
          arguments_summary: "workspace_id=w1",
          status: "succeeded",
          result_summary: "deleted",
          affected_domains: ["workspace"],
          created_at_ms: 1,
          completed_at_ms: 2,
        });
      }
      if (command === "ai_tool_pending") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    await useAiStore.getState().confirmTool("invocation-1", true);

    expect(affectedHandler).toHaveBeenCalledWith(["workspace"]);
    expect(useAiStore.getState().pendingInvocations).toEqual([]);
  });

  it("cancels the current chat stream and ignores late chunks", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_chat_stream") return Promise.resolve({ chat_id: "chat-cancel", conversation_id: "conversation-1" });
      if (command === "ai_chat_cancel") return Promise.resolve({ cancelled: true });
      if (command === "ai_conversation_get") {
        return Promise.resolve({
          id: "conversation-1",
          title: "测试",
          scope_kind: "follow_focus",
          scope_ref_json: "{}",
          approval_mode: "safe",
          status: "active",
          created_at_ms: 1,
          updated_at_ms: 2,
          messages: [
            { id: "persisted-user", conversation_id: "conversation-1", role: "user", content: "测试", status: "complete" },
            { id: "persisted-assistant", conversation_id: "conversation-1", role: "assistant", content: "迟到响应", status: "complete" },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });

    const request = useAiStore.getState().sendChat("测试", snapshot("runtime-1"));
    await request;
    expect(useAiStore.getState().loading).toBe(true);
    emitAiChatEvent("ai-chat:chunk", { chat_id: "chat-cancel", conversation_id: "conversation-1", delta: "部" });
    expect(useAiStore.getState().messages[1]).toEqual(expect.objectContaining({ content: "部" }));

    useAiStore.getState().cancelChat();
    await Promise.resolve();
    expect(useAiStore.getState().loading).toBe(false);
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "测试" }),
    ]);
    expect(invokeMock).toHaveBeenCalledWith("ai_chat_cancel", { chatId: "chat-cancel" });

    emitAiChatEvent("ai-chat:chunk", { chat_id: "chat-cancel", conversation_id: "conversation-1", delta: "迟到" });
    emitAiChatEvent("ai-chat:done", {
      chat_id: "chat-cancel",
      conversation_id: "conversation-1",
      message: "部迟到",
      pending_invocations: [],
      executed_invocations: [],
      context_used: true,
      generated_at_ms: 2,
    });
    await flushPromises();

    expect(useAiStore.getState().activeConversationId).toBe("conversation-1");
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "测试" }),
    ]);
  });

  it("deletes the active conversation and selects the next available history item", async () => {
    invokeMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce([
        { id: "conversation-2", title: "保留会话", updated_at_ms: 3 },
      ])
      .mockResolvedValueOnce({
        id: "conversation-2",
        title: "保留会话",
        scope_kind: "terminal",
        scope_ref_json: "{}",
        approval_mode: "full_access",
        status: "active",
        created_at_ms: 2,
        updated_at_ms: 3,
        messages: [
          {
            id: "message-2",
            conversation_id: "conversation-2",
            role: "assistant",
            content: "保留消息",
            status: "complete",
          },
        ],
      });
    useAiStore.setState({
      conversations: [
        { id: "conversation-1", title: "删除会话", updated_at_ms: 1 },
        { id: "conversation-2", title: "保留会话", updated_at_ms: 3 },
      ],
      activeConversationId: "conversation-1",
      messages: [
        { id: "message-1", conversation_id: "conversation-1", role: "user", content: "删除消息", status: "complete" },
      ],
      conversationPreviews: {
        "conversation-1": {
          loading: false,
          error: null,
          messages: [
            { id: "message-1", conversation_id: "conversation-1", role: "user", content: "删除消息", status: "complete" },
          ],
        },
      },
    });

    await useAiStore.getState().deleteConversation("conversation-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "ai_conversation_delete", { conversationId: "conversation-1" });
    expect(useAiStore.getState().activeConversationId).toBe("conversation-2");
    expect(useAiStore.getState().approvalMode).toBe("full_access");
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ id: "message-2", content: "保留消息" }),
    ]);
    expect(useAiStore.getState().conversationPreviews["conversation-1"]).toBeUndefined();
  });

  it("loads and caches AI conversation previews", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "conversation-1",
      title: "历史会话",
      scope_kind: "terminal",
      scope_ref_json: "{}",
      approval_mode: "safe",
      status: "active",
      created_at_ms: 1,
      updated_at_ms: 2,
      messages: [
        { id: "message-1", conversation_id: "conversation-1", role: "user", content: "历史消息", status: "complete" },
      ],
    });

    await useAiStore.getState().loadConversationPreview("conversation-1");
    await useAiStore.getState().loadConversationPreview("conversation-1");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ai_conversation_get", { conversationId: "conversation-1" });
    expect(useAiStore.getState().conversationPreviews["conversation-1"]).toEqual({
      loading: false,
      error: null,
      messages: [expect.objectContaining({ id: "message-1", content: "历史消息" })],
    });
  });

  it("records AI conversation preview loading failures", async () => {
    invokeMock.mockRejectedValueOnce(new Error("preview failed"));

    await useAiStore.getState().loadConversationPreview("conversation-1");

    expect(useAiStore.getState().conversationPreviews["conversation-1"]).toEqual({
      loading: false,
      error: "preview failed",
      messages: null,
    });
  });
});
