// Author: Liz
import type { ShortcutBinding, ShortcutDefinition } from "./settingsStore";

export function bindingsWithDefaults(definitions: ShortcutDefinition[], bindings: ShortcutBinding[]) {
  const byAction = new Map(bindings.map((binding) => [binding.action_id, binding]));
  return definitions.map((definition) => ({
    definition,
    binding: byAction.get(definition.action_id) ?? {
      action_id: definition.action_id,
      accelerator: definition.default_accelerator,
      scope: definition.scope,
    },
  }));
}

export function detectShortcutConflicts(bindings: ShortcutBinding[]) {
  const seen = new Map<string, string>();
  const conflicts = new Set<string>();
  bindings
    .filter((binding) => binding.accelerator.trim())
    .forEach((binding) => {
      const key = normalizeAccelerator(binding.accelerator);
      const previous = seen.get(key);
      if (previous) {
        conflicts.add(previous);
        conflicts.add(binding.action_id);
      } else {
        seen.set(key, binding.action_id);
      }
    });
  return conflicts;
}

export function shortcutMatches(event: KeyboardEvent, accelerator: string) {
  const parts = normalizeAccelerator(accelerator).split("+").filter(Boolean);
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  return (
    event.ctrlKey === modifiers.has("ctrl") &&
    event.shiftKey === modifiers.has("shift") &&
    event.altKey === modifiers.has("alt") &&
    event.metaKey === modifiers.has("meta") &&
    normalizeKey(event.key) === key
  );
}

export function acceleratorFromKeyboardEvent(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">) {
  const key = normalizeKey(event.key);
  if (!key || key === "ctrl" || key === "shift" || key === "alt" || key === "meta") {
    return null;
  }
  const parts = [
    event.ctrlKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
    event.metaKey ? "Meta" : null,
    displayKey(key),
  ].filter((part): part is string => Boolean(part));
  return parts.join("+");
}

function normalizeAccelerator(value: string) {
  return value
    .split("+")
    .map((part) => normalizeKey(part.trim()))
    .filter(Boolean)
    .join("+");
}

function displayKey(value: string) {
  if (value === "space") return "Space";
  if (value.length === 1) return value.toUpperCase();
  return value
    .split("-")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join("-");
}

function normalizeKey(value: string) {
  const lower = value.toLowerCase();
  if (lower === "control") return "ctrl";
  if (lower === " ") return "space";
  return lower;
}
