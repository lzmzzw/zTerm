// Author: Liz
import { describe, expect, it, vi } from "vitest";

import { useWorkspaceStore } from "./workspaceStore";
import type { PaneNode, WorkspaceDefinition, WorkspaceRuntime } from "./types";

function runtimeWorkspace(id: string, runtimeSessionId: string): WorkspaceRuntime {
  const now = 1;
  return {
    id,
    name: id === "workspace-a" ? "运维巡检" : "发布窗口",
    status: "running",
    active_tab_id: `${id}-tab-1`,
    activeTabId: `${id}-tab-1`,
    sort_order: id === "workspace-a" ? 0 : 1,
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

describe("workspaceStore pane tabs", () => {
  it("caches workspace definitions and deduplicates in-flight loaders", async () => {
    const definition: WorkspaceDefinition = {
      id: "workspace-cached",
      name: "缓存工作区",
      status: "closed",
      active_tab_id: "workspace-cached-tab-1",
      tabs: [],
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 2,
    };
    useWorkspaceStore.setState({ workspaceDefinitions: {}, workspaces: [] });
    const loader = vi.fn(async () => definition);

    const [first, second] = await Promise.all([
      useWorkspaceStore.getState().loadWorkspaceDefinition("workspace-cached", loader),
      useWorkspaceStore.getState().loadWorkspaceDefinition("workspace-cached", loader),
    ]);
    const third = await useWorkspaceStore.getState().loadWorkspaceDefinition("workspace-cached", loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toBe(definition);
    expect(second).toBe(definition);
    expect(third).toBe(definition);
    expect(useWorkspaceStore.getState().workspaceDefinitions["workspace-cached"]).toBe(definition);
  });

  it("prefetches workspace definitions without inserting closed definitions into runtime workspaces", async () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    const definition: WorkspaceDefinition = {
      id: "workspace-closed",
      name: "关闭态",
      status: "closed",
      active_tab_id: "workspace-closed-tab-1",
      tabs: [],
      sort_order: 2,
      created_at_ms: 1,
      updated_at_ms: 2,
    };
    useWorkspaceStore.setState({
      workspaceDefinitions: {},
      workspaces: [workspaceA],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    await useWorkspaceStore.getState().prefetchWorkspaceDefinitions(["workspace-closed"], async () => definition);

    const state = useWorkspaceStore.getState();
    expect(state.workspaceDefinitions["workspace-closed"]).toBe(definition);
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["workspace-a"]);
    expect(state.activeWorkspaceId).toBe("workspace-a");
  });

  it("switches active workspaces without clearing background runtime bindings", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    const workspaceB = runtimeWorkspace("workspace-b", "runtime-b");
    useWorkspaceStore.setState({
      workspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    useWorkspaceStore.getState().selectWorkspace("workspace-b");

    const state = useWorkspaceStore.getState();
    expect(state.activeWorkspaceId).toBe("workspace-b");
    expect(state.tabs[0].id).toBe("workspace-b-tab-1");
    expect(state.workspaces.find((workspace) => workspace.id === "workspace-a")?.tabs[0].root).toMatchObject({
      kind: "leaf",
      runtime_session_id: "runtime-a",
    });
  });

  it("freezes visual snapshots for one running workspace without touching other workspaces", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    const workspaceB = runtimeWorkspace("workspace-b", "runtime-b");
    useWorkspaceStore.setState({
      workspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceB.id,
      tabs: workspaceB.tabs,
      activeTabId: workspaceB.activeTabId,
    });

    useWorkspaceStore.getState().freezeWorkspaceRuntimeVisualSnapshots(
      "workspace-a",
      {
        "runtime-a": "tail for A",
        "runtime-b": "tail for B",
      },
      123,
    );

    const state = useWorkspaceStore.getState();
    const frozenWorkspace = state.workspaces.find((workspace) => workspace.id === "workspace-a");
    const untouchedWorkspace = state.workspaces.find((workspace) => workspace.id === "workspace-b");
    expect(frozenWorkspace?.tabs[0].root.kind).toBe("leaf");
    if (!frozenWorkspace || frozenWorkspace.tabs[0].root.kind !== "leaf") return;
    expect(frozenWorkspace.tabs[0].root.terminal_tabs?.[0].visual_snapshot).toEqual({
      kind: "terminal_tail",
      text: "tail for A",
      captured_at_ms: 123,
      runtime_session_id: "runtime-a",
    });
    expect(untouchedWorkspace?.tabs[0].root.kind).toBe("leaf");
    if (!untouchedWorkspace || untouchedWorkspace.tabs[0].root.kind !== "leaf") return;
    expect(untouchedWorkspace.tabs[0].root.terminal_tabs?.[0]).not.toHaveProperty("visual_snapshot");
    expect(state.activeWorkspaceId).toBe("workspace-b");
    expect(state.tabs[0].id).toBe("workspace-b-tab-1");
  });

  it("closes a workspace runtime by returning unique runtime ids and keeping the definition", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    if (workspaceA.tabs[0].root.kind === "leaf") {
      workspaceA.tabs[0].root.terminal_tabs?.push({
        id: "workspace-a-pane-1-tab-2",
        title: "生产机 2",
        runtime_session_id: "runtime-a",
        saved_session_id: "session-1",
      });
    }
    useWorkspaceStore.setState({
      workspaces: [workspaceA],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    const runtimeIds = useWorkspaceStore.getState().closeWorkspaceRuntime("workspace-a");

    const state = useWorkspaceStore.getState();
    const closed = state.workspaces[0];
    expect(runtimeIds).toEqual(["runtime-a"]);
    expect(closed.status).toBe("closed");
    expect(closed.tabs[0].root).toMatchObject({
      kind: "leaf",
      runtime_session_id: null,
    });
    if (closed.tabs[0].root.kind !== "leaf") return;
    expect(closed.tabs[0].root.terminal_tabs?.map((tab) => tab.runtime_session_id)).toEqual([null, null]);
  });

  it("collects workspace runtime ids without clearing runtime bindings", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    if (workspaceA.tabs[0].root.kind === "leaf") {
      workspaceA.tabs[0].root.terminal_tabs?.push({
        id: "workspace-a-pane-1-tab-2",
        title: "生产机 2",
        runtime_session_id: "runtime-a",
        saved_session_id: "session-1",
      });
    }
    useWorkspaceStore.setState({
      workspaces: [workspaceA],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    const runtimeIds = useWorkspaceStore.getState().getWorkspaceRuntimeSessionIds("workspace-a");

    const state = useWorkspaceStore.getState();
    expect(runtimeIds).toEqual(["runtime-a"]);
    expect(state.workspaces[0].status).toBe("running");
    expect(state.workspaces[0].tabs[0].root).toMatchObject({
      kind: "leaf",
      runtime_session_id: "runtime-a",
    });
  });

  it("builds a persisted workspace draft without runtime or restore error state", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    if (workspaceA.tabs[0].root.kind === "leaf") {
      workspaceA.tabs[0].root.terminal_tabs![0].visual_snapshot = {
        kind: "terminal_tail",
        text: "sensitive runtime output",
        captured_at_ms: 10,
        runtime_session_id: "runtime-a",
      };
    }
    useWorkspaceStore.setState({
      workspaces: [workspaceA],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    const draft = useWorkspaceStore.getState().buildActiveWorkspaceDraft();

    expect(draft).toMatchObject({
      id: "workspace-a",
      name: "运维巡检",
      active_tab_id: "workspace-a-tab-1",
      status: "closed",
    });
    const root = draft?.tabs[0].root;
    expect(root).toMatchObject({ kind: "leaf", runtime_session_id: null });
    if (!root || root.kind !== "leaf") return;
    expect(root.terminal_tabs?.[0]).toMatchObject({
      runtime_session_id: null,
      saved_session_id: "session-1",
      path: "/srv/app",
      startup_command: "source ./env.sh",
      restore_error: null,
    });
    expect(root.terminal_tabs?.[0]).not.toHaveProperty("visual_snapshot");
  });

  it("clears runtime-only visual snapshots when closing a workspace runtime", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    if (workspaceA.tabs[0].root.kind === "leaf") {
      workspaceA.tabs[0].root.terminal_tabs![0].visual_snapshot = {
        kind: "terminal_tail",
        text: "runtime-only output",
        captured_at_ms: 20,
        runtime_session_id: "runtime-a",
      };
    }
    useWorkspaceStore.setState({
      workspaces: [workspaceA],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    useWorkspaceStore.getState().closeWorkspaceRuntime("workspace-a");

    const closed = useWorkspaceStore.getState().workspaces[0];
    expect(closed.tabs[0].root.kind).toBe("leaf");
    if (closed.tabs[0].root.kind !== "leaf") return;
    expect(closed.tabs[0].root.terminal_tabs?.[0]).not.toHaveProperty("visual_snapshot");
  });

  it("removes a workspace runtime and cached definition while falling back from the active workspace", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    const defaultWorkspace = runtimeWorkspace("default-workspace", "runtime-default");
    const definitionA: WorkspaceDefinition = {
      id: "workspace-a",
      name: "运维巡检",
      status: "closed",
      active_tab_id: "workspace-a-tab-1",
      tabs: workspaceA.tabs,
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 2,
    };
    useWorkspaceStore.setState({
      workspaceDefinitions: {
        "workspace-a": definitionA,
      },
      workspaces: [workspaceA, defaultWorkspace],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    (useWorkspaceStore.getState() as unknown as { removeWorkspace: (workspaceId: string) => void }).removeWorkspace("workspace-a");

    const state = useWorkspaceStore.getState();
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["default-workspace"]);
    expect(state.workspaceDefinitions).not.toHaveProperty("workspace-a");
    expect(state.activeWorkspaceId).toBe("default-workspace");
    expect(state.tabs).toBe(defaultWorkspace.tabs);
    expect(state.activeTabId).toBe(defaultWorkspace.activeTabId);
  });

  it("keeps the current active workspace when removing a background workspace", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    const workspaceB = runtimeWorkspace("workspace-b", "runtime-b");
    useWorkspaceStore.setState({
      workspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceB.id,
      tabs: workspaceB.tabs,
      activeTabId: workspaceB.activeTabId,
    });

    (useWorkspaceStore.getState() as unknown as { removeWorkspace: (workspaceId: string) => void }).removeWorkspace("workspace-a");

    const state = useWorkspaceStore.getState();
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["workspace-b"]);
    expect(state.activeWorkspaceId).toBe("workspace-b");
    expect(state.tabs).toBe(workspaceB.tabs);
  });

  it("updates one pane terminal tab restore state without touching background workspaces", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    const workspaceB = runtimeWorkspace("workspace-b", "runtime-b");
    useWorkspaceStore.setState({
      workspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceB.id,
      tabs: workspaceB.tabs,
      activeTabId: workspaceB.activeTabId,
    });

    useWorkspaceStore.getState().updatePaneTerminalTab(
      "workspace-a",
      "workspace-a-tab-1",
      "workspace-a-pane-1",
      "workspace-a-pane-1-tab-1",
      {
        restore_status: "failed",
        restore_error: "连接已缺失",
      },
    );

    const state = useWorkspaceStore.getState();
    expect(state.activeWorkspaceId).toBe("workspace-b");
    expect(state.tabs[0].id).toBe("workspace-b-tab-1");
    const updatedWorkspace = state.workspaces.find((workspace) => workspace.id === "workspace-a");
    expect(updatedWorkspace?.tabs[0].root.kind).toBe("leaf");
    if (!updatedWorkspace || updatedWorkspace.tabs[0].root.kind !== "leaf") return;
    expect(updatedWorkspace.tabs[0].root.terminal_tabs?.[0]).toMatchObject({
      restore_status: "failed",
      restore_error: "连接已缺失",
    });
  });

  it("adds a tab inside the active pane without replacing the split workspace tab", () => {
    useWorkspaceStore.setState({
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

    useWorkspaceStore.getState().addPaneTab("pane-b");

    const state = useWorkspaceStore.getState();
    const workspaceTab = state.tabs[0];

    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe("tab-1");
    expect(workspaceTab.active_pane_id).toBe("pane-b");
    expect(workspaceTab.root.kind).toBe("split");
    if (workspaceTab.root.kind !== "split") return;
    expect(workspaceTab.root.first.kind).toBe("leaf");
    expect(workspaceTab.root.second.kind).toBe("leaf");
    if (workspaceTab.root.second.kind !== "leaf") return;
    expect(workspaceTab.root.second.terminal_tabs).toHaveLength(2);
    expect(workspaceTab.root.second.title).toBe("新建终端");
  });

  it("generates a unique pane id when splitting a restored layout with existing default ids", () => {
    const workspace: WorkspaceRuntime = {
      id: "workspace-split",
      name: "恢复分栏",
      status: "running",
      active_tab_id: "tab-1",
      activeTabId: "tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "tab-1",
          title: "主工作区",
          active_pane_id: "pane-1",
          root: {
            kind: "split",
            id: "split-root",
            direction: "horizontal",
            ratio: 0.5,
            first: {
              kind: "leaf",
              id: "pane-1",
              title: "A",
              runtime_session_id: null,
              saved_session_id: null,
            },
            second: {
              kind: "leaf",
              id: "pane-2",
              title: "B",
              runtime_session_id: null,
              saved_session_id: null,
            },
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
    };
    useWorkspaceStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      tabs: workspace.tabs,
      activeTabId: workspace.activeTabId,
    });

    useWorkspaceStore.getState().splitActivePane("vertical");

    const workspaceTab = useWorkspaceStore.getState().tabs[0];
    const paneIds = leafPaneIds(workspaceTab.root);
    expect(new Set(paneIds).size).toBe(paneIds.length);
    expect(paneIds.filter((paneId) => paneId === "pane-2")).toHaveLength(1);
    expect(workspaceTab.active_pane_id).not.toBe("pane-1");
    expect(workspaceTab.active_pane_id).not.toBe("pane-2");
  });

  it("returns the created pane tab and binds a runtime to that exact tab even after focus changes", () => {
    const workspaceA = runtimeWorkspace("workspace-a", "runtime-a");
    if (workspaceA.tabs[0].root.kind === "leaf") {
      workspaceA.tabs[0].root.active_terminal_tab_id = "workspace-a-pane-1-tab-2";
      workspaceA.tabs[0].root.terminal_tabs?.push({
        id: "workspace-a-pane-1-tab-2",
        title: "新建终端",
        runtime_session_id: null,
        saved_session_id: null,
      });
    }
    const workspaceB = runtimeWorkspace("workspace-b", "runtime-b");
    useWorkspaceStore.setState({
      workspaces: [workspaceA, workspaceB],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    const created = useWorkspaceStore.getState().addPaneTab("workspace-a-pane-1");
    useWorkspaceStore.getState().selectWorkspace("workspace-b");
    useWorkspaceStore.getState().bindRuntimeToPaneTab(
      "workspace-a",
      "workspace-a-tab-1",
      "workspace-a-pane-1",
      created.id,
      {
        runtime_session_id: "runtime-created",
        saved_session_id: "session-1",
        history_scope_kind: "saved_session",
        history_scope_id: "session-1",
        pane_id: "workspace-a-pane-1",
        title: "生产机",
        kind: "ssh",
        cols: 120,
        rows: 32,
      },
    );

    const state = useWorkspaceStore.getState();
    expect(state.activeWorkspaceId).toBe("workspace-b");
    const updatedWorkspace = state.workspaces.find((workspace) => workspace.id === "workspace-a");
    expect(updatedWorkspace?.tabs[0].root.kind).toBe("leaf");
    if (!updatedWorkspace || updatedWorkspace.tabs[0].root.kind !== "leaf") return;
    const updatedTab = updatedWorkspace.tabs[0].root.terminal_tabs?.find((tab) => tab.id === created.id);
    expect(updatedTab).toMatchObject({
      runtime_session_id: "runtime-created",
      saved_session_id: "session-1",
      title: "生产机 (2)",
    });
    expect(updatedWorkspace.tabs[0].root.terminal_tabs?.find((tab) => tab.id === "workspace-a-pane-1-tab-1"))
      .toMatchObject({ runtime_session_id: "runtime-a" });
  });

  it("binds a runtime to a restored non-active split pane without changing the active pane", () => {
    const workspaceA: WorkspaceRuntime = {
      id: "workspace-a",
      name: "多分栏恢复",
      status: "running",
      active_tab_id: "workspace-a-tab-1",
      activeTabId: "workspace-a-tab-1",
      sort_order: 0,
      created_at_ms: 1,
      updated_at_ms: 1,
      tabs: [
        {
          id: "workspace-a-tab-1",
          title: "aaa",
          active_pane_id: "pane-top",
          root: {
            kind: "split",
            id: "split-top-bottom",
            direction: "vertical",
            ratio: 0.5,
            first: {
              kind: "leaf",
              id: "pane-top",
              title: "aaa",
              runtime_session_id: "runtime-top",
              saved_session_id: "session-local",
              active_terminal_tab_id: "pane-top-tab-active",
              terminal_tabs: [
                {
                  id: "pane-top-tab-active",
                  title: "aaa",
                  runtime_session_id: "runtime-top",
                  saved_session_id: "session-local",
                  connection_source: "saved_session",
                  restore_status: "connected",
                },
              ],
            },
            second: {
              kind: "leaf",
              id: "pane-bottom",
              title: "172.16.41.180",
              runtime_session_id: null,
              saved_session_id: "session-ssh",
              active_terminal_tab_id: "pane-bottom-tab-active",
              terminal_tabs: [
                {
                  id: "pane-bottom-tab-active",
                  title: "172.16.41.180",
                  runtime_session_id: null,
                  saved_session_id: "session-ssh",
                  connection_source: "saved_session",
                  restore_status: "pending",
                },
              ],
            },
          },
          sort_order: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ],
    };
    useWorkspaceStore.setState({
      workspaces: [workspaceA],
      activeWorkspaceId: workspaceA.id,
      tabs: workspaceA.tabs,
      activeTabId: workspaceA.activeTabId,
    });

    useWorkspaceStore.getState().bindRuntimeToPaneTab(
      "workspace-a",
      "workspace-a-tab-1",
      "pane-bottom",
      "pane-bottom-tab-active",
      {
        runtime_session_id: "runtime-bottom",
        saved_session_id: "session-ssh",
        history_scope_kind: "saved_session",
        history_scope_id: "session-ssh",
        pane_id: "pane-bottom",
        title: "172.16.41.180",
        kind: "ssh",
        cols: 120,
        rows: 32,
      },
    );

    const state = useWorkspaceStore.getState();
    const workspaceTab = state.tabs[0];
    expect(workspaceTab.active_pane_id).toBe("pane-top");
    expect(workspaceTab.root.kind).toBe("split");
    if (workspaceTab.root.kind !== "split") return;
    expect(workspaceTab.root.first.kind).toBe("leaf");
    expect(workspaceTab.root.second.kind).toBe("leaf");
    if (workspaceTab.root.first.kind !== "leaf" || workspaceTab.root.second.kind !== "leaf") return;
    expect(workspaceTab.root.first).toMatchObject({
      id: "pane-top",
      runtime_session_id: "runtime-top",
      active_terminal_tab_id: "pane-top-tab-active",
    });
    expect(workspaceTab.root.second).toMatchObject({
      id: "pane-bottom",
      runtime_session_id: "runtime-bottom",
      active_terminal_tab_id: "pane-bottom-tab-active",
    });
  });

  it("numbers tabs that connect to the same saved session in the active workspace tab", () => {
    useWorkspaceStore.setState({
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

    useWorkspaceStore.getState().bindRuntimeToPane({
      runtime_session_id: "runtime-2",
      saved_session_id: "session-1",
      history_scope_kind: "saved_session",
      history_scope_id: "session-1",
      pane_id: "pane-a",
      title: "172.16.41.180",
      kind: "ssh",
      cols: 120,
      rows: 32,
    });

    const workspaceTab = useWorkspaceStore.getState().tabs[0];
    expect(workspaceTab.root.kind).toBe("leaf");
    if (workspaceTab.root.kind !== "leaf") return;
    expect(workspaceTab.root.title).toBe("172.16.41.180 (2)");
    expect(workspaceTab.root.terminal_tabs?.map((tab) => tab.title)).toEqual([
      "172.16.41.180 (1)",
      "172.16.41.180 (2)",
    ]);
  });

  it("closes a terminal tab and activates the remaining tab in the same pane", () => {
    useWorkspaceStore.setState({
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

    useWorkspaceStore.getState().closePaneTab("pane-a", "pane-a-tab-2");

    const root = useWorkspaceStore.getState().tabs[0].root;
    expect(root.kind).toBe("leaf");
    if (root.kind !== "leaf") return;
    expect(root.active_terminal_tab_id).toBe("pane-a-tab-1");
    expect(root.title).toBe("172.16.41.180 (1)");
    expect(root.runtime_session_id).toBe("runtime-1");
    expect(root.terminal_tabs?.map((tab) => tab.id)).toEqual(["pane-a-tab-1"]);
  });

  it("replaces the last closed terminal tab with an empty tab", () => {
    useWorkspaceStore.setState({
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

    useWorkspaceStore.getState().closePaneTab("pane-a", "pane-a-tab-1");

    const root = useWorkspaceStore.getState().tabs[0].root;
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

  it("resizes the targeted split pane ratio in the active workspace tab", () => {
    useWorkspaceStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "主工作区",
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

    useWorkspaceStore.getState().resizeSplitPane("split-left", 0.7);

    const root = useWorkspaceStore.getState().tabs[0].root;
    expect(root.kind).toBe("split");
    if (root.kind !== "split") return;
    expect(root.ratio).toBe(0.5);
    expect(root.first.kind).toBe("split");
    if (root.first.kind !== "split") return;
    expect(root.first.ratio).toBe(0.7);
  });
});
