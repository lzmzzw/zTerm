// Author: Liz
import { describe, expect, it } from "vitest";

import { buildDownloadTransferPlans, buildUploadTransferPlans } from "./fileTransferPlanner";
import type { FileEntry, LocalPathInfo } from "./fileStore";

describe("fileTransferPlanner", () => {
  it("plans file and directory uploads under the current remote root", () => {
    const localPaths: LocalPathInfo[] = [
      { path: "C:\\tmp\\bundle.zip", kind: "file" },
      { path: "C:\\tmp\\release", kind: "directory" },
    ];

    expect(
      buildUploadTransferPlans({
        currentRemotePath: "/",
        localPaths,
        conflictPolicy: "rename",
      }),
    ).toEqual([
      {
        localPath: "C:\\tmp\\bundle.zip",
        remotePath: "/bundle.zip",
        kind: "file",
        conflictPolicy: "rename",
      },
      {
        localPath: "C:\\tmp\\release",
        remotePath: "/release",
        kind: "directory",
        conflictPolicy: "rename",
      },
    ]);
  });

  it("plans batch downloads into the selected local directory and skips unsupported kinds", () => {
    const entries: FileEntry[] = [
      entry("app.log", "/var/app.log", "file"),
      entry("logs", "/var/logs", "directory"),
      entry("socket", "/var/socket", "other"),
    ];

    expect(
      buildDownloadTransferPlans({
        selectedEntries: entries,
        localDirectory: "D:\\Downloads",
        conflictPolicy: "skip",
      }),
    ).toEqual([
      {
        remotePath: "/var/app.log",
        localPath: "D:\\Downloads\\app.log",
        kind: "file",
        conflictPolicy: "skip",
      },
      {
        remotePath: "/var/logs",
        localPath: "D:\\Downloads\\logs",
        kind: "directory",
        conflictPolicy: "skip",
      },
    ]);
  });
});

function entry(name: string, path: string, kind: FileEntry["kind"]): FileEntry {
  return {
    name,
    path,
    kind,
    size: 1,
    modified_at_ms: null,
    permissions: null,
  };
}
