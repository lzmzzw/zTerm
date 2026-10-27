// Author: Liz
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { AgentPendingInvocation } from "./agentCodexApi";

import { AgentCodexPanel } from "./AgentCodexPanel";

function render(pendingInvocations: AgentPendingInvocation[] = [], onConfirmTool = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(
      <AgentCodexPanel
        session={null}
        activeTargetLabel="生产 SSH"
        approvalMode="safe"
        error={null}
        loading={false}
        pendingInvocations={pendingInvocations}
        onApprovalModeChange={vi.fn()}
        onClose={vi.fn()}
        onConfirmTool={onConfirmTool}
        onRestart={vi.fn()}
      />,
    );
  });

  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it("shows one stable associated connection label before the Agent session is available", () => {
  const view = render();
  const labels = Array.from(view.container.querySelectorAll(".zt-agent-codex-target"));

  expect(labels.map((label) => label.textContent)).toEqual(["关联连接：生产 SSH"]);
  expect(view.container.textContent).not.toContain("未连接");
  expect(view.container.textContent).not.toContain("当前终端：");
  view.unmount();
});

it("places pending approvals after the terminal in a separate layout region", () => {
  const view = render([{id: "pending-test", tool_id: "terminal.write", tool_title: "操作终端", risk_level: "high", arguments_summary: "test command", requires_confirmation: true, status: "pending"}]);
  const terminal = view.container.querySelector(".zt-agent-codex-terminal")!;
  const approvals = view.container.querySelector(".zt-agent-codex-approvals")!;
  expect(terminal.nextElementSibling).toBe(approvals);
  expect(approvals.querySelectorAll("button")).toHaveLength(2);
  view.unmount();
});

it("keeps the decision footer outside long details and lets the user page through pending operations", () => {
  const first: AgentPendingInvocation = { id: "first", tool_id: "ssh.execute", tool_title: "执行命令", risk_level: "high", arguments_summary: "long command\n".repeat(100), requires_confirmation: true, status: "pending" };
  const view = render([first, { ...first, id: "second", tool_id: "sftp.delete" }]);
  const details = view.container.querySelector(".zt-ai-tool-details")!;
  const footer = view.container.querySelector(".zt-ai-tool-card footer")!;
  expect(details.contains(footer)).toBe(false);
  expect(details.nextElementSibling).toBe(footer);
  expect(footer.querySelectorAll("button")).toHaveLength(2);
  expect(view.container.textContent).toContain("1 / 2");
  act(() => view.container.querySelector<HTMLButtonElement>('[aria-label="下一项待审批操作"]')!.click());
  expect(view.container.querySelector(".zt-ai-tool-card header")!.textContent).toContain("sftp.delete");
  expect(view.container.textContent).toContain("2 / 2");
  view.unmount();
});

it.each([true, false])("immediately disables both decisions while approval=%s is in flight", async (approved) => {
  let finish!: () => void;
  const onConfirmTool = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const view = render([{ id: "pending-test", tool_id: "ssh.execute", tool_title: "执行命令", risk_level: "high", arguments_summary: "command", requires_confirmation: true, status: "pending" }], onConfirmTool);
  const buttons = view.container.querySelectorAll<HTMLButtonElement>(".zt-ai-tool-actions button");
  act(() => {
    buttons[approved ? 0 : 1].click();
    buttons[approved ? 0 : 1].click();
  });
  expect(onConfirmTool).toHaveBeenCalledTimes(1);
  expect(onConfirmTool).toHaveBeenCalledWith("pending-test", approved, undefined);
  expect(buttons[0].disabled).toBe(true);
  expect(buttons[1].disabled).toBe(true);
  expect(view.container.textContent).toContain(approved ? "执行中..." : "拒绝中...");
  await act(async () => finish());
  expect(buttons[0].disabled).toBe(false);
  expect(buttons[1].disabled).toBe(false);
  view.unmount();
});

it("keeps local secret input beside the fixed actions and clears it on submit", async () => {
  const onConfirmTool = vi.fn();
  const view = render([{ id: "secret", tool_id: "ssh.execute", tool_title: "执行命令", risk_level: "high", arguments_summary: "command", requires_confirmation: true, requires_secret_input: true, status: "pending" }], onConfirmTool);
  const input = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const approve = view.container.querySelector<HTMLButtonElement>(".zt-ai-tool-actions button")!;
  expect(approve.disabled).toBe(true);
  expect(input.closest("footer")).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "test-only-input");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(approve.disabled).toBe(false);
  await act(async () => approve.click());
  expect(onConfirmTool).toHaveBeenCalledWith("secret", true, { password: "test-only-input" });
  expect(input.value).toBe("");
  view.unmount();
});
