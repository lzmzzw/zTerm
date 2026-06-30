// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

const tauriWindow = vi.hoisted(() => ({
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  close: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => tauriWindow,
}));

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
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("TitleBar", () => {
  beforeEach(() => {
    tauriWindow.minimize.mockClear();
    tauriWindow.toggleMaximize.mockClear();
    tauriWindow.isMaximized.mockReset();
    tauriWindow.isMaximized.mockResolvedValue(false);
    tauriWindow.close.mockClear();
    tauriWindow.startDragging.mockClear();
  });

  it("routes window action buttons to the current Tauri window", async () => {
    const view = render(<TitleBar />);

    await click(button(view.container, "最小化"));
    await click(button(view.container, "全屏切换"));
    await click(button(view.container, "关闭"));

    expect(tauriWindow.minimize).toHaveBeenCalledTimes(1);
    expect(tauriWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(tauriWindow.close).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("renders icon based window actions and switches maximize to restore when maximized", async () => {
    tauriWindow.isMaximized.mockResolvedValue(true);

    const view = render(<TitleBar />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(button(view.container, "最小化").querySelector(".lucide-minus")).not.toBeNull();
    expect(button(view.container, "恢复").querySelector(".lucide-copy")).not.toBeNull();
    expect(button(view.container, "关闭").querySelector(".lucide-x")).not.toBeNull();
    expect(view.container.querySelector('[aria-label="全屏切换"]')).toBeNull();

    await click(button(view.container, "恢复"));

    expect(tauriWindow.toggleMaximize).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("renders the maximize action as a square icon before the window is maximized", () => {
    const view = render(<TitleBar />);

    expect(button(view.container, "全屏切换").querySelector(".lucide-square")).not.toBeNull();
    expect(button(view.container, "全屏切换").querySelector(".lucide-maximize-2")).toBeNull();

    view.unmount();
  });

  it("removes the legacy brand and menus from the title row", () => {
    const view = render(<TitleBar />);

    expect(view.container.querySelector(".zt-titlebar-menu")).toBeNull();
    expect(view.container.querySelector(".zt-brand")).toBeNull();
    expect(view.container.querySelector(".zt-brand-logo")).toBeNull();
    expect(view.container.textContent).not.toContain("zTerm");
    expect(view.container.textContent).not.toContain("Option");
    expect(view.container.textContent).not.toContain("View");
    expect(view.container.textContent).not.toContain("Help");

    view.unmount();
  });

  it("renders the standalone app logo in the titlebar corner", () => {
    const view = render(<TitleBar />);
    const logo = view.container.querySelector(".zt-titlebar-logo");

    expect(logo).not.toBeNull();
    expect(logo?.tagName).toBe("IMG");
    expect(logo?.getAttribute("alt")).toBe("zTerm");
    expect(logo?.getAttribute("src")).toContain("data:image/svg+xml");
    expect(logo?.getAttribute("src")).toContain("borderGrad");

    view.unmount();
  });

  it("does not render sidebar, settings, or search controls in the titlebar", () => {
    const view = render(<TitleBar />);

    expect(view.container.querySelector('[aria-label="展开左侧栏"]')).toBeNull();
    expect(view.container.querySelector('[aria-label="折叠左侧栏"]')).toBeNull();
    expect(view.container.querySelector(".lucide-panel-left-open")).toBeNull();
    expect(view.container.querySelector(".lucide-panel-left-close")).toBeNull();
    expect(view.container.querySelector('[aria-label="打开设置"]')).toBeNull();
    expect(view.container.querySelector(".lucide-layout-grid")).toBeNull();
    expect(view.container.querySelector('[role="search"]')).toBeNull();
    expect(view.container.querySelector('input[type="search"]')).toBeNull();
    expect(view.container.querySelector(".zt-titlebar-search")).toBeNull();
    expect(view.container.textContent?.toLowerCase()).not.toContain("search");

    view.unmount();
  });

  it("keeps only non-interactive title regions draggable", () => {
    const view = render(<TitleBar />);

    expect(view.container.querySelector(".zt-titlebar")?.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(view.container.querySelector(".zt-brand")).toBeNull();
    expect(view.container.querySelector(".zt-titlebar-drag-region")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(view.container.querySelector(".zt-titlebar-left-actions")).toBeNull();
    expect(view.container.querySelector(".zt-titlebar-app-actions")).toBeNull();
    expect(button(view.container, "最小化").closest("[data-tauri-drag-region]")).toBe(null);

    view.unmount();
  });

  it("starts native window dragging from the blank titlebar region on left mouse down", async () => {
    const view = render(<TitleBar />);
    const dragRegion = view.container.querySelector(".zt-titlebar-drag-region");
    if (!dragRegion) {
      throw new Error("Drag region not found");
    }

    await act(async () => {
      dragRegion.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1);

    await act(async () => {
      dragRegion.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
    });

    expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1);

    view.unmount();
  });
});
