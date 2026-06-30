// Author: Liz
import { Folder, Monitor, MoreHorizontal, Pencil, Server, Terminal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

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
  buildSessionTreeModel,
  type SessionGroupTreeNode,
} from "./sessionTreeModel";
import type {
  SavedSession,
  SavedSessionDraft,
  SessionGroup,
  SessionGroupDraft,
  SessionTestResult,
  SessionType,
} from "./types";
import type { CredentialDraft, CredentialRecord, TerminalProfile } from "../settings/settingsStore";

interface SessionTreeProps {
  groups: SessionGroup[];
  sessions: SavedSession[];
  onSaveGroup?: (draft: SessionGroupDraft) => Promise<unknown> | unknown;
  onSaveSession?: (draft: SavedSessionDraft) => Promise<unknown> | unknown;
  onTestSession?: (draft: SavedSessionDraft) => Promise<SessionTestResult> | SessionTestResult;
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

  return (
    <section className="zt-session-tree" aria-label="会话树" onContextMenu={openRootMenu}>
      {actionError ? <div className="zt-session-error">{actionError}</div> : null}

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
            onOpenContextMenu={setContextMenu}
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
                  onEditSession={handleEditSession}
                  onDeleteSession={onDeleteSession ? setPendingDeleteSession : undefined}
                  onOpenContextMenu={setContextMenu}
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
  onOpenContextMenu,
}: {
  node: SessionGroupTreeNode;
  onOpenSession?: (session: SavedSession) => void;
  onDeleteGroup?: (group: SessionGroup) => Promise<void>;
  onDeleteSession?: (session: SavedSession) => void;
  onEditGroup: (group: SessionGroup) => void;
  onEditSession: (session: SavedSession) => void;
  onCreateSession: (groupId: string | null) => void;
  onOpenContextMenu: (menu: SessionTreeContextMenu) => void;
}) {
  const { group, groups: childGroups, sessions: groupSessions } = node;

  function openGroupMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({ kind: "group", group, x: event.clientX, y: event.clientY });
  }

  function openGroupButtonMenu(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    onOpenContextMenu({ kind: "group", group, x: rect.right, y: rect.bottom });
  }

  return (
    <section className="zt-session-group" aria-label={`分组 ${group.name}`}>
      <div className="zt-session-group-row" onContextMenu={openGroupMenu}>
        <Folder size={14} aria-hidden="true" />
        <span>{group.name}</span>
        <button type="button" aria-label={`分组操作 ${group.name}`} title={`分组操作 ${group.name}`} onClick={openGroupButtonMenu}>
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </div>
      <ul>
        {groupSessions.map((session) => (
          <SessionNode
            key={session.id}
            session={session}
            onOpenSession={onOpenSession}
            onEditSession={onEditSession}
            onDeleteSession={onDeleteSession}
            onOpenContextMenu={onOpenContextMenu}
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
              onOpenContextMenu={onOpenContextMenu}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
function SessionNode({
  session,
  onOpenSession,
  onEditSession,
  onDeleteSession,
  onOpenContextMenu,
}: {
  session: SavedSession;
  onOpenSession?: (session: SavedSession) => void;
  onEditSession: (session: SavedSession) => void;
  onDeleteSession?: (session: SavedSession) => void;
  onOpenContextMenu: (menu: SessionTreeContextMenu) => void;
}) {
  const Icon = session.type === "rdp" ? Monitor : session.type === "local" ? Terminal : Server;

  function openSessionMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    onOpenContextMenu({ kind: "session", session, x: event.clientX, y: event.clientY });
  }

  return (
    <li className="zt-session-node" onContextMenu={openSessionMenu}>
      <button
        type="button"
        className="zt-session-node-main"
        title={`${sessionTypeTitle(session.type)} ${session.name}`}
        onDoubleClick={() => onOpenSession?.(session)}
      >
        <Icon size={14} aria-hidden="true" />
        <span>{session.name}</span>
      </button>
      <div className="zt-session-node-actions">
        <button type="button" aria-label={`编辑会话 ${session.name}`} title={`编辑会话 ${session.name}`} onClick={() => onEditSession(session)}>
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`删除会话 ${session.name}`}
          title={`删除会话 ${session.name}`}
          onClick={() => void onDeleteSession?.(session)}
          disabled={!onDeleteSession}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

function sessionTypeTitle(type: SessionType) {
  if (type === "rdp") return "RDP 会话";
  if (type === "local") return "Local 会话";
  return "SSH 会话";
}
