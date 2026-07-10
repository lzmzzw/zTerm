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
    status: "running",
    active_tab_id: "tab-1",
    tab_count: 1,
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
  {
    id: "workspace-closed",
    name: "发布窗口",
    status: "closed",
    active_tab_id: "tab-1",
    tab_count: 1,
    sort_order: 1,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
  {
    id: "default-workspace",
    name: "默认工作区",
    status: "running",
    active_tab_id: "tab-1",
    tab_count: 1,
    sort_order: 2,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
];

describe("WorkspaceManagerPanel", () => {
  it("shows only the new workspace action from the expanded workspace context menu", () => {
    const onCreateWorkspace = vi.fn();
    const view = render(
      <WorkspaceManagerPanel
        workspaces={workspaces}
        activeWorkspaceId="workspace-1"
        onCreateWorkspace={onCreateWorkspace}
        onSelectWorkspace={vi.fn()}
        onEditWorkspace={vi.fn()}
        onRestoreWorkspace={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
      />,
    );

    act(() => {
      view.container.querySelector(".zt-workspace-panel")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 24 }),
      );
    });

    const menuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual(["新建工作区"]);

    act(() => {
      (view.container.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
    });

    expect(onCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[aria-label="编辑工作区 运维巡检"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="恢复工作区 运维巡检"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="关闭工作区 运维巡检"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="工作区 默认工作区"]')).toBeNull();
    view.unmount();
  });

  it("shows workspace actions from the targeted workspace context menu", () => {
    const onEditWorkspace = vi.fn();
    const onCloseWorkspace = vi.fn();
    const onDeleteWorkspace = vi.fn();
    const view = render(
      <WorkspaceManagerPanel
        workspaces={workspaces}
        activeWorkspaceId="workspace-1"
        onCreateWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onEditWorkspace={onEditWorkspace}
        onRestoreWorkspace={vi.fn()}
        onCloseWorkspace={onCloseWorkspace}
        onDeleteWorkspace={onDeleteWorkspace}
      />,
    );

    act(() => {
      view.container.querySelector('[aria-label="工作区 运维巡检"]')?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 96 }),
      );
    });

    const menuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual(["编辑", "恢复", "关闭", "删除"]);
    expect(view.container.querySelector<HTMLButtonElement>('[aria-label="恢复工作区 运维巡检"]')?.disabled).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>('[aria-label="关闭工作区 运维巡检"]')?.disabled).toBe(false);
    expect(view.container.querySelector<HTMLButtonElement>('[aria-label="删除工作区 运维巡检"]')?.disabled).toBe(false);

    act(() => {
      (view.container.querySelector('[aria-label="编辑工作区 运维巡检"]') as HTMLButtonElement).click();
    });

    expect(onEditWorkspace).toHaveBeenCalledWith("workspace-1");

    act(() => {
      view.container.querySelector('[aria-label="工作区 运维巡检"]')?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 96 }),
      );
    });
    act(() => {
      (view.container.querySelector('[aria-label="关闭工作区 运维巡检"]') as HTMLButtonElement).click();
    });

    expect(onCloseWorkspace).toHaveBeenCalledWith("workspace-1");

    act(() => {
      view.container.querySelector('[aria-label="工作区 运维巡检"]')?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 96 }),
      );
    });
    act(() => {
      (view.container.querySelector('[aria-label="删除工作区 运维巡检"]') as HTMLButtonElement).click();
    });

    expect(onDeleteWorkspace).toHaveBeenCalledWith("workspace-1");
    view.unmount();
  });

  it("disables unavailable workspace context menu actions and never renders the hidden default workspace", () => {
    const view = render(
      <WorkspaceManagerPanel
        workspaces={workspaces}
        activeWorkspaceId="workspace-1"
        onCreateWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onEditWorkspace={vi.fn()}
        onRestoreWorkspace={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
      />,
    );

    act(() => {
      view.container.querySelector('[aria-label="工作区 发布窗口"]')?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 80, clientY: 160 }),
      );
    });

    expect(view.container.querySelector<HTMLButtonElement>('[aria-label="恢复工作区 发布窗口"]')?.disabled).toBe(false);
    expect(view.container.querySelector<HTMLButtonElement>('[aria-label="关闭工作区 发布窗口"]')?.disabled).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>('[aria-label="删除工作区 发布窗口"]')?.disabled).toBe(false);

    expect(view.container.querySelector('[aria-label="工作区 默认工作区"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="切换工作区 默认工作区"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="删除工作区 默认工作区"]')).toBeNull();
    view.unmount();
  });

  it("keeps the error message and workspace list inside one content container", () => {
    const view = render(
      <WorkspaceManagerPanel
        workspaces={workspaces}
        activeWorkspaceId="workspace-1"
        error="加载工作区缩略图失败"
        onCreateWorkspace={vi.fn()}
        onSelectWorkspace={vi.fn()}
        onEditWorkspace={vi.fn()}
        onRestoreWorkspace={vi.fn()}
        onCloseWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
      />,
    );

    const body = view.container.querySelector(".zt-workspace-panel-body");
    expect(body?.querySelector(".zt-empty-line")?.textContent).toBe("加载工作区缩略图失败");
    expect(body?.querySelector(".zt-workspace-list")).not.toBeNull();

    view.unmount();
  });
});
