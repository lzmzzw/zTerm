// Author: Liz
import { describe, expect, it, vi } from "vitest";

import { readClipboardTextWithRetry, sanitizeTerminalPaste } from "./terminalClipboard";

describe("terminalClipboard", () => {
  it("strips terminal styling and unsafe controls while preserving plain text layout and Unicode", () => {
    const text =
      "\ufeff你好\tworld\r\n\x1b[31mred\x1b[0m\x00safe\u202ecommand\u2066\u0007";

    expect(sanitizeTerminalPaste(text)).toBe("你好\tworld\r\nredsafecommand");
  });

  it("briefly retries clipboard reads that fail because the clipboard is temporarily unavailable", async () => {
    const readText = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("clipboard busy"))
      .mockResolvedValue("plain text");

    await expect(readClipboardTextWithRetry({ readText }, 3, 0)).resolves.toBe("plain text");
    expect(readText).toHaveBeenCalledTimes(2);
  });

  it("returns an empty string when the clipboard API is unavailable", async () => {
    await expect(readClipboardTextWithRetry(undefined)).resolves.toBe("");
  });
});
