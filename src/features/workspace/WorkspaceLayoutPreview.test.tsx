// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceLayoutPreview } from "./WorkspaceLayoutPreview";
import type { PaneNode } from "./types";

function leaf(id: string, title: string, path?: string | null): PaneNode {
  return {
    kind: "leaf",
    id,
    runtime_session_id: null,
    saved_session_id: id === "pane-c" ? "session-1" : null,
    title,
    active_terminal_tab_id: `${id}-tab-1`,
    terminal_tabs: [
      {
        id: `${id}-tab-1`,
        title,
        runtime_session_id: null,
        saved_session_id: id === "pane-c" ? "session-1" : null,
        connection_source: id === "pane-c" ? "saved_session" : "default_local",
        path,
      },
    ],
  };
}

function fourPaneRoot(): PaneNode {
  return {
    kind: "split",
    id: "split-root",
    direction: "horizontal",
    ratio: 0.42,
    first: {
      kind: "split",
      id: "split-left",
      direction: "vertical",
      ratio: 0.58,
      first: leaf("pane-a", "PowerShell 7"),
      second: leaf("pane-c", "172.16.41.181", "/srv/app"),
    },
    second: {
      kind: "split",
      id: "split-right",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("pane-b", "PowerShell 7"),
      second: leaf("pane-d", "PowerShell 7"),
    },
  };
}

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

describe("WorkspaceLayoutPreview", () => {
  it("renders a four pane workspace using the real split tree", () => {
    const view = render(
      <WorkspaceLayoutPreview
        root={fourPaneRoot()}
        sessions={[{ id: "session-1", name: "172.16.41.181" }]}
        selectedPaneId="pane-b"
        onSelectPane={vi.fn()}
      />,
    );

    expect(view.container.querySelectorAll(".zt-workspace-layout-pane")).toHaveLength(4);
    expect(view.container.querySelector(".zt-workspace-layout-pane.selected")?.getAttribute("data-pane-id")).toBe("pane-b");
    expect(view.container.textContent).toContain("172.16.41.181");
    expect(view.container.textContent).toContain("/srv/app");

    view.unmount();
  });

  it("maps split ratios to preview grid variables", () => {
    const view = render(
      <WorkspaceLayoutPreview root={fourPaneRoot()} sessions={[]} selectedPaneId="pane-a" onSelectPane={vi.fn()} />,
    );

    const rootSplit = view.container.querySelector('[data-split-id="split-root"]') as HTMLElement | null;
    const leftSplit = view.container.querySelector('[data-split-id="split-left"]') as HTMLElement | null;

    expect(rootSplit?.style.getPropertyValue("--zt-workspace-preview-ratio")).toBe("42%");
    expect(leftSplit?.style.getPropertyValue("--zt-workspace-preview-ratio")).toBe("58%");

    view.unmount();
  });

  it("renders thumbnail previews as structure-only evenly split blocks", () => {
    const view = render(
      <WorkspaceLayoutPreview
        root={fourPaneRoot()}
        sessions={[{ id: "session-1", name: "172.16.41.181" }]}
        variant="thumbnail"
        interactive={false}
      />,
    );

    expect(view.container.querySelectorAll(".zt-workspace-layout-thumbnail-leaf")).toHaveLength(4);
    expect(view.container.querySelectorAll(".zt-workspace-layout-pane")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("PowerShell 7");
    expect(view.container.textContent).not.toContain("172.16.41.181");
    expect(view.container.textContent).not.toContain("/srv/app");
    expect(view.container.textContent).not.toContain("pane-a");

    const rootSplit = view.container.querySelector('[data-thumbnail-split-id="split-root"]') as HTMLElement | null;
    const leftSplit = view.container.querySelector('[data-thumbnail-split-id="split-left"]') as HTMLElement | null;

    expect(rootSplit?.style.getPropertyValue("--zt-workspace-preview-ratio")).toBe("");
    expect(leftSplit?.style.getPropertyValue("--zt-workspace-preview-ratio")).toBe("");

    view.unmount();
  });

  it("selects a pane without exposing runtime session ids", () => {
    const onSelectPane = vi.fn();
    const root = fourPaneRoot();
    if (root.kind === "split" && root.first.kind === "split" && root.first.first.kind === "leaf") {
      root.first.first.runtime_session_id = "runtime-secret";
      root.first.first.terminal_tabs = [
        {
          id: "pane-a-tab-1",
          title: "PowerShell 7",
          runtime_session_id: "runtime-secret",
          saved_session_id: null,
        },
      ];
    }
    const view = render(
      <WorkspaceLayoutPreview root={root} sessions={[]} selectedPaneId="pane-a" onSelectPane={onSelectPane} />,
    );

    const pane = view.container.querySelector('[data-pane-id="pane-c"]') as HTMLButtonElement;
    act(() => pane.click());

    expect(onSelectPane).toHaveBeenCalledWith("pane-c");
    expect(view.container.textContent).not.toContain("runtime-secret");

    view.unmount();
  });
});
