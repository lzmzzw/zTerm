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

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
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

    expect(view.container.textContent).toContain("排查终端");
    expect(view.container.textContent).toContain("当前绑定窗格");
    expect(view.container.textContent).toContain("主终端");
    expect(view.container.querySelector(".zt-ai-bound-target")?.textContent).not.toContain("pane=pane-left");
    expect(view.container.querySelector(".zt-ai-bound-target")?.textContent).not.toContain("runtime=runtime-1");
    expect(view.container.textContent).toContain("建议命令：`pwd`");
    change(input(view.container, "AI 请求"), "列出文件");
    await click(button(view.container, "发送"));

    expect(onSendChat).toHaveBeenCalledWith("列出文件");
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
            arguments_summary: "runtime_session_id=runtime-1, data=pwd",
            target_summary: "pane_id=pane-left, runtime_session_id=runtime-1",
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

    expect(view.container.textContent).toContain("terminal.write");
    expect(view.container.textContent).toContain("pane_id=pane-left");
    await click(button(view.container, "批准"));
    await click(button(view.container, "拒绝"));

    expect(onConfirmTool).toHaveBeenNthCalledWith(1, "tool-call-1", true);
    expect(onConfirmTool).toHaveBeenNthCalledWith(2, "tool-call-1", false);
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
    await chooseSelect(view.container, "审批模式", "request_approval");

    expect(onApprovalModeChange).toHaveBeenCalledWith("request_approval");
    view.unmount();
  });

  it("confirms deleting an AI conversation from the history list", async () => {
    const onDeleteConversation = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <AiPanel
        activeRuntimeSessionId="runtime-1"
        providersAvailable
        recentOutput=""
        loading={false}
        error={null}
        conversations={[{ id: "conversation-1", title: "排查终端", updated_at_ms: 1 }]}
        activeConversationId="conversation-1"
        onDeleteConversation={onDeleteConversation}
      />,
    );

    await click(button(view.container, "删除 AI 会话 排查终端"));
    expect(onDeleteConversation).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("确认删除 AI 会话“排查终端”？");

    await click(button(view.container, "确认删除"));
    expect(onDeleteConversation).toHaveBeenCalledWith("conversation-1");
    view.unmount();
  });
});
