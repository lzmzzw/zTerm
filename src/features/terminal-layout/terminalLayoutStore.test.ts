// Author: Liz
import { describe, expect, it } from "vitest";

import { useTerminalLayoutStore } from "./terminalLayoutStore";
import { DEFAULT_TERMINAL_LAYOUT_ID } from "./terminalLayoutConstants";
import type { PaneNode, TerminalLayoutRuntime } from "./types";

function runtimeTerminalLayout(id: string, runtimeSessionId: string): TerminalLayoutRuntime {
  const now = 1;
  return {
    id,
    name: id === "terminalLayout-a" ? "运维巡检" : "发布窗口",
    status: "running",
    active_tab_id: `${id}-tab-1`,
    activeTabId: `${id}-tab-1`,
    sort_order: id === "terminalLayout-a" ? 0 : 1,
    created_at_ms: now,
    updated_at_ms: now,
    tabs: [
      {
        id: `${id}-tab-1`,
        title: "主工作台",
        active_pane_id: `${id}-pane-1`,
        root: {
          kind: "leaf",
          id: `${id}-pane-1`,
          title: "生产机",
          runtime_session_id: runtimeSessionId,
          saved_session_id: "session-1",
          active_terminal_tab_id: `${id}-pane-1-tab-1`,
          terminal_tabs: [
            {
              id: `${id}-pane-1-tab-1`,
              title: "生产机",
              runtime_session_id: runtimeSessionId,
              saved_session_id: "session-1",
              connection_source: "saved_session",
              path: "/srv/app",
              startup_command: "source ./env.sh",
              restore_status: "connected",
              restore_error: null,
            },
          ],
        },
        sort_order: 0,
        created_at_ms: now,
        updated_at_ms: now,
      },
    ],
  };
}

function leafPaneIds(root: PaneNode): string[] {
  if (root.kind === "leaf") return [root.id];
  return [...leafPaneIds(root.first), ...leafPaneIds(root.second)];
}


