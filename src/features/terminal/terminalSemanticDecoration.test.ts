// Author: Liz
import type { IDecorationOptions, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import {
  createTerminalSemanticHighlighter,
  DIGE_BLACK_SEMANTIC_PALETTE,
} from "./terminalSemanticHighlight";

function fakeTerminal(
  lineText: string | string[],
  ansiColumns: number[] = [],
  bufferType: "normal" | "alternate" = "normal",
  cursorY = 0,
) {
  const decorationOptions: IDecorationOptions[] = [];
  const decorations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const markers: Array<{ dispose: ReturnType<typeof vi.fn>; isDisposed: boolean; line: number }> = [];
  let cursorMoveListener: (() => void) | undefined;
  const lines = typeof lineText === "string" ? [lineText] : lineText;
  const active = {
    baseY: 0,
    cursorX: lines[cursorY]?.length ?? 0,
    cursorY,
    getLine: (line: number) => {
      const text = lines[line];
      if (text === undefined) return undefined;
      const cells = Array.from(text).map((character, column) => ({
        getChars: () => character,
        getWidth: () => 1,
        isFgDefault: () => !ansiColumns.includes(column),
      }));
      return {
        getCell: (column: number) => cells[column],
        isWrapped: false,
        length: cells.length,
        translateToString: () => text,
      };
    },
    getNullCell: () => ({ getChars: () => "", getWidth: () => 1, isFgDefault: () => true }),
    length: lines.length,
    type: bufferType,
    viewportY: 0,
  };
  const terminal = {
    buffer: { active },
    cols: 120,
    onCursorMove: vi.fn((listener: () => void) => {
      cursorMoveListener = listener;
      return { dispose: vi.fn() };
    }),
    onScroll: vi.fn(() => ({ dispose: vi.fn() })),
    onWriteParsed: vi.fn(() => ({ dispose: vi.fn() })),
    registerDecoration: vi.fn((options: IDecorationOptions) => {
      decorationOptions.push(options);
      const decoration = { dispose: vi.fn(), marker: options.marker };
      decorations.push(decoration);
      return decoration;
    }),
    registerMarker: vi.fn((offset = 0) => {
      const marker = {
        dispose: vi.fn(function (this: { isDisposed: boolean }) {
          this.isDisposed = true;
        }),
        isDisposed: false,
        line: active.baseY + active.cursorY + offset,
      };
      markers.push(marker);
      return marker;
    }),
    rows: 30,
  } as unknown as Terminal;
  return { decorationOptions, decorations, emitCursorMove: () => cursorMoveListener?.(), markers, terminal };
}

describe("createTerminalSemanticHighlighter", () => {
  it("requires xterm's proposed API gate before decorations can be registered", async () => {
    const getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    const { Terminal: XtermTerminal } = await import("@xterm/xterm");
    const guardedTerminal = new XtermTerminal();
    const guardedMarker = guardedTerminal.registerMarker();

    expect(() =>
      guardedTerminal.registerDecoration({
        marker: guardedMarker,
        foregroundColor: "#f44747",
      }),
    ).toThrow(/allowProposedApi/);
    guardedTerminal.dispose();

    const enabledTerminal = new XtermTerminal({ allowProposedApi: true });
    const enabledMarker = enabledTerminal.registerMarker();
    const decoration = enabledTerminal.registerDecoration({
      marker: enabledMarker,
      foregroundColor: "#f44747",
    });

    expect(decoration).toBeDefined();
    enabledTerminal.dispose();
    getContextSpy.mockRestore();
  });

  it("registers WindTerm-style decorations at the matching terminal columns", () => {
    const fake = fakeTerminal("drwx------  5 root root  4096 Jun 30 10:25");
    const highlighter = createTerminalSemanticHighlighter(fake.terminal, DIGE_BLACK_SEMANTIC_PALETTE);

    highlighter.refresh();

    expect(fake.decorationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 0, width: 1, foregroundColor: "#b267e6" }),
        expect.objectContaining({ x: 1, width: 1, foregroundColor: "#6796e6" }),
        expect.objectContaining({ x: 2, width: 1, foregroundColor: "#cd9731" }),
        expect.objectContaining({ x: 3, width: 1, foregroundColor: "#f44747" }),
        expect.objectContaining({ x: 4, width: 6, foregroundColor: "#A6E22E" }),
        expect.objectContaining({ x: 12, width: 1, foregroundColor: "#AE81FF" }),
      ]),
    );
  });

  it("does not override cells that already have an ANSI foreground color", () => {
    const fake = fakeTerminal("drwx------  5", [0, 1, 2, 3]);
    const highlighter = createTerminalSemanticHighlighter(fake.terminal, DIGE_BLACK_SEMANTIC_PALETTE);

    highlighter.refresh();

    expect(
      fake.decorationOptions.some((options) => options.foregroundColor && (options.x ?? 0) < 4),
    ).toBe(false);
    expect(fake.decorationOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ x: 4, width: 6, foregroundColor: "#A6E22E" })]),
    );
  });

  it("distinguishes shell command lines from the current cursor line", () => {
    const fake = fakeTerminal(["root@host:~# ls", "plain output"], [], "normal", 1);
    const highlighter = createTerminalSemanticHighlighter(fake.terminal, DIGE_BLACK_SEMANTIC_PALETTE);

    highlighter.refresh();

    expect(fake.decorationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 0, width: 120, backgroundColor: "#27272b" }),
        expect.objectContaining({ x: 0, width: 120, backgroundColor: "#30303a" }),
      ]),
    );
  });

  it("moves the cursor-line decoration and releases the previous one", () => {
    const fake = fakeTerminal(["first", "second"], [], "normal", 0);
    const highlighter = createTerminalSemanticHighlighter(fake.terminal, DIGE_BLACK_SEMANTIC_PALETTE);

    highlighter.refresh();
    (fake.terminal.buffer.active as { cursorY: number }).cursorY = 1;
    fake.emitCursorMove();

    expect(fake.decorationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marker: expect.objectContaining({ line: 0 }), backgroundColor: "#30303a" }),
        expect.objectContaining({ marker: expect.objectContaining({ line: 1 }), backgroundColor: "#30303a" }),
      ]),
    );
    expect(fake.decorations.some((decoration) => decoration.dispose.mock.calls.length > 0)).toBe(true);
  });

  it("releases decorations after their lines leave the viewport", () => {
    const fake = fakeTerminal(["root@host:~# ls", "success", "plain output", "plain output"]);
    const highlighter = createTerminalSemanticHighlighter(fake.terminal, DIGE_BLACK_SEMANTIC_PALETTE);
    (fake.terminal as unknown as { rows: number }).rows = 2;

    highlighter.refresh();
    expect(fake.markers.some((marker) => !marker.isDisposed)).toBe(true);

    (fake.terminal.buffer.active as { viewportY: number }).viewportY = 2;
    highlighter.refresh();

    expect(fake.decorations.every((decoration) => decoration.dispose.mock.calls.length > 0)).toBe(true);
    expect(fake.markers.every((marker) => marker.isDisposed)).toBe(true);
  });

  it("skips alternate-screen applications and disposes normal-buffer decorations", () => {
    const fake = fakeTerminal("success 42");
    const highlighter = createTerminalSemanticHighlighter(fake.terminal, DIGE_BLACK_SEMANTIC_PALETTE);
    highlighter.refresh();
    expect(fake.decorationOptions.length).toBeGreaterThan(0);

    (fake.terminal.buffer.active as { type: "normal" | "alternate" }).type = "alternate";
    highlighter.refresh();

    expect(fake.decorations.every((decoration) => decoration.dispose.mock.calls.length > 0)).toBe(true);
    expect(fake.markers.every((marker) => marker.dispose.mock.calls.length > 0)).toBe(true);
  });
});
