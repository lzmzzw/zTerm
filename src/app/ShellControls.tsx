// Author: Liz
import type { ReactNode } from "react";

export function PanelHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="zt-panel-header">
      <span>{title}</span>
      {action ? <div className="zt-panel-header-action">{action}</div> : null}
    </div>
  );
}

export function ToolButton({
  label,
  active,
  className,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  className?: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      aria-expanded={active}
      className={className}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}
