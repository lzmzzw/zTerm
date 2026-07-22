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
    isDisposed: boolean;
    line: number;
    onDispose: ReturnType<typeof vi.fn>;
  }

  interface MockTerminalInstance {
    attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    buffer: {
      active: {
        baseY: number;
        cursorX: number;
        cursorY: number;
        getLine: (line: number) =>
          | {
              getCell: (column: number) =>
                | { getChars: () => string; getWidth: () => number; isFgDefault: () => boolean }
                | undefined;
              isWrapped: boolean;
              length: number;
              translateToString: () => string;
            }
          | undefined;
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
    onCursorMove: ReturnType<typeof vi.fn>;
    onRender: ReturnType<typeof vi.fn>;
    onResize: ReturnType<typeof vi.fn>;
    onScroll: ReturnType<typeof vi.fn>;
    onWriteParsed: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    options: unknown;
    registerDecoration: ReturnType<typeof vi.fn>;
    registerMarker: ReturnType<typeof vi.fn>;
    renderListener?: () => void;
    resizeListener?: (size: { cols: number; rows: number }) => void;
    rows: number;
    selectAll: ReturnType<typeof vi.fn>;
    bufferLines: Map<number, string>;
    customKeyEventHandler?: (event: KeyboardEvent) => boolean;
    scrollListener?: () => void;
    write: ReturnType<typeof vi.fn>;
    writeParsedListener?: () => void;
  }

  const disposable = (): MockDisposable => ({ dispose: vi.fn() });
  const instances: MockTerminalInstance[] = [];
  const Terminal = vi.fn(function (this: unknown, options: unknown) {
    const loadAddon = vi.fn();
    const instance: MockTerminalInstance = {
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        instance.customKeyEventHandler = handler;
      }),
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 5,
          getLine: (line: number) => {
            const text = instance.bufferLines.get(line);
            if (text === undefined) return undefined;
            const characters = Array.from(text);
            return {
              getCell: (column: number) => {
                const character = characters[column];
                if (character === undefined) return undefined;
                return {
                  getChars: () => character,
                  getWidth: () => 1,
                  isFgDefault: () => true,
                };
              },
              isWrapped: false,
              length: characters.length,
              translateToString: () => text,
            };
          },
          length: 10,
          type: "normal",
          viewportY: 0,
        },
      },
      bufferLines: new Map(),
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
      onCursorMove: vi.fn(() => disposable()),
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
      registerDecoration: vi.fn((decorationOptions: { marker: MockMarker }) => ({
        dispose: vi.fn(),
        marker: decorationOptions.marker,
      })),
      registerMarker: vi.fn((offset = 0) => {
        const marker: MockMarker = {
          dispose: vi.fn(() => {
            marker.isDisposed = true;
          }),
          isDisposed: false,
          line: instance.buffer.active.baseY + instance.buffer.active.cursorY + offset,
          onDispose: vi.fn(() => disposable()),
        };
        return marker;
      }),
      rows: 10,
      selectAll: vi.fn(),
      write: vi.fn((_data: string, callback?: () => void) => callback?.()),
    };
    instances.push(instance);
    return instance;
  });
  return { instances, Terminal };
});

