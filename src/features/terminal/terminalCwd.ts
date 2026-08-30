// Author: Liz
export function parseOsc7Cwd(payload: string): string | null {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || !url.pathname.startsWith("/")) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(url.pathname);
    if ([...decoded].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      return null;
    }
    if (/^\/[A-Za-z]:\//.test(decoded)) {
      return decoded.slice(1).replaceAll("/", "\\");
    }
    return decoded;
  } catch {
    return null;
  }
}

interface SimpleCdTarget {
  target: string | null;
}

export function parseSimpleCdTarget(commandLine: string): SimpleCdTarget | null {
  const match = commandLine.trim().match(/^cd(?:\s+(.*))?$/i);
  if (!match) return null;
  const rawTarget = match[1]?.trim();
  if (!rawTarget) return { target: null };
  if (/[;&|`$*?<>]/.test(rawTarget)) return null;

  let target = rawTarget;
  const quote = target[0];
  if (quote === "\"" || quote === "'") {
    if (target.length < 2 || target.at(-1) !== quote) return null;
    target = target.slice(1, -1);
  } else if (/\s/.test(target)) {
    return null;
  }
  if (!target || target === "-" || /[\r\n\0]/.test(target)) return null;
  return { target };
}
