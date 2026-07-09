// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetTerminalOutputCachesForTest, useTerminalStore } from "../features/terminal/terminalStore";
import type { WorkspaceDefinition } from "../features/workspace/types";
import { useWorkspaceVisualSwitch } from "./useWorkspaceVisualSwitch";

const cleanupFns: Array<() => void> = [];

describe("useWorkspaceVisualSwitch", () => {
  beforeEach(() => {
    let frameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1;
      callback(performance.now());
      return frameId;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    resetTerminalOutputCachesForTest();
    useTerminalStore.getState().appendOutput("runtime-1", "tail from runtime");
  });

  afterEach(() => {
    for (const cleanup of cleanupFns.splice(0)) {
      cleanup();
    }
    vi.restoreAllMocks();
    resetTerminalOutputCachesForTest();
  });

  it("moves through snapshot, committed, and live phases for a workspace switch", async () => {
    const commit = vi.fn();
    const onLive = vi.fn();
    const { api, rootElement } = renderHookHarness();

    act(() => {
      const epoch = api.current.beginWorkspaceVisualSwitch(workspaceDefinition(), {
        commit,
        onLive,
        completeMetricsOnCommit: true,
      });

      expect(epoch).toBe(1);
    });

    expect(rootElement.dataset.phase).toBe("snapshot");
    expect(rootElement.dataset.tail).toBe("tail from runtime");

    await waitForTimers();

    expect(commit).toHaveBeenCalledTimes(1);
    expect(rootElement.dataset.phase).toBe("committed");

    await waitForTimers(340);

    expect(onLive).toHaveBeenCalledTimes(1);
    expect(rootElement.dataset.phase).toBe("");
  });

  it("cancels the pending switch when a newer switch starts", async () => {
    const firstCancel = vi.fn();
    const firstCommit = vi.fn();
    const { api, rootElement } = renderHookHarness();

    act(() => {
      api.current.beginWorkspaceVisualSwitch(workspaceDefinition("workspace-1"), {
        commit: firstCommit,
        onCancel: firstCancel,
      });
    });

    act(() => {
      api.current.beginWorkspaceVisualSwitch(workspaceDefinition("workspace-2"), {
        commit: vi.fn(),
      });
    });

    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(rootElement.dataset.workspaceId).toBe("workspace-2");

    await waitForTimers();

    expect(firstCommit).not.toHaveBeenCalled();
  });
});

function renderHookHarness() {
  const api: { current: ReturnType<typeof useWorkspaceVisualSwitch> } = {
    current: null as unknown as ReturnType<typeof useWorkspaceVisualSwitch>,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<HookHarness api={api} />);
  });

  cleanupFns.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const rootElement = container.firstElementChild as HTMLElement;
  return { api, root: root as Root, rootElement };
}

function HookHarness({ api }: { api: { current: ReturnType<typeof useWorkspaceVisualSwitch> } }): ReactElement {
  const hook = useWorkspaceVisualSwitch();
  api.current = hook;
  const root = hook.workspaceSwitchOverlay?.root;
  const firstTab = root?.kind === "leaf" ? root.terminal_tabs?.[0] : null;

  return (
    <section
      data-phase={hook.workspaceSwitchOverlay?.phase ?? ""}
      data-workspace-id={hook.workspaceSwitchOverlay?.targetWorkspaceId ?? ""}
      data-tail={firstTab?.visual_snapshot?.text ?? ""}
    />
  );
}

function workspaceDefinition(id = "workspace-1"): WorkspaceDefinition {
  return {
    id,
    name: "运维工作区",
    status: "running",
    active_tab_id: "tab-1",
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    tabs: [
      {
        id: "tab-1",
        title: "终端",
        active_pane_id: "pane-1",
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        root: {
          kind: "leaf",
          id: "pane-1",
          runtime_session_id: "runtime-1",
          saved_session_id: null,
          title: "终端",
          active_terminal_tab_id: "pane-tab-1",
          terminal_tabs: [
            {
              id: "pane-tab-1",
              title: "终端",
              runtime_session_id: "runtime-1",
              saved_session_id: null,
            },
          ],
        },
      },
    ],
  };
}

function waitForTimers(delayMs = 10) {
  return act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  });
}
