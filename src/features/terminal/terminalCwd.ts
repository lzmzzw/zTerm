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

interface TrackedTerminalInput {
  buffer: string;
  submittedCommands: string[];
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

export function trackTerminalInput(current: string, data: string): TrackedTerminalInput {
  if (data.startsWith("\x1b")) {
    return { buffer: current, submittedCommands: [] };
  }
  let buffer = current;
  const submittedCommands: string[] = [];
  let pendingCr = false;
  for (const character of data) {
    if (character === "\r") {
      submittedCommands.push(buffer);
      buffer = "";
      pendingCr = true;
    } else if (character === "\n") {
      if (!pendingCr) submittedCommands.push(buffer);
      buffer = "";
      pendingCr = false;
    } else if (character === "\x03") {
      buffer = "";
      pendingCr = false;
    } else if (character === "\b" || character === "\x7f") {
      buffer = Array.from(buffer).slice(0, -1).join("");
      pendingCr = false;
    } else if (character === "\t") {
      pendingCr = false;
    } else if (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) {
      buffer += character;
      pendingCr = false;
    }
  }
  return { buffer, submittedCommands };
}
