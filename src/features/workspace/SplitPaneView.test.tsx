// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SplitPaneView } from "./SplitPaneView";
import { resetTerminalOutputCachesForTest, useTerminalStore } from "../terminal/terminalStore";
import type { PaneNode } from "./types";

vi.mock("../terminal/XtermPane", () => ({
  XtermPane: ({ contextMenuEnabled, data }: { contextMenuEnabled?: boolean; data?: string }) => (
    <div className="zt-xterm-pane" data-context-menu-enabled={String(contextMenuEnabled)}>
      {data}
    </div>
  ),
}));

function leaf(id: string, title: string): PaneNode {
  return {
    kind: "leaf",
    id,
    runtime_session_id: null,
    saved_session_id: null,
    title,
    active_terminal_tab_id: `${id}-tab-1`,
    terminal_tabs: [
      {
        id: `${id}-tab-1`,
        title,
        runtime_session_id: null,
        saved_session_id: null,
      },
    ],
  };
}

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  act(() => {
    root.render(ui);
  });

  return {
    container,
    rerender(nextUi: ReactElement) {
      act(() => {
        root.render(nextUi);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushDeferredXtermMount() {
  await flushVisualSwitchFrame();
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
  });
}

async function flushVisualSwitchFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
        return;
      }
      window.setTimeout(resolve, 0);
    });
  });
}

function installControlledPaintTimers() {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  let frameId = 0;
  const frameTimers = new Map<number, number>();

  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = (frameId += 1);
    const timerId = window.setTimeout(() => {
      frameTimers.delete(id);
      callback(performance.now());
    }, 0);
    frameTimers.set(id, timerId);
    return id;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => {
    const timerId = frameTimers.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
    frameTimers.delete(id);
  }) as typeof window.cancelAnimationFrame;

  return () => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  };
}

function seedTerminalOutput(outputs: Record<string, string>) {
  act(() => {
    for (const [runtimeId, output] of Object.entries(outputs)) {
      useTerminalStore.getState().appendOutput(runtimeId, output);
    }
  });
}

