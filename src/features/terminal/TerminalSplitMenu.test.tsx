// Author: Liz
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { TerminalSplitMenu } from "./TerminalSplitMenu";

function renderMenu(horizontal = true, vertical = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onSplit = vi.fn();
  const onClose = vi.fn();
  act(() => root.render(<TerminalSplitMenu x={100} y={20} availability={{ horizontal, vertical }} onSplit={onSplit} onClose={onClose} />));
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="终端分屏"] button'));
  return {
    buttons, onSplit, onClose,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("TerminalSplitMenu", () => {
  it("maps the two menu actions to the existing split directions", () => {
    const menu = renderMenu();
    expect(menu.buttons.map(button => button.textContent)).toEqual(["左右分屏", "上下分屏"]);
    act(() => menu.buttons[0].click());
    expect(menu.onSplit).toHaveBeenLastCalledWith("horizontal");
    act(() => menu.buttons[1].click());
    expect(menu.onSplit).toHaveBeenLastCalledWith("vertical");
    expect(menu.onClose).toHaveBeenCalledTimes(2);
    menu.unmount();
  });

  it("preserves direction limits and focuses the enabled action", () => {
    const menu = renderMenu(false, true);
    expect(menu.buttons[0].disabled).toBe(true);
    expect(menu.buttons[0].title).toContain("宽度小于页面的 1/4");
    expect(document.activeElement).toBe(menu.buttons[1]);
    act(() => menu.buttons[0].click());
    expect(menu.onSplit).not.toHaveBeenCalled();
    act(() => menu.buttons[1].click());
    expect(menu.onSplit).toHaveBeenCalledWith("vertical");
    menu.unmount();
  });

  it("supports arrow navigation, Escape and outside dismissal", () => {
    const menu = renderMenu();
    act(() => menu.buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(menu.buttons[1]);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(menu.onClose).toHaveBeenCalledTimes(1);
    act(() => document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(menu.onClose).toHaveBeenCalledTimes(2);
    menu.unmount();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(menu.onClose).toHaveBeenCalledTimes(2);
  });
});
