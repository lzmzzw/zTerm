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
