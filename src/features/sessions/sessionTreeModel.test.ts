// Author: Liz
import { describe, expect, it } from "vitest";

import { buildSessionGroupDraft, buildSessionTreeModel } from "./sessionTreeModel";
import type { SavedSession, SessionGroup } from "./types";

function group(overrides: Partial<SessionGroup>): SessionGroup {
  return {
    id: overrides.id ?? "group-1",
    parent_id: overrides.parent_id ?? null,
    name: overrides.name ?? "Group",
    expanded: overrides.expanded ?? true,
    sort_order: overrides.sort_order ?? 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...overrides,
  };
}

function session(overrides: Partial<SavedSession>): SavedSession {
  return {
    id: overrides.id ?? "session-1",
    name: overrides.name ?? "Session",
    type: overrides.type ?? "ssh",
    group_id: overrides.group_id ?? null,
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 22,
    username: overrides.username ?? "root",
    auth_mode: overrides.auth_mode ?? "password",
    credential_ref: null,
    description: null,
    tags: [],
    sort_order: overrides.sort_order ?? 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
    ssh_options: null,
    rdp_options: null,
    local_options: null,
    ...overrides,
  };
}

describe("sessionTreeModel", () => {
  it("sorts group and session names naturally at every tree level", () => {
    const model = buildSessionTreeModel({
      groups: [
        group({ id: "root-a", name: "生产环境" }),
        group({ id: "child-a", parent_id: "root-a", name: "A child" }),
        group({ id: "root-b", name: "开发环境" }),
        group({ id: "orphan", parent_id: "missing", name: "Missing parent" }),
      ],
      sessions: [
        session({ id: "root-191", name: "172.16.41.191", group_id: null }),
        session({ id: "root-2", name: "172.16.41.2", group_id: null }),
        session({ id: "session-a", name: "172.16.41.191", group_id: "root-a" }),
        session({ id: "session-b", name: "172.16.41.2", group_id: "root-a" }),
        session({ id: "session-child", group_id: "child-a" }),
        session({ id: "orphan-session", group_id: "missing" }),
      ],
    });

    expect(model.isEmpty).toBe(false);
    expect(model.rootSessions.map((item) => item.id)).toEqual(["root-2", "root-191"]);
    expect(model.groups.map((item) => item.group.id)).toEqual(["root-b", "root-a"]);
    expect(model.groups[1].sessions.map((item) => item.id)).toEqual(["session-b", "session-a"]);
    expect(model.groups[1].groups.map((item) => item.group.id)).toEqual(["child-a"]);
    expect(model.groups[1].groups[0].sessions.map((item) => item.id)).toEqual(["session-child"]);
    expect(JSON.stringify(model)).not.toContain("orphan");
  });

  it("reports an empty model only when both groups and sessions are empty", () => {
    expect(buildSessionTreeModel({ groups: [], sessions: [] }).isEmpty).toBe(true);
    expect(buildSessionTreeModel({ groups: [], sessions: [session({ id: "root" })] }).isEmpty).toBe(false);
  });

  it("builds group drafts using current edit and create defaults", () => {
    expect(
      buildSessionGroupDraft({
        editingGroup: null,
        parentId: "parent",
        name: "Database",
        groupCount: 4,
      }),
    ).toEqual({
      parent_id: "parent",
      name: "Database",
      expanded: true,
      sort_order: 4,
    });

    expect(
      buildSessionGroupDraft({
        editingGroup: group({
          id: "existing",
          parent_id: "old-parent",
          expanded: false,
          sort_order: 7,
        }),
        parentId: "new-parent",
        name: "Renamed",
        groupCount: 4,
      }),
    ).toEqual({
      id: "existing",
      parent_id: "old-parent",
      name: "Renamed",
      expanded: false,
      sort_order: 7,
    });
  });
});
