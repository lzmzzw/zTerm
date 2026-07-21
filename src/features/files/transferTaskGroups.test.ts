// Author: Liz
import { describe, expect, it, vi } from "vitest";

import type { FileEntry, TransferTask } from "./fileStore";
import { createTransferTaskGroupMeta, expandTransferPlans, groupTransferTasks } from "./transferTaskGroups";

describe("transferTaskGroups", () => {
  it("flattens every recursively discovered file directly into one batch", async () => {
    const listDirectory = vi.fn(async (endpoint: { path: string }): Promise<FileEntry[]> => {
      if (endpoint.path === "C:\\release") {
        return [
          file("C:\\release\\root.txt", "root.txt"),
          directory("C:\\release\\nested", "nested"),
        ];
      }
      return [file("C:\\release\\nested\\app.exe", "app.exe")];
    });
    const sourcePlans = [{
      source: { kind: "local" as const, saved_session_id: null, path: "C:\\release" },
      destination: { kind: "saved_session" as const, saved_session_id: "ssh-1", path: "/opt/release" },
      kind: "directory" as const,
    }];

    const plans = await expandTransferPlans(sourcePlans, listDirectory);

    expect(plans.map((plan) => [plan.source.path, plan.destination.path, plan.kind])).toEqual([
      ["C:\\release\\root.txt", "/opt/release/root.txt", "file"],
      ["C:\\release\\nested\\app.exe", "/opt/release/nested/app.exe", "file"],
    ]);
    expect(createTransferTaskGroupMeta(sourcePlans, plans, "上传").groupName).toBe("上传 2 个文件");
  });

  it("keeps grouped children together while legacy tasks remain top-level", () => {
    const tasks = [task("child-1", "group-1"), task("legacy"), task("child-2", "group-1")];

    const groups = groupTransferTasks(tasks);

    expect(groups).toHaveLength(2);
    expect(groups[0].tasks.map((item) => item.id)).toEqual(["child-1", "child-2"]);
    expect(groups[1].tasks.map((item) => item.id)).toEqual(["legacy"]);
  });
});

function file(path: string, name: string): FileEntry {
  return { name, path, kind: "file", size: 1, modified_at_ms: null, permissions: null };
}

function directory(path: string, name: string): FileEntry {
  return { name, path, kind: "directory", size: 0, modified_at_ms: null, permissions: null };
}

function task(id: string, groupId?: string): TransferTask {
  return {
    id,
    group_id: groupId,
    group_name: groupId ? "上传 2 个文件" : null,
    saved_session_id: "ssh-1",
    direction: "upload",
    local_path: `C:/${id}`,
    remote_path: `/${id}`,
    kind: "file",
    conflict_policy: "overwrite",
    total_bytes: 1,
    transferred_bytes: 0,
    status: "queued",
    error_message: null,
    created_at_ms: 1,
    updated_at_ms: 1,
  };
}
