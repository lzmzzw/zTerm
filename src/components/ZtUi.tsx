// Author: Liz
import {
  Check,
  ChevronDown,
  Minus,
  Plus,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";
import { resolveContextMenuPosition } from "./contextMenuPosition";

type ZtDensity = "dense" | "default" | "large";
type ZtControlSize = "dense" | "default" | "form";
type ZtButtonVariant = "default" | "primary" | "danger" | "ghost";
type ZtDialogSize = "compact" | "medium" | "large";

export const ztIconSizes = {
  dense: 14,
  default: 16,
  large: 18,
} as const;

const iconMap = {
  check: Check,
  chevronDown: ChevronDown,
  minus: Minus,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  x: X,
} satisfies Record<string, LucideIcon>;

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function ZtIcon({
  name,
  size = "dense",
  className,
}: {
  name: keyof typeof iconMap;
  size?: keyof typeof ztIconSizes;
  className?: string;
}) {
  const Icon = iconMap[name];
  return (
    <Icon
      size={ztIconSizes[size]}
      aria-hidden="true"
      className={classNames("zt-icon", `zt-icon-${size}`, className)}
    />
  );
}

export function ZtButton({
  size = "default",
  variant = "default",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: Exclude<ZtDensity, "large"> | "form";
  variant?: ZtButtonVariant;
}) {
  return (
    <button
      {...props}
      type={type}
      className={classNames("zt-button", `zt-button-${size}`, `zt-button-${variant}`, className)}
    />
  );
}

export function ZtIconButton({
  ariaLabel,
  title,
  size = "default",
  variant = "ghost",
  className,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  ariaLabel: string;
  size?: ZtDensity;
  variant?: ZtButtonVariant;
}) {
  return (
    <button
      {...props}
      type={type}
      aria-label={ariaLabel}
      title={title ?? ariaLabel}
      className={classNames("zt-icon-button", `zt-icon-button-${size}`, `zt-button-${variant}`, className)}
    />
  );
}

type ZtInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  controlSize?: ZtControlSize;
};

type ZtTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  controlSize?: ZtControlSize;
};

export const ZtInput = forwardRef<HTMLInputElement, ZtInputProps>(function ZtInput(
  { controlSize = "form", className, type = "text", ...props },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      type={type}
      className={classNames("zt-input", `zt-input-${controlSize}`, className)}
    />
  );
});

export const ZtTextarea = forwardRef<HTMLTextAreaElement, ZtTextareaProps>(function ZtTextarea(
  { controlSize = "form", className, ...props },
  ref,
) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={classNames("zt-textarea", `zt-textarea-${controlSize}`, className)}
    />
  );
});

export function ZtModalBackdrop({ className, children, onClick, ...props }: HTMLAttributes<HTMLDivElement>) {
  const [attention, setAttention] = useState(false);
  const attentionFrameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (attentionFrameRef.current !== null) {
        window.cancelAnimationFrame(attentionFrameRef.current);
      }
    },
    [],
  );

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) {
      return;
    }

    setAttention(false);
    if (attentionFrameRef.current !== null) {
      window.cancelAnimationFrame(attentionFrameRef.current);
    }
    attentionFrameRef.current = window.requestAnimationFrame(() => {
      attentionFrameRef.current = null;
      setAttention(true);
    });
  }

  return (
    <div
      {...props}
      className={classNames("zt-dialog-backdrop", attention && "is-attention", className)}
      onClick={handleClick}
    >
      {children}
    </div>
  );
}

