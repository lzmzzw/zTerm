// Author: Liz
import { describe, expect, it } from "vitest";

import {
  findLeafPane,
  findPane,
  firstLeafPaneId,
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
