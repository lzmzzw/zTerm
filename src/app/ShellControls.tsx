// Author: Liz
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function PanelHeader({ title, action, onClose }: { title: string; action?: ReactNode; onClose?: () => void }) {
  return (
    <div className="zt-panel-header">
      <span>{title}</span>
      {action || onClose ? <div className="zt-panel-header-action">{action}{onClose ? <button type="button" className="zt-panel-action-button" aria-label={`关闭${title}`} title={`关闭${title}`} onClick={onClose}><X size={16} aria-hidden="true" /></button> : null}</div> : null}
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
