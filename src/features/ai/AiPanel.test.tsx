// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { AiPanel } from "./AiPanel";

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender(nextUi: ReactElement) {
      act(() => root.render(nextUi));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function input(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Input not found: ${label}`);
  return match as HTMLTextAreaElement;
}

function select(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"][role="combobox"]`);
  if (!match) throw new Error(`Select not found: ${label}`);
  return match as HTMLButtonElement;
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function change(element: HTMLTextAreaElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function changeTextInput(element: HTMLInputElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function doubleClick(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}

async function keyDown(element: HTMLElement, init: KeyboardEventInit) {
  let allowed = true;
  await act(async () => {
    allowed = element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  return allowed;
}

async function chooseSelect(container: HTMLElement, label: string, value: string) {
  await click(select(container, label));
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.getAttribute("data-value") === value,
  );
  if (!option) throw new Error(`Option not found: ${label}=${value}`);
  await click(option as HTMLElement);
}

describe("AiPanel", () => {
  it("shows no provider state, blocks chat, and does not render the legacy agent entry", () => {
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable={false}
        recentOutput=""
        loading={false}
        error={null}
      />,
    );

    expect(view.container.textContent).toContain("请先配置 AI Provider");
    expect(view.container.textContent).not.toContain("旧 Agent 兼容入口");
    expect(view.container.textContent).not.toContain("启动旧 Agent");
    expect(button(view.container, "发送").disabled).toBe(true);
    view.unmount();
  });

  it("renders conversation messages context and sends chat", async () => {
    const onSendChat = vi.fn();
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput="last output"
        loading={false}
        error={null}
        conversations={[{ id: "conversation-1", title: "排查终端", updated_at_ms: 1 }]}
        activeConversationId="conversation-1"
        messages={[
          { id: "message-1", conversation_id: "conversation-1", role: "user", content: "显示当前目录", status: "complete" },
          {
            id: "message-2",
            conversation_id: "conversation-1",
            role: "assistant",
            content: "建议命令：`pwd`",
            status: "complete",
          },
        ]}
        contextSnapshot={{
          runtime_session_id: "runtime-1",
          pane_id: "pane-left",
          title: "主终端",
          target_summary: "窗格 主终端 · pane=pane-left · runtime=runtime-1",
          recent_output_tail: "last output",
        }}
        pendingInvocations={[]}
        onSendChat={onSendChat}
        onSelectConversation={vi.fn()}
        onNewConversation={vi.fn()}
        onConfirmTool={vi.fn()}
      />,
    );

    expect(view.container.textContent).not.toContain("排查终端");
    expect(view.container.textContent).not.toContain("当前绑定窗格");
    expect(view.container.textContent).toContain("主终端");
    expect(view.container.querySelector(".zt-ai-bound-target")?.textContent).not.toContain("pane=pane-left");
    expect(view.container.querySelector(".zt-ai-bound-target")?.textContent).not.toContain("runtime=runtime-1");
    expect(view.container.textContent).toContain("建议命令：`pwd`");
    expect(view.container.textContent).not.toContain("暂无待确认工具调用");
    expect(view.container.textContent).not.toContain("向 AI 提问");
    expect(input(view.container, "AI 请求").getAttribute("placeholder")).toBe(null);
    const userMessage = view.container.querySelector(".zt-ai-message.role-user");
    const assistantMessage = view.container.querySelector(".zt-ai-message.role-assistant");
    expect(userMessage?.classList.contains("role-user")).toBe(true);
    expect(userMessage?.textContent?.trim()).toBe("显示当前目录");
    expect(userMessage?.getAttribute("aria-label")).toBe("用户");
    expect(assistantMessage?.classList.contains("role-assistant")).toBe(true);
    expect(assistantMessage?.textContent?.trim()).toBe("建议命令：`pwd`");
    expect(assistantMessage?.getAttribute("aria-label")).toBe("AI");
    change(input(view.container, "AI 请求"), "列出文件");
    await click(button(view.container, "发送"));

    expect(onSendChat).toHaveBeenCalledWith("列出文件");
    view.unmount();
  });

  it("keeps the current conversation scrolled to the latest message as messages update", () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("zt-ai-messages") ? 480 : 0;
      },
    });

    const baseProps = {
      activeRuntimeSessionId: "runtime-1",
      providersAvailable: true,
      recentOutput: "",
      loading: false,
      error: null,
    };
    const view = render(
      <AiPanel
        {...baseProps}
        messages={[
          { id: "message-1", conversation_id: "conversation-1", role: "user", content: "问题", status: "complete" },
          { id: "message-2", conversation_id: "conversation-1", role: "assistant", content: "回复", status: "streaming" },
        ]}
      />,
    );

    try {
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 480, behavior: "auto" });
      expect((scrollTo.mock.contexts.at(-1) as HTMLElement | undefined)?.classList.contains("zt-ai-messages")).toBe(true);

      scrollTo.mockClear();
      view.rerender(
        <AiPanel
          {...baseProps}
          messages={[
            { id: "message-1", conversation_id: "conversation-1", role: "user", content: "问题", status: "complete" },
            { id: "message-2", conversation_id: "conversation-1", role: "assistant", content: "回复增量", status: "streaming" },
          ]}
        />,
      );

      expect(scrollTo).toHaveBeenLastCalledWith({ top: 480, behavior: "auto" });
      expect((scrollTo.mock.contexts.at(-1) as HTMLElement | undefined)?.classList.contains("zt-ai-messages")).toBe(true);
    } finally {
      view.unmount();
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: originalScrollTo });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
      }
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    }
  });

  it("clears the composer immediately after sending without waiting for the response", async () => {
    const send = deferred<void>();
    const onSendChat = vi.fn(() => send.promise);
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        onSendChat={onSendChat}
      />,
    );

    const prompt = input(view.container, "AI 请求");
    change(prompt, "测试");
    await click(button(view.container, "发送"));

    expect(onSendChat).toHaveBeenCalledWith("测试");
    expect(prompt.value).toBe("");
    send.resolve();
    await act(async () => {
      await send.promise;
    });
    view.unmount();
  });

  it("switches the composer action to cancel while a chat request is running", async () => {
    const onCancelChat = vi.fn();
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading
        error={null}
        onSendChat={vi.fn()}
        onCancelChat={onCancelChat}
      />,
    );

    const cancelButton = button(view.container, "取消");
    expect(cancelButton.classList.contains("is-cancel")).toBe(true);
    expect(cancelButton.textContent?.trim()).toBe("");
    await click(cancelButton);

    expect(onCancelChat).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("sends chat on Enter and keeps Ctrl+Enter or Alt+Enter for new lines", async () => {
    const onSendChat = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        onSendChat={onSendChat}
      />,
    );

    const prompt = input(view.container, "AI 请求");
    change(prompt, "列出当前目录");
    const enterAllowed = await keyDown(prompt, { key: "Enter" });
    expect(enterAllowed).toBe(false);
    expect(onSendChat).toHaveBeenCalledWith("列出当前目录");
    expect(prompt.value).toBe("");

    change(prompt, "第一行");
    const ctrlEnterAllowed = await keyDown(prompt, { key: "Enter", ctrlKey: true });
    const altEnterAllowed = await keyDown(prompt, { key: "Enter", altKey: true });
    expect(ctrlEnterAllowed).toBe(true);
    expect(altEnterAllowed).toBe(true);
    expect(onSendChat).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("shows an unbound target instead of a placeholder pane title without an active runtime", () => {
    const view = render(
      <AiPanel
        activeRuntimeSessionId={null}
        activePaneId="pane-1"
        activePaneTitle="新建终端"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        contextSnapshot={{
          runtime_session_id: null,
          pane_id: "pane-1",
          title: "新建终端",
          recent_output_tail: "",
        }}
      />,
    );

    const boundTarget = view.container.querySelector(".zt-ai-bound-target");
    expect(boundTarget?.classList.contains("is-unbound")).toBe(true);
    expect(boundTarget?.textContent).toContain("未绑定终端");
    expect(boundTarget?.textContent).not.toContain("新建终端");
    expect(view.container.textContent).not.toContain("当前未绑定终端，AI 仍可回答问题但不能写入终端");
    expect(boundTarget?.querySelector("strong")?.getAttribute("title")).toBe("未绑定终端");
    view.unmount();
  });

  it("keeps tool and system conversation messages neutral without visible role labels", () => {
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        messages={[
          {
            id: "message-tool",
            conversation_id: "conversation-1",
            role: "tool",
            content:
              "命令已写入活动终端。终端返回：touch a\u001b[?2004l\r\r\n\u001b[?2004h\u001b[32mubuntu@ubuntu\u001b[m:\u001b[34m~\u001b[m$",
            status: "complete",
          },
          {
            id: "message-system",
            conversation_id: "conversation-1",
            role: "system",
            content: "系统上下文已更新。",
            status: "complete",
          },
        ]}
      />,
    );

    const toolMessage = view.container.querySelector(".zt-ai-message.role-tool");
    const systemMessage = view.container.querySelector(".zt-ai-message.role-system");
    expect(toolMessage?.textContent).toContain("执行结果");
    expect(toolMessage?.textContent).toContain("状态");
    expect(toolMessage?.textContent).toContain("命令已写入活动终端。");
    expect(toolMessage?.textContent).toContain("终端输出");
    expect(toolMessage?.querySelector(".zt-ai-tool-output")?.textContent?.trim()).toBe("touch a");
    expect(toolMessage?.textContent).not.toContain("?2004");
    expect(toolMessage?.textContent).not.toContain("[32m");
    expect(toolMessage?.textContent).not.toContain("ubuntu@ubuntu");
    expect(toolMessage?.getAttribute("aria-label")).toBe("工具");
    expect(systemMessage?.textContent?.trim()).toBe("系统上下文已更新。");
    expect(systemMessage?.getAttribute("aria-label")).toBe("系统");
    view.unmount();
  });

  it("renders pending tool invocation and confirms or rejects it", async () => {
    const onConfirmTool = vi.fn();
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        conversations={[]}
        activeConversationId={null}
        messages={[]}
        pendingInvocations={[
          {
            id: "tool-call-1",
            tool_id: "terminal.write",
            tool_title: "写入终端",
            risk_level: "high",
            arguments_summary:
              "data=touch a && ls -l a, pane_id=pane-left, runtime_session_id=runtime-1, saved_session_id=session-1, target_title=172.16.41.180",
            target_summary:
              "target_title=172.16.41.180, pane_id=pane-left, runtime_session_id=runtime-1, saved_session_id=session-1",
            requires_confirmation: true,
            status: "pending",
          },
        ]}
        onSendChat={vi.fn()}
        onSelectConversation={vi.fn()}
        onNewConversation={vi.fn()}
        onConfirmTool={onConfirmTool}
      />,
    );

    const toolCard = view.container.querySelector(".zt-ai-tool-card");
    expect(toolCard?.textContent).toContain("连接：172.16.41.180");
    expect(toolCard?.textContent).toContain("操作：写入终端");
    expect(toolCard?.textContent).toContain("命令：touch a && ls -l a");
    expect(toolCard?.textContent).not.toContain("runtime_session_id");
    expect(toolCard?.textContent).not.toContain("saved_session_id");
    expect(toolCard?.textContent).not.toContain("pane_id");
    expect(toolCard?.getAttribute("title")).toContain("runtime_session_id=runtime-1");
    await click(button(view.container, "批准"));
    await click(button(view.container, "拒绝"));

    expect(onConfirmTool).toHaveBeenNthCalledWith(1, "tool-call-1", true);
    expect(onConfirmTool).toHaveBeenNthCalledWith(2, "tool-call-1", false);
    view.unmount();
  });

  it("requires a local secret before approving secret-backed tool invocations", async () => {
    const onConfirmTool = vi.fn();
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        messages={[]}
        pendingInvocations={[
          {
            id: "tool-call-secret",
            tool_id: "llm_provider.create",
            tool_title: "创建 LLM Provider",
            risk_level: "medium",
            arguments_summary: "draft={7 项}",
            requires_confirmation: true,
            requires_secret_input: true,
            secret_input_label: "API Key",
            status: "pending",
          },
        ]}
        onConfirmTool={onConfirmTool}
      />,
    );

    const approve = button(view.container, "批准");
    expect(approve.disabled).toBe(true);

    changeTextInput(input(view.container, "API Key") as unknown as HTMLInputElement, "sk-local-only");
    expect(approve.disabled).toBe(false);
    await click(approve);
    expect(input(view.container, "API Key").value).toBe("");
    await click(button(view.container, "拒绝"));

    expect(onConfirmTool).toHaveBeenNthCalledWith(1, "tool-call-secret", true, { api_key: "sk-local-only" });
    expect(onConfirmTool).toHaveBeenNthCalledWith(2, "tool-call-secret", false);
    view.unmount();
  });

  it("changes approval mode per conversation", async () => {
    const onApprovalModeChange = vi.fn();
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        approvalMode="safe"
        onApprovalModeChange={onApprovalModeChange}
      />,
    );

    const composer = view.container.querySelector(".zt-ai-composer");
    expect(composer).not.toBe(null);
    expect(composer?.querySelector('[aria-label="审批模式"]')).not.toBe(null);
    await click(select(view.container, "审批模式"));
    const approvalOptions = Array.from(document.querySelectorAll('[role="option"]')).filter((item) =>
      ["request_approval", "safe", "full_access"].includes(item.getAttribute("data-value") ?? ""),
    );
    expect(approvalOptions).toHaveLength(3);
    expect(approvalOptions.map((item) => item.querySelector(".zt-select-option-description"))).toEqual([null, null, null]);
    await click(select(view.container, "审批模式"));

    await chooseSelect(view.container, "审批模式", "request_approval");

    expect(onApprovalModeChange).toHaveBeenCalledWith("request_approval");
    view.unmount();
  });

  it("deletes an AI conversation directly from the history list", async () => {
    const onDeleteConversation = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        conversations={[
          { id: "conversation-1", title: "当前会话", updated_at_ms: 2 },
          { id: "conversation-2", title: "排查终端", updated_at_ms: 1 },
        ]}
        activeConversationId="conversation-1"
        onDeleteConversation={onDeleteConversation}
      />,
    );

    await click(button(view.container, "历史会话"));
    await click(button(view.container, "删除 AI 会话 排查终端"));
    expect(onDeleteConversation).toHaveBeenCalledWith("conversation-2");
    expect(view.container.textContent).not.toContain("确认删除 AI 会话“排查终端”？");
    view.unmount();
  });

  it("uses icon-only actions for new and history conversations", () => {
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        onNewConversation={vi.fn()}
      />,
    );

    const newButton = button(view.container, "新会话");
    const historyButton = button(view.container, "历史会话");
    expect(newButton.textContent?.trim()).toBe("");
    expect(historyButton.textContent?.trim()).toBe("");
    expect(newButton.getAttribute("title")).toBe("新会话");
    expect(historyButton.getAttribute("title")).toBe("历史会话");
    view.unmount();
  });

  it("switches to history view, expands a preview, and restores a conversation on double click", async () => {
    const onLoadConversationPreview = vi.fn();
    const onSelectConversation = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        conversations={[
          { id: "conversation-active", title: "列出当前目录文件", updated_at_ms: 6 },
          { id: "conversation-old", title: "历史排查", updated_at_ms: 5 },
        ]}
        activeConversationId="conversation-active"
        messages={[{ id: "active-message", conversation_id: "conversation-active", role: "assistant", content: "当前内容", status: "complete" }]}
        conversationPreviews={{
          "conversation-old": {
            loading: false,
            error: null,
            messages: [
              { id: "preview-1", conversation_id: "conversation-old", role: "user", content: "第一条不展示", status: "complete" },
              { id: "preview-2", conversation_id: "conversation-old", role: "assistant", content: "第二条", status: "complete" },
              { id: "preview-3", conversation_id: "conversation-old", role: "user", content: "第三条", status: "complete" },
              { id: "preview-4", conversation_id: "conversation-old", role: "assistant", content: "第四条", status: "complete" },
              { id: "preview-5", conversation_id: "conversation-old", role: "user", content: "第五条", status: "complete" },
            ],
          },
        }}
        onLoadConversationPreview={onLoadConversationPreview}
        onSelectConversation={onSelectConversation}
      />,
    );

    await click(button(view.container, "历史会话"));
    const historyView = view.container.querySelector(".zt-ai-history-view");
    const historyMain = button(view.container, "展开 AI 会话 历史排查");
    expect(historyView).not.toBeNull();
    expect(view.container.textContent).toContain("历史排查");
    expect(view.container.textContent).not.toContain("当前绑定窗格");
    expect(view.container.textContent).not.toContain("列出当前目录文件");
    expect(view.container.querySelector(".zt-ai-composer")).toBe(null);
    expect(historyMain.querySelector(".zt-ai-history-title")?.textContent).toBe("历史排查");
    expect(historyMain.querySelector(".zt-ai-history-time")?.textContent?.trim()).not.toBe("");

    await click(historyMain);
    expect(onLoadConversationPreview).toHaveBeenCalledWith("conversation-old");
    expect(view.container.textContent).toContain("第二条");
    expect(view.container.textContent).toContain("第五条");
    expect(view.container.textContent).not.toContain("第一条不展示");
    expect(view.container.querySelector(".zt-ai-history-preview-message")).toBe(null);
    expect(view.container.querySelector(".zt-ai-history-preview .zt-ai-message.role-user")?.textContent?.trim()).toBe("第三条");
    expect(view.container.querySelector(".zt-ai-history-preview .zt-ai-message.role-assistant")?.textContent?.trim()).toBe("第二条");

    await click(button(view.container, "折叠 AI 会话 历史排查"));
    expect(view.container.textContent).not.toContain("第二条");

    await doubleClick(button(view.container, "展开 AI 会话 历史排查"));
    expect(onSelectConversation).toHaveBeenCalledWith("conversation-old");
    expect(view.container.textContent).toContain("当前内容");
    view.unmount();
  });

  it("keeps delete separate from history expand and restore actions", async () => {
    const onDeleteConversation = vi.fn().mockResolvedValue(undefined);
    const onLoadConversationPreview = vi.fn();
    const onSelectConversation = vi.fn();
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        conversations={[
          { id: "conversation-active", title: "当前会话", updated_at_ms: 3 },
          { id: "conversation-old", title: "历史排查", updated_at_ms: 2 },
        ]}
        activeConversationId="conversation-active"
        onDeleteConversation={onDeleteConversation}
        onLoadConversationPreview={onLoadConversationPreview}
        onSelectConversation={onSelectConversation}
      />,
    );

    await click(button(view.container, "历史会话"));
    await click(button(view.container, "删除 AI 会话 历史排查"));

    expect(onLoadConversationPreview).not.toHaveBeenCalled();
    expect(onSelectConversation).not.toHaveBeenCalled();
    expect(onDeleteConversation).toHaveBeenCalledWith("conversation-old");
    expect(view.container.textContent).not.toContain("确认删除 AI 会话“历史排查”？");
    view.unmount();
  });

  it("shows pending tool notice but hides composer in history view", async () => {
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        conversations={[
          { id: "conversation-active", title: "当前会话", updated_at_ms: 3 },
          { id: "conversation-old", title: "历史排查", updated_at_ms: 2 },
        ]}
        activeConversationId="conversation-active"
        pendingInvocations={[
          {
            id: "tool-call-1",
            tool_id: "terminal.write",
            tool_title: "写入终端",
            risk_level: "medium",
            arguments_summary: "data=pwd",
            requires_confirmation: true,
            status: "pending",
          },
        ]}
      />,
    );

    await click(button(view.container, "历史会话"));

    expect(view.container.querySelector(".zt-ai-composer")).toBe(null);
    expect(view.container.textContent).toContain("有 1 个待确认工具调用，返回当前会话处理");
    view.unmount();
  });
});
