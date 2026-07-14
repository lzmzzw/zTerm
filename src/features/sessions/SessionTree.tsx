// Author: Liz
import { ChevronDown, ChevronRight, Folder, Monitor, Server, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { fallbackOnlyErrorMessage } from "../../lib/unknownErrorMessage";
import { SessionEditorDialog } from "./SessionEditorDialog";
import {
  ConfirmDialog,
  SessionContextMenu,
  SessionGroupDialog,
  type SessionTreeContextMenu,
} from "./SessionTreeDialogs";
import {
  buildSessionGroupDraft,
  buildSavedSessionDraft,
  buildSessionTreeModel,
  type SessionGroupTreeNode,
} from "./sessionTreeModel";
import type {
  SavedSession,
  SavedSessionDraft,
  SessionGroup,
  SessionGroupDraft,
  SessionTestRequest,
  SessionTestResult,
  SessionType,
} from "./types";
import type { CredentialDraft, CredentialRecord, TerminalProfile } from "../settings/settingsStore";
import { DragOverlay, type DragOverlayHandle } from "../../components/drag/DragOverlay";
import { useFlipLayout } from "../../components/drag/useFlipLayout";

const SESSION_DRAG_THRESHOLD = 6;

interface SessionPointerDragState {
  session: SavedSession;
  startX: number;
  startY: number;
  active: boolean;
  sourceRect: DOMRect;
  pointerOffsetX: number;
  pointerOffsetY: number;
}

interface SessionDragVisual {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SessionTreeProps {
  groups: SessionGroup[];
  sessions: SavedSession[];
  onSaveGroup?: (draft: SessionGroupDraft) => Promise<unknown> | unknown;
  onSaveSession?: (draft: SavedSessionDraft) => Promise<unknown> | unknown;
  onTestSession?: (request: SessionTestRequest) => Promise<SessionTestResult> | SessionTestResult;
  onSaveCredential?: (draft: CredentialDraft) => Promise<CredentialRecord> | CredentialRecord;
  onReadCredential?: (credentialRef: string) => Promise<string> | string;
  onSelectSshKeyFile?: () => Promise<string | null> | string | null;
  terminalProfiles?: TerminalProfile[];
  onDeleteGroup?: (groupId: string) => Promise<void> | void;
  onDeleteSession?: (sessionId: string) => Promise<void> | void;
  onOpenSession?: (session: SavedSession) => void;
}

export function SessionTree({
  groups,
  sessions,
  onSaveGroup,
  onSaveSession,
  onTestSession,
  onSaveCredential,
  onReadCredential,
  onSelectSshKeyFile,
  terminalProfiles = [],
  onDeleteGroup,
  onDeleteSession,
  onOpenSession,
}: SessionTreeProps) {
  const sessionTree = buildSessionTreeModel({ groups, sessions });
  const [dialogType, setDialogType] = useState<SessionType | null>(null);
  const [editingSession, setEditingSession] = useState<SavedSession | null>(null);
  const [initialGroupId, setInitialGroupId] = useState<string | null>(null);
  const [groupDialog, setGroupDialog] = useState<{ group?: SessionGroup; parentId: string | null } | null>(null);
  const [pendingDeleteSession, setPendingDeleteSession] = useState<SavedSession | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SessionTreeContextMenu | null>(null);
  const [draggedSessionId, setDraggedSessionId] = useState<string | null>(null);
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const pointerDragRef = useRef<SessionPointerDragState | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const dragOverlayRef = useRef<DragOverlayHandle>(null);
  const [dragVisual, setDragVisual] = useState<SessionDragVisual | null>(null);

  function handleCreateGroup(parentId: string | null = null) {
    setContextMenu(null);
    setGroupDialog({ parentId });
  }

  async function handleSaveGroup(name: string) {
    if (!onSaveGroup) return;
    const editingGroup = groupDialog?.group;
    const parentId = groupDialog?.parentId ?? null;
    setActionError(null);
    setContextMenu(null);
    try {
      await onSaveGroup(
        buildSessionGroupDraft({
          editingGroup,
          parentId,
          name,
          groupCount: groups.length,
        }),
      );
      setGroupDialog(null);
    } catch (error) {
      setActionError(fallbackOnlyErrorMessage(error, "保存文件夹失败"));
    }
  }

  function handleEditGroup(group: SessionGroup) {
    setContextMenu(null);
    setGroupDialog({ group, parentId: group.parent_id });
  }

  async function handleDeleteGroup(group: SessionGroup) {
    if (!onDeleteGroup) return;
    setActionError(null);
    setContextMenu(null);
    try {
      await onDeleteGroup(group.id);
    } catch (error) {
      setActionError(fallbackOnlyErrorMessage(error, "删除分组失败"));
    }
  }

  async function handleToggleGroup(group: SessionGroup) {
    if (!onSaveGroup) return;
    setActionError(null);
    try {
      await onSaveGroup({
        id: group.id,
        parent_id: group.parent_id,
        name: group.name,
        expanded: group.expanded,
        sort_order: group.sort_order,
      });
    } catch (error) {
      setActionError(fallbackOnlyErrorMessage(error, "更新分组状态失败"));
      throw error;
    }
  }

  async function handleDeleteSession(session: SavedSession) {
    if (!onDeleteSession) return;
    setActionError(null);
    setContextMenu(null);
    setPendingDeleteSession(null);
    try {
      await onDeleteSession(session.id);
    } catch (error) {
      setActionError(fallbackOnlyErrorMessage(error, "删除会话失败"));
    }
  }

  function handleEditSession(session: SavedSession) {
    setContextMenu(null);
    setInitialGroupId(null);
    setEditingSession(session);
    setDialogType(session.type);
  }

  function handleCreateSession(groupId: string | null = null) {
    setContextMenu(null);
    setEditingSession(null);
    setInitialGroupId(groupId);
    setDialogType("ssh");
  }

  function handleCloseDialog() {
    setDialogType(null);
    setEditingSession(null);
    setInitialGroupId(null);
  }

  function openRootMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    setContextMenu({ kind: "root", x: event.clientX, y: event.clientY });
  }

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  const clearSessionDrag = useCallback(() => {
    pointerDragRef.current = null;
    setDraggedSessionId(null);
    setDropTargetGroupId(null);
    setDragVisual(null);
  }, []);

  useEffect(() => () => pointerDragCleanupRef.current?.(), []);

  const handleSessionPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, session: SavedSession) => {
      if (!onSaveSession || event.button !== 0) return;

      const sourceRect = event.currentTarget.getBoundingClientRect();
      pointerDragRef.current = {
        session,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        sourceRect,
        pointerOffsetX: event.clientX - sourceRect.left,
        pointerOffsetY: event.clientY - sourceRect.top,
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        pointerDragCleanupRef.current = null;
      };
      const groupIdAt = (clientX: number, clientY: number) =>
        document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-session-group-id]")?.dataset.sessionGroupId ?? null;
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const drag = pointerDragRef.current;
        if (!drag) return;
        if (!drag.active) {
          const distance = Math.hypot(moveEvent.clientX - drag.startX, moveEvent.clientY - drag.startY);
          if (distance < SESSION_DRAG_THRESHOLD) return;
          drag.active = true;
          setDraggedSessionId(drag.session.id);
          setDragVisual({
            label: drag.session.name,
            x: moveEvent.clientX - drag.pointerOffsetX,
            y: moveEvent.clientY - drag.pointerOffsetY,
            width: drag.sourceRect.width,
            height: drag.sourceRect.height,
          });
        }
        dragOverlayRef.current?.moveTo(
          moveEvent.clientX - drag.pointerOffsetX,
          moveEvent.clientY - drag.pointerOffsetY,
        );
        const nextTargetGroupId = groupIdAt(moveEvent.clientX, moveEvent.clientY);
        setDropTargetGroupId((current) => (current === nextTargetGroupId ? current : nextTargetGroupId));
        moveEvent.preventDefault();
      };
      const finishPointerUp = async (upEvent: PointerEvent) => {
        const drag = pointerDragRef.current;
        const targetGroupId = drag?.active ? groupIdAt(upEvent.clientX, upEvent.clientY) : null;
        cleanup();
        if (!drag?.active) return;
        if (!targetGroupId || drag.session.group_id === targetGroupId) {
          await dragOverlayRef.current?.animateTo(drag.sourceRect);
          clearSessionDrag();
          return;
        }
        const targetRow = Array.from(document.querySelectorAll<HTMLElement>("[data-session-group-id]"))
          .find((item) => item.dataset.sessionGroupId === targetGroupId);
        if (targetRow) await dragOverlayRef.current?.animateTo(targetRow.getBoundingClientRect());
        setActionError(null);
        try {
          await onSaveSession(buildSavedSessionDraft(drag.session, targetGroupId));
        } catch (error) {
          setActionError(fallbackOnlyErrorMessage(error, "移动会话失败"));
          await dragOverlayRef.current?.animateTo(drag.sourceRect);
        } finally {
          clearSessionDrag();
        }
      };
      const handlePointerUp = (upEvent: PointerEvent) => void finishPointerUp(upEvent);
      const handlePointerCancel = () => {
        cleanup();
        clearSessionDrag();
      };

      pointerDragCleanupRef.current?.();
      pointerDragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerCancel, { once: true });
    },
    [clearSessionDrag, onSaveSession],
  );

  return (
    <section className="zt-session-tree" aria-label="会话树" onContextMenu={openRootMenu}>
      {actionError ? <div className="zt-session-error">{actionError}</div> : null}
      {dragVisual ? (
        <DragOverlay
          ref={dragOverlayRef}
          label={dragVisual.label}
          x={dragVisual.x}
          y={dragVisual.y}
          width={dragVisual.width}
          height={dragVisual.height}
          variant="session"
        />
      ) : null}

      <div className="zt-session-nodes">
        {sessionTree.groups.map((node) => (
          <SessionGroupNode
            key={node.group.id}
            node={node}
            onOpenSession={onOpenSession}
            onDeleteGroup={onDeleteGroup ? handleDeleteGroup : undefined}
            onDeleteSession={onDeleteSession ? setPendingDeleteSession : undefined}
            onEditGroup={handleEditGroup}
            onEditSession={handleEditSession}
            onCreateSession={handleCreateSession}
            onToggleGroup={onSaveGroup ? handleToggleGroup : undefined}
            onOpenContextMenu={setContextMenu}
            onSessionPointerDown={handleSessionPointerDown}
            draggedSessionId={draggedSessionId}
            dropTargetGroupId={dropTargetGroupId}
          />
        ))}

        {sessionTree.rootSessions.length > 0 ? (
          <section className="zt-session-group" aria-label="未分组会话">
            <div className="zt-session-group-row">
              <Folder size={14} aria-hidden="true" />
              <span>未分组</span>
            </div>
            <ul>
              {sessionTree.rootSessions.map((session) => (
                <SessionNode
                  key={session.id}
                  session={session}
                  onOpenSession={onOpenSession}
                  onOpenContextMenu={setContextMenu}
                  onPointerDown={handleSessionPointerDown}
                  dragging={draggedSessionId === session.id}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {sessionTree.isEmpty ? <div className="zt-empty-line">暂无会话</div> : null}
      </div>

      {dialogType ? (
        <SessionEditorDialog
          type={dialogType}
          groups={groups}
          sessions={sessions}
          initialSession={editingSession}
          initialGroupId={initialGroupId}
          onClose={handleCloseDialog}
          onTypeChange={setDialogType}
          onSaveCredential={onSaveCredential}
          onReadCredential={onReadCredential}
          onSelectSshKeyFile={onSelectSshKeyFile}
          onTestConnection={onTestSession}
          terminalProfiles={terminalProfiles}
          onSave={async (draft) => {
            await onSaveSession?.(draft);
          }}
        />
      ) : null}

      {contextMenu ? (
        <SessionContextMenu
          menu={contextMenu}
          onCreateGroup={handleCreateGroup}
          onCreateSession={handleCreateSession}
          onEditGroup={handleEditGroup}
          onDeleteGroup={handleDeleteGroup}
          onEditSession={handleEditSession}
          onDeleteSession={setPendingDeleteSession}
          onOpenSession={onOpenSession}
        />
      ) : null}

      {groupDialog ? (
        <SessionGroupDialog
          title={groupDialog.group ? "编辑组" : "新建组"}
          initialName={groupDialog.group?.name ?? ""}
          onCancel={() => setGroupDialog(null)}
          onSave={handleSaveGroup}
        />
      ) : null}

      {pendingDeleteSession ? (
        <ConfirmDialog
          title="删除会话"
          message={`确认删除会话“${pendingDeleteSession.name}”？`}
          confirmLabel="确认删除"
          onCancel={() => setPendingDeleteSession(null)}
          onConfirm={() => void handleDeleteSession(pendingDeleteSession)}
        />
      ) : null}
    </section>
  );
}
function SessionGroupNode({
  node,
  onOpenSession,
  onDeleteGroup,
  onDeleteSession,
  onEditGroup,
  onEditSession,
  onCreateSession,
  onToggleGroup,
  onOpenContextMenu,
  onSessionPointerDown,
  draggedSessionId,
  dropTargetGroupId,
}: {
  node: SessionGroupTreeNode;
  onOpenSession?: (session: SavedSession) => void;
  onDeleteGroup?: (group: SessionGroup) => Promise<void>;
  onDeleteSession?: (session: SavedSession) => void;
  onEditGroup: (group: SessionGroup) => void;
  onEditSession: (session: SavedSession) => void;
  onCreateSession: (groupId: string | null) => void;
  onToggleGroup?: (group: SessionGroup) => Promise<void>;
  onOpenContextMenu: (menu: SessionTreeContextMenu) => void;
  onSessionPointerDown: (event: ReactPointerEvent<HTMLElement>, session: SavedSession) => void;
  draggedSessionId: string | null;
  dropTargetGroupId: string | null;
}) {
  const { group, groups: childGroups, sessions: groupSessions } = node;
  const [expanded, setExpanded] = useState(group.expanded);
  const sessionListRef = useRef<HTMLUListElement>(null);
  useFlipLayout(sessionListRef, groupSessions.map((session) => session.id).join("/"));

  useEffect(() => {
    setExpanded(group.expanded);
  }, [group.expanded]);

  function openGroupMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({ kind: "group", group, x: event.clientX, y: event.clientY });
  }

  async function toggleGroup() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    try {
      await onToggleGroup?.({ ...group, expanded: nextExpanded });
    } catch {
      setExpanded(group.expanded);
    }
  }

  return (
    <section className="zt-session-group" aria-label={`分组 ${group.name}`}>
      <div
        role="button"
        tabIndex={onToggleGroup ? 0 : -1}
        aria-expanded={expanded}
        aria-label={`${expanded ? "折叠" : "展开"}分组 ${group.name}`}
        aria-disabled={!onToggleGroup}
        title={`${expanded ? "折叠" : "展开"}分组 ${group.name}`}
        className={`zt-session-group-row ${dropTargetGroupId === group.id ? "drop-target" : ""}`}
        data-session-group-id={group.id}
        onContextMenu={openGroupMenu}
        onClick={() => void toggleGroup()}
        onKeyDown={(event) => {
          if (!onToggleGroup || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          void toggleGroup();
        }}
      >
        <Folder size={14} aria-hidden="true" />
        <span>{group.name}</span>
        {expanded ? (
          <ChevronDown className="zt-session-group-indicator" size={14} aria-hidden="true" />
        ) : (
          <ChevronRight className="zt-session-group-indicator" size={14} aria-hidden="true" />
        )}
      </div>
      {expanded ? (
        <ul ref={sessionListRef}>
          {groupSessions.map((session) => (
            <SessionNode
              key={session.id}
              session={session}
              onOpenSession={onOpenSession}
              onOpenContextMenu={onOpenContextMenu}
              onPointerDown={onSessionPointerDown}
              dragging={draggedSessionId === session.id}
            />
          ))}
          {childGroups.map((child) => (
            <li key={child.group.id}>
              <SessionGroupNode
                node={child}
                onOpenSession={onOpenSession}
                onDeleteGroup={onDeleteGroup}
                onDeleteSession={onDeleteSession}
                onEditGroup={onEditGroup}
                onEditSession={onEditSession}
                onCreateSession={onCreateSession}
                onToggleGroup={onToggleGroup}
                onOpenContextMenu={onOpenContextMenu}
                onSessionPointerDown={onSessionPointerDown}
                draggedSessionId={draggedSessionId}
                dropTargetGroupId={dropTargetGroupId}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
function SessionNode({
  session,
  onOpenSession,
  onOpenContextMenu,
  onPointerDown,
  dragging = false,
}: {
  session: SavedSession;
  onOpenSession?: (session: SavedSession) => void;
  onOpenContextMenu: (menu: SessionTreeContextMenu) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>, session: SavedSession) => void;
  dragging?: boolean;
}) {
  const Icon = session.type === "rdp" ? Monitor : session.type === "local" ? Terminal : Server;

  function openSessionMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({ kind: "session", session, x: event.clientX, y: event.clientY });
  }

  return (
    <li
      className={`zt-session-node ${dragging ? "dragging" : ""}`}
      data-flip-id={session.id}
      onContextMenu={openSessionMenu}
    >
      <button
        type="button"
        className="zt-session-node-main"
        title={`${sessionTypeTitle(session.type)} ${session.name}`}
        onDoubleClick={() => onOpenSession?.(session)}
        onPointerDown={(event) => onPointerDown?.(event, session)}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{session.name}</span>
      </button>
    </li>
  );
}

function sessionTypeTitle(type: SessionType) {
  if (type === "rdp") return "RDP 会话";
  if (type === "local") return "Local 会话";
  return "SSH 会话";
}
