// Author: Liz
import { describe, expect, it } from "vitest";

import { rightToolFromShortcutActionId, rightToolLabelKey, rightToolRailOrder } from "./rightTools";

describe("rightTools", () => {
  it("keeps the right rail order and label keys stable", () => {
    expect(rightToolRailOrder).toEqual(["files", "containers", "tunnels", "history", "monitor", "agent"]);
    expect(rightToolLabelKey("files")).toBe("sftpFiles");
    expect(rightToolLabelKey("containers")).toBe("sshContainers");
    expect(rightToolLabelKey("tunnels")).toBe("sshTunnels");
    expect(rightToolLabelKey("history")).toBe("history");
    expect(rightToolLabelKey("monitor")).toBe("resourceMonitor");
    expect(rightToolLabelKey("agent")).toBe("agent");
  });

  it("maps only currently supported right tool shortcut actions", () => {
    expect(rightToolFromShortcutActionId("right_tool.files")).toBe("files");
    expect(rightToolFromShortcutActionId("right_tool.history")).toBe("history");
    expect(rightToolFromShortcutActionId("right_tool.monitor")).toBe("monitor");
    expect(rightToolFromShortcutActionId("right_tool.agent")).toBe(null);
    expect(rightToolFromShortcutActionId("right_tool.transfer")).toBe(null);
    expect(rightToolFromShortcutActionId("terminal.new_tab")).toBe(null);
  });
});
