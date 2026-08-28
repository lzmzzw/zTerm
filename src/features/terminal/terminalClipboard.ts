// Author: Liz

const ANSI_STYLE_SEQUENCE_PATTERN =
  /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]|\u009d(?:[^\x07\x1b\u009c]|\x1b(?!\\))*?(?:\x07|\x1b\\|\u009c)/g;
const UNSAFE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const UNICODE_DIRECTIONAL_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BYTE_ORDER_MARK_PATTERN = /\ufeff/g;

export interface ClipboardTextReader {
  readText(): Promise<string>;
}

export function sanitizeTerminalPaste(text: string) {
  return text
    .replace(ANSI_STYLE_SEQUENCE_PATTERN, "")
    .replace(UNSAFE_CONTROL_CHARACTER_PATTERN, "")
    .replace(UNICODE_DIRECTIONAL_CONTROL_PATTERN, "")
    .replace(BYTE_ORDER_MARK_PATTERN, "");
}

export async function readClipboardTextWithRetry(
  clipboard: ClipboardTextReader | null | undefined,
  attempts = 3,
  retryDelayMs = 40,
) {
  if (!clipboard || typeof clipboard.readText !== "function") {
    return "";
  }

  const maxAttempts = Math.max(1, attempts);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await clipboard.readText();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(0, retryDelayMs));
        });
      }
    }
  }
  throw lastError;
}
