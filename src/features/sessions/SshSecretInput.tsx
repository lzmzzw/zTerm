// Author: Liz
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

interface SshSecretInputProps {
  label: string;
  value: string;
  maskedPlaceholder?: boolean;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  onChange: (value: string) => void;
  onReveal?: () => Promise<boolean> | boolean;
}

export function SshSecretInput({
  label,
  value,
  visible,
  onVisibleChange,
  onChange,
  onReveal,
  maskedPlaceholder = false,
}: SshSecretInputProps) {
  const [revealing, setRevealing] = useState(false);
  const actionLabel = `${visible ? "隐藏" : "显示"}${label}`;

  async function handleToggleVisible() {
    if (visible) {
      onVisibleChange(false);
      return;
    }
    setRevealing(true);
    try {
      const canReveal = await onReveal?.();
      if (canReveal !== false) {
        onVisibleChange(true);
      }
    } finally {
      setRevealing(false);
    }
  }

  return (
    <div className="zt-secret-input">
      <input
        aria-label={label}
        type={visible ? "text" : "password"}
        value={value}
        placeholder={!visible && maskedPlaceholder ? "******" : undefined}
        autoComplete="new-password"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button type="button" aria-label={actionLabel} title={actionLabel} onClick={() => void handleToggleVisible()} disabled={revealing}>
        {visible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
