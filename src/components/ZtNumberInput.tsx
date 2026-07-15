// Author: Liz
import { Minus, Plus } from "lucide-react";
import { useCallback, useRef } from "react";

interface ZtNumberInputProps {
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

export function ZtNumberInput({
  value,
  min = 0,
  max = 100,
  step = 1,
  ariaLabel,
  disabled = false,
  onChange,
}: ZtNumberInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);

  const increment = useCallback(() => {
    onChange(clamp((value ?? 0) + step));
  }, [value, step, clamp, onChange]);

  const decrement = useCallback(() => {
    onChange(clamp((value ?? 0) - step));
  }, [value, step, clamp, onChange]);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const parsed = Number(event.currentTarget.value);
      if (!Number.isNaN(parsed)) {
        onChange(clamp(parsed));
      }
    },
    [clamp, onChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        increment();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        decrement();
      }
    },
    [increment, decrement],
  );

  return (
    <div className="zt-number-input">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        value={value ?? ""}
        disabled={disabled}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
      />
      <div className="zt-number-input-buttons">
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={increment}
          disabled={disabled || (value != null && value >= max)}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={decrement}
          disabled={disabled || (value != null && value <= min)}
        >
          <Minus size={14} />
        </button>
      </div>
    </div>
  );
}
