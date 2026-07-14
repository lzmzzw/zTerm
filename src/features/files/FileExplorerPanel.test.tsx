// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { FileExplorerPanel } from "./FileExplorerPanel";
import type { FileEntry } from "./fileStore";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn(async () => vi.fn()),
  }),
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
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const entries: FileEntry[] = [
  {
    name: "logs",
    path: "/home/ops/logs",
    kind: "directory",
    size: 0,
    modified_at_ms: 10,
    permissions: "755",
  },
  {
    name: "deploy.sh",
    path: "/home/ops/deploy.sh",
    kind: "file",
    size: 42,
    modified_at_ms: 20,
    permissions: "644",
  },
  {
    name: "design.png",
    path: "/home/ops/design.png",
    kind: "file",
    size: 1024,
    modified_at_ms: 30,
    permissions: "644",
  },
  {
    name: ".env",
    path: "/home/ops/.env",
    kind: "file",
    size: 12,
    modified_at_ms: 40,
    permissions: "600",
  },
];

describe("FileExplorerPanel", () => {
  it("renders path actions and dispatches file operations", async () => {
    const onRefresh = vi.fn();
    const onParent = vi.fn();
    const onMkdir = vi.fn();
    const onUpload = vi.fn();
    const onDownload = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <FileExplorerPanel
        savedSessionId="session-1"
        path="/home/ops"
        entries={entries}
        selectedPaths={["/home/ops/deploy.sh"]}
        loading={false}
        error={null}
        onPathChange={vi.fn()}
        onSelect={vi.fn()}
        onRefresh={onRefresh}
        onParent={onParent}
        onMkdir={onMkdir}
        onUpload={onUpload}
        onUploadDropped={vi.fn()}
        onDownload={onDownload}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );

    await click(button(view.container, "刷新文件列表"));
    await click(button(view.container, "上级目录"));
    await click(button(view.container, "新建文件夹"));
    await click(button(view.container, "上传"));
    await click(button(view.container, "下载"));
    await click(button(view.container, "重命名"));
    await click(button(view.container, "删除"));

    const pathControl = view.container.querySelector(".zt-file-path");
    const pathInput = pathControl?.querySelector("input");
    expect(pathControl?.querySelector("span")).toBeNull();
    expect(pathInput?.value).toBe("/home/ops");
    expect(view.container.textContent).toContain("deploy.sh");
    expect(onRefresh).toHaveBeenCalled();
    expect(onParent).toHaveBeenCalled();
    expect(onMkdir).toHaveBeenCalled();
    expect(onUpload).toHaveBeenCalledWith();
    expect(onDownload).toHaveBeenCalledWith([entries[1]]);
    expect(onRename).toHaveBeenCalledWith("/home/ops/deploy.sh");
    expect(onDelete).toHaveBeenCalledWith(["/home/ops/deploy.sh"], false);

    view.unmount();
  });

  it("offers rename and delete for the row opened by context menu", async () => {
    const onSelect = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <FileExplorerPanel
        savedSessionId="session-1"
        path="/home/ops"
        entries={entries}
        selectedPaths={[]}
        loading={false}
        error={null}
        onPathChange={vi.fn()}
        onSelect={onSelect}
        onRefresh={vi.fn()}
        onParent={vi.fn()}
        onMkdir={vi.fn()}
        onUpload={vi.fn()}
        onUploadDropped={vi.fn()}
        onDownload={vi.fn()}
        onRename={onRename}
        onDelete={onDelete}
      />,
    );

    const row = Array.from(view.container.querySelectorAll("button[role='listitem']")).find((item) =>
      item.textContent?.includes("deploy.sh"),
    ) as HTMLButtonElement;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    });

    expect(onSelect).toHaveBeenCalledWith("/home/ops/deploy.sh", undefined, entries.filter((entry) => !entry.name.startsWith(".")));
    expect(view.container.querySelector('[role="menu"] svg')).toBeNull();
    await click(Array.from(view.container.querySelectorAll('[role="menu"] button')).find((item) => item.textContent?.trim() === "重命名") as HTMLElement);
    expect(onRename).toHaveBeenCalledWith("/home/ops/deploy.sh");

    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    });
    await click(view.container.querySelector('[role="menu"] .zt-delete-button') as HTMLElement);
    expect(onDelete).toHaveBeenCalledWith(["/home/ops/deploy.sh"], false);

    view.unmount();
  });

  it("renders directory and extension-specific file icons", () => {
    const view = render(
      <FileExplorerPanel
        savedSessionId="session-1"
        path="/home/ops"
        entries={entries}
        selectedPaths={[]}
        loading={false}
        error={null}
        onPathChange={vi.fn()}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onParent={vi.fn()}
        onMkdir={vi.fn()}
        onUpload={vi.fn()}
        onUploadDropped={vi.fn()}
        onDownload={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const rows = view.container.querySelectorAll("button[role='listitem']");
    expect(rows.length).toBe(entries.filter((entry) => !entry.name.startsWith(".")).length);
    expect(rows[0].querySelector(".lucide-folder-open")).not.toBeNull();
    expect(rows[1].querySelector(".lucide-file-code")).not.toBeNull();
    expect(rows[2].querySelector(".lucide-file-image")).not.toBeNull();

    view.unmount();
  });

  it("keeps file sizes capped at MB for compatibility", () => {
    const view = render(
      <FileExplorerPanel
        savedSessionId="session-1"
        path="/home/ops"
        entries={[
          {
            name: "large.dump",
            path: "/home/ops/large.dump",
            kind: "file",
            size: 1024 * 1024 * 1024,
            modified_at_ms: 50,
            permissions: "644",
          },
        ]}
        selectedPaths={[]}
        loading={false}
        error={null}
        onPathChange={vi.fn()}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onParent={vi.fn()}
        onMkdir={vi.fn()}
        onUpload={vi.fn()}
        onUploadDropped={vi.fn()}
        onDownload={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(view.container.textContent).toContain("1024.0 MB");

    view.unmount();
  });

  it("requires recursive confirmation before deleting a directory", async () => {
    const onDelete = vi.fn();
    const view = render(
      <FileExplorerPanel
        savedSessionId="session-1"
        path="/home/ops"
        entries={entries}
        selectedPaths={["/home/ops/logs"]}
        loading={false}
        error={null}
        onPathChange={vi.fn()}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onParent={vi.fn()}
        onMkdir={vi.fn()}
        onUpload={vi.fn()}
        onUploadDropped={vi.fn()}
        onDownload={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
      />,
    );

    await click(button(view.container, "删除"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain("确认删除选中的 1 个项目");

    await click(button(view.container, "确认删除"));
    expect(onDelete).toHaveBeenCalledWith(["/home/ops/logs"], true);

    view.unmount();
  });

  it("opens SFTP context actions and toggles hidden files", async () => {
    const onRefresh = vi.fn();
    const onMkdir = vi.fn();
    const onUpload = vi.fn();
    const view = render(
      <FileExplorerPanel
        savedSessionId="session-1"
        path="/home/ops"
        entries={entries}
        selectedPaths={[]}
        loading={false}
        error={null}
        onPathChange={vi.fn()}
        onSelect={vi.fn()}
        onRefresh={onRefresh}
        onParent={vi.fn()}
        onMkdir={onMkdir}
        onUpload={onUpload}
        onUploadDropped={vi.fn()}
        onDownload={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(view.container.textContent).not.toContain(".env");

    await act(async () => {
      view.container.querySelector(".zt-file-panel")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
      );
    });

    const menuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual(["上传", "新建目录", "刷新目录", "显示隐藏文件"]);

    await click(button(view.container, "显示隐藏文件"));
    expect(view.container.textContent).toContain(".env");

    await act(async () => {
      view.container.querySelector(".zt-file-panel")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
      );
    });
    await click(button(view.container, "上传"));
    await act(async () => {
      view.container.querySelector(".zt-file-panel")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
      );
    });
    await click(button(view.container, "新建目录"));
    await act(async () => {
      view.container.querySelector(".zt-file-panel")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
      );
    });
    await click(button(view.container, "刷新目录"));

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(onUpload).toHaveBeenCalledWith();
    expect(onMkdir).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    view.unmount();
  });
});
