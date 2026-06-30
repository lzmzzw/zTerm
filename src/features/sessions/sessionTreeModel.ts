// Author: Liz
import type { SavedSession, SessionGroup, SessionGroupDraft } from "./types";

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
