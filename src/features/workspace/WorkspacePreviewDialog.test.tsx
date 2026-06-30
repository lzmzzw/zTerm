// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { WorkspacePreviewDialog } from "./WorkspacePreviewDialog";
import type { WorkspaceDefinition } from "./types";

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

function input(container: ParentNode, label: string) {
  const match = container.querySelector(`input[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Input not found: ${label}`);
  }
  return match as HTMLInputElement;
}

function textarea(container: ParentNode, label: string) {
  const match = container.querySelector(`textarea[aria-label="${label}"]`);
  if (!match) {
    throw new Error(`Textarea not found: ${label}`);
  }
  return match as HTMLTextAreaElement;
}

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function emptyWorkspaceDefinition(): WorkspaceDefinition {
  return {
    id: "workspace-1",
    name: "默认工作区",
    status: "closed",
    active_tab_id: "tab-1",
    tabs: [
      {
        id: "tab-1",
        title: "新建终端",
        active_pane_id: "pane-1",
        root: {
          kind: "leaf",
          id: "pane-1",
          title: "新建终端",
          runtime_session_id: null,
          saved_session_id: null,
          active_terminal_tab_id: "pane-1-tab-1",
          terminal_tabs: [
            {
              id: "pane-1-tab-1",
              title: "新建终端",
              runtime_session_id: null,
              saved_session_id: null,
              connection_source: "default_local",
              startup_command: null,
            },
          ],
        },
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
    ],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}

describe("WorkspacePreviewDialog", () => {
  it("hides empty placeholder terminal tabs in preview tab labels", () => {
    const view = render(
      <WorkspacePreviewDialog
        workspace={emptyWorkspaceDefinition()}
        sessions={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const workspaceTab = view.container.querySelector(".zt-workspace-preview-workspace-tabs [role='tab']");
    const paneTab = view.container.querySelector(".zt-workspace-preview-pane-tab-list [role='tab']");
    const nameInput = view.container.querySelector<HTMLInputElement>('input[aria-label="编辑标签名称"]');

    expect(workspaceTab).toBeNull();
    expect(paneTab).toBeNull();
    expect(view.container.querySelector(".zt-workspace-preview-inspector-title")).toBeNull();
    expect(nameInput).toBeNull();
    view.unmount();
  });

  it("keeps the workspace editor focused on terminal tab names", () => {
    const view = render(
      <WorkspacePreviewDialog
        mode="edit"
        workspace={{
          ...emptyWorkspaceDefinition(),
          name: "工作区2",
          tabs: [
            {
              ...emptyWorkspaceDefinition().tabs[0],
              title: "172.16.41.180 (1)",
              root: {
                kind: "leaf",
                id: "pane-1",
                title: "git bash",
                runtime_session_id: null,
                saved_session_id: null,
                active_terminal_tab_id: "pane-1-tab-1",
                terminal_tabs: [
                  {
                    id: "pane-1-tab-1",
                    title: "git bash",
                    runtime_session_id: null,
                    saved_session_id: null,
                    connection_source: "default_local",
                    path: "/c/Users/PKUWHAI",
                    startup_command: null,
                  },
                  {
                    id: "pane-1-tab-2",
                    title: "Git Bash",
                    runtime_session_id: null,
                    saved_session_id: null,
                    connection_source: "default_local",
                    path: "/home/ubuntu",
                    startup_command: null,
                  },
                ],
              },
            },
          ],
        }}
        sessions={[]}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const canvas = view.container.querySelector(".zt-workspace-preview-canvas");
    const paneTabList = view.container.querySelector(".zt-workspace-preview-pane-tab-list");

    expect(view.container.textContent).not.toContain("工作区名称");
    expect(view.container.querySelector(".zt-workspace-preview-workspace-tabs [role='tab']")).toBeNull();
    expect(view.container.querySelector(".zt-workspace-layout-pane-title")).toBeNull();
    expect(view.container.querySelector(".zt-workspace-preview-inspector-title")).toBeNull();
    expect(view.container.querySelector('input[aria-label="编辑标签名称"]')).toBeNull();
    expect(canvas?.textContent).toContain("git bash");
    expect(canvas?.textContent).toContain("Git Bash");
    expect(canvas?.textContent).not.toContain("pane-1");
    expect(canvas?.textContent).not.toContain("默认本地终端");
    expect(canvas?.textContent).not.toContain("/c/Users/PKUWHAI");
    expect(canvas?.querySelector(".zt-workspace-layout-pane-tabs span.active")?.textContent).toBe("git bash");
    expect(paneTabList?.classList.contains("horizontal")).toBe(true);
    view.unmount();
  });

  it("edits workspace name and terminal startup command in the same draft", () => {
    const onSave = vi.fn();
    const view = render(
      <WorkspacePreviewDialog
        mode="edit"
        workspace={{
          ...emptyWorkspaceDefinition(),
          name: "运维巡检",
          tabs: [
            {
              ...emptyWorkspaceDefinition().tabs[0],
              title: "主工作台",
              root: {
                kind: "leaf",
                id: "pane-1",
                title: "生产机",
                runtime_session_id: null,
                saved_session_id: "session-1",
                active_terminal_tab_id: "pane-1-tab-1",
                terminal_tabs: [
                  {
                    id: "pane-1-tab-1",
                    title: "生产机",
                    runtime_session_id: null,
                    saved_session_id: "session-1",
                    connection_source: "saved_session",
                    path: "/srv/app",
                    startup_command: "cd /srv/app",
                  },
                ],
              },
            },
          ],
        }}
        sessions={[
          {
            id: "session-1",
            name: "生产机",
            type: "ssh",
            host: "10.0.0.10",
            port: 22,
            username: "ops",
            auth_mode: "none",
            credential_ref: null,
            description: null,
            group_id: null,
            tags: [],
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_used_at_ms: null,
          },
        ]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    change(input(view.container, "编辑工作区名称"), "发布窗口");
    change(textarea(view.container, "编辑连接后指令"), "source ./env.sh");

    act(() => {
      (view.container.querySelector('[aria-label="保存工作区"]') as HTMLButtonElement).click();
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "workspace-1",
        name: "发布窗口",
        tabs: expect.arrayContaining([
          expect.objectContaining({
            root: expect.objectContaining({
              terminal_tabs: expect.arrayContaining([
                expect.objectContaining({
                  id: "pane-1-tab-1",
                  startup_command: "source ./env.sh",
                }),
              ]),
            }),
          }),
        ]),
      }),
    );
    view.unmount();
  });
});