describe("SplitPaneView", () => {
  beforeEach(() => {
    useTerminalStore.setState({ runtimes: {}, outputChunks: {}, inputSerialByRuntime: {} });
    resetTerminalOutputCachesForTest();
  });

  it("hides empty unconnected pane tabs while keeping the add button", () => {
    const root: PaneNode = leaf("pane-a", "新建终端");
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    const tabs = view.container.querySelectorAll('[role="tab"]');
    const closeButtons = view.container.querySelectorAll('[aria-label^="关闭标签"]');
    const addButtons = view.container.querySelectorAll('button[aria-label="创建连接"]');

    expect(tabs).toHaveLength(0);
    expect(closeButtons).toHaveLength(0);
    expect(addButtons).toHaveLength(1);
    expect(view.container.textContent).not.toContain("新建终端");
    view.unmount();
  });

  it("renders the connected runtime shell before mounting xterm on the next task", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
          history_scope_kind: "local_profile",
          history_scope_id: "git-bash",
          pane_id: "pane-a",
          title: "aaa",
          kind: "local",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({ "runtime-local": "$ " });
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-local",
      saved_session_id: "local-session-1",
      title: "aaa",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "aaa",
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
        },
      ],
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain("$ ");
    expect(view.container.querySelector('[role="tab"]')?.textContent).toBe("aaa");

    await flushDeferredXtermMount();

    expect(view.container.querySelector(".zt-xterm-pane")).not.toBeNull();
    expect(view.container.querySelector('[aria-label="空终端分栏"]')).toBeNull();
    view.unmount();
  });

  it("replays local output that arrived before the delayed xterm mount", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          history_scope_kind: "local_profile",
          history_scope_id: "pwsh",
          pane_id: "pane-a",
          title: "PowerShell",
          kind: "local",
          cols: 120,
          rows: 32,
        },
      },
      outputChunks: {},
    });
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-local",
      saved_session_id: null,
      title: "PowerShell",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "PowerShell",
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          connection_source: "default_local",
        },
      ],
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();

    act(() => {
      useTerminalStore.getState().appendOutput("runtime-local", "PS C:\\workspace> ");
    });

    await flushDeferredXtermMount();

    expect(view.container.querySelector(".zt-xterm-pane")?.textContent).toContain("PS C:\\workspace> ");
    view.unmount();
  });

  it("does not flash terminal status queries in the snapshot layer before xterm mounts", () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          history_scope_kind: "local_profile",
          history_scope_id: "pwsh",
          pane_id: "pane-a",
          title: "PowerShell",
          kind: "local",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({ "runtime-local": "\x1b[?25l\x1b[6n" });
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-local",
      saved_session_id: null,
      title: "PowerShell",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "PowerShell",
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          connection_source: "default_local",
        },
      ],
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain(
      "正在准备 PowerShell",
    );
    expect(view.container.textContent).not.toContain("[6n");
    view.unmount();
  });

  it("enables terminal context actions for local, ssh, and ssh_container terminals", async () => {
    const rootFor = (runtimeId: string): PaneNode => ({
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: runtimeId,
      saved_session_id: "session-1",
      title: runtimeId,
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: runtimeId,
          runtime_session_id: runtimeId,
          saved_session_id: "session-1",
        },
      ],
    });

    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
          history_scope_kind: "local_profile",
          history_scope_id: "git-bash",
          pane_id: "pane-a",
          title: "Local",
          kind: "local",
          cols: 120,
          rows: 32,
        },
        "runtime-ssh": {
          runtime_session_id: "runtime-ssh",
          saved_session_id: "ssh-session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "ssh-session-1",
          pane_id: "pane-a",
          title: "SSH",
          kind: "ssh",
          cols: 120,
          rows: 32,
        },
        "runtime-container": {
          runtime_session_id: "runtime-container",
          saved_session_id: "ssh-session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "ssh-session-1",
          pane_id: "pane-a",
          title: "容器: api",
          kind: "ssh_container",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({
      "runtime-local": "$ ",
      "runtime-ssh": "$ ",
      "runtime-container": "# ",
    });

    const props = {
      activePaneId: "pane-a",
      onActivatePane: vi.fn(),
      onAddPaneTab: vi.fn(),
      onSelectPaneTab: vi.fn(),
      onClosePaneTab: vi.fn(),
      onSplitPane: vi.fn(),
      onClosePane: vi.fn(),
    };
    const view = render(<SplitPaneView root={rootFor("runtime-local")} {...props} />);

    await flushDeferredXtermMount();
    expect(view.container.querySelector(".zt-xterm-pane")?.getAttribute("data-context-menu-enabled")).toBe("true");

    view.unmount();

    const sshView = render(<SplitPaneView root={rootFor("runtime-ssh")} {...props} />);
    await flushDeferredXtermMount();
    expect(sshView.container.querySelector(".zt-xterm-pane")?.getAttribute("data-context-menu-enabled")).toBe("true");
    sshView.unmount();

    const containerView = render(<SplitPaneView root={rootFor("runtime-container")} {...props} />);
    await flushDeferredXtermMount();
    expect(containerView.container.querySelector(".zt-xterm-pane")?.getAttribute("data-context-menu-enabled")).toBe("true");
    expect(containerView.container.querySelector(".zt-terminal-placeholder")).toBeNull();
    containerView.unmount();
  });

  it("keeps xterm unmounted for the first visual switch frame", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
          history_scope_kind: "local_profile",
          history_scope_id: "git-bash",
          pane_id: "pane-a",
          title: "aaa",
          kind: "local",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({ "runtime-local": "$ " });
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-local",
      saved_session_id: "local-session-1",
      title: "aaa",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "aaa",
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
        },
      ],
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    await flushVisualSwitchFrame();

    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain("$ ");
    view.unmount();
  });

  it("renders terminal snapshots without mounting xterm in snapshot mode", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
          history_scope_kind: "local_profile",
          history_scope_id: "git-bash",
          pane_id: "pane-a",
          title: "aaa",
          kind: "local",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({ "runtime-local": "live output should not be read" });
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-local",
      saved_session_id: "local-session-1",
      title: "aaa",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "aaa",
          runtime_session_id: "runtime-local",
          saved_session_id: "local-session-1",
          visual_snapshot: {
            kind: "terminal_tail",
            text: "snapshot tail",
            captured_at_ms: 10,
            runtime_session_id: "runtime-local",
          },
        },
      ],
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
        visualMode="snapshot"
      />,
    );

    await flushDeferredXtermMount();

    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain("snapshot tail");
    expect(view.container.textContent).not.toContain("live output should not be read");
    view.unmount();
  });

  it("mounts inactive split panes in the active workspace after showing their snapshots first", () => {
    vi.useFakeTimers();
    const restorePaintTimers = installControlledPaintTimers();
    let view: ReturnType<typeof render> | null = null;
    useTerminalStore.setState({
      runtimes: {
        "runtime-active": {
          runtime_session_id: "runtime-active",
          saved_session_id: null,
          history_scope_kind: "local_profile",
          history_scope_id: "pwsh",
          pane_id: "pane-a",
          title: "Active",
          kind: "local",
          cols: 120,
          rows: 32,
        },
        "runtime-inactive": {
          runtime_session_id: "runtime-inactive",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-b",
          title: "Inactive",
          kind: "ssh",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({
      "runtime-active": "active output",
      "runtime-inactive": "inactive output",
    });
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: {
        kind: "leaf",
        id: "pane-a",
        runtime_session_id: "runtime-active",
        saved_session_id: null,
        title: "Active",
        active_terminal_tab_id: "pane-a-tab-1",
        terminal_tabs: [
          {
            id: "pane-a-tab-1",
            title: "Active",
            runtime_session_id: "runtime-active",
            saved_session_id: null,
          },
        ],
      },
      second: {
        kind: "leaf",
        id: "pane-b",
        runtime_session_id: "runtime-inactive",
        saved_session_id: "session-1",
        title: "Inactive",
        active_terminal_tab_id: "pane-b-tab-1",
        terminal_tabs: [
          {
            id: "pane-b-tab-1",
            title: "Inactive",
            runtime_session_id: "runtime-inactive",
            saved_session_id: "session-1",
            visual_snapshot: {
              kind: "terminal_tail",
              text: "inactive snapshot",
              captured_at_ms: 20,
              runtime_session_id: "runtime-inactive",
            },
          },
        ],
      },
    };
    try {
      view = render(
        <SplitPaneView
          root={root}
          activePaneId="pane-a"
          onActivatePane={vi.fn()}
          onAddPaneTab={vi.fn()}
          onSelectPaneTab={vi.fn()}
          onClosePaneTab={vi.fn()}
          onSplitPane={vi.fn()}
          onClosePane={vi.fn()}
        />,
      );

      expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(0);
      expect(view.container.textContent).toContain("inactive snapshot");
      expect(view.container.textContent).not.toContain("inactive output");

      act(() => {
        vi.advanceTimersByTime(60);
      });

      expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(1);
      expect(view.container.textContent).toContain("active output");
      expect(view.container.textContent).toContain("inactive snapshot");
      expect(view.container.textContent).not.toContain("inactive output");

      act(() => {
        vi.advanceTimersByTime(60);
      });

      expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(2);
      expect(view.container.textContent).toContain("active output");
      expect(view.container.textContent).toContain("inactive output");
    } finally {
      view?.unmount();
      restorePaintTimers();
      vi.useRealTimers();
    }
  });

  it("renders a tab and add button for every split leaf pane", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a", "172.16.41.180"),
      second: leaf("pane-b", "新建终端"),
    };
    const onAddPaneTab = vi.fn();
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={onAddPaneTab}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    const tablists = view.container.querySelectorAll(".zt-pane-tablist");
    const addButtons = view.container.querySelectorAll('button[aria-label="创建连接"]');

    expect(tablists).toHaveLength(2);
    expect(addButtons).toHaveLength(2);
    expect(view.container.textContent).toContain("172.16.41.180");
    expect(view.container.textContent).not.toContain("新建终端");

    act(() => {
      (addButtons[1] as HTMLButtonElement).click();
    });

    expect(onAddPaneTab).toHaveBeenCalledWith("pane-b");
    view.unmount();
  });

  it("highlights only the active terminal tab in the active leaf pane", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a", "PowerShell 7"),
      second: leaf("pane-b", "WSL"),
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-b"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    const activePaneTabs = view.container.querySelectorAll(".zt-pane-tab.active");
    const selectedTabs = Array.from(view.container.querySelectorAll('[role="tab"]')).filter(
      (tab) => tab.getAttribute("aria-selected") === "true",
    );

    expect(activePaneTabs).toHaveLength(1);
    expect(activePaneTabs[0].textContent).toBe("WSL");
    expect(selectedTabs).toHaveLength(1);
    expect(selectedTabs[0].textContent).toBe("WSL");
    view.unmount();
  });

  it("switches between multiple tabs inside the same leaf pane", () => {
    const onSelectPaneTab = vi.fn();
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: null,
      saved_session_id: null,
      title: "2.lz-gcp-35.239.137.54",
      active_terminal_tab_id: "pane-a-tab-2",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "1.cmd",
          runtime_session_id: null,
          saved_session_id: null,
        },
        {
          id: "pane-a-tab-2",
          title: "2.lz-gcp-35.239.137.54",
          runtime_session_id: null,
          saved_session_id: null,
        },
      ],
    };

    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={onSelectPaneTab}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    const tabs = view.container.querySelectorAll('[role="tab"]');

    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toBe("1.cmd");
    expect(tabs[1].textContent).toBe("2.lz-gcp-35.239.137.54");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");

    act(() => {
      (tabs[0] as HTMLButtonElement).click();
    });

    expect(onSelectPaneTab).toHaveBeenCalledWith("pane-a", "pane-a-tab-1");
    view.unmount();
  });

  it("shows a spinner and connecting placeholder for a pending restored tab", () => {
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: null,
      saved_session_id: "session-1",
      title: "生产机",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "生产机",
          runtime_session_id: null,
          saved_session_id: "session-1",
          connection_source: "saved_session",
          restore_status: "pending",
        },
      ],
    };

    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-pane-tab-spinner")?.getAttribute("aria-label")).toBe("正在连接 生产机");
    expect(view.container.querySelector(".zt-pane-tab-spinner .lucide-loader-circle")).not.toBeNull();
    expect(view.container.querySelector(".zt-terminal-placeholder")?.textContent).toContain("正在连接 生产机");
    expect(view.container.querySelector('[aria-label="空终端分栏"]')).toBeNull();
    view.unmount();
  });

  it("shows a queued restored tab without mounting xterm or using the pending spinner", () => {
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: null,
      saved_session_id: "session-1",
      title: "生产机",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "生产机",
          runtime_session_id: null,
          saved_session_id: "session-1",
          connection_source: "saved_session",
          restore_status: "queued",
        },
      ],
    };

    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-pane-tab-queued")?.getAttribute("aria-label")).toBe("等待连接 生产机");
    expect(view.container.querySelector(".zt-pane-tab-spinner")).toBeNull();
    expect(view.container.querySelector(".zt-terminal-placeholder")?.textContent).toContain("等待连接 生产机");
    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();
    view.unmount();
  });

  it("shows a failed restored tab error without mounting xterm", () => {
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: null,
      saved_session_id: "session-1",
      title: "生产机",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "生产机",
          runtime_session_id: null,
          saved_session_id: "session-1",
          connection_source: "saved_session",
          restore_status: "failed",
          restore_error: "连接失败",
        },
      ],
    };

    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelector(".zt-pane-tab-failed")?.getAttribute("aria-label")).toBe("连接失败 生产机");
    expect(view.container.querySelector(".zt-terminal-placeholder")?.textContent).toContain("连接失败");
    expect(view.container.querySelector(".zt-xterm-pane")).toBeNull();
    view.unmount();
  });

  it("does not mount xterm for inactive pane tabs that already have runtimes", async () => {
    useTerminalStore.setState({
      runtimes: {
        "runtime-active": {
          runtime_session_id: "runtime-active",
          saved_session_id: null,
          history_scope_kind: "local_profile",
          history_scope_id: "pwsh",
          pane_id: "pane-a",
          title: "Active",
          kind: "local",
          cols: 120,
          rows: 32,
        },
        "runtime-background": {
          runtime_session_id: "runtime-background",
          saved_session_id: "session-1",
          history_scope_kind: "saved_session",
          history_scope_id: "session-1",
          pane_id: "pane-a",
          title: "Background",
          kind: "ssh",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({
      "runtime-active": "active output",
      "runtime-background": "background output",
    });
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-active",
      saved_session_id: null,
      title: "Active",
      active_terminal_tab_id: "pane-a-tab-active",
      terminal_tabs: [
        {
          id: "pane-a-tab-active",
          title: "Active",
          runtime_session_id: "runtime-active",
          saved_session_id: null,
        },
        {
          id: "pane-a-tab-background",
          title: "Background",
          runtime_session_id: "runtime-background",
          saved_session_id: "session-1",
        },
      ],
    };

    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(0);
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain("active output");
    expect(view.container.textContent).toContain("active output");
    expect(view.container.textContent).not.toContain("background output");

    await flushDeferredXtermMount();

    expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(1);
    expect(view.container.textContent).toContain("active output");
    expect(view.container.textContent).not.toContain("background output");
    view.unmount();
  });

  it("unmounts the active xterm and freezes a snapshot while its workspace is hidden", async () => {
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: "runtime-local",
      saved_session_id: null,
      title: "Build Shell",
      active_terminal_tab_id: "pane-a-tab-1",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "Build Shell",
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          visual_snapshot: {
            kind: "terminal_tail",
            text: "before hide",
            captured_at_ms: 10,
            runtime_session_id: "runtime-local",
          },
        },
      ],
    };
    const props = {
      root,
      activePaneId: "pane-a",
      onActivatePane: vi.fn(),
      onAddPaneTab: vi.fn(),
      onSelectPaneTab: vi.fn(),
      onClosePaneTab: vi.fn(),
      onSplitPane: vi.fn(),
      onClosePane: vi.fn(),
    };
    useTerminalStore.setState({
      runtimes: {
        "runtime-local": {
          runtime_session_id: "runtime-local",
          saved_session_id: null,
          history_scope_kind: "local_profile",
          history_scope_id: "pwsh",
          pane_id: "pane-a",
          title: "Build Shell",
          kind: "local",
          cols: 120,
          rows: 32,
        },
      },
    });
    seedTerminalOutput({ "runtime-local": "before hide" });
    const view = render(<SplitPaneView {...props} />);

    await flushDeferredXtermMount();
    expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(1);
    expect(view.container.textContent).toContain("before hide");

    view.rerender(<SplitPaneView {...props} workspaceActive={false} />);
    act(() => {
      useTerminalStore.getState().appendOutput("runtime-local", "after hide");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(0);
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain("before hide");
    expect(view.container.textContent).toContain("before hide");
    expect(view.container.textContent).not.toContain("after hide");

    view.rerender(<SplitPaneView {...props} workspaceActive />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(0);
    expect(view.container.querySelector(".zt-terminal-snapshot-pane")?.textContent).toContain("before hide");

    await flushDeferredXtermMount();

    expect(view.container.querySelectorAll(".zt-xterm-pane")).toHaveLength(1);
    expect(view.container.textContent).toContain("after hide");
    view.unmount();
  });

  it("renders a close icon for each terminal tab and closes the clicked tab", () => {
    const onClosePaneTab = vi.fn();
    const root: PaneNode = {
      kind: "leaf",
      id: "pane-a",
      runtime_session_id: null,
      saved_session_id: null,
      title: "172.16.41.180 (2)",
      active_terminal_tab_id: "pane-a-tab-2",
      terminal_tabs: [
        {
          id: "pane-a-tab-1",
          title: "172.16.41.180 (1)",
          runtime_session_id: null,
          saved_session_id: null,
        },
        {
          id: "pane-a-tab-2",
          title: "172.16.41.180 (2)",
          runtime_session_id: null,
          saved_session_id: null,
        },
      ],
    };

    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={onClosePaneTab}
        onSplitPane={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    const closeButtons = view.container.querySelectorAll('[aria-label^="关闭标签"]');

    expect(closeButtons).toHaveLength(2);
    expect(closeButtons[1].querySelector(".lucide-x")).not.toBeNull();

    act(() => {
      (closeButtons[1] as HTMLButtonElement).click();
    });

    expect(onClosePaneTab).toHaveBeenCalledWith("pane-a", "pane-a-tab-2");
    view.unmount();
  });

  it("activates the pane that owns the toolbar before splitting from that pane", () => {
    const onActivatePane = vi.fn();
    const onSplitPane = vi.fn();
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a", "172.16.41.180"),
      second: leaf("pane-b", "新建终端"),
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={onActivatePane}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={onSplitPane}
        onClosePane={vi.fn()}
      />,
    );
    const verticalSplitButtons = view.container.querySelectorAll('[aria-label="纵向分栏"]');

    act(() => {
      (verticalSplitButtons[1] as HTMLButtonElement).click();
    });

    expect(onActivatePane).toHaveBeenCalledWith("pane-b");
    expect(onSplitPane).toHaveBeenCalledWith("vertical");
    expect(onActivatePane.mock.invocationCallOrder[0]).toBeLessThan(onSplitPane.mock.invocationCallOrder[0]);
    view.unmount();
  });

  it("renders split dividers without visible icons", () => {
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a", "PowerShell 7"),
      second: leaf("pane-b", "WSL"),
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onResizeSplit={vi.fn()}
        onClosePane={vi.fn()}
      />,
    );

    const divider = view.container.querySelector(".zt-split-divider");

    expect(divider).not.toBeNull();
    expect(divider?.querySelector("svg")).toBeNull();
    view.unmount();
  });

  it("calculates a horizontal split ratio while dragging the divider", () => {
    const onResizeSplit = vi.fn();
    const root: PaneNode = {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      ratio: 0.5,
      first: leaf("pane-a", "PowerShell 7"),
      second: leaf("pane-b", "WSL"),
    };
    const view = render(
      <SplitPaneView
        root={root}
        activePaneId="pane-a"
        onActivatePane={vi.fn()}
        onAddPaneTab={vi.fn()}
        onSelectPaneTab={vi.fn()}
        onClosePaneTab={vi.fn()}
        onSplitPane={vi.fn()}
        onResizeSplit={onResizeSplit}
        onClosePane={vi.fn()}
      />,
    );
    const splitPane = view.container.querySelector(".zt-split-pane");
    const divider = view.container.querySelector(".zt-split-divider");

    expect(splitPane).not.toBeNull();
    expect(divider).not.toBeNull();
    Object.defineProperty(splitPane, "getBoundingClientRect", {
      value: () => ({
        left: 0,
        top: 0,
        width: 800,
        height: 400,
        right: 800,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    act(() => {
      divider?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 100 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 600, clientY: 100 }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 600, clientY: 100 }));
    });

    expect(onResizeSplit).toHaveBeenLastCalledWith("split-root", 0.75);
    view.unmount();
  });
});
