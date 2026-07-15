// Author: Liz
import { act, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileEntry, TransferTask } from "./fileStore";
import { useFileTransferStore } from "./fileTransferStore";
import { useSessionStore } from "../sessions/sessionStore";
import type { SavedSession, SessionGroup } from "../sessions/types";

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn(async () => vi.fn()));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import { FileTransferPanel } from "./FileTransferPanel";

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

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function pointerDragBetween(source: HTMLElement, destination: HTMLElement) {
  const originalElementFromPoint = document.elementFromPoint;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => destination),
  });
  try {
    await act(async () => {
      source.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }), { pointerId: 1 }));
      source.dispatchEvent(Object.assign(new MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 30, clientY: 30 }), { pointerId: 1 }));
      await Promise.resolve();
    });
    const preview = document.body.querySelector(".zt-file-transfer-drag-preview") as HTMLElement | null;
    await act(async () => {
      source.dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 30, clientY: 30 }), { pointerId: 1 }));
      await Promise.resolve();
    });
    return preview;
  } finally {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
  }
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function fileEntry(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    name: path.split(/[\\/]/).pop() ?? path,
    path,
    kind: "file",
    size: 10,
    modified_at_ms: null,
    permissions: null,
    ...overrides,
  };
}

function transferTask(): TransferTask {
  return {
    id: "task-1",
    saved_session_id: "ssh-1",
    direction: "upload",
    local_path: "C:/Users/Ops/bundle.zip",
    remote_path: "/bundle.zip",
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 10,
    transferred_bytes: 0,
    status: "queued",
    error_message: null,
    created_at_ms: 1,
    updated_at_ms: 2,
    task_origin: "file_transfer",
    source_endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
    destination_endpoint: { kind: "saved_session", saved_session_id: "ssh-1", path: "/bundle.zip" },
  };
}

function sshSession(): SavedSession {
  return {
    id: "ssh-1",
    name: "Prod SSH",
    type: "ssh",
    group_id: null,
    host: "prod.example.test",
    port: 22,
    username: "ops",
    auth_mode: "password",
    credential_ref: "cred-1",
    description: null,
    tags: [],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 2,
    last_used_at_ms: null,
    ssh_options: null,
    rdp_options: null,
    local_options: null,
  };
}

function sessionGroup(overrides: Partial<SessionGroup>): SessionGroup {
  return {
    id: overrides.id ?? "group",
    parent_id: overrides.parent_id ?? null,
    name: overrides.name ?? "Group",
    expanded: true,
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  };
}

