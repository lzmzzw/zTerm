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
