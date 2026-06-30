// Author: Liz
import { useEffect, useRef, useState, type FormEvent } from "react";

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
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      setError(requiredMessage);
      return;
    }
    setError(null);
    onSubmit(normalizedValue);
  }

  return (
    <div className="zt-session-modal-backdrop">
      <div className="zt-session-dialog zt-session-group-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <form onSubmit={handleSubmit}>
          <header>
            <strong>{title}</strong>
            <button type="button" aria-label={`关闭${title}`} onClick={onCancel}>
              ×
            </button>
          </header>
          <label>
            <span>{label}</span>
            <input
              ref={inputRef}
              aria-label={label}
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          {error ? <p className="zt-session-error">{error}</p> : null}
          <footer>
            <button type="button" aria-label={`取消${title}`} onClick={onCancel}>
              取消
            </button>
            <button type="submit" aria-label={`确认${title}`}>
              {confirmLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
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
    <div className="zt-session-modal-backdrop">
      <div className="zt-session-dialog zt-connection-picker-dialog" role="dialog" aria-modal="true" aria-label="选择连接">
        <header>
          <strong>选择连接</strong>
          <button type="button" aria-label="关闭选择连接" disabled={opening} onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="zt-connection-picker-body">
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
        </div>
        {error ? <p className="zt-session-error">{error}</p> : null}
        <footer>
          <button type="button" aria-label="取消选择连接" disabled={opening} onClick={onCancel}>
            取消
          </button>
        </footer>
      </div>
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
    <div className="zt-session-modal-backdrop">
      <div className="zt-session-dialog zt-transfer-conflict-dialog" role="dialog" aria-modal="true" aria-label="传输冲突">
        <header>
          <strong>传输冲突</strong>
          <button type="button" aria-label="关闭传输冲突" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="zt-transfer-conflict-body">
          <p>检测到 {conflicts.length} 个同名目标。</p>
          <ul>
            {conflicts.slice(0, 5).map((conflict) => (
              <li key={`${conflict.direction}:${conflict.path}`}>{conflict.path}</li>
            ))}
          </ul>
        </div>
        <footer>
          <button type="button" aria-label="覆盖冲突项" onClick={() => onSelect("overwrite")}>
            覆盖
          </button>
          <button type="button" aria-label="跳过冲突项" onClick={() => onSelect("skip")}>
            跳过
          </button>
          <button type="button" aria-label="自动重命名冲突项" onClick={() => onSelect("rename")}>
            自动重命名
          </button>
          <button type="button" aria-label="取消传输冲突" onClick={onCancel}>
            取消
          </button>
        </footer>
      </div>
    </div>
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
