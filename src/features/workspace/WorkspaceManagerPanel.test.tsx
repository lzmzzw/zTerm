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
];

describe("WorkspaceManagerPanel", () => {
  it("shows only the new workspace action from the expanded workspace context menu", () => {
    const onCreateWorkspace = vi.fn();
    const onEditWorkspace = vi.fn();
    const view = render(
      <WorkspaceManagerPanel
        workspaces={workspaces}
        activeWorkspaceId="workspace-1"
        onCreateWorkspace={onCreateWorkspace}
        onSelectWorkspace={vi.fn()}
        onEditWorkspace={onEditWorkspace}
        onRestoreWorkspace={vi.fn()}
        onCloseWorkspace={vi.fn()}
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

    act(() => {
      (view.container.querySelector('[aria-label="编辑工作区 运维巡检"]') as HTMLButtonElement).click();
    });

    expect(onEditWorkspace).toHaveBeenCalledWith("workspace-1");
    view.unmount();
  });
});
