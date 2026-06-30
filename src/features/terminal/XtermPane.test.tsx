// Author: Liz
import { StrictMode, act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const terminalMock = vi.hoisted(() => {
  interface MockDisposable {
    dispose: ReturnType<typeof vi.fn>;
  }

  interface MockMarker {
    dispose: ReturnType<typeof vi.fn>;
    line: number;
    onDispose: ReturnType<typeof vi.fn>;
  }

  interface MockTerminalInstance {
    buffer: {
      active: {
        baseY: number;
        cursorY: number;
        length: number;
        type: "normal" | "alternate";
        viewportY: number;
      };
    };
    clear: ReturnType<typeof vi.fn>;
    cols: number;
    dataListener?: (value: string) => void;
    dispose: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    host?: HTMLElement;
    loadAddon: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    onRender: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    onWriteParsed: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    options: unknown;
    registerMarker: ReturnType<typeof vi.fn>;
    renderListener?: () => void;
    resizeListener?: (size: { cols: number; rows: number }) => void;
    rows: number;
    scrollListener?: () => void;
    write: ReturnType<typeof vi.fn>;
    writeParsedListener?: () => void;
  }

  const disposable = (): MockDisposable => ({ dispose: vi.fn() });
  const instances: MockTerminalInstance[] = [];
  const Terminal = vi.fn(function (this: unknown, options: unknown) {
    const loadAddon = vi.fn();
    const instance: MockTerminalInstance = {
      buffer: {
        active: {
          baseY: 0,
          cursorY: 5,
          length: 10,
          type: "normal",
          viewportY: 0,
        },
      },
      clear: vi.fn(),
      cols: 80,
      dispose: vi.fn(),
      focus: vi.fn(),
      getSelection: vi.fn(() => "selected text"),
      loadAddon,
      onData: vi.fn((listener: (value: string) => void) => {
        instance.dataListener = listener;
        return disposable();
      }),
      onRender: vi.fn((listener: () => void) => {
        instance.renderListener = listener;
        return disposable();
      }),
      onResize: vi.fn((listener: (size: { cols: number; rows: number }) => void) => {
        instance.resizeListener = listener;
        return disposable();
      }),
      onScroll: vi.fn((listener: () => void) => {
        instance.scrollListener = listener;
        return disposable();
      }),
      onWriteParsed: vi.fn((listener: () => void) => {
        instance.writeParsedListener = listener;
        return disposable();
      }),
      open: vi.fn((container: HTMLElement) => {
        instance.host = container;
        const terminal = document.createElement("div");
        terminal.className = "terminal xterm";
        terminal.style.lineHeight = "17px";
        const rows = document.createElement("div");
        rows.className = "xterm-rows";
        for (let rowIndex = 0; rowIndex < 10; rowIndex += 1) {
          const row = document.createElement("div");
          row.style.height = "17px";
          rows.appendChild(row);
        }
        terminal.appendChild(rows);
        container.appendChild(terminal);
      }),
      options,
      registerMarker: vi.fn(() => {
        const marker: MockMarker = {
          dispose: vi.fn(),
          line: instance.buffer.active.baseY + instance.buffer.active.cursorY,
          onDispose: vi.fn(() => disposable()),
        };
        return marker;
      }),
      rows: 10,
      write: vi.fn((_data: string, callback?: () => void) => callback?.()),
    };
    instances.push(instance);
    return instance;
  });
  return { instances, Terminal };
});

const webglAddonMock = vi.hoisted(() => ({
  WebglAddon: vi.fn(function () {
    return {};
  }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMock.Terminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn(function () {
    return { fit: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn(function () {
    return { findNext: vi.fn() };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn(function () {
    return {};
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: webglAddonMock.WebglAddon,
}));

import { XtermPane } from "./XtermPane";

interface TerminalOptions {
  fontFamily?: string;
  fontSize?: number;
  theme?: Record<string, string>;
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

async function flushAfterNextPaint() {
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

describe("XtermPane", () => {
  beforeEach(() => {
    terminalMock.instances.length = 0;
    terminalMock.Terminal.mockClear();
    webglAddonMock.WebglAddon.mockClear();
    delete document.documentElement.dataset.ztTheme;
  });

  it("initializes xterm with the kerminal-like dark ANSI palette without changing font settings", () => {
    const view = render(<XtermPane data="" />);

    const options = terminalMock.instances[0]?.options as TerminalOptions;

    expect(options.fontSize).toBe(13);
    expect(options.fontFamily).toContain("Cascadia Mono");
    expect(options.fontFamily).toContain("Microsoft YaHei Mono");
    expect(options.theme).toMatchObject({
      background: "#1f1f21",
      foreground: "rgba(245, 245, 247, 0.9)",
      cursor: "rgba(245, 245, 247, 0.9)",
      black: "rgba(38, 38, 42, 0.96)",
      red: "rgba(255, 95, 86, 0.94)",
      green: "rgba(48, 209, 88, 0.94)",
      yellow: "rgba(255, 214, 10, 0.94)",
      blue: "rgba(100, 210, 255, 0.94)",
      magenta: "rgba(191, 90, 242, 0.94)",
      cyan: "rgba(100, 210, 255, 0.88)",
      white: "rgba(245, 245, 247, 0.86)",
      brightBlack: "rgba(150, 150, 158, 0.9)",
      brightRed: "rgba(249, 38, 114, 0.94)",
      brightGreen: "rgba(50, 215, 75, 0.94)",
      brightYellow: "rgba(255, 214, 10, 0.94)",
      brightBlue: "rgba(10, 132, 255, 0.94)",
      brightMagenta: "rgba(191, 90, 242, 0.94)",
      brightCyan: "rgba(102, 217, 239, 0.94)",
      brightWhite: "rgba(255, 255, 255, 0.92)",
    });
    view.unmount();
  });

  it("initializes xterm with a readable light palette when the document theme is light", () => {
    document.documentElement.dataset.ztTheme = "light";
    const view = render(<XtermPane data="" />);

    const options = terminalMock.instances[0]?.options as TerminalOptions;

    expect(options.theme).toMatchObject({
      background: "#f7f7fa",
      foreground: "#1d1d1f",
      cursor: "#1d1d1f",
      black: "#1d1d1f",
      red: "#d70015",
      green: "#248a3d",
      yellow: "#b25000",
      blue: "#0066cc",
      magenta: "#af52de",
      cyan: "#0071a4",
      white: "#f5f5f7",
      brightBlack: "#6e6e73",
      brightWhite: "#ffffff",
    });

    view.unmount();
    delete document.documentElement.dataset.ztTheme;
  });

  it("uses xterm's default renderer instead of the WebGL renderer to avoid GPU texture artifacts", () => {
    const view = render(<XtermPane data="" />);

    expect(webglAddonMock.WebglAddon).not.toHaveBeenCalled();
    expect(terminalMock.instances[0]?.loadAddon).toHaveBeenCalledTimes(3);

    view.unmount();
  });

  it("clears the xterm host immediately and defers terminal dispose until the next task when unmounting", async () => {
    const view = render(<XtermPane data="" />);
    const terminal = terminalMock.instances[0];
    const replaceChildrenSpy = vi.spyOn(terminal.host!, "replaceChildren");

    view.unmount();

    expect(replaceChildrenSpy).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).not.toHaveBeenCalled();

    await flushAfterNextPaint();

    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not render command timestamps or folding controls next to xterm output", async () => {
    const view = render(<XtermPane data="" />);
    const terminal = terminalMock.instances[0];
    terminal.buffer.active.cursorY = 2;

    await act(async () => {
      terminal.dataListener?.("ls -la\r");
      terminal.buffer.active.cursorY = 6;
      terminal.writeParsedListener?.();
    });

    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".xterm-rows > div"));

    expect(view.container.querySelector(".zt-terminal-activity-rail")).toBeNull();
    expect(view.container.querySelector('[aria-label*="命令输出"]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(rows.some((row) => row.dataset.terminalActivityFolded === "true")).toBe(false);
    expect(rows.some((row) => row.style.visibility === "hidden")).toBe(false);

    view.unmount();
  });

  it("writes first connection output without folding or connection time markers", async () => {
    const view = render(<XtermPane data="" />);
    const terminal = terminalMock.instances[0];
    const rows = Array.from(view.container.querySelectorAll<HTMLElement>(".xterm-rows > div"));
    rows[0].textContent = "ubuntu@172.16.41.180's password:";
    rows[8].textContent = "ubuntu@ubuntu:~$";
    terminal.buffer.active.cursorY = 0;

    view.rerender(<XtermPane data={"Welcome to Ubuntu\r\nSystem information\r\nLast login\r\n"} />);
    await act(async () => {
      terminal.buffer.active.cursorY = 8;
      terminal.buffer.active.length = 12;
      terminal.writeParsedListener?.();
    });

    const foldedRows = Array.from(view.container.querySelectorAll<HTMLElement>(".xterm-rows > div")).filter(
      (row) => row.dataset.terminalActivityFolded === "true",
    );

    expect(view.container.querySelector(".zt-terminal-activity-rail")).toBeNull();
    expect(view.container.querySelector('[aria-label*="命令输出"]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    expect(foldedRows).toHaveLength(0);
    expect(rows[0].style.visibility).not.toBe("hidden");
    expect(rows[8].style.visibility).not.toBe("hidden");
    expect(rows[8].style.transform).not.toContain("translateY");

    view.unmount();
  });

  it("shows a ghost completion and accepts only the missing suffix with Tab", async () => {
    const onInput = vi.fn();
    const onCompletionRequest = vi.fn().mockResolvedValue([
      {
        provider: "system",
        replacement_text: "echo",
        replacement_range: { start: 0, end: 2 },
        score: 0.8,
        source_label: "系统命令",
        suffix: "ho",
      },
    ]);
    const view = render(
      <XtermPane data="" onCompletionRequest={onCompletionRequest} onInput={onInput} />,
    );
    const terminal = terminalMock.instances[0];

    await act(async () => {
      terminal.dataListener?.("ec");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onInput).toHaveBeenCalledWith("ec");
    expect(onCompletionRequest).toHaveBeenCalledWith("ec", 2);
    expect(view.container.querySelector(".zt-command-ghost")?.textContent).toBe("ho");

    await act(async () => {
      terminal.dataListener?.("\t");
      await Promise.resolve();
    });

    expect(onInput).toHaveBeenLastCalledWith("ho");
    expect(view.container.querySelector(".zt-command-ghost")).toBeNull();

    view.unmount();
  });

  it("suppresses terminal-generated input while replaying existing output", async () => {
    const onInput = vi.fn();
    const view = render(<XtermPane data="" streamId="runtime-1" onInput={onInput} />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockImplementationOnce(() => undefined);

    view.rerender(<XtermPane data={"existing output\x1b[6n"} streamId="runtime-1" onInput={onInput} />);

    await act(async () => {
      terminal.dataListener?.("\x1b[12;40R");
      await Promise.resolve();
    });

    expect(onInput).not.toHaveBeenCalled();

    view.unmount();
  });

  it("allows an initial live terminal status query to generate a CPR response", async () => {
    const onInput = vi.fn();
    const view = render(<XtermPane data="" streamId="runtime-1" onInput={onInput} />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      terminal.dataListener?.("\x1b[1;1R");
      callback?.();
    });

    view.rerender(<XtermPane data={"\x1b[6n"} streamId="runtime-1" onInput={onInput} />);

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R");
    view.unmount();
  });

  it("replays an initial terminal status query after StrictMode remounts the terminal effect", () => {
    const view = render(
      <StrictMode>
        <XtermPane
          data={"\x1b[6n"}
          liveData={"\x1b[6n"}
          liveSerial={1}
          replayKey={1}
          streamId="runtime-1"
        />
      </StrictMode>,
    );

    expect(terminalMock.instances.length).toBeGreaterThanOrEqual(2);
    const remountedTerminal = terminalMock.instances[terminalMock.instances.length - 1];
    expect(remountedTerminal?.write).toHaveBeenCalledWith("\x1b[6n");
    view.unmount();
  });

  it("allows live replay that only contains a terminal status query to generate a CPR response", async () => {
    const onInput = vi.fn();
    const view = render(
      <XtermPane
        data=""
        liveData={null}
        liveSerial={null}
        replayKey={0}
        streamId="runtime-1"
        onInput={onInput}
      />,
    );
    const terminal = terminalMock.instances[0];
    terminal.write.mockImplementation((data: string, callback?: () => void) => {
      if (data === "\x1b[6n") {
        terminal.dataListener?.("\x1b[1;1R");
      }
      callback?.();
    });

    view.rerender(
      <XtermPane
        data={"\x1b[6n"}
        liveData={null}
        liveSerial={null}
        replayKey={1}
        streamId="runtime-1"
        onInput={onInput}
      />,
    );

    await act(async () => {
      terminal.dataListener?.("e");
      await Promise.resolve();
    });

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R");
    expect(onInput).toHaveBeenCalledWith("e");
    view.unmount();
  });

  it("allows an initial local shell handshake with cursor controls to generate a CPR response", () => {
    const onInput = vi.fn();
    const view = render(<XtermPane data="" streamId="runtime-1" onInput={onInput} />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockImplementationOnce((data: string, callback?: () => void) => {
      if (data.includes("\x1b[6n")) {
        terminal.dataListener?.("\x1b[1;1R");
      }
      callback?.();
    });

    view.rerender(<XtermPane data={"\x1b[?25l\x1b[6n"} streamId="runtime-1" onInput={onInput} />);

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R");
    view.unmount();
  });

  it("allows a new stream status query to generate CPR after a pending suppressed replay", () => {
    const onInput = vi.fn();
    const view = render(<XtermPane data="" streamId="runtime-old" onInput={onInput} />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockImplementationOnce(() => undefined);

    view.rerender(<XtermPane data={"previous output\x1b[6n"} streamId="runtime-old" onInput={onInput} />);
    expect(onInput).not.toHaveBeenCalled();

    terminal.write.mockImplementationOnce((data: string, callback?: () => void) => {
      if (data.includes("\x1b[6n")) {
        terminal.dataListener?.("\x1b[1;1R");
      }
      callback?.();
    });
    view.rerender(<XtermPane data={"\x1b[?25l\x1b[6n"} streamId="runtime-new" onInput={onInput} />);

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R");
    view.unmount();
  });

  it("limits replayed output and strips terminal status queries that would regenerate input", () => {
    const replay = `${"a".repeat(120_000)}\x1b[6nTAIL`;
    const view = render(<XtermPane data={replay} streamId="runtime-1" />);
    const terminal = terminalMock.instances[0];

    const written = terminal.write.mock.calls[0][0] as string;
    expect(written.length).toBeLessThan(replay.length);
    expect(written.length).toBeLessThanOrEqual(16_004);
    expect(written).not.toContain("\x1b[6n");
    expect(written.endsWith("TAIL")).toBe(true);

    view.rerender(<XtermPane data={`${replay}x`} streamId="runtime-1" />);

    expect(terminal.write).toHaveBeenLastCalledWith("x");
    view.unmount();
  });

  it("clears and replays the current runtime tail when switching terminal streams", () => {
    const view = render(<XtermPane data={"old output"} streamId="runtime-old" />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockClear();
    terminal.clear.mockClear();

    view.rerender(<XtermPane data={`${"n".repeat(20_000)}new output`} streamId="runtime-new" />);

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    const written = terminal.write.mock.calls[0][0] as string;
    expect(written.length).toBeLessThanOrEqual(16_010);
    expect(written.endsWith("new output")).toBe(true);
    view.unmount();
  });

  it("does not duplicate the live chunk already included in a replay", () => {
    const view = render(
      <XtermPane
        data="hello chunk"
        liveData=" chunk"
        liveSerial={1}
        replayKey={1}
        streamId="runtime-1"
      />,
    );
    const terminal = terminalMock.instances[0];

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write.mock.calls[0][0]).toBe("hello chunk");

    view.rerender(
      <XtermPane
        data="hello chunk"
        liveData=" next"
        liveSerial={2}
        replayKey={1}
        streamId="runtime-1"
      />,
    );

    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write.mock.calls[1][0]).toBe(" next");
    view.unmount();
  });

  it("does not mark a live chunk as processed before delayed replay data writes", () => {
    const view = render(
      <XtermPane data="" liveData={"PS C:\\workspace> "} liveSerial={1} replayKey={0} streamId="runtime-1" />,
    );
    const terminal = terminalMock.instances[0];

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith("PS C:\\workspace> ");

    view.rerender(
      <XtermPane
        data={"PS C:\\workspace> "}
        liveData={"PS C:\\workspace> "}
        liveSerial={1}
        replayKey={1}
        streamId="runtime-1"
      />,
    );

    expect(terminal.write).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("passes live xterm cursor position reports through because remote terminal apps depend on them", async () => {
    const onInput = vi.fn();
    const view = render(<XtermPane data="" onInput={onInput} />);
    const terminal = terminalMock.instances[0];

    await act(async () => {
      terminal.dataListener?.("\x1b[12;40R");
      terminal.dataListener?.("R");
      await Promise.resolve();
    });

    expect(onInput).toHaveBeenCalledTimes(2);
    expect(onInput).toHaveBeenNthCalledWith(1, "\x1b[12;40R");
    expect(onInput).toHaveBeenNthCalledWith(2, "R");

    view.unmount();
  });

  it("forwards resize events only when terminal dimensions change", async () => {
    const onResize = vi.fn();
    const view = render(<XtermPane data="" onResize={onResize} />);
    const terminal = terminalMock.instances[0];

    await act(async () => {
      terminal.resizeListener?.({ cols: 120, rows: 32 });
      terminal.resizeListener?.({ cols: 120, rows: 32 });
      terminal.resizeListener?.({ cols: 121, rows: 32 });
      await Promise.resolve();
    });

    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenNthCalledWith(1, 120, 32);
    expect(onResize).toHaveBeenNthCalledWith(2, 121, 32);

    view.unmount();
  });

  it("hides ghost completion with Escape without sending input", async () => {
    const onInput = vi.fn();
    const onCompletionRequest = vi.fn().mockResolvedValue([
      {
        provider: "history",
        replacement_text: "git status",
        replacement_range: { start: 0, end: 3 },
        score: 0.9,
        source_label: "当前会话历史",
        suffix: " status",
      },
    ]);
    const view = render(
      <XtermPane data="" onCompletionRequest={onCompletionRequest} onInput={onInput} />,
    );
    const terminal = terminalMock.instances[0];

    await act(async () => {
      terminal.dataListener?.("git");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.container.querySelector(".zt-command-ghost")?.textContent).toBe(" status");

    await act(async () => {
      terminal.dataListener?.("\x1b");
      await Promise.resolve();
    });

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith("git");
    expect(view.container.querySelector(".zt-command-ghost")).toBeNull();

    view.unmount();
  });

  it("resets completion input after Ctrl+C before requesting the next prefix", async () => {
    const onCompletionRequest = vi.fn().mockResolvedValue([]);
    const view = render(<XtermPane data="" onCompletionRequest={onCompletionRequest} />);
    const terminal = terminalMock.instances[0];

    await act(async () => {
      terminal.dataListener?.("git");
      await Promise.resolve();
      await Promise.resolve();
      terminal.dataListener?.("\x03");
      await Promise.resolve();
      terminal.dataListener?.("ec");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onCompletionRequest).toHaveBeenLastCalledWith("ec", 2);

    view.unmount();
  });

  it("shows terminal context actions in two groups and dispatches local operations", async () => {
    const onDisconnect = vi.fn();
    const onInput = vi.fn();
    const onReconnect = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const readText = vi.fn().mockResolvedValue("pasted text");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText, readText },
    });
    vi.spyOn(window, "prompt").mockReturnValue("error");
    const view = render(
      <XtermPane data="" onDisconnect={onDisconnect} onInput={onInput} onReconnect={onReconnect} />,
    );
    async function openMenu() {
      await act(async () => {
        view.container.querySelector(".zt-xterm-pane")?.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
        );
        await Promise.resolve();
      });
    }

    await openMenu();

    const menuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual(["复制", "粘贴", "清屏", "搜索", "重新连接", "断开连接"]);
    expect(view.container.querySelector('[role="separator"]')).not.toBeNull();

    await act(async () => {
      (view.container.querySelector('[role="menuitem"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("selected text");

    await openMenu();
    await act(async () => {
      (Array.from(view.container.querySelectorAll('[role="menuitem"]'))[1] as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onInput).toHaveBeenCalledWith("pasted text");

    await openMenu();
    await act(async () => {
      (Array.from(view.container.querySelectorAll('[role="menuitem"]'))[2] as HTMLButtonElement).click();
    });
    expect(terminalMock.instances[0].clear).toHaveBeenCalled();

    await openMenu();
    await act(async () => {
      (Array.from(view.container.querySelectorAll('[role="menuitem"]'))[4] as HTMLButtonElement).click();
    });
    await openMenu();
    await act(async () => {
      (Array.from(view.container.querySelectorAll('[role="menuitem"]'))[5] as HTMLButtonElement).click();
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("shows only edit and search actions when connection actions are unavailable", async () => {
    const view = render(<XtermPane data="" />);

    await act(async () => {
      view.container.querySelector(".zt-xterm-pane")?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 12, clientY: 18 }),
      );
      await Promise.resolve();
    });

    const menuItems = Array.from(view.container.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim());
    expect(menuItems).toEqual(["复制", "粘贴", "清屏", "搜索"]);
    expect(view.container.querySelector('[role="separator"]')).toBeNull();

    view.unmount();
  });

  it("prevents the default context menu without rendering actions when disabled", async () => {
    const view = render(<XtermPane contextMenuEnabled={false} data="" />);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 18 });

    await act(async () => {
      view.container.querySelector(".zt-xterm-pane")?.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    view.unmount();
  });
});
