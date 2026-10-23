// Author: Liz
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ZtNumberInput } from "./ZtNumberInput";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function render(options: { value?: number | null; min?: number; max?: number; step?: number; disabled?: boolean; clearable?: boolean } = {}) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  function Form() {
    const [value, setValue] = useState(options.value === undefined ? 13 : options.value);
    return <ZtNumberInput {...options} value={value} ariaLabel="数值" min={options.min ?? 11} max={options.max ?? 18}
      onChange={(next) => { onChange(next); setValue(next); }}
      onClear={options.clearable ? () => { onClear(); setValue(null); } : undefined} />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Form />));
  cleanups.push(() => { act(() => root.unmount()); container.remove(); });
  const input = container.querySelector("input")!;
  const buttons = Array.from(container.querySelectorAll("button"));
  return {
    input, buttons, onChange, onClear,
    type(text: string) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    key(key: string) { act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }); },
    blur() { act(() => { input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }); },
    click(index: number) { act(() => buttons[index].click()); },
  };
}

describe("ZtNumberInput", () => {
  it("allows clearing and typing a two-digit font size without clamping intermediate digits", () => {
    const view = render();
    view.type("");
    expect(view.input.value).toBe("");
    view.type("1");
    expect(view.input.value).toBe("1");
    expect(view.onChange).not.toHaveBeenCalled();
    view.type("16");
    view.blur();
    expect(view.input.value).toBe("16");
    expect(view.onChange).toHaveBeenCalledExactlyOnceWith(16);
  });

  it("clamps out-of-range values only when committed and restores invalid or empty input", () => {
    const view = render();
    view.type("99");
    expect(view.input.value).toBe("99");
    expect(view.onChange).not.toHaveBeenCalled();
    view.key("Enter");
    expect(view.input.value).toBe("18");
    view.type("1");
    view.blur();
    expect(view.input.value).toBe("11");
    for (const invalid of ["", "abc", "1.5", "1e2", "Infinity", "9007199254740992"]) {
      view.type(invalid);
      view.blur();
      expect(view.input.value).toBe("11");
    }
    view.type("17x");
    view.key("Escape");
    expect(view.input.value).toBe("11");
  });

  it("uses pending text for buttons and arrow keys, with limits and accessible controls", () => {
    const view = render();
    expect(view.buttons[0].getAttribute("aria-label")).toBe("数值 +");
    expect(view.buttons[1].getAttribute("aria-label")).toBe("数值 −");
    expect(view.buttons.every((button) => button.tabIndex === 0 && !button.hasAttribute("aria-hidden"))).toBe(true);
    view.type("15");
    view.click(0);
    expect(view.input.value).toBe("16");
    view.key("ArrowDown");
    expect(view.input.value).toBe("15");
    view.type("18");
    expect(view.buttons[0].disabled).toBe(true);
    view.key("ArrowUp");
    expect(view.input.value).toBe("18");
    view.type("11");
    expect(view.buttons[1].disabled).toBe(true);
  });

  it("preserves large steps, nullable ports and disabled fields", () => {
    const timeout = render({ value: 30000, min: 1000, max: 300000, step: 1000 });
    timeout.click(0);
    expect(timeout.input.value).toBe("31000");
    timeout.key("ArrowDown");
    expect(timeout.input.value).toBe("30000");
    const port = render({ value: 22, min: 1, max: 65535, clearable: true });
    port.type("");
    port.blur();
    expect(port.input.value).toBe("");
    expect(port.onClear).toHaveBeenCalledOnce();
    port.type("2222");
    expect(port.onChange).toHaveBeenCalledWith(2222);
    const disabled = render({ disabled: true });
    expect(disabled.input.disabled).toBe(true);
    expect(disabled.buttons.every((button) => button.disabled)).toBe(true);
    disabled.click(0);
    expect(disabled.onChange).not.toHaveBeenCalled();
  });
});
