// Author: Liz
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { AgentPendingInvocation } from "./agentCodexApi";

import { AgentCodexPanel } from "./AgentCodexPanel";

function render(pendingInvocations: AgentPendingInvocation[] = []) {
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
        onConfirmTool={vi.fn()}
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
