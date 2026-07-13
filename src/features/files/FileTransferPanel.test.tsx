// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileEntry, TransferTask } from "./fileStore";
import { useFileTransferStore } from "./fileTransferStore";
import { useSessionStore } from "../sessions/sessionStore";
import type { SavedSession } from "../sessions/types";

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

async function dragBetween(source: HTMLElement, destination: HTMLElement) {
  const dataTransfer = {
    dropEffect: "copy",
    effectAllowed: "copy",
    getData: vi.fn(() => ""),
    setData: vi.fn(),
  };
  await act(async () => {
    source.dispatchEvent(Object.assign(new Event("dragstart", { bubbles: true }), { dataTransfer }));
    destination.dispatchEvent(Object.assign(new Event("dragover", { bubbles: true, cancelable: true }), { dataTransfer }));
    destination.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer }));
    await Promise.resolve();
  });
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

function fileEntry(path: string): FileEntry {
  return {
    name: path.split(/[\\/]/).pop() ?? path,
    path,
    kind: "file",
    size: 10,
    modified_at_ms: null,
    permissions: null,
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
    destination_endpoint: { kind: "ssh", saved_session_id: "ssh-1", path: "/bundle.zip" },
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
        endpoint: { kind: "ssh", saved_session_id: null, path: "/" },
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

    expect((view.container.querySelector('[aria-label="右侧端点"]') as HTMLSelectElement).value).toBe("ssh:ssh-1");
    expect(view.container.textContent).toContain("bundle.zip");

    const row = Array.from(view.container.querySelectorAll('button[role="listitem"]')).find((item) =>
      item.textContent?.includes("bundle.zip"),
    );
    expect(row).toBeTruthy();
    await click(row as HTMLElement);
    await click(button(view.container, "传输到右侧"));

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_check_conflicts", {
      items: [{ destination: { kind: "ssh", saved_session_id: "ssh-1", path: "/bundle.zip" }, kind: "file" }],
    });
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_enqueue", {
      source: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
      destination: { kind: "ssh", saved_session_id: "ssh-1", path: "/bundle.zip" },
      kind: "file",
      conflictPolicy: "overwrite",
    });

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
    const destinationPane = view.container.querySelector('[aria-label="右侧文件端点"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(destinationPane).toBeTruthy();

    await dragBetween(row as HTMLElement, destinationPane);

    expect(invokeMock).toHaveBeenCalledWith("file_transfer_check_conflicts", {
      items: [{ destination: { kind: "ssh", saved_session_id: "ssh-1", path: "/bundle.zip" }, kind: "file" }],
    });
    expect(invokeMock).toHaveBeenCalledWith("file_transfer_enqueue", {
      source: { kind: "local", saved_session_id: null, path: "C:/Users/Ops/bundle.zip" },
      destination: { kind: "ssh", saved_session_id: "ssh-1", path: "/bundle.zip" },
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
});
