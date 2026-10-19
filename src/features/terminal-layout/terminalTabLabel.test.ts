import { describe, expect, it } from "vitest";
import { terminalTabLabel } from "./terminalTabLabel";
import type { PaneTerminalTab } from "./types";

describe("terminalTabLabel", () => {
  const tab: PaneTerminalTab = { id: "tab", title: "实验室", saved_session_id: "ssh", runtime_session_id: null };
  const labels = { ssh: "192.0.2.10" };
  it("keeps duplicate SSH sessions distinguishable", () => {
    expect(terminalTabLabel(tab, labels)).toBe("192.0.2.10");
    expect(terminalTabLabel({ ...tab, title: "实验室 (2)" }, labels)).toBe("192.0.2.10 (2)");
  });
  it("retains container identity and local shell names", () => {
    expect(terminalTabLabel({ ...tab, connection_source: "ssh_container", container_target: { id: "container", name: "web" } }, labels)).toBe("192.0.2.10 · web");
    expect(terminalTabLabel({ ...tab, saved_session_id: "local", title: "PowerShell" }, labels)).toBe("PowerShell");
    expect(terminalTabLabel(tab)).toBe("实验室");
  });
});
