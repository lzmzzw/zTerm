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

async function clickWithModifiers(element: HTMLElement, options: { ctrlKey?: boolean; shiftKey?: boolean }) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, ...options }));
  });
}

async function contextMenu(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 16 }));
  });
}

async function keyDown(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
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

function historyEntry(container: HTMLElement, command: string) {
  const entry = Array.from(container.querySelectorAll<HTMLElement>(".zt-history-entry")).find(
    (item) => item.querySelector("code")?.textContent?.trim() === command,
  );
  if (!entry) throw new Error(`History entry not found: ${command}`);
  return entry;
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
      onDeleteEntries={vi.fn().mockResolvedValue(undefined)}
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
    expect(button(view.container, "保存为指令组").disabled).toBe(true);

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

    await click(historyEntry(view.container, "pwd"));
    const saveSelectedButton = button(view.container, "保存为指令组");
    expect(saveSelectedButton.textContent).not.toContain("保存为指令组");
    await click(saveSelectedButton);
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("保存为指令组");
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

  it("selects history entries by row click with ctrl and shift modifiers", async () => {
    const selectionEntries = [
      ...entries,
      {
        ...entries[1],
        id: "history-3",
        command: "uname -a",
        started_at_ms: 3,
      },
    ];
    const view = renderPanel({ entries: selectionEntries });
    const pwd = historyEntry(view.container, "pwd");
    const whoami = historyEntry(view.container, "whoami");
    const uname = historyEntry(view.container, "uname -a");

    expect(view.container.querySelector(".zt-history-entry-checkbox")).toBeNull();

    await click(pwd);
    expect(pwd.classList.contains("is-selected")).toBe(true);
    expect(whoami.classList.contains("is-selected")).toBe(false);

    await click(pwd);
    expect(pwd.classList.contains("is-selected")).toBe(false);

    await click(pwd);

    await clickWithModifiers(uname, { ctrlKey: true });
    expect(pwd.classList.contains("is-selected")).toBe(true);
    expect(uname.classList.contains("is-selected")).toBe(true);

    await click(pwd);
    expect(pwd.classList.contains("is-selected")).toBe(false);
    expect(uname.classList.contains("is-selected")).toBe(true);

    await click(pwd);
    await clickWithModifiers(uname, { shiftKey: true });
    expect(pwd.classList.contains("is-selected")).toBe(true);
    expect(whoami.classList.contains("is-selected")).toBe(true);
    expect(uname.classList.contains("is-selected")).toBe(true);

    view.unmount();
  });

  it("opens a batch context menu for selected history entries", async () => {
    const onCopy = vi.fn();
    const onSend = vi.fn();
    const onDeleteEntries = vi.fn().mockResolvedValue(undefined);
    const view = renderPanel({ onCopy, onSend, onDeleteEntries });
    const pwd = historyEntry(view.container, "pwd");
    const whoami = historyEntry(view.container, "whoami");

    await click(pwd);
    await clickWithModifiers(whoami, { ctrlKey: true });
    await contextMenu(pwd);
    expect(Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim())).toEqual([
      "复制",
      "发送",
      "删除",
    ]);
    await click(button(view.container, "复制"));
    expect(onCopy).toHaveBeenCalledWith("pwd\nwhoami");

    await contextMenu(pwd);
    await click(button(view.container, "发送"));
    expect(onSend).toHaveBeenNthCalledWith(1, "pwd");
    expect(onSend).toHaveBeenNthCalledWith(2, "whoami");

    await contextMenu(pwd);
    await click(button(view.container, "删除"));
    expect(onDeleteEntries).toHaveBeenCalledWith(["history-1", "history-2"]);

    view.unmount();
  });

  it("selects an unselected history entry before opening its context menu and supports keyboard actions", async () => {
    const onSend = vi.fn();
    const onDeleteEntries = vi.fn().mockResolvedValue(undefined);
    const view = renderPanel({ onSend, onDeleteEntries });
    const pwd = historyEntry(view.container, "pwd");
    const whoami = historyEntry(view.container, "whoami");

    await click(pwd);
    await contextMenu(whoami);
    expect(pwd.classList.contains("is-selected")).toBe(false);
    expect(whoami.classList.contains("is-selected")).toBe(true);

    await keyDown(whoami, "Enter");
    expect(onSend).toHaveBeenCalledWith("whoami");
    await keyDown(whoami, "Delete");
    expect(onDeleteEntries).toHaveBeenCalledWith(["history-2"]);

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
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("新增指令组");
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
    expect(view.container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("编辑指令组");
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

  it("renders the command group form as a centered shared dialog", async () => {
    const view = renderPanel({ activeView: "groups", commandGroups: [] });

    expect(view.container.querySelector(".zt-history-group-toolbar")?.textContent).not.toContain("当前历史作用域");

    await click(button(view.container, "新增指令组"));

    const dialog = view.container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute("aria-label")).toBe("新增指令组");
    expect(dialog.classList.contains("zt-dialog")).toBe(true);
    expect(dialog.classList.contains("zt-dialog-compact")).toBe(true);
    expect(dialog.closest(".zt-dialog-backdrop")).not.toBeNull();
    expect(input(view.container, "指令组名称").getAttribute("placeholder")).toBeNull();
    expect(button(view.container, "保存指令组").classList.contains("zt-button-primary")).toBe(true);

    await click(button(view.container, "取消"));

    expect(view.container.querySelector('[role="dialog"]')).toBeNull();

    view.unmount();
  });

  it("keeps the command group editor out of the right panel layout", async () => {
    const view = renderPanel({ activeView: "groups", commandGroups: [] });

    await click(button(view.container, "新增指令组"));

    const panel = view.container.querySelector(".zt-history-panel") as HTMLElement;
    const directClasses = Array.from(panel.children).map((child) => child.className);
    expect(directClasses).toEqual(["zt-history-mode-tabs", "zt-history-groups-view", "zt-dialog-backdrop zt-modal-overlay"]);
    expect(panel.querySelector(".zt-history-groups-view .zt-history-group-form")).toBeNull();
    expect(panel.querySelector(":scope > .zt-dialog-backdrop > [role=dialog]")).not.toBeNull();

    view.unmount();
  });

  it("disables command group dialog actions while saving", async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveCommandGroup = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const view = renderPanel({ activeView: "groups", commandGroups: [], onSaveCommandGroup });

    await click(button(view.container, "新增指令组"));
    await inputText(input(view.container, "指令组名称"), "发布检查");
    await inputText(input(view.container, "指令组命令"), "git status");
    await click(button(view.container, "保存指令组"));

    expect(button(view.container, "保存指令组").disabled).toBe(true);
    expect(button(view.container, "取消").disabled).toBe(true);
    expect(button(view.container, "关闭新增指令组").disabled).toBe(true);

    await act(async () => resolveSave?.());
    expect(view.container.querySelector('[role="dialog"]')).toBeNull();

    view.unmount();
  });

  it("keeps the command group dialog open when saving fails", async () => {
    const onSaveCommandGroup = vi.fn().mockRejectedValue(new Error("保存失败，请重试"));
    const view = renderPanel({ activeView: "groups", commandGroups: [], onSaveCommandGroup });

    await click(button(view.container, "新增指令组"));
    await inputText(input(view.container, "指令组名称"), "发布检查");
    await inputText(input(view.container, "指令组命令"), "git status");
    await click(button(view.container, "保存指令组"));

    expect(view.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("保存失败，请重试");
    expect(button(view.container, "保存指令组").disabled).toBe(false);
    expect(button(view.container, "取消").disabled).toBe(false);

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
