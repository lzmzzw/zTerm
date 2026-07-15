// Author: Liz

import { ChevronDown, Folder, Monitor, Server, Terminal } from "lucide-react";
import type { CSSProperties } from "react";

import { ZtButton, ZtDialog, ZtPromptDialog } from "../components/ZtUi";
import type { TransferConflict, TransferConflictPolicy } from "../features/files/fileStore";
import { buildSessionTreeListItems } from "../features/sessions/sessionTreeModel";
import type { SavedSession, SessionGroup } from "../features/sessions/types";

export type ConnectionChoice =
  | { kind: "default_local" }
  | { kind: "saved_session"; session: SavedSession };

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
  const treeItems = buildSessionTreeListItems({ groups, sessions });

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
        <button
          type="button"
          role="treeitem"
          className="zt-session-picker-row zt-session-picker-option"
          disabled={opening}
          aria-label="选择默认本地终端"
          aria-level={1}
          data-session-tree-depth="0"
          style={{ "--zt-session-tree-depth": 0 } as CSSProperties}
          onClick={() => onSelect({ kind: "default_local" })}
        >
          <Terminal size={14} aria-hidden="true" />
          <span>默认本地终端</span>
        </button>
        {treeItems.map((item) => {
          const depthStyle = { "--zt-session-tree-depth": item.depth } as CSSProperties;
          if (item.kind === "group") {
            return (
              <div
                key={item.key}
                role="treeitem"
                aria-expanded="true"
                aria-level={item.depth + 1}
                className="zt-session-picker-row zt-session-picker-group"
                data-session-tree-depth={item.depth}
                style={depthStyle}
              >
                <Folder size={14} aria-hidden="true" />
                <span>{item.name}</span>
                {item.groupId ? (
                  <ChevronDown className="zt-session-picker-indicator" size={14} aria-hidden="true" />
                ) : null}
              </div>
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