export function ZtDialog({
  title,
  ariaLabel,
  size = "large",
  onClose,
  closeLabel,
  closeDisabled = false,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  ariaLabel: string;
  size?: ZtDialogSize;
  onClose?: () => void;
  closeLabel?: string;
  closeDisabled?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const titleText = typeof title === "string" ? title : ariaLabel;
  return (
    <ZtModalBackdrop>
      <section
        className={classNames("zt-dialog", `zt-dialog-${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <header className="zt-dialog-header">
          <strong className="zt-dialog-title">{title}</strong>
          {onClose ? (
            <ZtIconButton
              ariaLabel={closeLabel ?? `关闭${titleText}`}
              className="zt-dialog-close"
              size="default"
              disabled={closeDisabled}
              onClick={onClose}
            >
              <ZtIcon name="x" size="dense" />
            </ZtIconButton>
          ) : null}
        </header>
        <div className={classNames("zt-dialog-body", bodyClassName)}>{children}</div>
        {footer ? <footer className="zt-dialog-footer">{footer}</footer> : null}
      </section>
    </ZtModalBackdrop>
  );
}

export function ZtConfirmDialog({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  danger = false,
  busy = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const formId = useId();
  return (
    <ZtDialog
      ariaLabel={title}
      title={title}
      size="compact"
      onClose={onCancel}
      footer={
        <>
          <ZtButton disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </ZtButton>
          <ZtButton form={formId} type="submit" disabled={busy} variant={danger ? "danger" : "primary"}>
            {confirmLabel}
          </ZtButton>
        </>
      }
    >
      <form
        id={formId}
        className="zt-dialog-message"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        {typeof message === "string" ? <p>{message}</p> : message}
      </form>
    </ZtDialog>
  );
}

export function ZtPromptDialog({
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
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

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
    <ZtDialog
      ariaLabel={title}
      title={title}
      size="compact"
      onClose={onCancel}
      footer={
        <>
          <ZtButton aria-label={`取消${title}`} onClick={onCancel}>
            取消
          </ZtButton>
          <ZtButton aria-label={`确认${title}`} form={formId} type="submit" variant="primary">
            {confirmLabel}
          </ZtButton>
        </>
      }
    >
      <form id={formId} className="zt-dialog-form" onSubmit={handleSubmit}>
        <label>
          <span>{label}</span>
          <ZtInput
            ref={inputRef}
            aria-label={label}
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </label>
        {error ? <p className="zt-session-error">{error}</p> : null}
      </form>
    </ZtDialog>
  );
}

export const ZtFloatingSurface = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & {
    style?: CSSProperties;
  }
>(function ZtFloatingSurface({ className, children, ...props }, ref) {
  return (
    <div {...props} ref={ref} className={classNames("zt-floating-surface", className)}>
      {children}
    </div>
  );
});

export function ZtContextMenu({
  x,
  y,
  style,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "style"> & {
  x: number;
  y: number;
  style?: CSSProperties;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      const nextPosition = resolveContextMenuPosition({
        anchor: { x, y },
        menu: { width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setPosition((current) =>
        current.left === nextPosition.left && current.top === nextPosition.top ? current : nextPosition,
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [x, y]);

  return <ZtFloatingSurface {...props} ref={menuRef} style={{ ...style, ...position }} />;
}

export function ZtSwitch({
  label,
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <label className={classNames("zt-switch", disabled && "is-disabled")}>
      <input
        className="zt-switch-input"
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="zt-switch-control" aria-hidden="true" />
      <span className="zt-switch-label">{label}</span>
    </label>
  );
}

export function ZtCheckbox({
  label,
  checked,
  onChange,
  disabled = false,
  ariaLabel,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <label className={classNames("zt-checkbox", disabled && "is-disabled", className)}>
      <input
        className="zt-checkbox-input"
        type="checkbox"
        aria-label={ariaLabel}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="zt-checkbox-control" aria-hidden="true" />
      <span className="zt-checkbox-label">{label}</span>
    </label>
  );
}

export function ZtSlider({
  ariaLabel,
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "min" | "max" | "step" | "onChange" | "aria-label"> & {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      {...props}
      className={classNames("zt-slider-input", props.className)}
      type="range"
      aria-label={ariaLabel}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(Number(event.currentTarget.value))}
    />
  );
}

export function ZtTabs({
  ariaLabel,
  value,
  items,
  onChange,
  orientation = "horizontal",
}: {
  ariaLabel: string;
  value: string;
  items: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
  onChange: (value: string) => void;
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      className={classNames("zt-tabs", `zt-tabs-${orientation}`)}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-label={`${ariaLabel} ${item.label}`}
          aria-selected={item.value === value}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function ZtSegmentedControl({
  ariaLabel,
  value,
  items,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  items: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="zt-segmented-control" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-label={`${ariaLabel} ${item.label}`}
          aria-selected={item.value === value}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
