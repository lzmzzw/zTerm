// Author: Liz
import type { IDecorationOptions, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import {
  createTerminalSemanticHighlighter,
  DIGE_BLACK_SEMANTIC_PALETTE,
} from "./terminalSemanticHighlight";

function fakeTerminal(lineText: string, ansiColumns: number[] = [], bufferType: "normal" | "alternate" = "normal") {
  const decorationOptions: IDecorationOptions[] = [];
  const decorations: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
  const markers: Array<{ dispose: ReturnType<typeof vi.fn>; isDisposed: boolean; line: number }> = [];
  const cells = Array.from(lineText).map((character, column) => ({
    getChars: () => character,
    getWidth: () => 1,
    isFgDefault: () => !ansiColumns.includes(column),
  }));
  const active = {
    baseY: 0,
    cursorX: lineText.length,
    cursorY: 0,
    getLine: (line: number) =>
      line === 0
        ? {
            getCell: (column: number) => cells[column],
            isWrapped: false,
            length: cells.length,
            translateToString: () => lineText,
          }
        : undefined,
    getNullCell: () => cells[0],
    length: 1,
    type: bufferType,
    viewportY: 0,
  };
  const terminal = {
    buffer: { active },
    cols: 120,
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
  return { decorationOptions, decorations, markers, terminal };
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

    expect(fake.decorationOptions.some((options) => (options.x ?? 0) < 4)).toBe(false);
    expect(fake.decorationOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ x: 4, width: 6, foregroundColor: "#A6E22E" })]),
    );
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
