// Author: Liz

import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Folder, Monitor, Server, Terminal } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";

import { ZtButton, ZtDialog, ZtPromptDialog } from "../components/ZtUi";
import type { TransferConflict, TransferConflictPolicy } from "../features/files/fileStore";
import { buildSessionTreeListItems, visibleSessionTreeListItems } from "../features/sessions/sessionTreeModel";
import type { SavedSession, SessionGroup } from "../features/sessions/types";
import type { SyncChannelMember } from "../features/terminal/syncInputStore";

export type ConnectionChoice = { kind: "saved_session"; session: SavedSession };

export function AppTextInputDialog({
  title,
  label,
  initialValue = "",
  requiredMessage,
  confirmLabel = "确定",
  onCancel,
  onSubmit,
}: {
  title: string;
  label: string;
  initialValue?: string;
  requiredMessage: string;
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <ZtPromptDialog
      title={title}
      label={label}
      initialValue={initialValue}
      requiredMessage={requiredMessage}
      confirmLabel={confirmLabel}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

export function ConnectionPickerDialog({
  groups,
  sessions,
  opening,
  error,
  onCancel,
  onSelect,
}: {
  groups: SessionGroup[];
  sessions: SavedSession[];
  opening: boolean;
  error: string | null;
  onCancel: () => void;
  onSelect: (choice: ConnectionChoice) => void;
}) {
  const treeItems = buildSessionTreeListItems({ groups, sessions, hideEmptyGroups: true });
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(() => new Set());
  const visibleTreeItems = visibleSessionTreeListItems(treeItems, collapsedGroupKeys);

  function toggleGroup(key: string) {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <ZtDialog
      ariaLabel="选择连接"
      title="选择连接"
      size="compact"
      onClose={onCancel}
      closeLabel="关闭选择连接"
      closeDisabled={opening}
      bodyClassName="zt-connection-picker-body"
      footer={
        <ZtButton aria-label="取消选择连接" disabled={opening} onClick={onCancel}>
          取消
        </ZtButton>
      }
    >
      <div className="zt-session-picker-tree" role="tree" aria-label="可用连接">
        {visibleTreeItems.map((item) => {
          const depthStyle = { "--zt-session-tree-depth": item.depth } as CSSProperties;
          if (item.kind === "group") {
            const collapsed = collapsedGroupKeys.has(item.key);
            return (
              <button
                type="button"
                key={item.key}
                role="treeitem"
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "展开" : "折叠"}分组 ${item.name}`}
                aria-level={item.depth + 1}
                disabled={opening}
                className="zt-session-picker-row zt-session-picker-group"
                data-session-tree-depth={item.depth}
                style={depthStyle}
                onClick={() => toggleGroup(item.key)}
              >
                <Folder size={14} aria-hidden="true" />
                <span>{item.name}</span>
                {collapsed ? (
                  <ChevronRight className="zt-session-picker-indicator" size={14} aria-hidden="true" />
                ) : (
                  <ChevronDown className="zt-session-picker-indicator" size={14} aria-hidden="true" />
                )}
              </button>
            );
          }
          const Icon = item.session.type === "rdp" ? Monitor : item.session.type === "local" ? Terminal : Server;
          return (
            <button
              type="button"
              role="treeitem"
              key={item.key}
              className="zt-session-picker-row zt-session-picker-option"
              disabled={opening}
              aria-label={`选择连接 ${item.session.name}`}
              aria-level={item.depth + 1}
              data-session-tree-depth={item.depth}
              style={depthStyle}
              onClick={() => onSelect({ kind: "saved_session", session: item.session })}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{item.session.name}</span>
            </button>
          );
        })}
      </div>
      {error ? <p className="zt-session-error">{error}</p> : null}
    </ZtDialog>
  );
}

export function SyncChannelDialog({
  candidates,
  initialMemberIds,
  onCancel,
  onSubmit,
}: {
  candidates: SyncChannelMember[];
  initialMemberIds: string[];
  onCancel: () => void;
  onSubmit: (memberIds: string[]) => void;
}) {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const [memberIds, setMemberIds] = useState<string[]>(() =>
    initialMemberIds.filter((memberId) => candidateIds.has(memberId)),
  );
  const selectedIds = new Set(memberIds);
  const available = candidates.filter((candidate) => !selectedIds.has(candidate.id));
  const selected = memberIds
    .map((memberId) => candidates.find((candidate) => candidate.id === memberId))
    .filter((candidate): candidate is SyncChannelMember => Boolean(candidate));

  function addMember(memberId: string) {
    setMemberIds((current) => (current.includes(memberId) ? current : [...current, memberId]));
  }

  function removeMember(memberId: string) {
    setMemberIds((current) => current.filter((id) => id !== memberId));
  }

  return (
    <ZtDialog
      ariaLabel="创建同步频道"
      title="创建同步频道"
      size="medium"
      className="zt-sync-channel-dialog"
      bodyClassName="zt-sync-channel-body"
      onClose={onCancel}
      closeLabel="关闭同步频道创建"
      footer={
        <>
          <ZtButton aria-label="取消创建同步频道" onClick={onCancel}>
            取消
          </ZtButton>
          <ZtButton
            aria-label="创建同步频道"
            variant="primary"
            disabled={selected.length < 2}
            onClick={() => onSubmit(selected.map((member) => member.id))}
          >
            创建频道
          </ZtButton>
        </>
      }
    >
      <div className="zt-sync-channel-columns">
        <SyncChannelMemberList title="可用 SSH 连接" emptyText="没有其他可用 SSH 连接">
          {available.map((candidate) => (
            <SyncChannelMemberRow
              key={candidate.id}
              candidate={candidate}
              actionLabel={`添加 ${candidate.title}`}
              icon={<ArrowRight size={14} aria-hidden="true" />}
              onAction={() => addMember(candidate.id)}
            />
          ))}
        </SyncChannelMemberList>
        <SyncChannelMemberList title={`频道成员（${selected.length}）`} emptyText="请添加至少两个 SSH 连接">
          {selected.map((candidate) => (
            <SyncChannelMemberRow
              key={candidate.id}
              candidate={candidate}
              actionLabel={`移除 ${candidate.title}`}
              icon={<ArrowLeft size={14} aria-hidden="true" />}
              onAction={() => removeMember(candidate.id)}
            />
          ))}
        </SyncChannelMemberList>
      </div>
    </ZtDialog>
  );
}

function SyncChannelMemberList({
  title,
  emptyText,
  children,
}: {
  title: string;
  emptyText: string;
  children: ReactNode;
}) {
  const empty = !Array.isArray(children) || children.length === 0;
  return (
    <section className="zt-sync-channel-column" aria-label={title}>
      <header>{title}</header>
      <div className="zt-sync-channel-list">{empty ? <p>{emptyText}</p> : children}</div>
    </section>
  );
}

function SyncChannelMemberRow({
  candidate,
  actionLabel,
  icon,
  onAction,
}: {
  candidate: SyncChannelMember;
  actionLabel: string;
  icon: ReactNode;
  onAction: () => void;
}) {
  return (
    <div className="zt-sync-channel-row">
      <Server size={14} aria-hidden="true" />
      <span>
        <strong>{candidate.title}</strong>
        <small>{candidate.host}</small>
      </span>
      <button type="button" aria-label={actionLabel} title={actionLabel} onClick={onAction}>
        {icon}
      </button>
    </div>
  );
}

export function AppTransferConflictDialog({
  conflicts,
  onCancel,
  onSelect,
}: {
  conflicts: TransferConflict[];
  onCancel: () => void;
  onSelect: (policy: TransferConflictPolicy) => void;
}) {
  return (
    <ZtDialog
      ariaLabel="传输冲突"
      title="传输冲突"
      size="compact"
      onClose={onCancel}
      closeLabel="关闭传输冲突"
      bodyClassName="zt-transfer-conflict-body"
      footer={
        <>
          <ZtButton aria-label="取消传输冲突" onClick={onCancel}>
            取消
          </ZtButton>
          <ZtButton aria-label="跳过冲突项" onClick={() => onSelect("skip")}>
            跳过
          </ZtButton>
          <ZtButton aria-label="自动重命名冲突项" onClick={() => onSelect("rename")}>
            自动重命名
          </ZtButton>
          <ZtButton aria-label="覆盖冲突项" variant="primary" onClick={() => onSelect("overwrite")}>
            覆盖
          </ZtButton>
        </>
      }
    >
      <p>检测到 {conflicts.length} 个同名目标。</p>
      <ul>
        {conflicts.slice(0, 5).map((conflict) => (
          <li key={`${conflict.direction}:${conflict.path}`}>{conflict.path}</li>
        ))}
      </ul>
    </ZtDialog>
  );
}