const fitAddonMock = vi.hoisted(() => {
  const instances: Array<{ fit: ReturnType<typeof vi.fn> }> = [];
  const FitAddon = vi.fn(function () {
    const instance = { fit: vi.fn() };
    instances.push(instance);
    return instance;
  });
  return { FitAddon, instances };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMock.Terminal,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: fitAddonMock.FitAddon,
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

import { XtermPane } from "./XtermPane";

interface TerminalOptions {
  allowProposedApi?: boolean;
  cursorInactiveStyle?: "outline";
  cursorStyle?: "block";
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
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

async function flushQueuedTerminalWrites(turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function writtenTerminalText(terminal: (typeof terminalMock.instances)[number]) {
  return terminal.write.mock.calls.map((call) => call[0] as string).join("");
}

function lastWrittenTerminalText(terminal: (typeof terminalMock.instances)[number]) {
  const lastCall = terminal.write.mock.calls[terminal.write.mock.calls.length - 1];
  return lastCall?.[0] as string | undefined;
}

describe("XtermPane", () => {
  beforeEach(() => {
    terminalMock.instances.length = 0;
    terminalMock.Terminal.mockClear();
    fitAddonMock.instances.length = 0;
    fitAddonMock.FitAddon.mockClear();
    delete document.documentElement.dataset.ztTheme;
  });

  it("initializes xterm with the dige-black ANSI palette without changing font settings", () => {
    const view = render(<XtermPane data="" />);

    const options = terminalMock.instances[0]?.options as TerminalOptions;

    expect(options.allowProposedApi).toBe(true);
    expect(options.fontSize).toBe(13);
    expect(options.fontWeight).toBe(350);
    expect(options.fontFamily).toContain("Cascadia Mono");
    expect(options.fontFamily).toContain("Microsoft YaHei Mono");
    expect(options.theme).toMatchObject({
      background: "#1f1f21",
      foreground: "#F8F8F2",
      cursor: "#ff9d00",
      cursorAccent: "#1f1f21",
      black: "#333333",
      red: "#C4265E",
      green: "#86B42B",
      yellow: "#D0A500",
      blue: "#3465A4",
      magenta: "#8C6BC8",
      cyan: "#56ADBC",
      white: "#e3e3dd",
      brightBlack: "#666666",
      brightRed: "#f92672",
      brightGreen: "#A6E22E",
      brightYellow: "#9e862f",
      brightBlue: "#819aff",
      brightMagenta: "#AE81FF",
      brightCyan: "#66D9EF",
      brightWhite: "#f8f8f2",
    });
    expect(options.cursorStyle).toBe("block");
    expect(options.cursorInactiveStyle).toBe("outline");
    expect(terminalMock.instances[0]?.focus).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("initializes xterm with the dige-white ANSI palette when the document theme is light", () => {
    document.documentElement.dataset.ztTheme = "light";
    const view = render(<XtermPane data="" />);

    const options = terminalMock.instances[0]?.options as TerminalOptions;

    expect(options.theme).toMatchObject({
      background: "#f7f7fa",
      foreground: "#333333",
      cursor: "#ff9d00",
      cursorAccent: "#f7f7fa",
      black: "#272822",
      red: "#dc322f",
      green: "#32CD32",
      yellow: "#FFD700",
      blue: "#3465A4",
      magenta: "#d33682",
      cyan: "#3A96DD",
      white: "#D3D3D3",
      brightBlack: "#333333",
      brightRed: "#ff7882",
      brightGreen: "#3CB371",
      brightYellow: "#D2691E",
      brightBlue: "#80baff",
      brightMagenta: "#d778ff",
      brightCyan: "#78ffff",
      brightWhite: "#708090",
    });

    view.unmount();
    delete document.documentElement.dataset.ztTheme;
  });

  it("does not take focus from an inactive terminal pane", () => {
    const view = render(<XtermPane autoFocus={false} data="" />);

    expect(terminalMock.instances[0]?.focus).not.toHaveBeenCalled();

    view.unmount();
  });

  it("adds WindTerm-style semantic colors to default-colored terminal output", () => {
    const view = render(<XtermPane data="" />);
    const terminal = terminalMock.instances[0];
    terminal.bufferLines.set(0, "drwx------  5 root root  4096 Jun 30 10:25");
    terminal.buffer.active.cursorY = 0;
    terminal.buffer.active.length = 1;

    act(() => terminal.writeParsedListener?.());

    expect(terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, width: 1, foregroundColor: "#b267e6", layer: "bottom" }),
    );
    expect(terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 4, width: 6, foregroundColor: "#A6E22E", layer: "bottom" }),
    );
    expect(terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 12, width: 1, foregroundColor: "#AE81FF", layer: "bottom" }),
    );

    view.unmount();
  });

  it("uses dige-white semantic colors for local CMD and PowerShell output in the light theme", () => {
    document.documentElement.dataset.ztTheme = "light";
    const view = render(<XtermPane data="" />);
    const terminal = terminalMock.instances[0];
    terminal.bufferLines.set(0, "C:\\work\\zTerm>dir /a");
    terminal.buffer.active.cursorY = 0;
    terminal.buffer.active.length = 1;

    act(() => terminal.writeParsedListener?.());

    expect(terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, width: 13, foregroundColor: "#FF8C00", layer: "bottom" }),
    );
    expect(terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 14, width: 3, foregroundColor: "#1E90FF", layer: "bottom" }),
    );

    view.unmount();
    delete document.documentElement.dataset.ztTheme;
  });

  it("uses xterm's default renderer instead of the WebGL renderer to avoid GPU texture artifacts", () => {
    const view = render(<XtermPane data="" />);

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

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R", { source: "terminal_response" });
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
    expect(remountedTerminal?.write.mock.calls.some((call) => call[0] === "\x1b[6n")).toBe(true);
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

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R", { source: "terminal_response" });
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

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R", { source: "terminal_response" });
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

    expect(onInput).toHaveBeenCalledWith("\x1b[1;1R", { source: "terminal_response" });
    view.unmount();
  });

  it("limits replayed output and strips terminal status queries that would regenerate input", async () => {
    const replay = `${"a".repeat(120_000)}\x1b[6nTAIL`;
    const view = render(<XtermPane data={replay} streamId="runtime-1" />);
    const terminal = terminalMock.instances[0];

    await flushQueuedTerminalWrites();

    const written = writtenTerminalText(terminal);
    expect(written.length).toBeLessThan(replay.length);
    expect(written.length).toBeLessThanOrEqual(16_004);
    expect(written).not.toContain("\x1b[6n");
    expect(written.endsWith("TAIL")).toBe(true);

    view.rerender(<XtermPane data={`${replay}x`} streamId="runtime-1" />);

    expect(lastWrittenTerminalText(terminal)).toBe("x");
    view.unmount();
  });

  it("clears and replays the current runtime tail when switching terminal streams", async () => {
    const view = render(<XtermPane data={"old output"} streamId="runtime-old" />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockClear();
    terminal.clear.mockClear();

    view.rerender(<XtermPane data={`${"n".repeat(20_000)}new output`} streamId="runtime-new" />);

    expect(terminal.clear).toHaveBeenCalledTimes(1);
    await flushQueuedTerminalWrites();

    const written = writtenTerminalText(terminal);
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
    expect(terminal.write.mock.calls[0][0]).toBe("PS C:\\workspace> ");

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

    expect(onResize).toHaveBeenCalledTimes(3);
    expect(onResize).toHaveBeenNthCalledWith(1, terminal.cols, terminal.rows);
    expect(onResize).toHaveBeenNthCalledWith(2, 120, 32);
    expect(onResize).toHaveBeenNthCalledWith(3, 121, 32);

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

  it("does not truncate a serialized screen replay", async () => {
    const replay = `${"a".repeat(20_000)}TAIL`;
    const view = render(<XtermPane data={replay} replayKind="screen" streamId="runtime-1" />);
    const terminal = terminalMock.instances[0];

    await flushQueuedTerminalWrites();

    expect(writtenTerminalText(terminal)).toBe(replay);
    view.unmount();
  });

  it("marks input generated while parsing live output as a terminal response", () => {
    const onInput = vi.fn();
    const view = render(<XtermPane data="" streamId="runtime-1" onInput={onInput} />);
    const terminal = terminalMock.instances[0];
    terminal.write.mockImplementationOnce((_data: string, callback?: () => void) => {
      terminal.dataListener?.("\u001b[12;40R");
      callback?.();
    });

    view.rerender(
      <XtermPane
        data=""
        liveData={"\u001b[6n"}
        liveSerial={1}
        streamId="runtime-1"
        onInput={onInput}
      />,
    );

    expect(onInput).toHaveBeenCalledWith("\u001b[12;40R", { source: "terminal_response" });
    view.unmount();
  });

  it("selects all terminal content with ctrl+a", async () => {
    const view = render(<XtermPane data="" />);
    const event = new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    const terminal = terminalMock.instances[0];

    expect(terminal.customKeyEventHandler?.(event)).toBe(false);
    expect(terminal.selectAll).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("subscribes to xterm resize events before the initial fit so the PTY receives the measured size", () => {
    const onResize = vi.fn();
    const view = render(<XtermPane data="" onResize={onResize} />);
    const terminal = terminalMock.instances[0];
    const fitAddon = fitAddonMock.instances[0];

    expect(terminal.onResize).toHaveBeenCalledTimes(1);
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(terminal.onResize.mock.invocationCallOrder[0]).toBeLessThan(
      fitAddon.fit.mock.invocationCallOrder[0],
    );
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(terminal.cols, terminal.rows);

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
