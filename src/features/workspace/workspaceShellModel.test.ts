// Author: Liz
import { describe, expect, it, vi } from "vitest";

import {
  collectWorkspaceTerminalTargets,
  definitionFromRuntime,
  isReusableConnectionTab,
  mergeWorkspaceSidebarItems,
  nextWorkspaceSortOrder,
} from "./workspaceShellModel";
import { DEFAULT_WORKSPACE_ID } from "./workspaceConstants";
import type { PaneNode, PaneTerminalTab, WorkspaceDefinition, WorkspaceRuntime, WorkspaceSummary, WorkspaceTab } from "./types";

function leaf(id: string, patch: Partial<Extract<PaneNode, { kind: "leaf" }>> = {}): Extract<PaneNode, { kind: "leaf" }> {
  return {
    kind: "leaf",
    id,
    runtime_session_id: null,
    saved_session_id: null,
    title: id,
    ...patch,
  };
}

function tab(id: string, root: PaneNode, sortOrder: number): WorkspaceTab {
  return {
    id,
    title: id,
    active_pane_id: root.kind === "leaf" ? root.id : "pane-a",
    root,
    sort_order: sortOrder,
    created_at_ms: sortOrder,
    updated_at_ms: sortOrder,
  };
}

function definition(id: string, tabs: WorkspaceTab[], patch: Partial<WorkspaceDefinition> = {}): WorkspaceDefinition {
  return {
    id,
    name: id,
    status: "closed",
    active_tab_id: tabs[0]?.id ?? "",
    tabs,
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    ...patch,
  };
}

describe("workspaceShellModel", () => {
  it("builds sidebar items only from persisted summaries and keeps preview roots", () => {
    const previewRoot = leaf("preview-pane");
    const summaries: WorkspaceSummary[] = [
      {
        id: DEFAULT_WORKSPACE_ID,
        name: "默认工作区",
        status: "closed",
        active_tab_id: "tab-1",
        tab_count: 0,
        sort_order: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
      {
        id: "workspace-a",
        name: "持久化工作区",
        status: "closed",
        active_tab_id: "persisted-tab",
        tab_count: 1,
        sort_order: 2,
        created_at_ms: 1,
        updated_at_ms: 10,
      },
      {
        id: "workspace-b",
        name: "另一个工作区",
        status: "closed",
        active_tab_id: "tab-b",
        tab_count: 1,
        sort_order: 1,
        created_at_ms: 2,
        updated_at_ms: 20,
      },
    ];
    const items = mergeWorkspaceSidebarItems(summaries, {
      "workspace-a": definition("workspace-a", [tab("preview-tab", previewRoot, 0)]),
    });

    expect(items.map((item) => item.id)).toEqual(["workspace-a", "workspace-b"]);
    expect(items.some((item) => item.id === DEFAULT_WORKSPACE_ID)).toBe(false);
    expect(items.find((item) => item.id === "workspace-a")).toMatchObject({
      name: "持久化工作区",
      active_tab_id: "persisted-tab",
      tab_count: 1,
      preview_root: previewRoot,
    });
  });

  it("sorts sidebar items by workspace name by default", () => {
    const summaries: WorkspaceSummary[] = [
      {
        id: "workspace-z",
        name: "Zulu",
        status: "closed",
        active_tab_id: "tab-z",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 30,
      },
      {
        id: "workspace-a",
        name: "Alpha",
        status: "closed",
        active_tab_id: "tab-a",
        tab_count: 1,
        sort_order: 2,
        created_at_ms: 2,
        updated_at_ms: 10,
      },
    ];
    const items = mergeWorkspaceSidebarItems(summaries, {});

    expect(items.map((item) => item.name)).toEqual(["Alpha", "Zulu"]);
  });

  it("uses the Chinese locale when sorting Chinese workspace names", () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare");
    const summaries: WorkspaceSummary[] = [
      {
        id: "workspace-a",
        name: "持久化工作区",
        status: "closed",
        active_tab_id: "tab-a",
        tab_count: 1,
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      },
      {
        id: "workspace-b",
        name: "另一个工作区",
        status: "closed",
        active_tab_id: "tab-b",
        tab_count: 1,
        sort_order: 1,
        created_at_ms: 2,
        updated_at_ms: 2,
      },
    ];

    mergeWorkspaceSidebarItems(summaries, {});

    expect(localeCompare.mock.calls.some(([, locale]) => locale === "zh-CN")).toBe(true);
  });

  it("converts runtime workspaces and calculates the next sort order", () => {
    const runtime: WorkspaceRuntime = {
      ...definition("runtime-workspace", [tab("tab-1", leaf("pane-1"), 0)]),
      active_tab_id: "stored-active-tab",
      activeTabId: "runtime-active-tab",
    };

    expect(definitionFromRuntime(runtime)).toMatchObject({
      id: "runtime-workspace",
      active_tab_id: "runtime-active-tab",
      tabs: [
        expect.objectContaining({
          id: "tab-1",
          root: expect.objectContaining({ id: "pane-1" }),
        }),
      ],
    });
    expect(nextWorkspaceSortOrder([{ sort_order: 0 }, { sort_order: 4 }])).toBe(5);
    expect(nextWorkspaceSortOrder([])).toBe(0);
  });

  it("does not persist external one-time SSH tabs into workspace definitions", () => {
    const runtime: WorkspaceRuntime = {
      ...definition("runtime-workspace", [
        tab(
          "tab-1",
          leaf("pane-1", {
            runtime_session_id: "runtime-external",
            saved_session_id: "external:launch-1",
            title: "ops@cloud.example.test:22",
            active_terminal_tab_id: "pane-1-tab-1",
            terminal_tabs: [
              {
                id: "pane-1-tab-1",
                title: "ops@cloud.example.test:22",
                runtime_session_id: "runtime-external",
                saved_session_id: "external:launch-1",
                connection_source: "external_ssh",
              },
            ],
          }),
          0,
        ),
      ]),
      activeTabId: "tab-1",
    };

    const savedDefinition = definitionFromRuntime(runtime);
    const root = savedDefinition.tabs[0].root;

    expect(root).toMatchObject({
      kind: "leaf",
      runtime_session_id: null,
      saved_session_id: null,
      terminal_tabs: [
        {
          runtime_session_id: null,
          saved_session_id: null,
          connection_source: "missing",
          restore_status: "failed",
          restore_error: "外部一次性连接不会保存到工作区",
        },
      ],
    });
  });

  it("collects terminal restore targets by workspace tab sort order", () => {
    const workspace = definition("workspace", [
      tab("tab-later", leaf("pane-c"), 2),
      tab(
        "tab-first",
        {
          kind: "split",
          id: "split-a",
          direction: "vertical",
          ratio: 0.5,
          first: leaf("pane-a", {
            terminal_tabs: [
              {
                id: "pane-a-custom",
                title: "A",
                runtime_session_id: "runtime-a",
                saved_session_id: "session-a",
              },
            ],
          }),
          second: leaf("pane-b"),
        },
        1,
      ),
    ]);

    expect(
      collectWorkspaceTerminalTargets(workspace).map((target) => ({
        workspaceTabId: target.workspaceTabId,
        paneId: target.paneId,
        terminalTabId: target.terminalTab.id,
      })),
    ).toEqual([
      { workspaceTabId: "tab-first", paneId: "pane-a", terminalTabId: "pane-a-custom" },
      { workspaceTabId: "tab-first", paneId: "pane-b", terminalTabId: "pane-b-tab-1" },
      { workspaceTabId: "tab-later", paneId: "pane-c", terminalTabId: "pane-c-tab-1" },
    ]);
  });

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
  });
});