describe("FileTransferPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockImplementation(async () => vi.fn());
    useSessionStore.setState({
      groups: [],
      sessions: [],
      loading: false,
      error: null,
    });
    useFileTransferStore.setState({
      left: {
        endpoint: { kind: "local", saved_session_id: null, path: "" },
        entries: [],
        selectedPaths: [],
        selectionAnchorPath: null,
        loading: false,
        error: null,
      },
      right: {
        endpoint: { kind: "saved_session", saved_session_id: null, path: "/" },
        entries: [],
        selectedPaths: [],
        selectionAnchorPath: null,
        loading: false,
        error: null,
      },
      transfers: [],
      transferLoading: false,
      transferError: null,
      conflictPolicy: "overwrite",
      defaultLocalPath: "",
      localRoots: [],
    });
  });

  it("does not render a manual transfer task refresh button", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    expect(view.container.querySelector('[aria-label="刷新文件传输任务"]')).toBeNull();

    view.unmount();
  });

  it("selects all visible files in the focused transfer list with ctrl+a", async () => {
    const leftEntries = [fileEntry("C:/Users/Ops/a.txt"), fileEntry("C:/Users/Ops/b.txt")];
    useFileTransferStore.setState((state) => ({
      left: { ...state.left, endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops" }, entries: leftEntries },
    }));
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list") return Promise.resolve([]);
      if (command === "file_transfer_list_endpoint") return Promise.resolve(leftEntries);
      throw new Error(`unexpected invoke: ${command}`);
    });
    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();
    const list = view.container.querySelector('[aria-label="左侧文件列表"]') as HTMLElement;
    const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });

    await act(async () => {
      list.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(useFileTransferStore.getState().left.selectedPaths).toEqual(leftEntries.map((entry) => entry.path));
    view.unmount();
  });

  it("renders transfer failures as an inline dialog alert without the global terminal overlay style", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    act(() => useFileTransferStore.setState({ transferError: "文件传输操作失败" }));

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("文件传输操作失败");
    expect(alert?.classList.contains("zt-file-transfer-error")).toBe(true);
    expect(alert?.classList.contains("zt-terminal-error")).toBe(false);

    view.unmount();
  });

  it("renames and deletes a local endpoint entry from its context menu", async () => {
    const localFile = fileEntry("C:/Users/Ops/bundle.zip");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list") return Promise.resolve([]);
      if (command === "file_transfer_list_endpoint") {
        const endpoint = args?.endpoint as { kind: string };
        return Promise.resolve(endpoint.kind === "local" ? [localFile] : []);
      }
      if (command === "file_transfer_rename_endpoint" || command === "file_transfer_delete_endpoint") {
        return Promise.resolve({ renamed: true, deleted: true });
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();
    const row = Array.from(view.container.querySelectorAll('button[role="listitem"]')).find((item) =>
      item.textContent?.includes("bundle.zip"),
    ) as HTMLButtonElement;

    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    });
    expect(document.body.querySelector('[role="menu"] svg')).toBeNull();
    await click(button(document.body, "重命名"));
    const renameInput = document.body.querySelector('[aria-label="重命名为"]') as HTMLInputElement;
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(renameInput, "release.zip");
      renameInput.dispatchEvent(new Event("input", { bubbles: true }));
      renameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(button(document.body, "确认重命名"));
    await flushEffects();
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_rename_endpoint", {
      endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
      to: "C:/Users/Ops/release.zip",
    });

    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    });
    await click(button(document.body, "删除"));
    await click(button(document.body, "确认删除"));
    await flushEffects();
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_delete_endpoint", {
      endpoint: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
      recursive: false,
    });

    view.unmount();
  });

  it("uses the selected SSH endpoint for context-menu file operations", async () => {
    const remoteFile = fileEntry("/var/log/app.log");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list") return Promise.resolve([]);
      if (command === "file_transfer_list_endpoint") {
        const endpoint = args?.endpoint as { kind: string };
        return Promise.resolve(endpoint.kind === "saved_session" ? [remoteFile] : []);
      }
      if (command === "file_transfer_rename_endpoint" || command === "file_transfer_delete_endpoint") {
        return Promise.resolve({ renamed: true, deleted: true });
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();
    const row = Array.from(view.container.querySelectorAll('button[role="listitem"]')).find((item) =>
      item.textContent?.includes("app.log"),
    ) as HTMLButtonElement;
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
    });
    await click(button(document.body, "删除"));
    await click(button(document.body, "确认删除"));
    await flushEffects();

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_delete_endpoint", {
      endpoint: { kind: "saved_session", saved_session_id: "ssh-1", path: "/var/log/app.log" },
      recursive: false,
    });

    view.unmount();
  });

  it("selects an SSH endpoint and enqueues the selected local file to the remote side", async () => {
    const localFile = fileEntry("C:/Users/Ops/bundle.zip");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") {
        return Promise.resolve(["C:\\", "D:\\"]);
      }
      if (command === "sessions_list") {
        return Promise.resolve({ groups: [], sessions: [sshSession()] });
      }
      if (command === "file_transfer_default_local_path") {
        return Promise.resolve("C:/Users/Ops");
      }
      if (command === "file_transfer_list") {
        return Promise.resolve([]);
      }
      if (command === "file_transfer_list_endpoint") {
        const endpoint = args?.endpoint as { kind: string; path: string };
        if (endpoint.kind === "local") {
          return Promise.resolve([localFile]);
        }
        return Promise.resolve([]);
      }
      if (command === "file_transfer_check_conflicts") {
        return Promise.resolve([]);
      }
      if (command === "file_transfer_enqueue") {
        return Promise.resolve(transferTask());
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    expect((view.container.querySelector('[aria-label="右侧端点"]') as HTMLSelectElement).value).toBe("session:ssh-1");
    expect(view.container.textContent).toContain("bundle.zip");

    const row = Array.from(view.container.querySelectorAll('button[role="listitem"]')).find((item) =>
      item.textContent?.includes("bundle.zip"),
    );
    expect(row).toBeTruthy();
    await click(row as HTMLElement);
    await click(button(view.container, "传输到右侧"));

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_check_conflicts", {
      items: [{ destination: { kind: "saved_session", saved_session_id: "ssh-1", path: "/bundle.zip" }, kind: "file" }],
    });
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_enqueue", {
      source: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
      destination: { kind: "saved_session", saved_session_id: "ssh-1", path: "/bundle.zip" },
      kind: "file",
      conflictPolicy: "overwrite",
    });

    view.unmount();
  });

  it("shows an ordered SSH-only connection tree and removes empty groups from endpoint selectors", async () => {
    const baseSsh = sshSession();
    const groups = [
      sessionGroup({ id: "parent", name: "Parent" }),
      sessionGroup({ id: "ssh-group", parent_id: "parent", name: "SSH Group" }),
      sessionGroup({ id: "rdp-group", name: "RDP Only" }),
    ];
    const sessions = [
      { ...baseSsh, id: "ssh-198", name: "z-host-172.16.40.198", group_id: "ssh-group" },
      { ...baseSsh, id: "ssh-20", name: "a-host-172.16.40.20", group_id: "ssh-group" },
      { ...baseSsh, id: "rdp", name: "RDP Connection", group_id: "rdp-group", type: "rdp" as const },
    ];
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups, sessions });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();
    await click(view.container.querySelector('[aria-label="右侧端点"]') as HTMLElement);

    expect(Array.from(document.body.querySelectorAll(".zt-select-tree-row")).map((node) => node.textContent)).toEqual([
      "本机",
      "Parent",
      "SSH Group",
      "a-host-172.16.40.20",
      "z-host-172.16.40.198",
    ]);
    expect(document.body.textContent).not.toContain("RDP Only");
    expect(document.body.textContent).not.toContain("RDP Connection");

    await click(document.body.querySelector('[aria-label="折叠分组 Parent"]') as HTMLElement);
    expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain("Parent");
    expect(document.body.querySelector('[role="listbox"]')?.textContent).not.toContain("SSH Group");
    expect(document.body.querySelector('[role="listbox"]')?.textContent).not.toContain("a-host-172.16.40.20");
    expect(view.container.querySelector('[aria-label="右侧端点"]')?.textContent).toContain("a-host-172.16.40.20");
    await click(document.body.querySelector('[aria-label="展开分组 Parent"]') as HTMLElement);
    expect(document.body.textContent).toContain("SSH Group");
    expect(document.body.textContent).toContain("a-host-172.16.40.20");

    view.unmount();
  });

  it("enqueues a transfer when a file is dragged from the left endpoint to the right endpoint", async () => {
    const localFile = fileEntry("C:/Users/Ops/bundle.zip");
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") {
        return Promise.resolve(["C:\\", "D:\\"]);
      }
      if (command === "sessions_list") {
        return Promise.resolve({ groups: [], sessions: [sshSession()] });
      }
      if (command === "file_transfer_default_local_path") {
        return Promise.resolve("C:/Users/Ops");
      }
      if (command === "file_transfer_list") {
        return Promise.resolve([]);
      }
      if (command === "file_transfer_list_endpoint") {
        const endpoint = args?.endpoint as { kind: string; path: string };
        if (endpoint.kind === "local") {
          return Promise.resolve([localFile]);
        }
        return Promise.resolve([]);
      }
      if (command === "file_transfer_check_conflicts") {
        return Promise.resolve([]);
      }
      if (command === "file_transfer_enqueue") {
        return Promise.resolve(transferTask());
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    const row = Array.from(view.container.querySelectorAll('button[role="listitem"]')).find((item) =>
      item.textContent?.includes("bundle.zip"),
    );
    const destinationPane = view.container.querySelector('[aria-label="右侧文件列表"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(destinationPane).toBeTruthy();
    expect(row?.getAttribute("draggable")).toBeNull();
    expect(row?.getAttribute("data-transfer-draggable")).toBe("true");

    const preview = await pointerDragBetween(row as HTMLElement, destinationPane);

    expect(preview?.textContent).toContain("bundle.zip");
    expect(preview?.querySelector(".zt-file-transfer-drag-preview-icon svg")).toBeTruthy();
    expect(document.body.querySelector(".zt-file-transfer-drag-preview")).toBeNull();

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_check_conflicts", {
      items: [{ destination: { kind: "saved_session", saved_session_id: "ssh-1", path: "/bundle.zip" }, kind: "file" }],
    });
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_enqueue", {
      source: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
      destination: { kind: "saved_session", saved_session_id: "ssh-1", path: "/bundle.zip" },
      kind: "file",
      conflictPolicy: "overwrite",
    });

    view.unmount();
  });

  it("switches a local endpoint to a selected Windows drive root", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") {
        return Promise.resolve(["C:\\", "D:\\"]);
      }
      if (command === "sessions_list") {
        return Promise.resolve({ groups: [], sessions: [sshSession()] });
      }
      if (command === "file_transfer_default_local_path") {
        return Promise.resolve("C:/Users/Ops");
      }
      if (command === "file_transfer_list") {
        return Promise.resolve([]);
      }
      if (command === "file_transfer_list_endpoint") {
        return Promise.resolve([]);
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    const leftPathBar = view.container.querySelector('[aria-label="左侧文件端点"] .zt-file-transfer-path') as HTMLElement;
    expect(leftPathBar.firstElementChild?.getAttribute("aria-label")).toBe("左侧本地磁盘");
    expect(leftPathBar.children[1]?.getAttribute("aria-label")).toBe("左侧路径");

    await click(button(view.container, "左侧本地磁盘"));
    const driveOption = Array.from(document.querySelectorAll('[role="option"]')).find(
      (option) => option.getAttribute("data-value") === "D:\\",
    ) as HTMLElement | undefined;
    expect(driveOption).toBeTruthy();
    await click(driveOption as HTMLElement);
    await flushEffects();

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_list_endpoint", {
      endpoint: { kind: "local", saved_session_id: null, path: "D:\\" },
    });

    view.unmount();
  });

  it("keeps the Windows drive selected when navigating to its root", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\", "D:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    act(() => useFileTransferStore.getState().setPath("left", "D:\\bundle"));

    expect(button(view.container, "左侧本地磁盘").textContent).toContain("D:\\");
    await click(button(view.container, "左侧返回上级"));
    await flushEffects();

    expect(button(view.container, "左侧本地磁盘").textContent).toContain("D:\\");
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_list_endpoint", {
      endpoint: { kind: "local", saved_session_id: null, path: "D:\\" },
    });

    view.unmount();
  });

  it("uses the full endpoint header for the connection selector without visible side labels", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    const headers = view.container.querySelectorAll(".zt-file-transfer-pane-header");
    expect(headers).toHaveLength(2);
    headers.forEach((header) => expect(header.querySelector("strong")).toBeNull());
    expect((headers[0].firstElementChild as HTMLElement).getAttribute("aria-label")).toBe("左侧端点");
    expect((headers[1].firstElementChild as HTMLElement).getAttribute("aria-label")).toBe("右侧端点");

    view.unmount();
  });

  it("shows sortable file columns and toggles each column between ascending and descending", async () => {
    const entries = [
      fileEntry("C:/Users/Ops/zeta.zip", { size: 20, modified_at_ms: 200 }),
      fileEntry("C:/Users/Ops/alpha.zip", { size: 30, modified_at_ms: 100 }),
      fileEntry("C:/Users/Ops/middle.zip", { size: 10, modified_at_ms: 300 }),
    ];
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list") return Promise.resolve([]);
      if (command === "file_transfer_list_endpoint") {
        return Promise.resolve((args?.endpoint as { kind: string }).kind === "local" ? entries : []);
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();
    const leftPane = view.container.querySelector('[aria-label="左侧文件端点"]') as HTMLElement;
    const rowNames = () => Array.from(leftPane.querySelectorAll('button[role="listitem"] strong')).map((item) => item.textContent);

    expect(leftPane.querySelector(".zt-file-transfer-list-header")?.textContent).toContain("文件名文件大小最近修改");
    await click(button(leftPane, "按文件名升序排列"));
    expect(rowNames()).toEqual(["alpha.zip", "middle.zip", "zeta.zip"]);
    await click(button(leftPane, "按文件名降序排列"));
    expect(rowNames()).toEqual(["zeta.zip", "middle.zip", "alpha.zip"]);
    await click(button(leftPane, "按文件大小升序排列"));
    expect(rowNames()).toEqual(["middle.zip", "zeta.zip", "alpha.zip"]);
    await click(button(leftPane, "按文件大小降序排列"));
    expect(rowNames()).toEqual(["alpha.zip", "zeta.zip", "middle.zip"]);
    await click(button(leftPane, "按最近修改升序排列"));
    expect(rowNames()).toEqual(["alpha.zip", "zeta.zip", "middle.zip"]);
    await click(button(leftPane, "按最近修改降序排列"));
    expect(rowNames()).toEqual(["middle.zip", "zeta.zip", "alpha.zip"]);

    view.unmount();
  });

  it("resizes file columns for only the current endpoint without persisting the ratio", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();
    const leftPane = view.container.querySelector('[aria-label="左侧文件端点"]') as HTMLElement;
    const rightPane = view.container.querySelector('[aria-label="右侧文件端点"]') as HTMLElement;
    const leftHeader = leftPane.querySelector(".zt-file-transfer-list-header") as HTMLElement;
    const resizeHandle = button(leftPane, "调整文件名和文件大小列宽");
    Object.defineProperty(leftHeader, "clientWidth", { configurable: true, value: 400 });

    await act(async () => {
      resizeHandle.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }), { pointerId: 2 }));
      resizeHandle.dispatchEvent(Object.assign(new MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: 108 }), { pointerId: 2 }));
      resizeHandle.dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true, button: 0, clientX: 108 }), { pointerId: 2 }));
    });

    expect(leftPane.style.getPropertyValue("--zt-file-name-fr")).toBe("72fr");
    expect(leftPane.style.getPropertyValue("--zt-file-size-fr")).toBe("13fr");
    expect(rightPane.style.getPropertyValue("--zt-file-name-fr")).toBe("70fr");
    expect(rightPane.style.getPropertyValue("--zt-file-size-fr")).toBe("15fr");

    view.unmount();

    const reopenedView = render(<FileTransferPanel />);
    await flushEffects();
    const reopenedLeftPane = reopenedView.container.querySelector('[aria-label="左侧文件端点"]') as HTMLElement;
    expect(reopenedLeftPane.style.getPropertyValue("--zt-file-name-fr")).toBe("70fr");
    expect(reopenedLeftPane.style.getPropertyValue("--zt-file-size-fr")).toBe("15fr");
    expect(reopenedLeftPane.style.getPropertyValue("--zt-file-modified-fr")).toBe("15fr");
    reopenedView.unmount();
  });

  it("starts with the transfer task dock collapsed", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list" || command === "file_transfer_list_endpoint" || command === "file_transfer_list_tasks") {
        return Promise.resolve([]);
      }
      throw new Error(`unexpected invoke: ${command}`);
    });

    const view = render(<FileTransferPanel />);
    await flushEffects();
    await flushEffects();

    expect(button(view.container, "展开传输任务")).toBeTruthy();
    expect(view.container.querySelector('[aria-label="传输任务列表"]')).toBeNull();

    view.unmount();
  });

  it("loads the initial SSH endpoint only once in StrictMode", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "file_transfer_local_roots") return Promise.resolve(["C:\\"]);
      if (command === "sessions_list") return Promise.resolve({ groups: [], sessions: [sshSession()] });
      if (command === "file_transfer_default_local_path") return Promise.resolve("C:/Users/Ops");
      if (command === "file_transfer_list") return Promise.resolve([]);
      if (command === "file_transfer_list_endpoint") return Promise.resolve([]);
      throw new Error(`unexpected invoke: ${command} (${JSON.stringify(args)})`);
    });

    const view = render(
      <StrictMode>
        <FileTransferPanel />
      </StrictMode>,
    );
    await flushEffects();
    await flushEffects();

    const initialSshLoads = invokeMock.mock.calls.filter(
      ([command, args]) => command === "file_transfer_list_endpoint" && (args as { endpoint: { kind: string } }).endpoint.kind === "saved_session",
    );
    expect(initialSshLoads).toHaveLength(1);

    view.unmount();
  });
});
