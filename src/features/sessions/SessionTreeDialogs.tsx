// Author: Liz
import { useState } from "react";

import { ZtButton, ZtConfirmDialog, ZtContextMenu, ZtDialog, ZtInput } from "../../components/ZtUi";
import type { SavedSession, SessionGroup } from "./types";

export type SessionTreeContextMenu =
  | { kind: "root"; x: number; y: number }
  | { kind: "group"; group: SessionGroup; x: number; y: number }
  | { kind: "session"; session: SavedSession; x: number; y: number };

export function SessionContextMenu({
  menu,
  onCreateGroup,
  onCreateSession,
  onEditGroup,
  onDeleteGroup,
  onEditSession,
  onDeleteSession,
  onOpenSession,
}: {
  menu: SessionTreeContextMenu;
  onCreateGroup: (parentId?: string | null) => void;
  onCreateSession: (groupId?: string | null) => void;
  onEditGroup: (group: SessionGroup) => void;
  onDeleteGroup: (group: SessionGroup) => Promise<void>;
  onEditSession: (session: SavedSession) => void;
  onDeleteSession: (session: SavedSession) => void;
  onOpenSession?: (session: SavedSession) => void;
}) {
  return (
    <ZtContextMenu className="zt-session-context-menu" role="menu" x={menu.x} y={menu.y}>
      {menu.kind === "root" ? (
        <>
          <button type="button" role="menuitem" onClick={() => onCreateSession(null)}>
            添加连接
          </button>
          <button type="button" role="menuitem" onClick={() => onCreateGroup(null)}>
            新建分组
          </button>
        </>
      ) : null}

      {menu.kind === "group" ? (
        <>
          <button type="button" role="menuitem" onClick={() => onCreateSession(menu.group.id)}>
            新建连接
          </button>
          <button type="button" role="menuitem" onClick={() => onEditGroup(menu.group)}>
            编辑
          </button>
          <button type="button" className="zt-delete-button" role="menuitem" onClick={() => void onDeleteGroup(menu.group)}>
            删除
          </button>
        </>
      ) : null}

      {menu.kind === "session" ? (
        <>
          <button type="button" role="menuitem" onClick={() => onEditSession(menu.session)}>
            编辑
          </button>
          <button type="button" className="zt-delete-button" role="menuitem" onClick={() => void onDeleteSession(menu.session)}>
            删除
          </button>
          <button type="button" role="menuitem" onClick={() => onOpenSession?.(menu.session)}>
            建立新连接
          </button>
        </>
      ) : null}
    </ZtContextMenu>
  );
}

export function SessionGroupDialog({
  title,
  initialName,
  onCancel,
  onSave,
}: {
  title: string;
  initialName: string;
  onCancel: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("请填写文件夹名称");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(normalizedName);
    } finally {
      setSaving(false);
    }
  }

  const formId = `${title}-session-group-form`;

  return (
    <ZtDialog
      ariaLabel={title}
      title={title}
      size="compact"
      onClose={onCancel}
      closeLabel="关闭分组编辑"
      footer={
        <>
          <ZtButton disabled={saving} onClick={onCancel}>
            取消
          </ZtButton>
          <ZtButton form={formId} type="submit" disabled={saving} variant="primary">
            确定
          </ZtButton>
        </>
      }
    >
      <form id={formId} className="zt-dialog-form" onSubmit={handleSubmit}>
        <label>
          <span>文件夹名称</span>
          <ZtInput aria-label="文件夹名称" value={name} onChange={(event) => setName(event.currentTarget.value)} />
        </label>
        {error ? <p className="zt-session-error">{error}</p> : null}
      </form>
    </ZtDialog>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ZtConfirmDialog
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      danger={confirmLabel.includes("删除")}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
