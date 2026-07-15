// Author: Liz
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ZtFloatingSurface } from "./ZtUi";

export interface ZtSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  kind?: "option" | "group";
  depth?: number;
  icon?: ReactNode;
  trailing?: ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}

interface ZtSelectProps {
  value: string;
  options: ZtSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  searchable?: boolean;
  className?: string;
  tree?: boolean;
  selectedLabel?: string;
}

const SEARCH_THRESHOLD = 6;

function isSelectableOption(option: ZtSelectOption) {
  return option.kind !== "group" && !option.disabled;
}

export function ZtSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  disabled = false,
  searchable = false,
  className,
  tree = false,
  selectedLabel,
}: ZtSelectProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const selectedOption = options.find((option) => option.value === value);
  const displayLabel = selectedOption?.label ?? selectedLabel;
  const showSearch = searchable && options.length > SEARCH_THRESHOLD;

  const filteredOptions = useMemo(() => {
    const normalized = searchTerm.trim().toLocaleLowerCase();
    if (!showSearch || !normalized) return options;
    return options.filter((option) => {
      const label = option.label.toLocaleLowerCase();
      const description = option.description?.toLocaleLowerCase() ?? "";
      return label.includes(normalized) || description.includes(normalized);
    });
  }, [options, searchTerm, showSearch]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = filteredOptions.findIndex((option) => option.value === value && isSelectableOption(option));
    if (selectedIndex >= 0) {
      setActiveIndex(selectedIndex);
      return;
    }
    const firstEnabledIndex = filteredOptions.findIndex(isSelectableOption);
    setActiveIndex(firstEnabledIndex >= 0 ? firstEnabledIndex : 0);
  }, [filteredOptions, open, value]);

  useEffect(() => {
    if (!open) return;
    updatePanelPosition();
    if (showSearch) {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }

    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      closePanel();
    }

    function onWindowResize() {
      updatePanelPosition();
    }

    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("scroll", onWindowResize, true);
    return () => {
      document.removeEventListener("click", onDocumentClick, true);
      window.removeEventListener("resize", onWindowResize);
      window.removeEventListener("scroll", onWindowResize, true);
    };
  }, [open, showSearch]);

  function updatePanelPosition() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 6;
    const maxHeight = Math.min(280, Math.max(180, window.innerHeight - 24));
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUpward = spaceBelow < 220 && spaceAbove > spaceBelow;
    setPanelStyle({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      width: rect.width,
      maxHeight,
      ...(openUpward ? { bottom: Math.max(8, window.innerHeight - rect.top + gap) } : { top: rect.bottom + gap }),
    });
  }

  function openPanel() {
    if (disabled) return;
    setSearchTerm("");
    setOpen(true);
  }

  function closePanel() {
    setOpen(false);
    setSearchTerm("");
  }

  function selectOption(option: ZtSelectOption | undefined) {
    if (!option || !isSelectableOption(option)) return;
    onChange(option.value);
    closePanel();
    triggerRef.current?.focus();
  }

  function moveActive(offset: -1 | 1) {
    if (!filteredOptions.length) return;
    let nextIndex = activeIndex;
    for (let step = 0; step < filteredOptions.length; step += 1) {
      nextIndex = (nextIndex + offset + filteredOptions.length) % filteredOptions.length;
      if (filteredOptions[nextIndex] && isSelectableOption(filteredOptions[nextIndex])) {
        setActiveIndex(nextIndex);
        return;
      }
    }
  }

  function handleKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (disabled) return;
    if (event.key === "Tab") return;
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closePanel();
        triggerRef.current?.focus();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openPanel();
      } else {
        moveActive(1);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openPanel();
      } else {
        moveActive(-1);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        openPanel();
      } else {
        selectOption(filteredOptions[activeIndex]);
      }
    }
  }

  const activeOption = filteredOptions[activeIndex];
  const activeId = activeOption ? `${id}-option-${activeOption.value}` : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-listbox` : undefined}
        aria-activedescendant={open ? activeId : undefined}
        className={["zt-select-trigger", className].filter(Boolean).join(" ")}
        disabled={disabled}
        value={value}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={handleKeyboard}
      >
        <span className={displayLabel ? "zt-select-value" : "zt-select-placeholder"}>{displayLabel ?? placeholder}</span>
        <span className="zt-select-chevron" aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <ZtFloatingSurface
              ref={panelRef}
              className={tree ? "zt-select-popover zt-select-tree-popover" : "zt-select-popover"}
              style={panelStyle}
            >
              {showSearch ? (
                <div className="zt-select-search-wrap">
                  <input
                    ref={searchRef}
                    aria-label="搜索选择项"
                    className="zt-select-search"
                    value={searchTerm}
                    onChange={(event) => setSearchTerm(event.currentTarget.value)}
                    onKeyDown={handleKeyboard}
                    placeholder="搜索"
                  />
                </div>
              ) : null}
              <div id={`${id}-listbox`} className="zt-select-list" role="listbox" aria-label={ariaLabel}>
                {filteredOptions.length > 0 ? (
                  filteredOptions.map((option, index) => {
                    const depthStyle = { "--zt-session-tree-depth": option.depth ?? 0 } as CSSProperties;
                    if (option.kind === "group") {
                      return (
                        <button
                          type="button"
                          key={option.value}
                          className="zt-select-tree-row zt-select-tree-group"
                          aria-label={`${option.collapsed ? "展开" : "折叠"}分组 ${option.label}`}
                          aria-expanded={!option.collapsed}
                          data-session-tree-depth={option.depth ?? 0}
                          style={depthStyle}
                          onClick={option.onToggle}
                        >
                          {option.icon ? <span className="zt-select-tree-icon">{option.icon}</span> : null}
                          <span className="zt-select-option-label">{option.label}</span>
                          {option.trailing ? <span className="zt-select-tree-trailing">{option.trailing}</span> : null}
                        </button>
                      );
                    }
                    const selected = option.value === value;
                    const active = index === activeIndex;
                    return (
                      <button
                        id={`${id}-option-${option.value}`}
                        key={option.value}
                        type="button"
                        role="option"
                        data-value={option.value}
                        aria-selected={selected}
                        disabled={option.disabled}
                        className={[
                          "zt-select-option",
                          tree ? "zt-select-tree-row zt-select-tree-option" : "",
                          selected ? "is-selected" : "",
                          active ? "is-active" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => selectOption(option)}
                        data-session-tree-depth={option.depth ?? 0}
                        style={tree ? depthStyle : undefined}
                      >
                        {option.icon ? <span className="zt-select-tree-icon">{option.icon}</span> : null}
                        <span className="zt-select-option-label">{option.label}</span>
                        {option.description ? <span className="zt-select-option-description">{option.description}</span> : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="zt-select-empty">没有匹配项</div>
                )}
              </div>
            </ZtFloatingSurface>,
            document.body,
          )
        : null}
    </>
  );
}
