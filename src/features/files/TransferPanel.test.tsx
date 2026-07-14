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

async function mouseEvent(target: EventTarget, type: string, clientY: number) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY }));
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
  {
    id: "task-3",
    saved_session_id: "session-1",
    direction: "download",
    local_path: "C:/tmp/c.txt",
    remote_path: "/tmp/c.txt",
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 10,
    transferred_bytes: 5,
    status: "paused",
    error_message: null,
    created_at_ms: 5,
    updated_at_ms: 6,
  },
  {
    id: "task-4",
    saved_session_id: "session-1",
    direction: "upload",
    local_path: "C:/tmp/d.txt",
    remote_path: "/tmp/d.txt",
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 10,
    transferred_bytes: 10,
    status: "done",
    error_message: null,
    created_at_ms: 7,
    updated_at_ms: 8,
  },
];

describe("TransferPanel", () => {
  it("renders transfer progress failure details and task actions", async () => {
    const onRetry = vi.fn();
    const onPause = vi.fn();
    const onResume = vi.fn();
    const onCancel = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <TransferPanel
        tasks={tasks}
        onRetry={onRetry}
        onPause={onPause}
        onResume={onResume}
        onCancel={onCancel}
        onDelete={onDelete}
      />,
    );

    expect(view.container.textContent).toContain("40%");
    expect(view.container.textContent).toContain("permission denied");

    await click(button(view.container, "暂停 task-1"));
    expect(onPause).toHaveBeenCalledWith("task-1");

    await click(button(view.container, "恢复 task-3"));
    expect(onResume).toHaveBeenCalledWith("task-3");

    await click(button(view.container, "取消 task-1"));
    expect(onCancel).toHaveBeenCalledWith("task-1");

    await click(button(view.container, "重试 task-2"));
    expect(onRetry).toHaveBeenCalledWith("task-2");

    await click(button(view.container, "删除 task-4"));
    expect(onDelete).toHaveBeenCalledWith("task-4");

    view.unmount();
  });

  it("confirms before deleting an active transfer", async () => {
    const onDelete = vi.fn();
    const view = render(
      <TransferPanel
        tasks={[tasks[0]]}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={onDelete}
      />,
    );

    await click(button(view.container, "删除 task-1"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="dialog"][aria-label="删除传输任务"]')?.textContent).toContain(
      "删除运行中传输会先取消该任务",
    );

    await click(button(view.container, "取消"));
    expect(onDelete).not.toHaveBeenCalled();

    await click(button(view.container, "删除 task-1"));
    await click(button(view.container, "确认删除"));
    expect(onDelete).toHaveBeenCalledWith("task-1");

    view.unmount();
  });

  it("renders an empty transfer state", () => {
    const view = render(
      <TransferPanel tasks={[]} onRetry={vi.fn()} onPause={vi.fn()} onResume={vi.fn()} onCancel={vi.fn()} onDelete={vi.fn()} />,
    );

    expect(view.container.textContent).toContain("暂无传输任务");

    view.unmount();
  });

  it("prefers endpoint snapshot paths for file transfer tasks", () => {
    const view = render(
      <TransferPanel
        tasks={[
          {
            ...tasks[0],
            id: "task-remote-copy",
            task_origin: "file_transfer",
            source_endpoint: { kind: "ssh", saved_session_id: "source-ssh", path: "/var/app.log" },
            destination_endpoint: { kind: "ssh", saved_session_id: "destination-ssh", path: "/backup/app.log" },
          },
        ]}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(view.container.textContent).toContain("/var/app.log");
    expect(view.container.textContent).toContain("/backup/app.log");
    expect(view.container.textContent).not.toContain("C:/tmp/a.txt");

    view.unmount();
  });

  it("keeps the collapsible transfer dock expanded by default and collapses from its summary", async () => {
    const view = render(
      <TransferPanel
        collapsible
        tasks={tasks}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(button(view.container, "折叠传输任务")).toBeTruthy();
    expect(view.container.querySelector(".zt-transfer-dock-summary")).toBeTruthy();
    expect(view.container.querySelector('[aria-label="传输任务列表"]')).toBeTruthy();

    await click(button(view.container, "折叠传输任务"));

    expect(button(view.container, "展开传输任务")).toBeTruthy();
    expect(view.container.querySelector('[aria-label="传输任务列表"]')).toBeNull();

    view.unmount();
  });

  it("keeps the collapsed transfer dock summary across the full title bar", () => {
    const view = render(
      <TransferPanel
        collapsible
        defaultCollapsed
        tasks={tasks}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onPauseAll={vi.fn()}
      />,
    );

    expect(button(view.container, "展开传输任务")).toBeTruthy();
    expect(view.container.querySelector(".zt-transfer-dock-collapsed .zt-transfer-dock-actions")).toBeTruthy();
    expect(view.container.querySelector('[aria-label="传输任务列表"]')).toBeNull();

    view.unmount();
  });

  it("does not toggle the transfer dock when using a bulk action", async () => {
    const onPauseAll = vi.fn();
    const view = render(
      <TransferPanel
        collapsible
        tasks={tasks}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onPauseAll={onPauseAll}
      />,
    );

    await click(button(view.container, "暂停全部传输任务"));

    expect(onPauseAll).toHaveBeenCalledWith(["task-1"]);
    expect(view.container.querySelector('[aria-label="传输任务列表"]')).toBeTruthy();
    expect(button(view.container, "折叠传输任务")).toBeTruthy();

    view.unmount();
  });

  it("reports temporary dock resizing after the dock is expanded", async () => {
    const onCollapsedChange = vi.fn();
    const onResize = vi.fn();
    const view = render(
      <TransferPanel
        collapsible
        tasks={tasks}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onCollapsedChange={onCollapsedChange}
        onResize={onResize}
      />,
    );

    const resizer = view.container.querySelector('[role="separator"][aria-label="调整传输任务高度"]');
    expect(resizer).toBeTruthy();
    await mouseEvent(resizer as HTMLElement, "mousedown", 300);
    await mouseEvent(document, "mousemove", 260);
    await mouseEvent(document, "mouseup", 260);

    expect(onResize).toHaveBeenLastCalledWith(240);
    view.unmount();
  });

  it("runs collapsible transfer dock bulk actions", async () => {
    const onPauseAll = vi.fn();
    const onResumeAll = vi.fn();
    const onClearAll = vi.fn();
    const view = render(
      <TransferPanel
        collapsible
        tasks={tasks}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onPauseAll={onPauseAll}
        onResumeAll={onResumeAll}
        onClearAll={onClearAll}
      />,
    );

    await click(button(view.container, "暂停全部传输任务"));
    expect(onPauseAll).toHaveBeenCalledWith(["task-1"]);

    await click(button(view.container, "恢复全部传输任务"));
    expect(onResumeAll).toHaveBeenCalledWith(["task-3"]);

    await click(button(view.container, "清理全部传输任务"));
    expect(view.container.querySelector('[role="dialog"][aria-label="清理传输任务"]')?.textContent).toContain(
      "清理全部任务会取消进行中的传输并删除任务记录",
    );
    await click(button(view.container, "确认清理"));
    expect(onClearAll).toHaveBeenCalledWith(["task-1", "task-2", "task-3", "task-4"]);

    view.unmount();
  });

  it("does not clear all transfers when the bulk clear confirmation is rejected", async () => {
    const onClearAll = vi.fn();
    const view = render(
      <TransferPanel
        collapsible
        tasks={tasks}
        onRetry={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onCancel={vi.fn()}
        onDelete={vi.fn()}
        onClearAll={onClearAll}
      />,
    );

    await click(button(view.container, "清理全部传输任务"));
    await click(button(view.container, "取消"));

    expect(onClearAll).not.toHaveBeenCalled();

    view.unmount();
  });
});
