// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDefaultLocalTerminal } from "./defaultLocalTerminal";
import { useTerminalLayoutStore } from "../features/terminal-layout/terminalLayoutStore";
import type { RuntimeSessionInfo } from "../features/terminal/terminalStore";

const runtime: RuntimeSessionInfo = {
  runtime_session_id: "local-1", saved_session_id: null, pane_id: "pane-1", title: "Default",
  kind: "local", initial_cwd: null, history_scope_kind: null, history_scope_id: null, cols: 80, rows: 24,
};
describe("default local terminal fallback", () => {
  beforeEach(() => {
    useTerminalLayoutStore.getState().restoreWorkbenchDefinition({ id: "default-terminalLayout", name: "Terminal", status: "running", sort_order: 0, created_at_ms: 1, updated_at_ms: 1, active_tab_id: "tab-1", tabs: [{
      id: "tab-1", title: "Terminal", active_pane_id: "pane-1", sort_order: 0, created_at_ms: 1, updated_at_ms: 1,
      root: { kind: "leaf", id: "pane-1", title: "Empty", runtime_session_id: null, saved_session_id: null },
    }] });
  });
  it("opens once even while another check runs before PTY creation finishes", async () => {
    let resolve!: (runtime: RuntimeSessionInfo) => void;
    const open = vi.fn(() => new Promise<RuntimeSessionInfo>(done => { resolve = done; }));
    const close = vi.fn().mockResolvedValue(undefined);
    const pending = ensureDefaultLocalTerminal(open, close);
    await ensureDefaultLocalTerminal(open, close);
    expect(open).toHaveBeenCalledTimes(1);
    resolve(runtime);
    await pending;
    await ensureDefaultLocalTerminal(open, close);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("closes an opened PTY if its target was removed while opening", async () => {
    let resolve!: (runtime: RuntimeSessionInfo) => void;
    const close = vi.fn().mockResolvedValue(undefined);
    const pending = ensureDefaultLocalTerminal(() => new Promise(done => { resolve = done; }), close);
    useTerminalLayoutStore.getState().splitActivePane("vertical");
    useTerminalLayoutStore.getState().closePane("pane-1");
    resolve(runtime);
    await pending;
    expect(close).toHaveBeenCalledWith("local-1");
  });
  it("records a failed opening and permits an explicit later retry", async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error("PTY failed")).mockResolvedValue(runtime);
    const close = vi.fn();
    await expect(ensureDefaultLocalTerminal(open, close)).rejects.toThrow("PTY failed");
    const root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind === "leaf" && root.terminal_tabs?.[0].restore_status).toBe("failed");
    await ensureDefaultLocalTerminal(open, close);
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("retains an existing connection in another pane", async () => {
    const state = useTerminalLayoutStore.getState();
    state.bindRuntimeToPane(runtime);
    state.splitActivePane("vertical");
    const open = vi.fn();
    await ensureDefaultLocalTerminal(open, vi.fn());
    expect(open).not.toHaveBeenCalled();
  });
});
