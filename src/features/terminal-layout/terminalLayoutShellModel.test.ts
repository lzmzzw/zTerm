// Author: Liz
import { describe, expect, it } from "vitest";
import type { PaneTerminalTab } from "./types";
import { isReusableConnectionTab } from "./terminalLayoutShellModel";

describe("connection tab model", () => {
  it("identifies reusable connection tabs without treating missing connections as reusable", () => {
    const baseTab: PaneTerminalTab = {
      id: "tab-1",
      title: "空终端",
      runtime_session_id: null,
      saved_session_id: null,
    };

    expect(isReusableConnectionTab(baseTab)).toBe(true);
    expect(isReusableConnectionTab({ ...baseTab, connection_source: "missing" })).toBe(false);
    expect(isReusableConnectionTab({ ...baseTab, runtime_session_id: "runtime-1" })).toBe(false);
    expect(isReusableConnectionTab({ ...baseTab, saved_session_id: "session-1" })).toBe(false);
    expect(isReusableConnectionTab({ ...baseTab, connection_source: "external_local", restore_status: "pending" })).toBe(false);
    expect(isReusableConnectionTab({ ...baseTab, restore_status: "queued" })).toBe(false);
  });
});
