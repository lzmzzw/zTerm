// Author: Liz
import { Minus, Plus } from "lucide-react";
import { useEffect, useState } from "react";

interface ZtNumberInputProps {
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  onClear?: () => void;
}

export function ZtNumberInput({
  value,
  min = 0,
  max = 100,
  step = 1,
  ariaLabel,
  disabled = false,
  onChange,
  onClear,
}: ZtNumberInputProps) {
  const [text, setText] = useState(String(value ?? ""));
  useEffect(() => setText(String(value ?? "")), [value]);

  const clamp = (number: number) => Math.max(min, Math.min(max, number));
  const parsed = /^-?\d+$/.test(text.trim()) ? Number(text) : NaN;
  const current = Number.isSafeInteger(parsed) ? parsed : (value ?? min);

  function update(number: number) {
    const next = clamp(number);
    setText(String(next));
    if (next !== value) onChange(next);
  }

  function commit() {
    if (!text.trim() && onClear) {
      setText("");
      if (value !== null) onClear();
    } else if (Number.isSafeInteger(parsed)) {
      update(parsed);
    } else {
      setText(String(value ?? ""));
    }
  }

  return (
    <div className="zt-number-input">
      <input
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (next === "" && onClear) {
            if (value !== null) onClear();
            return;
          }
          // Keep intermediate text editable; only publish valid values to the form.
          const number = /^-?\d+$/.test(next.trim()) ? Number(next) : NaN;
          if (Number.isSafeInteger(number) && number >= min && number <= max) {
            if (number !== value) onChange(number);
          }
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            update(current + (event.key === "ArrowUp" ? step : -step));
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setText(String(value ?? ""));
          }
        }}
      />
      <div className="zt-number-input-buttons">
        <button
          type="button"
          aria-label={`${ariaLabel} +`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => update(current + step)}
          disabled={disabled || current >= max}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          aria-label={`${ariaLabel} −`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => update(current - step)}
          disabled={disabled || current <= min}
        >
          <Minus size={14} />
        </button>
      </div>
    </div>
  );
}
