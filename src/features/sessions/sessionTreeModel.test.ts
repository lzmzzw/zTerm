// Author: Liz
import { describe, expect, it } from "vitest";

import {
  buildCopiedSessionDraft,
  buildSavedSessionDraft,
  buildSessionGroupDraft,
  buildSessionTreeListItems,
  buildSessionTreeModel,
} from "./sessionTreeModel";
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

  it("sorts session names containing IPv4 addresses by address octets", () => {
    const model = buildSessionTreeModel({
      groups: [],
      sessions: [
        session({ id: "session-40-198", name: "z-host-172.16.40.198" }),
        session({ id: "session-41-20-b", name: "a-host-172.16.41.20-b" }),
        session({ id: "session-41-20-a", name: "a-host-172.16.41.20-a" }),
      ],
    });

    expect(model.rootSessions.map((item) => item.id)).toEqual([
      "session-40-198",
      "session-41-20-a",
      "session-41-20-b",
    ]);
  });

  it("falls back to natural name sorting when an IPv4 address is invalid", () => {
    const model = buildSessionTreeModel({
      groups: [],
      sessions: [
        session({ id: "session-999", name: "invalid-172.16.41.999" }),
        session({ id: "session-named", name: "Named session" }),
        session({ id: "session-2", name: "invalid-172.16.41.2" }),
      ],
    });

    expect(model.rootSessions.map((item) => item.id)).toEqual([
      "session-2",
      "session-999",
      "session-named",
    ]);
  });

  it("reports an empty model only when both groups and sessions are empty", () => {
    expect(buildSessionTreeModel({ groups: [], sessions: [] }).isEmpty).toBe(true);
    expect(buildSessionTreeModel({ groups: [], sessions: [session({ id: "root" })] }).isEmpty).toBe(false);
  });

  it("builds ordered selectable tree items and removes groups emptied by session filtering", () => {
    const groups = [
      group({ id: "group-10", name: "Group 10" }),
      group({ id: "group-2", name: "Group 2" }),
      group({ id: "group-child", parent_id: "group-10", name: "Child" }),
      group({ id: "group-empty", name: "Empty" }),
    ];
    const sshSessions = [
      session({ id: "ssh-198", name: "z-host-172.16.40.198", group_id: "group-child" }),
      session({ id: "ssh-20", name: "a-host-172.16.40.20", group_id: "group-child" }),
    ];

    const items = buildSessionTreeListItems({ groups, sessions: sshSessions, hideEmptyGroups: true });

    expect(items.map((item) => `${item.kind}:${item.kind === "group" ? item.groupId : item.session.id}:${item.depth}`)).toEqual([
      "group:group-10:0",
      "group:group-child:1",
      "session:ssh-20:2",
      "session:ssh-198:2",
    ]);
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

  it("builds a complete session draft when moving a session to another group", () => {
    const source = session({
      id: "session-move",
      group_id: "group-old",
      description: "keep me",
      tags: ["prod"],
      ssh_options: { connect_timeout_ms: 15_000 },
    });

    expect(buildSavedSessionDraft(source, "group-new")).toEqual({
      id: "session-move",
      name: source.name,
      type: source.type,
      group_id: "group-new",
      host: source.host,
      port: source.port,
      username: source.username,
      auth_mode: source.auth_mode,
      credential_ref: source.credential_ref,
      description: "keep me",
      tags: ["prod"],
      sort_order: source.sort_order,
      ssh_options: { connect_timeout_ms: 15_000 },
      rdp_options: null,
      local_options: null,
    });
  });

  it("copies a session into the same group with the next available name suffix and credential reference", () => {
    const source = session({
      id: "session-source",
      name: "生产跳板机",
      group_id: "group-prod",
      username: "deploy",
      credential_ref: "credential:ssh-prod",
      tags: ["prod"],
      ssh_options: { connect_timeout_ms: 15_000 },
    });

    expect(
      buildCopiedSessionDraft(source, [
        source,
        session({ id: "session-copy-2", name: "生产跳板机-2", group_id: "group-prod" }),
        session({ id: "session-other-group", name: "生产跳板机-3", group_id: "group-dev" }),
      ]),
    ).toEqual({
      name: "生产跳板机-3",
      type: source.type,
      group_id: "group-prod",
      host: source.host,
      port: source.port,
      username: "deploy",
      auth_mode: source.auth_mode,
      credential_ref: "credential:ssh-prod",
      description: source.description,
      tags: ["prod"],
      sort_order: source.sort_order,
      ssh_options: { connect_timeout_ms: 15_000 },
      rdp_options: null,
      local_options: null,
    });
  });
});
