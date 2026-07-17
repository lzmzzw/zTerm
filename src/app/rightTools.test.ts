// Author: Liz
import { describe, expect, it } from "vitest";

import {
  rightToolFromShortcutActionId,
  rightToolLabelKey,
  rightToolRailOrder,
  visibleRightTools,
} from "./rightTools";

describe("rightTools", () => {
  it("keeps the right rail order and label keys stable", () => {
    expect(rightToolRailOrder).toEqual(["monitor", "history", "files", "containers", "tunnels", "agent"]);
    expect(rightToolLabelKey("files")).toBe("sftpFiles");
    expect(rightToolLabelKey("containers")).toBe("sshContainers");
    expect(rightToolLabelKey("tunnels")).toBe("sshTunnels");
    expect(rightToolLabelKey("history")).toBe("history");
    expect(rightToolLabelKey("monitor")).toBe("resourceMonitor");
    expect(rightToolLabelKey("agent")).toBe("agent");
  });

  it("shows connection-scoped tools only for the active opened connection kind", () => {
    expect(visibleRightTools("none")).toEqual(["monitor", "agent"]);
    expect(visibleRightTools("local")).toEqual(["monitor", "history", "agent"]);
    expect(visibleRightTools("ssh")).toEqual([
      "monitor",
      "history",
      "files",
      "containers",
      "tunnels",
      "agent",
    ]);
    expect(visibleRightTools("ssh_transient_multi")).toEqual([
      "monitor",
      "history",
      "files",
      "containers",
      "tunnels",
      "agent",
    ]);
    expect(visibleRightTools("ssh_transient_restricted")).toEqual(["monitor", "history", "agent"]);
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
