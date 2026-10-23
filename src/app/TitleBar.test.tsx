// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TitleBar } from "./TitleBar";

const tauriWindow = vi.hoisted(() => ({
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  close: vi.fn().mockResolvedValue(undefined),
  startDragging: vi.fn().mockResolvedValue(undefined),
  isFullscreen: vi.fn().mockResolvedValue(false),
  setFullscreen: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => {}),
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
  afterEach(() => vi.unstubAllGlobals());
  it("places Agent actions before the Windows window controls outside the drag region", () => {
    const view = render(<TitleBar actions={<button aria-label="Agent">Agent</button>} />);
    const actions = view.container.querySelector(".zt-titlebar-actions")!;
    expect(actions.querySelector('[aria-label="Agent"]')).not.toBeNull();
    expect(actions.nextElementSibling?.classList.contains("zt-window-actions")).toBe(true);
    expect(actions.closest("[data-tauri-drag-region]")).toBeNull();
    view.unmount();
  });

  beforeEach(() => {
    tauriWindow.minimize.mockClear();
    tauriWindow.toggleMaximize.mockClear();
    tauriWindow.isMaximized.mockReset();
    tauriWindow.isMaximized.mockResolvedValue(false);
    tauriWindow.close.mockClear();
    tauriWindow.startDragging.mockClear();
    tauriWindow.isFullscreen.mockReset().mockResolvedValue(false);
    tauriWindow.setFullscreen.mockClear();
    tauriWindow.onResized.mockReset().mockResolvedValue(() => {});
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
    expect(logo?.getAttribute("src")).toContain("zterm");

    view.unmount();
  });

  it("hides the app logo from the macOS traffic-light titlebar", () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    try {
      const view = render(<TitleBar />);

      expect(view.container.querySelector(".zt-titlebar-macos")).not.toBeNull();
      expect(view.container.querySelector(".zt-titlebar-logo")).toBeNull();

      view.unmount();
    } finally {
      if (descriptor) {
        Object.defineProperty(navigator, "platform", descriptor);
      } else {
        Reflect.deleteProperty(navigator, "platform");
      }
    }
  });

  it("groups Mac navigation with Agent on the right and traffic lights first in standard order", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
    const unlisten = vi.fn();
    tauriWindow.onResized.mockResolvedValue(unlisten);
    const view = render(<TitleBar
      navigation={<nav aria-label="主导航"><button>会话</button><button>文件传输</button><button>设置</button></nav>}
      actions={<button>Agent</button>}
    />);
    await act(async () => { await Promise.resolve(); });
    const header = view.container.querySelector("header")!;
    expect(header.firstElementChild?.classList.contains("zt-window-actions-macos")).toBe(true);
    expect(Array.from(header.firstElementChild!.querySelectorAll("button")).map((item) => item.getAttribute("aria-label")))
      .toEqual(["关闭", "最小化", "进入全屏"]);
    const actions = header.querySelector(".zt-titlebar-actions")!;
    expect(Array.from(actions.querySelectorAll("button")).map((item) => item.textContent))
      .toEqual(["会话", "文件传输", "设置", "Agent"]);
    expect(actions.previousElementSibling?.classList.contains("zt-titlebar-drag-region")).toBe(true);
    expect(actions.closest("[data-tauri-drag-region]")).toBeNull();
    await click(button(view.container, "最小化"));
    await click(button(view.container, "关闭"));
    expect(tauriWindow.minimize).toHaveBeenCalledOnce();
    expect(tauriWindow.close).toHaveBeenCalledOnce();
    view.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("enters and exits native Mac fullscreen and synchronizes external window changes", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "Macintosh" });
    const view = render(<TitleBar />);
    await act(async () => { await Promise.resolve(); });
    await click(button(view.container, "进入全屏"));
    expect(tauriWindow.setFullscreen).toHaveBeenLastCalledWith(true);
    expect(button(view.container, "退出全屏")).toBeDefined();
    tauriWindow.isFullscreen.mockResolvedValue(true);
    await click(button(view.container, "退出全屏"));
    expect(tauriWindow.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(tauriWindow.toggleMaximize).not.toHaveBeenCalled();
    await act(async () => {
      tauriWindow.onResized.mock.calls[0][0]();
      await Promise.resolve();
    });
    expect(button(view.container, "退出全屏")).toBeDefined();
    view.unmount();
  });

  it("renders active connection context in the center and omits it when unavailable", () => {
    const sshView = render(<TitleBar centerContent="192.168.10.24" />);

    expect(sshView.container.querySelector(".zt-titlebar-center")?.textContent).toBe("192.168.10.24");
    sshView.unmount();

    const emptyView = render(<TitleBar centerContent={null} />);
    expect(emptyView.container.querySelector(".zt-titlebar-center")).toBeNull();
    emptyView.unmount();
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

  it("preserves full local paths for hover while separating the final directory for truncation", async () => {
    const path = "F:\\Workspace\\Repos\\zTerm";
    const view = render(<TitleBar centerContent={path} centerIsPath />);
    const title = view.container.querySelector(".zt-titlebar-center")!;
    expect(title.getAttribute("title")).toBe(path);
    expect(title.textContent).toBe(path);
    expect(title.querySelector(".zt-titlebar-path-tail")?.textContent).toBe("\\zTerm");
    await act(async () => { title.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); });
    expect(tauriWindow.startDragging).toHaveBeenCalledTimes(1);
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
