// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { TransferPanel } from "./TransferPanel";
import type { TransferTask } from "./fileStore";

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
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const tasks: TransferTask[] = [
  {
    id: "task-1",
    saved_session_id: "session-1",
    direction: "upload",
    local_path: "C:/tmp/a.txt",
    remote_path: "/tmp/a.txt",
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 100,
    transferred_bytes: 40,
    status: "running",
    error_message: null,
    created_at_ms: 1,
    updated_at_ms: 2,
  },
  {
    id: "task-2",
    saved_session_id: "session-1",
    direction: "download",
    local_path: "C:/tmp/b.txt",
    remote_path: "/tmp/b.txt",
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 0,
    transferred_bytes: 0,
    status: "failed",
    error_message: "permission denied",
    created_at_ms: 3,
    updated_at_ms: 4,
  },
];

describe("TransferPanel", () => {
  it("renders transfer progress failure details and retry action", async () => {
    const onRetry = vi.fn();
    const view = render(<TransferPanel tasks={tasks} onRetry={onRetry} />);

    expect(view.container.textContent).toContain("40%");
    expect(view.container.textContent).toContain("permission denied");

    await click(button(view.container, "重试 task-2"));
    expect(onRetry).toHaveBeenCalledWith("task-2");

    view.unmount();
  });

  it("renders an empty transfer state", () => {
    const view = render(<TransferPanel tasks={[]} onRetry={vi.fn()} />);

    expect(view.container.textContent).toContain("暂无传输任务");

    view.unmount();
  });
});
