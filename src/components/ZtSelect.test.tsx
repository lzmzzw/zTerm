// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZtSelect } from "./ZtSelect";

interface TestZtSelectOption {
  value: string;
  label: string;
  description?: string;
}

const cleanupFns: Array<() => void> = [];

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  const view = {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  cleanupFns.push(view.unmount);
  return view;
}

function trigger(label = "选择主机") {
  const match = document.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Trigger not found: ${label}`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function keyDown(element: HTMLElement, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
  });
}

function input(label: string) {
  const match = document.querySelector(`[aria-label="${label}"]`);
  if (!match) throw new Error(`Input not found: ${label}`);
  return match as HTMLInputElement;
}

function changeInput(element: HTMLInputElement, value: string) {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function options(count = 8): TestZtSelectOption[] {
  return Array.from({ length: count }, (_, index) => ({
    value: `host-${index + 1}`,
    label: `host-${index + 1}`,
    description: index === 4 ? "production gateway" : undefined,
  }));
}

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
  document.body.innerHTML = "";
});

describe("ZtSelect", () => {
  it("renders placeholder and selected label", () => {
    const view = render(
      <ZtSelect ariaLabel="选择主机" value="" placeholder="请选择 SSH 主机" options={options(2)} onChange={vi.fn()} />,
    );

    expect(trigger().textContent).toContain("请选择 SSH 主机");

    view.unmount();

    render(<ZtSelect ariaLabel="选择主机" value="host-2" placeholder="请选择 SSH 主机" options={options(2)} onChange={vi.fn()} />);

    expect(trigger().textContent).toContain("host-2");
  });

  it("opens, closes on outside click, and emits selected value", async () => {
    const onChange = vi.fn();
    render(<ZtSelect ariaLabel="选择主机" value="" placeholder="请选择 SSH 主机" options={options(3)} onChange={onChange} />);

    await click(trigger());

    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("host-2");

    await click(document.querySelector('[role="option"][data-value="host-2"]') as HTMLElement);

    expect(onChange).toHaveBeenCalledWith("host-2");
    expect(document.querySelector('[role="listbox"]')).toBeNull();

    await click(trigger());
    await click(document.body);

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("does not open when disabled", async () => {
    render(
      <ZtSelect
        ariaLabel="选择主机"
        value="host-1"
        placeholder="请选择 SSH 主机"
        options={options(2)}
        onChange={vi.fn()}
        disabled
      />,
    );

    await click(trigger());

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("only shows search for searchable lists with more than six options", async () => {
    const shortView = render(
      <ZtSelect ariaLabel="选择主机" value="" placeholder="请选择 SSH 主机" options={options(6)} searchable onChange={vi.fn()} />,
    );

    await click(trigger());

    expect(document.querySelector('[aria-label="搜索选择项"]')).toBeNull();
    shortView.unmount();
    document.body.innerHTML = "";

    render(<ZtSelect ariaLabel="选择主机" value="" placeholder="请选择 SSH 主机" options={options(7)} searchable onChange={vi.fn()} />);

    await click(trigger());

    expect(input("搜索选择项")).toBeTruthy();
  });

  it("reserves space for search and makes a long option list scrollable", async () => {
    render(<ZtSelect ariaLabel="选择终端 Profile" value="" options={options(12)} searchable onChange={vi.fn()} />);

    await click(trigger("选择终端 Profile"));

    const list = document.querySelector<HTMLElement>(".zt-select-list");
    const popover = document.querySelector<HTMLElement>(".zt-select-popover");
    expect(list).toBeTruthy();
    expect(popover?.style.maxHeight).toBe("280px");
    expect(popover?.style.getPropertyValue("--zt-select-list-max-height")).toBe("229px");
  });

  it("filters by label and description while preserving empty state", async () => {
    render(<ZtSelect ariaLabel="选择主机" value="" placeholder="请选择 SSH 主机" options={options(8)} searchable onChange={vi.fn()} />);

    await click(trigger());
    changeInput(input("搜索选择项"), "production");

    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("host-5");
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain("host-1");

    changeInput(input("搜索选择项"), "missing");

    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("没有匹配项");
  });

  it("supports keyboard open, navigation, selection, and escape close", async () => {
    const onChange = vi.fn();
    render(<ZtSelect ariaLabel="选择主机" value="" placeholder="请选择 SSH 主机" options={options(3)} onChange={onChange} />);

    trigger().focus();
    await keyDown(trigger(), "Enter");
    await keyDown(trigger(), "ArrowDown");
    await keyDown(trigger(), "Enter");

    expect(onChange).toHaveBeenCalledWith("host-2");

    await click(trigger());
    await keyDown(trigger(), "Escape");

    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("keeps spaces and IME confirmation in the search input without selecting an option", async () => {
    const onChange = vi.fn();
    render(<ZtSelect ariaLabel="选择主机" value="" options={options()} searchable onChange={onChange} />);
    await click(trigger());
    const search = input("搜索选择项");
    changeInput(search, "production");

    for (const init of [
      { key: " " },
      { key: "Enter", isComposing: true },
      { key: "Enter", keyCode: 229 },
      { key: "ArrowDown", isComposing: true },
    ]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      await act(async () => { search.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(false);
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    }

    changeInput(search, "production gateway");
    expect(document.querySelector('[role="listbox"]')?.textContent).toContain("host-5");
    await keyDown(search, "Enter");
    expect(onChange).toHaveBeenCalledWith("host-5");
  });

  it("renders tree groups and skips them during keyboard selection", async () => {
    const onChange = vi.fn();
    const onToggle = vi.fn();
    render(
      <ZtSelect
        ariaLabel="选择端点"
        value="local"
        tree
        options={[
          { value: "local", label: "本机", depth: 0 },
          { value: "group:prod", label: "生产环境", kind: "group", collapsed: false, depth: 0, onToggle },
          { value: "ssh:prod", label: "生产 SSH", depth: 1 },
        ]}
        onChange={onChange}
      />,
    );

    await keyDown(trigger("选择端点"), "Enter");
    expect(document.querySelector(".zt-select-tree-group")?.textContent).toBe("生产环境");
    await click(document.querySelector(".zt-select-tree-group") as HTMLElement);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    await keyDown(trigger("选择端点"), "ArrowDown");
    await keyDown(trigger("选择端点"), "Enter");

    expect(onChange).toHaveBeenCalledWith("ssh:prod");
  });
});
