// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShortcutBinding } from "../features/settings/settingsStore";
import { useAppShortcutKeys } from "./useAppShortcutKeys";

const cleanupFns: Array<() => void> = [];

describe("useAppShortcutKeys", () => {
  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) {
      cleanup();
    }
    vi.restoreAllMocks();
  });

  it("matches a shortcut and dispatches the resolved command", () => {
    const handlers = shortcutHandlers();
    renderShortcutHarness({
      bindings: [binding("right_tool.files", "Ctrl+Shift+F")],
      handlers,
    });

    const event = dispatchKey({ key: "F", ctrlKey: true, shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onToggleRightTool).toHaveBeenCalledWith("files");
  });

  it("opens the sync channel dialog through the configured shortcut", () => {
    const handlers = shortcutHandlers();
    renderShortcutHarness({ bindings: [binding("sync_channel.open", "Ctrl+Shift+M")], handlers });

    dispatchKey({ key: "m", ctrlKey: true, shiftKey: true });

    expect(handlers.onOpenSyncChannel).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch commands that require missing context", () => {
    const handlers = shortcutHandlers();
    renderShortcutHarness({
      bindings: [binding("terminal.close_tab", "Ctrl+W")],
      context: {
        activePaneId: null,
        activePaneTabId: null,
        newTabPaneId: "pane-1",
      },
      handlers,
    });

    const event = dispatchKey({ key: "w", ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onCloseTerminalTab).not.toHaveBeenCalled();
  });

  it("ignores unmatched keyboard events", () => {
    const handlers = shortcutHandlers();
    renderShortcutHarness({
      bindings: [binding("settings.open", "Ctrl+,")],
      handlers,
    });

    const event = dispatchKey({ key: "x", ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(handlers.onOpenSettings).not.toHaveBeenCalled();
  });

  it("prevents ctrl+a page selection outside editable controls", () => {
    const handlers = shortcutHandlers();
    renderShortcutHarness({ bindings: [binding("settings.open", "Ctrl+A")], handlers });
    const panel = document.createElement("section");
    document.body.appendChild(panel);

    const event = dispatchKey({ key: "a", ctrlKey: true, target: panel });

    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onOpenSettings).not.toHaveBeenCalled();
    panel.remove();
  });

  it("keeps ctrl+a available for editable controls and locally handled selection regions", () => {
    renderShortcutHarness({ bindings: [], handlers: shortcutHandlers() });
    const input = document.createElement("input");
    document.body.appendChild(input);

    const inputEvent = dispatchKey({ key: "a", ctrlKey: true, target: input });
    const localEvent = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    localEvent.preventDefault();
    const localPreventDefault = vi.spyOn(localEvent, "preventDefault");
    window.dispatchEvent(localEvent);

    expect(inputEvent.defaultPrevented).toBe(false);
    expect(localEvent.defaultPrevented).toBe(true);
    expect(localPreventDefault).not.toHaveBeenCalled();
    input.remove();
  });

  it("keeps one keydown listener while reading latest handlers after rerender", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const firstHandlers = shortcutHandlers();
    const secondHandlers = shortcutHandlers();
    const bindings = [binding("settings.open", "Ctrl+,")];
    const harness = renderShortcutHarness({
      bindings,
      handlers: firstHandlers,
    });

    harness.rerender({
      bindings,
      handlers: secondHandlers,
    });
    const event = dispatchKey({ key: ",", ctrlKey: true });

    expect(keydownCallCount(addSpy)).toBe(1);
    expect(keydownCallCount(removeSpy)).toBe(0);
    expect(event.defaultPrevented).toBe(true);
    expect(firstHandlers.onOpenSettings).not.toHaveBeenCalled();
    expect(secondHandlers.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

function renderShortcutHarness({
  bindings,
  context = {
    activePaneId: "pane-1",
    activePaneTabId: "pane-tab-1",
    newTabPaneId: "pane-1",
  },
  handlers,
}: {
  bindings: ShortcutBinding[];
  context?: Parameters<typeof useAppShortcutKeys>[1];
  handlers: Parameters<typeof useAppShortcutKeys>[2];
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<ShortcutHarness bindings={bindings} context={context} handlers={handlers} />);
  });

  cleanupFns.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  return {
    rerender(nextProps: {
      bindings: ShortcutBinding[];
      context?: Parameters<typeof useAppShortcutKeys>[1];
      handlers: Parameters<typeof useAppShortcutKeys>[2];
    }) {
      act(() => {
        root.render(
          <ShortcutHarness
            bindings={nextProps.bindings}
            context={nextProps.context ?? context}
            handlers={nextProps.handlers}
          />,
        );
      });
    },
  };
}

function ShortcutHarness({
  bindings,
  context,
  handlers,
}: {
  bindings: ShortcutBinding[];
  context: Parameters<typeof useAppShortcutKeys>[1];
  handlers: Parameters<typeof useAppShortcutKeys>[2];
}): ReactElement {
  useAppShortcutKeys(bindings, context, handlers);
  return <section />;
}

function shortcutHandlers(): Parameters<typeof useAppShortcutKeys>[2] {
  return {
    onOpenSettings: vi.fn(),
    onOpenSyncChannel: vi.fn(),
    onAddTerminalTab: vi.fn(),
    onCloseTerminalTab: vi.fn(),
    onSplitPane: vi.fn(),
    onToggleRightTool: vi.fn(),
  };
}

function binding(actionId: string, accelerator: string): ShortcutBinding {
  return {
    action_id: actionId,
    accelerator,
    scope: "app",
  };
}

function dispatchKey({
  key,
  ctrlKey = false,
  shiftKey = false,
  altKey = false,
  metaKey = false,
  target = window,
}: {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target?: Window | HTMLElement;
}) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function keydownCallCount(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter((call: unknown[]) => call[0] === "keydown").length;
}
