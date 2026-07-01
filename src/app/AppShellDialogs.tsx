// Author: Liz

import { ZtButton, ZtDialog, ZtPromptDialog } from "../components/ZtUi";
import type { TransferConflict, TransferConflictPolicy } from "../features/files/fileStore";
import type { SavedSession } from "../features/sessions/types";

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
  sessions,
  opening,
  error,
  onCancel,
  onSelect,
}: {
  sessions: SavedSession[];
  opening: boolean;
  error: string | null;
  onCancel: () => void;
  onSelect: (choice: ConnectionChoice) => void;
}) {
  const sortedSessions = [...sessions].sort(
    (left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name),
  );

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
      <button
        type="button"
        className="zt-connection-choice"
        disabled={opening}
        aria-label="选择默认本地终端"
        onClick={() => onSelect({ kind: "default_local" })}
      >
        <strong>默认本地终端</strong>
        <span>Local</span>
      </button>
      {sortedSessions.map((session) => (
        <button
          type="button"
          key={session.id}
          className="zt-connection-choice"
          disabled={opening}
          aria-label={`选择连接 ${session.name}`}
          onClick={() => onSelect({ kind: "saved_session", session })}
        >
          <strong>{session.name}</strong>
          <span>{sessionTypeLabel(session.type)}</span>
        </button>
      ))}
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

function sessionTypeLabel(type: SavedSession["type"]) {
  switch (type) {
    case "ssh":
      return "SSH";
    case "local":
      return "Local";
    case "rdp":
      return "RDP";
  }
}
