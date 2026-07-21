// Author: Liz
import { describe, expect, it, vi } from "vitest";

import { createRemoteFileActions } from "./remoteFileActions";
import type { LocalPathInfo } from "../features/files/fileStore";

describe("remoteFileActions", () => {
  it("opens the parent directory and refreshes it for the active SSH session", async () => {
    const deps = dependencies({ filePath: "/home/ops/logs" });
    const actions = createRemoteFileActions(deps);

    await actions.openParentDirectory();

    expect(deps.setFilePath).toHaveBeenCalledWith("/home/ops");
    expect(deps.listFiles).toHaveBeenCalledWith("session-1", "/home/ops");
  });

  it("prompts for a new directory path before creating it", async () => {
    const deps = dependencies({
      filePath: "/home/ops",
      textInputResults: ["/home/ops/new-folder"],
    });
    const actions = createRemoteFileActions(deps);

    await actions.createRemoteDirectory();

    expect(deps.requestTextInput).toHaveBeenCalledWith({
      title: "新建文件夹",
      label: "文件夹路径",
      initialValue: "/home/ops/new-folder",
      requiredMessage: "请填写文件夹路径",
    });
    expect(deps.mkdir).toHaveBeenCalledWith("session-1", "/home/ops/new-folder");
  });

  it("selects local paths and enqueues upload plans under the current remote directory", async () => {
    const deps = dependencies({
      filePath: "/tmp",
      uploadPaths: ["C:\\build\\bundle.zip", "C:\\build\\release-folder"],
    });
    const actions = createRemoteFileActions(deps);

    await actions.uploadPath();

    expect(deps.selectUploadPaths).toHaveBeenCalled();
    expect(deps.classifyLocalPaths).toHaveBeenCalledWith(["C:\\build\\bundle.zip", "C:\\build\\release-folder"]);
    expect(deps.checkTransferConflicts).toHaveBeenCalledWith("session-1", [
      {
        direction: "upload",
        localPath: "C:\\build\\bundle.zip",
        remotePath: "/tmp/bundle.zip",
        kind: "file",
      },
      {
        direction: "upload",
        localPath: "C:\\build\\release-folder\\app.exe",
        remotePath: "/tmp/release-folder/app.exe",
        kind: "file",
      },
    ]);
    expect(deps.upload).toHaveBeenCalledWith("session-1", "C:\\build\\bundle.zip", "/tmp/bundle.zip", expect.objectContaining({
      kind: "file",
      conflictPolicy: "overwrite",
      groupId: expect.any(String),
      groupName: "上传 2 个文件",
    }));
    expect(deps.upload).toHaveBeenCalledWith("session-1", "C:\\build\\release-folder\\app.exe", "/tmp/release-folder/app.exe", expect.objectContaining({
      kind: "file",
      conflictPolicy: "overwrite",
      groupId: expect.any(String),
      groupName: "上传 2 个文件",
    }));
  });

  it("uses a batch conflict policy for downloads", async () => {
    const deps = dependencies({
      downloadDirectory: "D:\\Downloads",
      conflicts: [{ direction: "download", path: "D:\\Downloads\\logs\\app.log" }],
      conflictPolicy: "rename",
    });
    const actions = createRemoteFileActions(deps);

    await actions.downloadRemotePaths([
      {
        name: "logs",
        path: "/var/logs",
        kind: "directory",
        size: 0,
        modified_at_ms: null,
        permissions: null,
      },
    ]);

    expect(deps.requestConflictPolicy).toHaveBeenCalledWith([{ direction: "download", path: "D:\\Downloads\\logs\\app.log" }]);
    expect(deps.download).toHaveBeenCalledWith("session-1", "/var/logs/app.log", "D:\\Downloads\\logs\\app.log", expect.objectContaining({
      kind: "file",
      conflictPolicy: "rename",
      groupName: "下载 1 个文件",
    }));
  });

  it("does not prompt or mutate when there is no active SSH session", async () => {
    const deps = dependencies({ activeSshSessionId: null });
    const actions = createRemoteFileActions(deps);

    await actions.uploadPath();
    await actions.createRemoteDirectory();
    await actions.downloadRemotePaths([]);
    await actions.renameRemotePath("/tmp/file.txt");
    await actions.deleteRemotePaths(["/tmp/file.txt"], false);

    expect(deps.requestTextInput).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.mkdir).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.renamePath).not.toHaveBeenCalled();
    expect(deps.deletePath).not.toHaveBeenCalled();
  });
});

function dependencies({
  activeSshSessionId = "session-1",
  filePath = ".",
  textInputResults = [],
  uploadPaths = [],
  downloadDirectory = null,
  conflicts = [],
  conflictPolicy = "overwrite",
}: {
  activeSshSessionId?: string | null;
  filePath?: string;
  textInputResults?: Array<string | null>;
  uploadPaths?: string[];
  downloadDirectory?: string | null;
  conflicts?: Array<{ direction: "upload" | "download"; path: string }>;
  conflictPolicy?: "overwrite" | "skip" | "rename" | null;
} = {}) {
  const pendingInputs = [...textInputResults];
  return {
    activeSshSessionId,
    filePath,
    setFilePath: vi.fn(),
    requestTextInput: vi.fn(async () => pendingInputs.shift() ?? null),
    requestConflictPolicy: vi.fn(async () => conflictPolicy),
    listFiles: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => undefined),
    deletePath: vi.fn(async () => undefined),
    renamePath: vi.fn(async () => undefined),
    classifyLocalPaths: vi.fn(async (paths: string[]): Promise<LocalPathInfo[]> =>
      paths.map((path) => ({
        path,
        kind: path.toLowerCase().includes("folder") || path.toLowerCase().includes("release") ? "directory" : "file",
      })),
    ),
    checkTransferConflicts: vi.fn(async () => conflicts),
    listTransferEndpoint: vi.fn(async (endpoint: { path: string }) => {
      if (endpoint.path === "C:\\build\\release-folder") {
        return [{ name: "app.exe", path: "C:\\build\\release-folder\\app.exe", kind: "file" as const, size: 8, modified_at_ms: null, permissions: null }];
      }
      if (endpoint.path === "/var/logs") {
        return [{ name: "app.log", path: "/var/logs/app.log", kind: "file" as const, size: 12, modified_at_ms: null, permissions: null }];
      }
      return [];
    }),
    selectUploadPaths: vi.fn(async () => uploadPaths),
    selectDownloadDirectory: vi.fn(async () => downloadDirectory),
  };
}
