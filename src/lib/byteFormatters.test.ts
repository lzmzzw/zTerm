// Author: Liz
import { describe, expect, it } from "vitest";

import { formatBytes } from "./byteFormatters";

describe("formatBytes", () => {
  it("formats bytes using binary units and monitor defaults", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(42)).toBe("42 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
  });

  it("can cap the largest displayed unit for file list compatibility", () => {
    expect(formatBytes(1024 * 1024 * 1024, { maxUnit: "MB" })).toBe("1024.0 MB");
  });
});
