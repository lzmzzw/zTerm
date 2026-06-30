// Author: Liz
import { describe, expect, it } from "vitest";

import { formatBytes, formatPercent, formatUptime, gpuMissingMessage, percentOf } from "./serverInfoFormatters";

describe("serverInfoFormatters", () => {
  it("formats resource values for monitor cards", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatPercent(12.345)).toBe("12.3%");
    expect(formatUptime(186400)).toBe("2 天 3 小时");
    expect(percentOf(25, 100)).toBe(25);
    expect(gpuMissingMessage("no_probe_command")).toContain("无法识别 GPU");
  });
});
