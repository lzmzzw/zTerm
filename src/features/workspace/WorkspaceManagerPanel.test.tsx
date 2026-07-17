// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceManagerPanel } from "./WorkspaceManagerPanel";
import type { WorkspaceSidebarItem } from "./workspaceShellModel";

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

const workspaces: WorkspaceSidebarItem[] = [
  {
    id: "workspace-1",
    name: "运维巡检",
    active_tab_id: "tab-1",
    tab_count: 1,
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
  {
    id: "workspace-2",
    name: "发布窗口",
    active_tab_id: "tab-1",
    tab_count: 1,
    sort_order: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
  {
    id: "default-workspace",
    name: "默认工作区",
    active_tab_id: "tab-1",
    tab_count: 1,
    sort_order: 2,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
];

function panel(overrides: Partial<React.ComponentProps<typeof WorkspaceManagerPanel>> = {}) {
  return (
    <WorkspaceManagerPanel
      workspaces={workspaces}
      selectedWorkspaceId={null}
      onCreateWorkspace={vi.fn()}
      onSaveWorkspace={vi.fn()}
      onSelectWorkspace={vi.fn()}
      onClearWorkspaceSelection={vi.fn()}
      onEditWorkspace={vi.fn()}
      onRestoreWorkspace={vi.fn()}
      onDeleteWorkspace={vi.fn()}
      {...overrides}
    />
  );
}

describe("WorkspaceManagerPanel", () => {
  it("shows new only when nothing is selected and save only when a workspace is selected", () => {
    const unselected = render(panel());
    expect(unselected.container.querySelector('[aria-label="新建工作区"]')?.classList.contains("zt-panel-action-button")).toBe(true);
    expect(unselected.container.querySelector('[aria-label="保存工作区"]')).toBeNull();
    unselected.unmount();

    const selected = render(panel({ selectedWorkspaceId: "workspace-1" }));
    expect(selected.container.querySelector('[aria-label="新建工作区"]')).toBeNull();
    expect(selected.container.querySelector('[aria-label="保存工作区"]')?.classList.contains("zt-panel-action-button")).toBe(true);
    selected.unmount();
  });

  it("selects a workspace without toggling the already selected item", () => {
    const onSelectWorkspace = vi.fn();
    const view = render(panel({ selectedWorkspaceId: "workspace-1", onSelectWorkspace }));
    const selectedButton = view.container.querySelector('[aria-label="选择工作区 运维巡检"]') as HTMLButtonElement;
    const otherButton = view.container.querySelector('[aria-label="选择工作区 发布窗口"]') as HTMLButtonElement;

    act(() => selectedButton.click());
    act(() => otherButton.click());

    expect(onSelectWorkspace).toHaveBeenCalledTimes(1);
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-2");
    view.unmount();
  });

  it("clears selection from list whitespace and Escape", () => {
    const onClearWorkspaceSelection = vi.fn();
    const view = render(panel({ selectedWorkspaceId: "workspace-1", onClearWorkspaceSelection }));

    act(() => {
      view.container.querySelector(".zt-workspace-list")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(onClearWorkspaceSelection).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("selects the context target and exposes only edit, restore, and delete", () => {
    const onSelectWorkspace = vi.fn();
    const onEditWorkspace = vi.fn();
    const view = render(panel({ onSelectWorkspace, onEditWorkspace }));

    act(() => {
      view.container.querySelector('[aria-label="工作区 运维巡检"]')?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 96 }),
      );
    });

    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim())).toEqual([
      "恢复",
      "编辑",
      "删除",
    ]);

    act(() => {
      (view.container.querySelector('[aria-label="编辑工作区 运维巡检"]') as HTMLButtonElement).click();
    });
    expect(onEditWorkspace).toHaveBeenCalledWith("workspace-1");
    view.unmount();
  });

  it("restores a workspace on double click and hides the internal workbench record", () => {
    const onRestoreWorkspace = vi.fn();
    const view = render(panel({ onRestoreWorkspace }));

    act(() => {
      view.container.querySelector('[aria-label="选择工作区 发布窗口"]')?.dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true }),
      );
    });

    expect(onRestoreWorkspace).toHaveBeenCalledWith("workspace-2");
    expect(view.container.querySelector('[aria-label="工作区 默认工作区"]')).toBeNull();
    expect(view.container.querySelector(".zt-workspace-dot")).toBeNull();
    view.unmount();
  });

  it("keeps the error message and workspace list inside one content container", () => {
    const view = render(panel({ error: "加载工作区缩略图失败" }));
    const body = view.container.querySelector(".zt-workspace-panel-body");
    expect(body?.querySelector(".zt-empty-line")?.textContent).toBe("加载工作区缩略图失败");
    expect(body?.querySelector(".zt-workspace-list")).not.toBeNull();
    view.unmount();
  });
});
