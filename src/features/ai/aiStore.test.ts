// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { useAiStore, type AiTerminalContextSnapshot } from "./aiStore";

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

  it("shows the user message immediately and streams the assistant response into the panel", async () => {
    vi.useFakeTimers();
    const chat = deferred<{
      conversation_id: string;
      provider_id: string;
      provider_name: string;
      model: string;
      message: string;
      pending_invocations: [];
      executed_invocations: [];
      response_redacted: boolean;
      context_used: boolean;
      tool_count: number;
      generated_at_ms: number;
    }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_chat") return chat.promise;
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

    expect(useAiStore.getState().loading).toBe(true);
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "测试", status: "complete" }),
      expect.objectContaining({ role: "assistant", content: "", status: "streaming" }),
    ]);

    chat.resolve({
      conversation_id: "conversation-1",
      provider_id: "provider-1",
      provider_name: "Provider",
      model: "model",
      message: "收到",
      pending_invocations: [],
      executed_invocations: [],
      response_redacted: false,
      context_used: true,
      tool_count: 1,
      generated_at_ms: 2,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ id: "persisted-user", role: "user", content: "测试", status: "complete" }),
      expect.objectContaining({ id: "persisted-assistant", role: "assistant", content: "", status: "streaming" }),
    ]);

    await vi.advanceTimersByTimeAsync(20);
    expect(useAiStore.getState().messages[1]).toEqual(expect.objectContaining({ content: "收", status: "streaming" }));

    await vi.advanceTimersByTimeAsync(20);
    expect(useAiStore.getState().messages[1]).toEqual(expect.objectContaining({ content: "收到", status: "complete" }));
    expect(useAiStore.getState().loading).toBe(false);
    expect(useAiStore.getState().conversationPreviews["conversation-1"]?.messages?.[1]).toEqual(
      expect.objectContaining({ content: "收到", status: "complete" }),
    );

    await request;
    vi.useRealTimers();
  });

  it("cancels the current chat request and ignores its late response", async () => {
    const chat = deferred<{
      conversation_id: string;
      provider_id: string;
      provider_name: string;
      model: string;
      message: string;
      pending_invocations: [];
      executed_invocations: [];
      response_redacted: boolean;
      context_used: boolean;
      tool_count: number;
      generated_at_ms: number;
    }>();
    invokeMock.mockImplementation((command: string) => {
      if (command === "ai_chat") return chat.promise;
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
    expect(useAiStore.getState().loading).toBe(true);

    useAiStore.getState().cancelChat();
    expect(useAiStore.getState().loading).toBe(false);
    expect(useAiStore.getState().messages).toEqual([
      expect.objectContaining({ role: "user", content: "测试" }),
    ]);

    chat.resolve({
      conversation_id: "conversation-1",
      provider_id: "provider-1",
      provider_name: "Provider",
      model: "model",
      message: "迟到响应",
      pending_invocations: [],
      executed_invocations: [],
      response_redacted: false,
      context_used: true,
      tool_count: 1,
      generated_at_ms: 2,
    });
    await request;

    expect(useAiStore.getState().activeConversationId).toBe(null);
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
