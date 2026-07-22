// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { TerminalToolbar } from "./TerminalToolbar";

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

describe("TerminalToolbar", () => {
  it("uses an x icon for closing the active split pane", () => {
    const view = render(<TerminalToolbar onSplitPane={vi.fn()} onClosePane={vi.fn()} />);

    const closeButton = view.container.querySelector('[aria-label="关闭分栏"]');

    expect(closeButton?.querySelector(".lucide-x")).not.toBeNull();
    view.unmount();
  });

  it("disables only the split direction that has reached its pane limit", () => {
    const onSplitPane = vi.fn();
    const view = render(
      <TerminalToolbar
        onSplitPane={onSplitPane}
        onClosePane={vi.fn()}
        canSplitHorizontal={false}
        canSplitVertical
      />,
    );

    const horizontal = view.container.querySelector('[aria-label="横向分栏"]') as HTMLButtonElement;
    const vertical = view.container.querySelector('[aria-label="纵向分栏"]') as HTMLButtonElement;
    horizontal.click();
    vertical.click();

    expect(horizontal.disabled).toBe(true);
    expect(horizontal.title).toContain("宽度小于页面的 1/4");
    expect(vertical.disabled).toBe(false);
    expect(onSplitPane).toHaveBeenCalledWith("vertical");
    view.unmount();
  });

  it("shows channel controls only for a channel member and keeps leave separate from close", () => {
    const onLeaveSyncChannel = vi.fn();
    const onCloseSyncChannel = vi.fn();
    const view = render(
      <TerminalToolbar
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        syncChannelMember
        onLeaveSyncChannel={onLeaveSyncChannel}
        onCloseSyncChannel={onCloseSyncChannel}
      />,
    );

    (view.container.querySelector('[aria-label="离开同步频道"]') as HTMLButtonElement).click();
    expect(onLeaveSyncChannel).toHaveBeenCalledTimes(1);
    expect(onCloseSyncChannel).not.toHaveBeenCalled();

    (view.container.querySelector('[aria-label="关闭同步频道"]') as HTMLButtonElement).click();
    expect(onCloseSyncChannel).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
