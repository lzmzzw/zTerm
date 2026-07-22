// Author: Liz
import { describe, expect, it } from "vitest";

import {
  canSplitPane,
  findLeafPane,
  findPane,
  firstLeafPaneId,
  getLeafPaneIdsInVisualOrder,
  getPaneDisplayLabels,
  getTerminalReferences,
  removePane,
  splitPane,
  updateLeafPane,
  updateSplitRatio,
  updateTerminalTabInRoot,
} from "./workspaceLayout";
import type { PaneNode } from "./types";

function leaf(id: string): PaneNode {
  return {
    kind: "leaf",
    id,
    runtime_session_id: null,
    saved_session_id: null,
    title: id,
  };
}

describe("workspaceLayout", () => {
  it("clamps split ratios to stable workspace bounds through public layout operations", () => {
    const low = splitPane(leaf("pane-a"), "pane-a", "vertical", leaf("pane-b"), -1);
    const middle = splitPane(leaf("pane-a"), "pane-a", "vertical", leaf("pane-b"), 0.5);
    const high = splitPane(leaf("pane-a"), "pane-a", "vertical", leaf("pane-b"), 2);

    expect(low).toMatchObject({ kind: "split", ratio: 0.2 });
    expect(middle).toMatchObject({ kind: "split", ratio: 0.5 });
    expect(high).toMatchObject({ kind: "split", ratio: 0.8 });
  });

  it("splits the requested pane and leaves siblings untouched", () => {
    const root = leaf("pane-a");

    const next = splitPane(root, "pane-a", "vertical", leaf("pane-b"), 0.9);

    expect(next).toEqual({
      kind: "split",
      id: expect.stringMatching(/^split-/),
      direction: "vertical",
      ratio: 0.8,
      first: leaf("pane-a"),
      second: leaf("pane-b"),
    });
    expect(findPane(next, "pane-b")).toEqual(leaf("pane-b"));
  });

  it("removes nested panes by promoting the remaining sibling", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-left",
        direction: "vertical",
        ratio: 0.4,
        first: leaf("pane-a"),
        second: leaf("pane-b"),
      },
      second: leaf("pane-c"),
    };

    const next = removePane(root, "pane-a");

    expect(next).toEqual({
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-b"),
      second: leaf("pane-c"),
    });
  });

  it("finds leaf panes and the first leaf id from nested layouts", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-left",
        direction: "vertical",
        ratio: 0.4,
        first: leaf("pane-a"),
        second: leaf("pane-b"),
      },
      second: leaf("pane-c"),
    };

    expect(firstLeafPaneId(root)).toBe("pane-a");
    expect(findLeafPane(root, "pane-b")).toEqual(leaf("pane-b"));
    expect(findLeafPane(root, "missing")).toBeNull();
  });

  it("returns null when removing the last pane", () => {
    expect(removePane(leaf("pane-a"), "pane-a")).toBeNull();
  });

  it("labels panes in visual reading order instead of binary-tree order", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-columns",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-left",
        direction: "vertical",
        ratio: 0.5,
        first: leaf("pane-a"),
        second: leaf("pane-c"),
      },
      second: {
        kind: "split",
        id: "split-right",
        direction: "vertical",
        ratio: 0.5,
        first: leaf("pane-b"),
        second: leaf("pane-d"),
      },
    };

    expect(getLeafPaneIdsInVisualOrder(root)).toEqual(["pane-a", "pane-b", "pane-c", "pane-d"]);
    expect(getPaneDisplayLabels(root)).toEqual({
      "pane-a": "A",
      "pane-b": "B",
      "pane-c": "C",
      "pane-d": "D",
    });
  });

  it("builds transient MCP terminal references from the visible tab order", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-a",
        title: "生产机",
        runtime_session_id: null,
        saved_session_id: null,
        active_terminal_tab_id: "pane-a-tab-2",
        terminal_tabs: [
          { id: "pane-a-tab-1", title: "新建终端", runtime_session_id: null, saved_session_id: null },
          { id: "pane-a-tab-2", title: "生产机", runtime_session_id: "runtime-a", saved_session_id: "ssh-a" },
        ],
      },
      second: {
        kind: "leaf",
        id: "pane-b",
        title: "本地终端",
        runtime_session_id: "runtime-b",
        saved_session_id: null,
      },
    };

    expect(getTerminalReferences(root)).toEqual([
      { terminal_ref: "A1", runtime_session_id: "runtime-a" },
      { terminal_ref: "B1", runtime_session_id: "runtime-b" },
    ]);
  });

  it("uses the target pane dimensions instead of the total number of panes", () => {
    const fullRow: PaneNode = {
      kind: "split",
      id: "split-row-1",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-row-2",
        direction: "horizontal",
        ratio: 0.5,
        first: {
          kind: "split",
          id: "split-row-3",
          direction: "horizontal",
          ratio: 0.5,
          first: leaf("pane-a"),
          second: leaf("pane-b"),
        },
        second: leaf("pane-c"),
      },
      second: leaf("pane-d"),
    };
    const root: PaneNode = {
      kind: "split",
      id: "split-rows",
      direction: "vertical",
      ratio: 0.5,
      first: fullRow,
      second: leaf("pane-e"),
    };

    expect(canSplitPane(root, "pane-a", "horizontal")).toBe(false);
    expect(canSplitPane(root, "pane-e", "horizontal")).toBe(true);
    expect(canSplitPane(root, "pane-a", "vertical")).toBe(false);
  });

  it("allows a half-width pane to become two quarter-width panes, then stops", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a"),
      second: leaf("pane-b"),
    };
    const afterSplit = splitPane(root, "pane-a", "horizontal", leaf("pane-c"));

    expect(canSplitPane(root, "pane-a", "horizontal")).toBe(true);
    expect(canSplitPane(afterSplit, "pane-a", "horizontal")).toBe(false);
    expect(canSplitPane(afterSplit, "pane-c", "horizontal")).toBe(false);
    expect(canSplitPane(afterSplit, "pane-b", "horizontal")).toBe(true);
  });

  it("allows either split direction for the half-size pane in a three-pane layout", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a"),
      second: {
        kind: "split",
        id: "split-right",
        direction: "vertical",
        ratio: 0.5,
        first: leaf("pane-b"),
        second: leaf("pane-c"),
      },
    };

    expect(canSplitPane(root, "pane-a", "horizontal")).toBe(true);
    expect(canSplitPane(root, "pane-a", "vertical")).toBe(true);
  });

  it("updates only the targeted leaf pane runtime binding", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("pane-a"),
      second: leaf("pane-b"),
    };

    const next = updateLeafPane(root, "pane-b", {
      runtime_session_id: "runtime-1",
      saved_session_id: "saved-1",
      title: "开发机",
    });

    expect(findPane(next, "pane-a")).toEqual(leaf("pane-a"));
    expect(findPane(next, "pane-b")).toMatchObject({
      kind: "leaf",
      id: "pane-b",
      runtime_session_id: "runtime-1",
      saved_session_id: "saved-1",
      title: "开发机",
      terminal_tabs: [
        {
          runtime_session_id: "runtime-1",
          saved_session_id: "saved-1",
          title: "开发机",
        },
      ],
    });
  });

  it("updates only the targeted split ratio and clamps the dragged ratio", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "split",
        id: "split-left",
        direction: "vertical",
        ratio: 0.4,
        first: leaf("pane-a"),
        second: leaf("pane-b"),
      },
      second: leaf("pane-c"),
    };

    const next = updateSplitRatio(root, "split-left", 0.95);

    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    expect(next.ratio).toBe(0.5);
    expect(next.first.kind).toBe("split");
    if (next.first.kind !== "split") return;
    expect(next.first.ratio).toBe(0.8);
    expect(next.second).toEqual(leaf("pane-c"));
  });

  it("updates a terminal tab inside the targeted leaf pane and syncs the leaf summary", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-a",
        title: "A",
        runtime_session_id: null,
        saved_session_id: null,
        active_terminal_tab_id: "pane-a-tab-1",
        terminal_tabs: [
          {
            id: "pane-a-tab-1",
            title: "A",
            runtime_session_id: null,
            saved_session_id: null,
          },
        ],
      },
      second: {
        kind: "leaf",
        id: "pane-b",
        title: "旧会话",
        runtime_session_id: "runtime-old",
        saved_session_id: "session-old",
        active_terminal_tab_id: "pane-b-tab-2",
        terminal_tabs: [
          {
            id: "pane-b-tab-1",
            title: "备用",
            runtime_session_id: null,
            saved_session_id: null,
          },
          {
            id: "pane-b-tab-2",
            title: "旧会话",
            runtime_session_id: "runtime-old",
            saved_session_id: "session-old",
          },
        ],
      },
    };

    const next = updateTerminalTabInRoot(root, "pane-b", "pane-b-tab-2", (terminalTab) => ({
      ...terminalTab,
      title: "生产机",
      runtime_session_id: "runtime-new",
      saved_session_id: "session-new",
    }));

    expect(findLeafPane(next, "pane-a")).toEqual(findLeafPane(root, "pane-a"));
    expect(findLeafPane(next, "pane-b")).toMatchObject({
      title: "生产机",
      runtime_session_id: "runtime-new",
      saved_session_id: "session-new",
      active_terminal_tab_id: "pane-b-tab-2",
      terminal_tabs: [
        {
          id: "pane-b-tab-1",
          title: "备用",
          runtime_session_id: null,
          saved_session_id: null,
        },
        {
          id: "pane-b-tab-2",
          title: "生产机",
          runtime_session_id: "runtime-new",
          saved_session_id: "session-new",
        },
      ],
    });
  });

  it("keeps the original layout when the terminal tab target is missing", () => {
    const root = leaf("pane-a");

    const next = updateTerminalTabInRoot(root, "pane-a", "missing-tab", (terminalTab) => ({
      ...terminalTab,
      title: "should not apply",
    }));

    expect(next).toBe(root);
  });
});
