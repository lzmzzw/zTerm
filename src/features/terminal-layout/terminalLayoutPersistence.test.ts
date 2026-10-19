import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeTauri } from "../../lib/tauriClient";
import { collectTerminalLayoutRestoreTargets } from "./terminalLayoutRestoreScheduler";
import { useTerminalLayoutStore } from "./terminalLayoutStore";
import { loadTerminalLayout, saveTerminalLayout, terminalLayoutSnapshot } from "./terminalLayoutPersistence";
vi.mock("../../lib/tauriClient", () => ({ invokeTauri: vi.fn() }));
describe("single current terminal layout persistence", () => {
  beforeEach(() => { vi.mocked(invokeTauri).mockReset(); });
  it("stores only the current layout with no name, runtime, command or restore metadata", () => {
    const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft()!;
    const leaf = draft.tabs[0].root;
    if (leaf.kind !== "leaf") throw new Error("expected leaf");
    leaf.terminal_tabs = [{ id: "t", title: "SSH", runtime_session_id: "runtime-secret", saved_session_id: "session-1",
      startup_command: "secret command", restore_status: "pending", restore_token: "token", visual_snapshot: {kind: "terminal_tail", text: "secret output", captured_at_ms: 1} }];
    const result = terminalLayoutSnapshot(draft);
    expect(Object.keys(result).sort()).toEqual(["active_tab_id", "tabs"]);
    expect(JSON.stringify(result)).not.toMatch(/runtime-secret|secret command|secret output|restore_token|restore_status/);
    expect(JSON.stringify(result)).toContain("session-1");
  });
  it("keeps empty panes empty rather than creating a local shell on restart", async () => {
    const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft()!;
    const snapshot = terminalLayoutSnapshot(draft);
    expect(JSON.stringify(snapshot)).toContain('"connection_source":"empty"');
    vi.mocked(invokeTauri).mockResolvedValueOnce(snapshot);
    const loaded = await loadTerminalLayout();
    expect(collectTerminalLayoutRestoreTargets(loaded!)).toEqual([]);
  });
  it("saves only the active root and falls back to the first root when the active id is missing", () => {
    const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft()!;
    const second = { ...draft.tabs[0], id: "second-root" };
    const multiple = { ...draft, tabs: [...draft.tabs, second], active_tab_id: second.id };
    expect(terminalLayoutSnapshot(multiple).tabs.map(tab => tab.id)).toEqual([second.id]);
    const fallback = terminalLayoutSnapshot({ ...multiple, active_tab_id: "missing" });
    expect(fallback.active_tab_id).toBe(draft.tabs[0].id);
    expect(fallback.tabs.map(tab => tab.id)).toEqual([draft.tabs[0].id]);
  });
  it("loads a single snapshot and assigns only local runtime metadata", async () => {
    const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft()!;
    vi.mocked(invokeTauri).mockResolvedValueOnce(terminalLayoutSnapshot(draft));
    const restored = await loadTerminalLayout();
    expect(invokeTauri).toHaveBeenCalledWith("terminal_layout_get");
    expect(restored?.tabs).toHaveLength(1);
    expect(restored?.active_tab_id).toBe(draft.active_tab_id);
  });
  it("serializes saves so the latest layout cannot be overwritten by an older request", async () => {
    let finish!: () => void;
    vi.mocked(invokeTauri).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const draft = useTerminalLayoutStore.getState().buildActiveTerminalLayoutDraft()!;
    const first = saveTerminalLayout(draft);
    const second = saveTerminalLayout({ ...draft, active_tab_id: "latest", tabs: [{ ...draft.tabs[0], id: "latest" }] });
    await Promise.resolve(); await Promise.resolve();
    expect(invokeTauri).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([first, second]);
    expect(invokeTauri).toHaveBeenLastCalledWith("terminal_layout_save", { snapshot: expect.objectContaining({active_tab_id: "latest"}) });
  });
});
