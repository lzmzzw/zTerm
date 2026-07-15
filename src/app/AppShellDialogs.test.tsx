// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  AppTextInputDialog,
  ConnectionPickerDialog,
  SyncChannelDialog,
  type ConnectionChoice,
} from "./AppShellDialogs";
import type { SavedSession, SessionGroup } from "../features/sessions/types";

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: ParentNode, label: string) {
  const match = container.querySelector(`button[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match as HTMLButtonElement;
}

function input(container: ParentNode, label: string) {
  const match = container.querySelector(`input[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Input not found: ${label}`);
  }
  return match as HTMLInputElement;
}

function change(element: HTMLInputElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function click(element: HTMLElement) {
  act(() => {
    element.click();
  });
}

function session(overrides: Partial<SavedSession>): SavedSession {
  return {
    id: "session",
    name: "Session",
    type: "ssh",
    group_id: null,
    host: "127.0.0.1",
    port: 22,
    username: "user",
    auth_mode: "none",
    credential_ref: null,
    description: null,
    tags: [],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
    ...overrides,
  };
}

function group(overrides: Partial<SessionGroup>): SessionGroup {
  return {
    id: overrides.id ?? "group",
    parent_id: overrides.parent_id ?? null,
    name: overrides.name ?? "Group",
    expanded: overrides.expanded ?? true,
    sort_order: overrides.sort_order ?? 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  };
}

describe("AppShellDialogs", () => {
  it("trims text input before submit and rejects blank values", () => {
    const onSubmit = vi.fn();
    const view = render(
      <AppTextInputDialog
        title="新建工作区"
        label="工作区名称"
        initialValue="运维巡检 副本"
        requiredMessage="请输入工作区名称"
        confirmLabel="确认新建工作区"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    change(input(view.container, "工作区名称"), "   ");
    click(button(view.container, "确认新建工作区"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("请输入工作区名称");

    change(input(view.container, "工作区名称"), "  发布窗口  ");
    click(button(view.container, "确认新建工作区"));

    expect(onSubmit).toHaveBeenCalledWith("发布窗口");
    view.unmount();
  });

  it("renders available grouped sessions in session-list ordering without empty groups", () => {
    const view = render(
      <ConnectionPickerDialog
        groups={[
          group({ id: "group-10", name: "Group 10" }),
          group({ id: "group-2", name: "Group 2" }),
          group({ id: "group-child", parent_id: "group-10", name: "Child" }),
          group({ id: "group-empty", name: "Group 30 Empty" }),
        ]}
        sessions={[
          session({ id: "session-198", name: "172.16.40.198", group_id: "group-10", type: "ssh" }),
          session({ id: "session-20", name: "172.16.40.20", group_id: "group-10", type: "rdp" }),
          session({ id: "session-child", name: "Child local", group_id: "group-child", type: "local" }),
          session({ id: "session-root", name: "Root SSH", group_id: null, type: "ssh" }),
        ]}
        opening={false}
        error={null}
        onCancel={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(Array.from(view.container.querySelectorAll(".zt-session-picker-row")).map((node) => node.textContent)).toEqual([
      "Group 10",
      "172.16.40.20",
      "172.16.40.198",
      "Child",
      "Child local",
      "未分组",
      "Root SSH",
    ]);
    expect(view.container.querySelector('[aria-label="折叠分组 Group 2"]')).toBe(null);
    expect(view.container.querySelector('[aria-label="折叠分组 Group 30 Empty"]')).toBe(null);
    expect(view.container.querySelector('[data-session-tree-depth="2"]')?.textContent).toBe("Child local");
    expect(view.container.querySelector('[aria-label="选择连接 Child local"]')?.getAttribute("aria-level")).toBe("3");

    click(button(view.container, "折叠分组 Group 10"));
    expect(view.container.textContent).not.toContain("172.16.40.20");
    expect(view.container.textContent).not.toContain("Child local");
    expect(button(view.container, "展开分组 Group 10")).toBeTruthy();
    click(button(view.container, "展开分组 Group 10"));
    expect(view.container.textContent).toContain("Child local");
    view.unmount();
  });

  it("disables cancel and connection choices while opening", () => {
    const view = render(
      <ConnectionPickerDialog
        groups={[]}
        sessions={[session({ id: "ssh", name: "SSH Prod", sort_order: 0 })]}
        opening={true}
        error="正在打开连接"
        onCancel={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(button(view.container, "关闭选择连接").disabled).toBe(true);
    expect(button(view.container, "取消选择连接").disabled).toBe(true);
    expect(button(view.container, "选择连接 SSH Prod").disabled).toBe(true);
    expect(view.container.textContent).toContain("正在打开连接");
    view.unmount();
  });

  it("emits saved session choices without a synthetic default local option", () => {
    const selected: ConnectionChoice[] = [];
    const sshSession = session({ id: "ssh", name: "SSH Prod", sort_order: 0 });
    const view = render(
      <ConnectionPickerDialog
        groups={[]}
        sessions={[sshSession]}
        opening={false}
        error={null}
        onCancel={vi.fn()}
        onSelect={(choice) => selected.push(choice)}
      />,
    );

    expect(view.container.textContent).not.toContain("默认本地终端");
    click(button(view.container, "选择连接 SSH Prod"));

    expect(selected).toEqual([{ kind: "saved_session", session: sshSession }]);
    view.unmount();
  });

  it("requires two selected SSH connections before creating a sync channel", () => {
    const onSubmit = vi.fn();
    const view = render(
      <SyncChannelDialog
        candidates={[
          { id: "tab-1", runtimeSessionId: "runtime-1", title: "SSH A", host: "10.0.0.1" },
          { id: "tab-2", runtimeSessionId: "runtime-2", title: "SSH B", host: "10.0.0.2" },
        ]}
        initialMemberIds={["tab-1"]}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(button(view.container, "创建同步频道").disabled).toBe(true);
    click(button(view.container, "添加 SSH B"));
    expect(button(view.container, "创建同步频道").disabled).toBe(false);
    click(button(view.container, "创建同步频道"));

    expect(onSubmit).toHaveBeenCalledWith(["tab-1", "tab-2"]);
    view.unmount();
  });
});
