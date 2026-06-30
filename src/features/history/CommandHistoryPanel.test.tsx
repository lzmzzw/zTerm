// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { CommandHistoryPanel } from "./CommandHistoryPanel";
import type { CommandHistoryEntry, SessionCommandGroup } from "./historyStore";

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

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function input(container: HTMLElement, label: string) {
  const match = container.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Input not found: ${label}`);
  return match as HTMLInputElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function inputText(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function change(element: HTMLInputElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const entries: CommandHistoryEntry[] = [
  {
    id: "history-1",
    scope_kind: "saved_session",
    scope_id: "session-1",
    runtime_session_id: "runtime-1",
    command: "pwd",
    cwd: "/home/ops",
    exit_code: null,
    started_at_ms: 1,
    finished_at_ms: null,
  },
  {
    id: "history-2",
    scope_kind: "saved_session",
    scope_id: "session-1",
    runtime_session_id: "runtime-1",
    command: "whoami",
    cwd: null,
    exit_code: null,
    started_at_ms: 2,
    finished_at_ms: null,
  },
];

const groups: SessionCommandGroup[] = [
  {
    id: "group-1",
    saved_session_id: "session-1",
    scope_kind: "saved_session",
    scope_id: "session-1",
    name: "巡检",
    created_at_ms: 1,
    updated_at_ms: 2,
    items: [
      {
        id: "item-1",
        group_id: "group-1",
        command: "uptime",
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
      {
        id: "item-2",
        group_id: "group-1",
        command: "df -h",
        sort_order: 10,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ],
  },
];

function renderPanel(overrides: Partial<Parameters<typeof CommandHistoryPanel>[0]> = {}) {
  return render(
    <CommandHistoryPanel
      activeView="history"
      commandGroups={[]}
      entries={entries}
      error={null}
      groupError={null}
      groupLoading={false}
      loading={false}
      query=""
      historyScopeKind="saved_session"
      historyScopeId="session-1"
      onClear={vi.fn()}
      onCopy={vi.fn()}
      onDeleteCommandGroup={vi.fn()}
      onQueryChange={vi.fn()}
      onSaveCommandGroup={vi.fn()}
      onSearch={vi.fn()}
      onSend={vi.fn()}
      onViewChange={vi.fn()}
      {...overrides}
    />,
  );
}

describe("CommandHistoryPanel", () => {
  it("searches copies and sends command history entries", async () => {
    const onQueryChange = vi.fn();
    const onSearch = vi.fn();
    const onCopy = vi.fn();
    const onSend = vi.fn();
    const view = renderPanel({
      onQueryChange,
      onSearch,
      onCopy,
      onSend,
    });

    change(input(view.container, "搜索历史命令"), "who");
    await click(button(view.container, "搜索"));
    await click(button(view.container, "复制 pwd"));
    await click(button(view.container, "发送 pwd"));

    expect(onQueryChange).toHaveBeenCalledWith("who");
    expect(onSearch).toHaveBeenCalled();
    expect(onCopy).toHaveBeenCalledWith("pwd");
    expect(onSend).toHaveBeenCalledWith("pwd");

    view.unmount();
  });

  it("switches between history deduplicated history and command groups", async () => {
    const onViewChange = vi.fn();
    const onSearch = vi.fn();
    const view = renderPanel({ onSearch, onViewChange });

    await click(button(view.container, "去重"));
    expect(onViewChange).toHaveBeenCalledWith("deduplicated");
    expect(onSearch).toHaveBeenCalledWith({ deduplicate: true });

    await click(button(view.container, "指令组"));
    expect(onViewChange).toHaveBeenCalledWith("groups");

    view.unmount();
  });

  it("saves selected history entries as a session command group", async () => {
    const onSaveCommandGroup = vi.fn();
    const view = renderPanel({ onSaveCommandGroup });

    await click(input(view.container, "选择 pwd"));
    await click(button(view.container, "保存为指令组"));
    await inputText(input(view.container, "指令组名称"), "巡检");
    await click(button(view.container, "保存指令组"));

    expect(onSaveCommandGroup).toHaveBeenCalledWith({
      id: undefined,
      saved_session_id: "session-1",
      scope_kind: "saved_session",
      scope_id: "session-1",
      name: "巡检",
      commands: ["pwd"],
    });

    view.unmount();
  });

  it("creates edits deletes and sends session command groups", async () => {
    const onSaveCommandGroup = vi.fn();
    const onDeleteCommandGroup = vi.fn();
    const onSend = vi.fn();
    const view = renderPanel({
      activeView: "groups",
      commandGroups: groups,
      onDeleteCommandGroup,
      onSaveCommandGroup,
      onSend,
    });

    await click(button(view.container, "新增指令组"));
    await inputText(input(view.container, "指令组名称"), "发布检查");
    await inputText(input(view.container, "指令组命令"), "git status\nnpm test");
    await click(button(view.container, "保存指令组"));

    expect(onSaveCommandGroup).toHaveBeenCalledWith({
      id: undefined,
      saved_session_id: "session-1",
      scope_kind: "saved_session",
      scope_id: "session-1",
      name: "发布检查",
      commands: ["git status", "npm test"],
    });

    await click(button(view.container, "发送 uptime"));
    await click(button(view.container, "编辑 巡检"));
    await inputText(input(view.container, "指令组名称"), "快速巡检");
    await click(button(view.container, "保存指令组"));
    await click(button(view.container, "删除 巡检"));

    expect(onSend).toHaveBeenCalledWith("uptime");
    expect(onSaveCommandGroup).toHaveBeenCalledWith({
      id: "group-1",
      saved_session_id: "session-1",
      scope_kind: "saved_session",
      scope_id: "session-1",
      name: "快速巡检",
      commands: ["uptime", "df -h"],
    });
    expect(onDeleteCommandGroup).toHaveBeenCalledWith("group-1");

    view.unmount();
  });

  it("renders an empty state when no history exists", () => {
    const view = renderPanel({ entries: [] });

    expect(view.container.textContent).toContain("暂无历史命令");

    view.unmount();
  });

  it("saves command groups for a local profile history scope", async () => {
    const onSaveCommandGroup = vi.fn();
    const view = renderPanel({
      activeView: "groups",
      commandGroups: [],
      historyScopeKind: "local_profile",
      historyScopeId: "pwsh",
      onSaveCommandGroup,
    });

    await click(button(view.container, "新增指令组"));
    await inputText(input(view.container, "指令组名称"), "本地巡检");
    await inputText(input(view.container, "指令组命令"), "pwd");
    await click(button(view.container, "保存指令组"));

    expect(onSaveCommandGroup).toHaveBeenCalledWith({
      id: undefined,
      saved_session_id: null,
      scope_kind: "local_profile",
      scope_id: "pwsh",
      name: "本地巡检",
      commands: ["pwd"],
    });

    view.unmount();
  });

  it("disables command group saving when the active pane has no history scope", async () => {
    const view = renderPanel({
      activeView: "groups",
      commandGroups: [],
      historyScopeKind: null,
      historyScopeId: null,
    });

    expect(view.container.textContent).toContain("当前终端没有历史作用域");
    expect(button(view.container, "新增指令组").disabled).toBe(true);

    view.unmount();
  });
});
