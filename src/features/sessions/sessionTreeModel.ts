// Author: Liz
import type { SavedSession, SavedSessionDraft, SessionGroup, SessionGroupDraft } from "./types";

const nameCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export interface SessionGroupTreeNode {
  group: SessionGroup;
  groups: SessionGroupTreeNode[];
  sessions: SavedSession[];
}

interface SessionTreeModel {
  groups: SessionGroupTreeNode[];
  rootSessions: SavedSession[];
  isEmpty: boolean;
}

export type SessionTreeListItem =
  | { kind: "group"; key: string; groupId: string | null; name: string; depth: number }
  | { kind: "session"; key: string; session: SavedSession; depth: number };

export function buildSessionTreeModel({
  groups,
  sessions,
}: {
  groups: SessionGroup[];
  sessions: SavedSession[];
}): SessionTreeModel {
  const groupsByParentId = new Map<string | null, SessionGroup[]>();
  const sessionsByGroupId = new Map<string | null, SavedSession[]>();

  for (const group of groups) {
    const parentId = group.parent_id || null;
    const siblings = groupsByParentId.get(parentId);
    if (siblings) {
      siblings.push(group);
    } else {
      groupsByParentId.set(parentId, [group]);
    }
  }

  for (const session of sessions) {
    const groupId = session.group_id || null;
    const groupSessions = sessionsByGroupId.get(groupId);
    if (groupSessions) {
      groupSessions.push(session);
    } else {
      sessionsByGroupId.set(groupId, [session]);
    }
  }

  for (const siblingGroups of groupsByParentId.values()) {
    siblingGroups.sort(compareNamedItems);
  }
  for (const groupSessions of sessionsByGroupId.values()) {
    groupSessions.sort(compareSessions);
  }

  function buildGroupNodes(parentId: string | null, ancestors: Set<string>): SessionGroupTreeNode[] {
    return (groupsByParentId.get(parentId) ?? [])
      .filter((group) => !ancestors.has(group.id))
      .map((group) => {
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(group.id);
        return {
          group,
          groups: buildGroupNodes(group.id, nextAncestors),
          sessions: sessionsByGroupId.get(group.id) ?? [],
        };
      });
  }

  return {
    groups: buildGroupNodes(null, new Set()),
    rootSessions: sessionsByGroupId.get(null) ?? [],
    isEmpty: groups.length === 0 && sessions.length === 0,
  };
}

function compareNamedItems(left: { id: string; name: string }, right: { id: string; name: string }) {
  return nameCollator.compare(left.name, right.name) || nameCollator.compare(left.id, right.id);
}

function compareSessions(left: SavedSession, right: SavedSession) {
  const leftAddress = extractIpv4Address(left.name);
  const rightAddress = extractIpv4Address(right.name);
  if (leftAddress && rightAddress) {
    for (let index = 0; index < leftAddress.length; index += 1) {
      const difference = leftAddress[index] - rightAddress[index];
      if (difference !== 0) return difference;
    }
  }
  if (leftAddress || rightAddress) return leftAddress ? -1 : 1;
  return compareNamedItems(left, right);
}

function extractIpv4Address(name: string): number[] | null {
  const candidates = name.matchAll(/(^|[^\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/g);
  for (const candidate of candidates) {
    const octets = candidate[2].split(".").map(Number);
    if (octets.every((octet) => octet <= 255)) return octets;
  }
  return null;
}

export function buildSessionTreeListItems({
  groups,
  sessions,
  hideEmptyGroups = false,
}: {
  groups: SessionGroup[];
  sessions: SavedSession[];
  hideEmptyGroups?: boolean;
}): SessionTreeListItem[] {
  const model = buildSessionTreeModel({ groups, sessions });

  function flattenGroupNodes(nodes: SessionGroupTreeNode[], depth: number): SessionTreeListItem[] {
    return nodes.flatMap((node) => {
      const childItems = flattenGroupNodes(node.groups, depth + 1);
      if (hideEmptyGroups && node.sessions.length === 0 && childItems.length === 0) return [];
      return [
        {
          kind: "group" as const,
          key: `group:${node.group.id}`,
          groupId: node.group.id,
          name: node.group.name,
          depth,
        },
        ...node.sessions.map((session) => ({
          kind: "session" as const,
          key: `session:${session.id}`,
          session,
          depth: depth + 1,
        })),
        ...childItems,
      ];
    });
  }

  const items = flattenGroupNodes(model.groups, 0);
  if (model.rootSessions.length > 0) {
    items.push(
      { kind: "group", key: "group:__ungrouped__", groupId: null, name: "未分组", depth: 0 },
      ...model.rootSessions.map((session) => ({
        kind: "session" as const,
        key: `session:${session.id}`,
        session,
        depth: 1,
      })),
    );
  }
  return items;
}

export function buildSessionGroupDraft({
  editingGroup,
  parentId,
  name,
  groupCount,
}: {
  editingGroup?: SessionGroup | null;
  parentId: string | null;
  name: string;
  groupCount: number;
}): SessionGroupDraft {
  return {
    id: editingGroup?.id,
    parent_id: editingGroup?.parent_id ?? parentId,
    name,
    expanded: editingGroup?.expanded ?? true,
    sort_order: editingGroup?.sort_order ?? groupCount,
  };
}

export function buildSavedSessionDraft(session: SavedSession, groupId: string | null): SavedSessionDraft {
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    group_id: groupId,
    host: session.host,
    port: session.port,
    username: session.username,
    auth_mode: session.auth_mode,
    credential_ref: session.credential_ref,
    description: session.description,
    tags: [...session.tags],
    sort_order: session.sort_order,
    ssh_options: session.ssh_options ?? null,
    rdp_options: session.rdp_options ?? null,
    local_options: session.local_options ?? null,
  };
}

export function buildCopiedSessionDraft(session: SavedSession, sessions: SavedSession[]): SavedSessionDraft {
  const { id: _id, ...draft } = buildSavedSessionDraft(session, session.group_id);
  const groupId = session.group_id ?? null;
  const baseName = session.name.replace(/-\d+$/, "");
  const siblingNames = new Set(
    sessions.filter((item) => (item.group_id ?? null) === groupId).map((item) => item.name),
  );
  let suffix = 2;
  while (siblingNames.has(`${baseName}-${suffix}`)) suffix += 1;

  return {
    ...draft,
    name: `${baseName}-${suffix}`,
  };
}
