// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { TerminalPlaceholder } from "./TerminalPlaceholder";

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

describe("TerminalPlaceholder", () => {
  it("describes RDP as an external window without a future-phase promise", () => {
    const view = render(<TerminalPlaceholder mode="rdp" message="172.16.40.198" />);

    expect(view.container.textContent).toContain("RDP 已在外部窗口中打开");
    expect(view.container.textContent).toContain("172.16.40.198");
    expect(view.container.textContent).not.toContain("第二阶段");
    view.unmount();
  });
});
