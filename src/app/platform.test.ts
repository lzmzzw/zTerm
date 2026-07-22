import { describe, expect, it } from "vitest";

import { currentDesktopPlatform, displayAccelerator } from "./platform";

describe("desktop platform helpers", () => {
  it("detects macOS without depending on a deprecated platform-only check", () => {
    expect(currentDesktopPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0" })).toBe("macos");
    expect(currentDesktopPlatform({ platform: "Win32", userAgent: "Mozilla/5.0" })).toBe("windows");
  });

  it("uses macOS modifier glyphs only for display", () => {
    expect(displayAccelerator("Meta+Shift+S", true)).toBe("⌘⇧S");
    expect(displayAccelerator("Ctrl+Shift+S", false)).toBe("Ctrl+Shift+S");
  });
});