describe("terminalLayoutStore pane tabs", () => {
  it("reorders pane tabs and moves them across split panes while allowing an empty source pane", () => {
    useTerminalLayoutStore.setState({
      tabs: [{
        id: "tab-1", title: "主终端布局", active_pane_id: "pane-a", sort_order: 0, created_at_ms: 1, updated_at_ms: 1,
        root: {
          kind: "split", id: "split-root", direction: "horizontal", ratio: 0.5,
          first: {
            kind: "leaf", id: "pane-a", title: "A", runtime_session_id: "runtime-a", saved_session_id: "session-a",
            active_terminal_tab_id: "pane-a-tab-1",
            terminal_tabs: [
              { id: "pane-a-tab-1", title: "A", runtime_session_id: "runtime-a", saved_session_id: "session-a" },
              { id: "pane-a-tab-2", title: "B", runtime_session_id: "runtime-b", saved_session_id: "session-b" },
            ],
          },
          second: {
            kind: "leaf", id: "pane-b", title: "C", runtime_session_id: "runtime-c", saved_session_id: "session-c",
            active_terminal_tab_id: "pane-b-tab-1",
            terminal_tabs: [{ id: "pane-b-tab-1", title: "C", runtime_session_id: "runtime-c", saved_session_id: "session-c" }],
          },
        },
      }],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().movePaneTab("pane-a", "pane-a-tab-2", "pane-a", "pane-a-tab-1");
    let root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split" || root.first.kind !== "leaf" || root.second.kind !== "leaf") return;
    expect(root.first.terminal_tabs?.map((tab) => tab.id)).toEqual(["pane-a-tab-2", "pane-a-tab-1"]);

    useTerminalLayoutStore.getState().movePaneTab("pane-a", "pane-a-tab-2", "pane-b", "pane-b-tab-1");
    root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split" || root.first.kind !== "leaf" || root.second.kind !== "leaf") return;
    expect(root.first.terminal_tabs?.map((tab) => tab.title)).toEqual(["A"]);
    expect(root.second.terminal_tabs?.map((tab) => tab.id)).toEqual(["pane-a-tab-2", "pane-b-tab-1"]);
    expect(root.second.active_terminal_tab_id).toBe("pane-a-tab-2");

    useTerminalLayoutStore.getState().movePaneTab("pane-a", "pane-a-tab-1", "pane-b", null);
    root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split" || root.first.kind !== "leaf" || root.second.kind !== "leaf") return;
    expect(root.first.terminal_tabs).toEqual([]);
    expect(root.second.terminal_tabs?.map((tab) => tab.id)).toEqual(["pane-a-tab-2", "pane-b-tab-1", "pane-a-tab-1"]);
  });


  it("clears only the successfully closed runtime binding from the live workbench", () => {
    const workbench = runtimeTerminalLayout(DEFAULT_TERMINAL_LAYOUT_ID, "runtime-current");
    useTerminalLayoutStore.setState({
      runtime: workbench,
      activeTerminalLayoutId: DEFAULT_TERMINAL_LAYOUT_ID,
      tabs: workbench.tabs,
      activeTabId: workbench.activeTabId,
    });

    useTerminalLayoutStore.getState().clearRuntimeSession("runtime-current");

    const root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root).toMatchObject({ kind: "leaf", runtime_session_id: null });
    if (root.kind !== "leaf") return;
    expect(root.terminal_tabs?.[0]).toMatchObject({
      runtime_session_id: null,
      saved_session_id: "session-1",
      restore_status: null,
    });
  });










  it("updates one pane terminal tab restore state in the live workbench", () => {
    const terminalLayoutA = runtimeTerminalLayout("terminalLayout-a", "runtime-a");
    useTerminalLayoutStore.setState({
      runtime: terminalLayoutA,
      activeTerminalLayoutId: terminalLayoutA.id,
      tabs: terminalLayoutA.tabs,
      activeTabId: terminalLayoutA.activeTabId,
    });

    useTerminalLayoutStore.getState().updatePaneTerminalTab(
      "terminalLayout-a",
      "terminalLayout-a-tab-1",
      "terminalLayout-a-pane-1",
      "terminalLayout-a-pane-1-tab-1",
      {
        restore_status: "failed",
        restore_error: "连接已缺失",
      },
    );

    const state = useTerminalLayoutStore.getState();
    expect(state.activeTerminalLayoutId).toBe("terminalLayout-a");
    expect(state.tabs[0].id).toBe("terminalLayout-a-tab-1");
    const updatedTerminalLayout = state.runtime;
    expect(updatedTerminalLayout?.tabs[0].root.kind).toBe("leaf");
    if (!updatedTerminalLayout || updatedTerminalLayout.tabs[0].root.kind !== "leaf") return;
    expect(updatedTerminalLayout.tabs[0].root.terminal_tabs?.[0]).toMatchObject({
      restore_status: "failed",
      restore_error: "连接已缺失",
    });
  });

  it("adds a tab inside the active pane without replacing the split terminalLayout tab", () => {
    useTerminalLayoutStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "新建终端",
          active_pane_id: "pane-a",
          root: {
            kind: "split",
            id: "split-root",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              kind: "leaf",
              id: "pane-a",
              title: "1.cmd",
              runtime_session_id: null,
              saved_session_id: null,
              active_terminal_tab_id: "pane-a-tab-1",
              terminal_tabs: [
                {
                  id: "pane-a-tab-1",
                  title: "1.cmd",
                  runtime_session_id: null,
                  saved_session_id: null,
                },
              ],
            },
            second: {
              kind: "leaf",
              id: "pane-b",
              title: "新建终端",
              runtime_session_id: null,
              saved_session_id: null,
              active_terminal_tab_id: "pane-b-tab-1",
              terminal_tabs: [
                {
                  id: "pane-b-tab-1",
                  title: "新建终端",
                  runtime_session_id: null,
                  saved_session_id: null,
                },
              ],
            },
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().addPaneTab("pane-b");

    const state = useTerminalLayoutStore.getState();
    const terminalLayoutTab = state.tabs[0];

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe("tab-1");
    expect(terminalLayoutTab.active_pane_id).toBe("pane-b");
    expect(terminalLayoutTab.root.kind).toBe("split");
    if (terminalLayoutTab.root.kind !== "split") return;
    expect(terminalLayoutTab.root.first.kind).toBe("leaf");
    expect(terminalLayoutTab.root.second.kind).toBe("leaf");
    if (terminalLayoutTab.root.second.kind !== "leaf") return;
    expect(terminalLayoutTab.root.second.terminal_tabs).toHaveLength(2);
    expect(terminalLayoutTab.root.second.title).toBe("新建终端");
  });


  it("stops splitting a pane once another horizontal split would fall below quarter width", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-2",
        direction: "horizontal",
        ratio: 0.5,
        first: {
          kind: "split",
          id: "split-3",
          direction: "horizontal",
          ratio: 0.5,
          first: { kind: "leaf", id: "pane-a", title: "A", runtime_session_id: null, saved_session_id: null },
          second: { kind: "leaf", id: "pane-b", title: "B", runtime_session_id: null, saved_session_id: null },
        },
        second: { kind: "leaf", id: "pane-c", title: "C", runtime_session_id: null, saved_session_id: null },
      },
      second: { kind: "leaf", id: "pane-d", title: "D", runtime_session_id: null, saved_session_id: null },
    };
    const terminalLayout: TerminalLayoutRuntime = {
      id: DEFAULT_TERMINAL_LAYOUT_ID,
      name: "终端布局",
      status: "running",
      active_tab_id: "tab-1",
      activeTabId: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [{
        id: "tab-1",
        title: "终端",
        active_pane_id: "pane-d",
        root,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      }],
    };
    useTerminalLayoutStore.setState({
      runtime: terminalLayout,
      activeTerminalLayoutId: terminalLayout.id,
      tabs: terminalLayout.tabs,
      activeTabId: terminalLayout.activeTabId,
    });

    useTerminalLayoutStore.getState().splitActivePane("horizontal");
    expect(leafPaneIds(useTerminalLayoutStore.getState().tabs[0].root)).toHaveLength(5);

    useTerminalLayoutStore.getState().splitActivePane("horizontal");
    expect(leafPaneIds(useTerminalLayoutStore.getState().tabs[0].root)).toHaveLength(5);

    useTerminalLayoutStore.getState().splitActivePane("vertical");
    expect(leafPaneIds(useTerminalLayoutStore.getState().tabs[0].root)).toHaveLength(6);
  });

  it("returns the created pane tab and binds a runtime to that exact tab even after focus changes", () => {
    const terminalLayoutA = runtimeTerminalLayout("terminalLayout-a", "runtime-a");
    if (terminalLayoutA.tabs[0].root.kind === "leaf") {
      terminalLayoutA.tabs[0].root.active_terminal_tab_id = "terminalLayout-a-pane-1-tab-2";
      terminalLayoutA.tabs[0].root.terminal_tabs?.push({
        id: "terminalLayout-a-pane-1-tab-2",
        title: "新建终端",
        runtime_session_id: null,
        saved_session_id: null,
      });
    }
    useTerminalLayoutStore.setState({
      runtime: terminalLayoutA,
      activeTerminalLayoutId: terminalLayoutA.id,
      tabs: terminalLayoutA.tabs,
      activeTabId: terminalLayoutA.activeTabId,
    });

    const created = useTerminalLayoutStore.getState().addPaneTab("terminalLayout-a-pane-1");
    useTerminalLayoutStore.getState().selectPaneTab("terminalLayout-a-pane-1", "terminalLayout-a-pane-1-tab-1");
    useTerminalLayoutStore.getState().bindRuntimeToPaneTab(
      "terminalLayout-a",
      "terminalLayout-a-tab-1",
      "terminalLayout-a-pane-1",
      created.id,
      {
        runtime_session_id: "runtime-created",
        saved_session_id: "session-1",
        history_scope_kind: "saved_session",
        history_scope_id: "session-1",
        pane_id: "terminalLayout-a-pane-1",
        title: "生产机",
          kind: "ssh",
          initial_cwd: null,
        cols: 120,
        rows: 32,
      },
    );

    const state = useTerminalLayoutStore.getState();
    expect(state.activeTerminalLayoutId).toBe("terminalLayout-a");
    const updatedTerminalLayout = state.runtime;
    expect(updatedTerminalLayout?.tabs[0].root.kind).toBe("leaf");
    if (!updatedTerminalLayout || updatedTerminalLayout.tabs[0].root.kind !== "leaf") return;
    const updatedTab = updatedTerminalLayout.tabs[0].root.terminal_tabs?.find((tab) => tab.id === created.id);
    expect(updatedTab).toMatchObject({
      runtime_session_id: "runtime-created",
      saved_session_id: "session-1",
      title: "生产机 (2)",
    });
    expect(updatedTerminalLayout.tabs[0].root.terminal_tabs?.find((tab) => tab.id === "terminalLayout-a-pane-1-tab-1"))
      .toMatchObject({ runtime_session_id: "runtime-a" });
  });


  it("numbers tabs that connect to the same saved session in the active terminalLayout tab", () => {
    useTerminalLayoutStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "172.16.41.180",
          active_pane_id: "pane-a",
          root: {
            kind: "leaf",
            id: "pane-a",
            title: "新建终端",
            runtime_session_id: null,
            saved_session_id: null,
            active_terminal_tab_id: "pane-a-tab-2",
            terminal_tabs: [
              {
                id: "pane-a-tab-1",
                title: "172.16.41.180",
                runtime_session_id: "runtime-1",
                saved_session_id: "session-1",
              },
              {
                id: "pane-a-tab-2",
                title: "新建终端",
                runtime_session_id: null,
                saved_session_id: null,
              },
            ],
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().bindRuntimeToPane({
      runtime_session_id: "runtime-2",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-a",
      title: "172.16.41.180",
          kind: "ssh",
          initial_cwd: null,
          cols: 120,
      rows: 32,
    });

    const terminalLayoutTab = useTerminalLayoutStore.getState().tabs[0];
    expect(terminalLayoutTab.root.kind).toBe("leaf");
    if (terminalLayoutTab.root.kind !== "leaf") return;
    expect(terminalLayoutTab.root.title).toBe("172.16.41.180 (2)");
    expect(terminalLayoutTab.root.terminal_tabs?.map((tab) => tab.title)).toEqual([
      "172.16.41.180 (1)",
      "172.16.41.180 (2)",
    ]);
  });

  it("closes a terminal tab and activates the remaining tab in the same pane", () => {
    useTerminalLayoutStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "172.16.41.180 (2)",
          active_pane_id: "pane-a",
          root: {
            kind: "leaf",
            id: "pane-a",
            title: "172.16.41.180 (2)",
            runtime_session_id: "runtime-2",
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-a-tab-2",
            terminal_tabs: [
              {
                id: "pane-a-tab-1",
                title: "172.16.41.180 (1)",
                runtime_session_id: "runtime-1",
                saved_session_id: "session-1",
              },
              {
                id: "pane-a-tab-2",
                title: "172.16.41.180 (2)",
                runtime_session_id: "runtime-2",
                saved_session_id: "session-1",
              },
            ],
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().closePaneTab("pane-a", "pane-a-tab-2");

    const root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("leaf");
    if (root.kind !== "leaf") return;
    expect(root.active_terminal_tab_id).toBe("pane-a-tab-1");
    expect(root.title).toBe("172.16.41.180 (1)");
    expect(root.runtime_session_id).toBe("runtime-1");
    expect(root.terminal_tabs?.map((tab) => tab.id)).toEqual(["pane-a-tab-1"]);
  });

  it("replaces the last closed terminal tab with an empty tab", () => {
    useTerminalLayoutStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "172.16.41.180",
          active_pane_id: "pane-a",
          root: {
            kind: "leaf",
            id: "pane-a",
            title: "172.16.41.180",
            runtime_session_id: "runtime-1",
            saved_session_id: "session-1",
            active_terminal_tab_id: "pane-a-tab-1",
            terminal_tabs: [
              {
                id: "pane-a-tab-1",
                title: "172.16.41.180",
                runtime_session_id: "runtime-1",
                saved_session_id: "session-1",
              },
            ],
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().closePaneTab("pane-a", "pane-a-tab-1");

    const root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("leaf");
    if (root.kind !== "leaf") return;
    expect(root.title).toBe("新建终端");
    expect(root.runtime_session_id).toBeNull();
    expect(root.saved_session_id).toBeNull();
    expect(root.terminal_tabs).toHaveLength(1);
    expect(root.terminal_tabs?.[0]).toMatchObject({
      title: "新建终端",
      runtime_session_id: null,
      saved_session_id: null,
    });
  });

  it("closes the targeted inactive pane and preserves the active pane", () => {
    useTerminalLayoutStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "主终端布局",
          active_pane_id: "pane-a",
          root: {
            kind: "split",
            id: "split-root",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              kind: "leaf",
              id: "pane-a",
              title: "PowerShell 7",
              runtime_session_id: null,
              saved_session_id: null,
            },
            second: {
              kind: "leaf",
              id: "pane-b",
              title: "WSL",
              runtime_session_id: null,
              saved_session_id: null,
            },
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().closePane("pane-b");

    const terminalLayoutTab = useTerminalLayoutStore.getState().tabs[0];
    expect(terminalLayoutTab.active_pane_id).toBe("pane-a");
    expect(terminalLayoutTab.root).toMatchObject({ kind: "leaf", id: "pane-a" });
  });

  it("resizes the targeted split pane ratio in the active terminalLayout tab", () => {
    useTerminalLayoutStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "主终端布局",
          active_pane_id: "pane-a",
          root: {
            kind: "split",
            id: "split-root",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              kind: "split",
              id: "split-left",
              direction: "vertical",
              ratio: 0.4,
              first: {
                kind: "leaf",
                id: "pane-a",
                title: "A",
                runtime_session_id: null,
                saved_session_id: null,
              },
              second: {
                kind: "leaf",
                id: "pane-b",
                title: "B",
                runtime_session_id: null,
                saved_session_id: null,
              },
            },
            second: {
              kind: "leaf",
              id: "pane-c",
              title: "C",
              runtime_session_id: null,
              saved_session_id: null,
            },
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
      activeTabId: "tab-1",
    });

    useTerminalLayoutStore.getState().resizeSplitPane("split-left", 0.7);

    const root = useTerminalLayoutStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.ratio).toBe(0.5);
    expect(root.first.kind).toBe("split");
    if (root.first.kind !== "split") return;
    expect(root.first.ratio).toBe(0.7);
  });
  it("uses fresh target identities when closing the last pane or terminal tab", () => {
    const source = runtimeTerminalLayout(DEFAULT_TERMINAL_LAYOUT_ID, "runtime-old");
    useTerminalLayoutStore.getState().restoreWorkbenchDefinition(source);
    const oldTab = useTerminalLayoutStore.getState().tabs[0];
    const oldRoot = oldTab.root;
    if (oldRoot.kind !== "leaf") throw new Error("expected leaf");
    const oldPaneTabId = oldRoot.terminal_tabs![0].id;
    useTerminalLayoutStore.getState().closePaneTab(oldRoot.id, oldPaneTabId);
    expect(useTerminalLayoutStore.getState().hasPaneTerminalTab(DEFAULT_TERMINAL_LAYOUT_ID, oldTab.id, oldRoot.id, oldPaneTabId)).toBe(false);
    useTerminalLayoutStore.getState().closePane(oldRoot.id);
    expect(useTerminalLayoutStore.getState().tabs[0].root.id).not.toBe(oldRoot.id);
    expect(useTerminalLayoutStore.getState().hasPaneTerminalTab(DEFAULT_TERMINAL_LAYOUT_ID, oldTab.id, oldRoot.id, oldPaneTabId)).toBe(false);
  });
  it("invalidates a restore token when the user starts a new connection in the same target", () => {
    const source = runtimeTerminalLayout(DEFAULT_TERMINAL_LAYOUT_ID, "");
    const tab = source.tabs[0];
    const root = tab.root;
    if (root.kind !== "leaf") throw new Error("expected leaf");
    root.terminal_tabs![0].restore_token = "previous-restore";
    useTerminalLayoutStore.getState().restoreWorkbenchDefinition(source);
    useTerminalLayoutStore.getState().updatePaneTerminalTab(DEFAULT_TERMINAL_LAYOUT_ID, tab.id, root.id, root.terminal_tabs![0].id, { restore_status: "pending" });
    const next = useTerminalLayoutStore.getState().tabs[0].root;
    expect(next.kind === "leaf" && next.terminal_tabs![0].restore_token).toBeNull();
  });
});
