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

function buttonExists(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).some(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
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
      deduplicateHistory={false}
      query=""
      historyScopeKind="saved_session"
      historyScopeId="session-1"
      onClear={vi.fn()}
      onCopy={vi.fn()}
      onDeleteCommandGroup={vi.fn()}
      onDeduplicateHistoryChange={vi.fn()}
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
  it("filters copies and sends command history entries without a search button", async () => {
    const onQueryChange = vi.fn();
    const onCopy = vi.fn();
    const onSend = vi.fn();
    const view = renderPanel({
      onQueryChange,
      onCopy,
      onSend,
    });

    const filterInput = input(view.container, "筛选");
    expect(filterInput.getAttribute("placeholder")).toBe("筛选");
    expect(buttonExists(view.container, "搜索")).toBe(false);

    change(filterInput, "who");
    await click(button(view.container, "复制 pwd"));
    await click(button(view.container, "发送 pwd"));

    expect(onQueryChange).toHaveBeenCalledWith("who");
    expect(onCopy).toHaveBeenCalledWith("pwd");
    expect(onSend).toHaveBeenCalledWith("pwd");

    view.unmount();
  });

  it("shows only history and command group tabs", async () => {
    const onViewChange = vi.fn();
    const view = renderPanel({ onViewChange });

    const tabs = Array.from(view.container.querySelectorAll(".zt-history-mode-tabs button")).map((item) =>
      item.textContent?.trim(),
    );
    expect(tabs).toEqual(["历史", "指令组"]);

    await click(button(view.container, "指令组"));
    expect(onViewChange).toHaveBeenCalledWith("groups");

    view.unmount();
  });

  it("toggles deduplicated history display from the toolbar checkbox", async () => {
    const onDeduplicateHistoryChange = vi.fn();
    const view = renderPanel({ onDeduplicateHistoryChange });

    await click(input(view.container, "去重展示"));

    expect(onDeduplicateHistoryChange).toHaveBeenCalledWith(true);

    view.unmount();
  });

  it("orders command history by operation time hides cwd and scrolls to the latest entry", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("zt-history-list") ? 240 : 0;
      },
    });
    const view = renderPanel({ entries: [entries[1], entries[0]] });

    const commands = Array.from(view.container.querySelectorAll(".zt-history-entry code")).map((item) =>
      item.textContent?.trim(),
    );
    expect(commands).toEqual(["pwd", "whoami"]);
    expect(view.container.textContent).not.toContain("/home/ops");
    expect(view.container.textContent).not.toContain("cwd 未知");
    expect((view.container.querySelector(".zt-history-list") as HTMLDivElement).scrollTop).toBe(240);

    view.unmount();
  });

  it("saves selected history entries as a session command group", async () => {
    const onSaveCommandGroup = vi.fn();
    const view = renderPanel({ onSaveCommandGroup });

    await click(input(view.container, "选择 pwd"));
    const saveSelectedButton = button(view.container, "保存为指令组");
    expect(saveSelectedButton.textContent).not.toContain("保存为指令组");
    await click(saveSelectedButton);
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

  it("renders the command group form as a compact inline editor", async () => {
    const view = renderPanel({ activeView: "groups", commandGroups: [] });

    expect(view.container.querySelector(".zt-history-group-toolbar")?.textContent).not.toContain("当前历史作用域");

    await click(button(view.container, "新增指令组"));

    expect(input(view.container, "指令组名称").getAttribute("placeholder")).toBeNull();
    expect(button(view.container, "保存指令组").classList.contains("zt-history-group-save-action")).toBe(true);
    expect(button(view.container, "取消").classList.contains("zt-history-group-cancel-action")).toBe(true);

    await click(button(view.container, "取消"));

    expect(view.container.querySelector(".zt-history-group-form")).toBeNull();

    view.unmount();
  });

  it("keeps command group form out of the panel stretch row", async () => {
    const view = renderPanel({ activeView: "groups", commandGroups: [] });

    await click(button(view.container, "新增指令组"));

    const panel = view.container.querySelector(".zt-history-panel") as HTMLElement;
    const directClasses = Array.from(panel.children).map((child) => child.className);
    expect(directClasses).toEqual(["zt-history-mode-tabs", "zt-history-groups-view"]);
    expect(panel.querySelector(":scope > .zt-history-group-form")).toBeNull();
    expect(panel.querySelector(".zt-history-groups-view > .zt-history-group-form")).not.toBeNull();

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
