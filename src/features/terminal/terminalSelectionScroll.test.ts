// Author: Liz
import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerminalSelectionScroll } from "./terminalSelectionScroll";

function fixture(type = "normal", tracking = "none") {
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () => ({ left: 20, right: 820, top: 100, bottom: 500, width: 800, height: 400 }) as DOMRect;
  host.appendChild(screen);
  document.body.appendChild(host);
  let scroll = () => {};
  let parsed = () => {};
  const scrollDispose = vi.fn();
  const parsedDispose = vi.fn();
  const terminal = {
    cols: 80,
    rows: 20,
    parser: { registerCsiHandler: vi.fn((_id: unknown, _handler: (params: number[]) => boolean) => ({ dispose: vi.fn() })) },
    buffer: { active: { type } },
    modes: { mouseTrackingMode: tracking, applicationCursorKeysMode: false },
    onScroll: vi.fn((callback: () => void) => { scroll = callback; return { dispose: scrollDispose }; }),
    onWriteParsed: vi.fn((callback: () => void) => { parsed = callback; return { dispose: parsedDispose }; }),
  };
  const hint = vi.fn();
  const input = vi.fn();
  const controller = createTerminalSelectionScroll(terminal as unknown as Terminal, host, hint, input);
  terminal.parser.registerCsiHandler.mock.calls[0][1]([1006]);
  const wheels: WheelEvent[] = [];
  const moves: MouseEvent[] = [];
  screen.addEventListener("wheel", (event) => wheels.push(event));
  screen.addEventListener("mousemove", (event) => moves.push(event));
  const down = (shiftKey = false) => screen.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, buttons: 1, clientX: 50, clientY: 200, shiftKey }));
  const move = (y: number, buttons = 1) => document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons, clientX: 50, clientY: y }));
  const wheel = () => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    screen.dispatchEvent(event);
    return event;
  };
  return { host, screen, terminal, controller, wheels, moves, down, move, wheel, hint, input, scroll: () => scroll(), parsed: () => parsed(), scrollDispose, parsedDispose };
}

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

describe("terminal selection scrolling", () => {
  it("extends the local selection at the stationary pointer after scrolling history in either direction", () => {
    const f = fixture();
    f.down();
    f.move(300);
    f.scroll();
    f.move(150);
    f.scroll();
    expect(f.moves.map((event) => event.clientY)).toEqual([300, 150]);
    expect(f.wheels).toHaveLength(0);
    document.dispatchEvent(new MouseEvent("mouseup"));
    f.scroll();
    expect(f.moves).toHaveLength(2);
    f.controller.dispose();
  });

  it.each([80, 550])("continues the left drag beyond the viewport at y=%s without resetting Vim's anchor via wheel events", (y) => {
    vi.useFakeTimers();
    const f = fixture("alternate", "drag");
    f.down();
    f.move(y);
    vi.advanceTimersByTime(300);
    expect(f.input).toHaveBeenCalledTimes(3);
    expect(f.input.mock.calls[0][0]).toBe(`\x1b[<32;4;${y < 100 ? 0 : 21}M`);
    expect(f.input.mock.calls[1][0]).toBe(`\x1b[<32;5;${y < 100 ? 0 : 21}M`);
    expect(f.wheels).toHaveLength(0);
    f.parsed();
    expect(f.moves).toHaveLength(0);
    f.controller.dispose();
    vi.advanceTimersByTime(300);
    expect(f.input).toHaveBeenCalledTimes(3);
  });

  it("extends the Vim selection with boundary drags when wheeling without pointer motion", () => {
    const f = fixture("alternate", "drag");
    f.down();
    expect(f.wheel().defaultPrevented).toBe(true);
    expect(f.input).toHaveBeenCalledWith("\x1b[<32;4;21M");
    f.parsed();
    expect(f.moves).toHaveLength(0);
    f.parsed();
    expect(f.moves).toHaveLength(0);
    f.controller.dispose();
  });

  it("moves the editor cursor by one line per wheel event without a held button", () => {
    const f = fixture("alternate");
    expect(f.wheel().defaultPrevented).toBe(true);
    expect(f.input).toHaveBeenCalledWith("\x1b[B");
    f.terminal.modes.applicationCursorKeysMode = true;
    f.screen.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 }));
    expect(f.input).toHaveBeenLastCalledWith("\x1bOA");
    expect(f.wheels).toHaveLength(0);
    expect(f.hint).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it("keeps ordinary history wheel events out of the process input stream", () => {
    const f = fixture();
    expect(f.wheel().defaultPrevented).toBe(false);
    expect(f.input).not.toHaveBeenCalled();
    f.controller.dispose();
  });

  it("uses the negotiated legacy and pixel mouse encodings for selection drags", () => {
    const f = fixture("alternate", "drag");
    f.terminal.parser.registerCsiHandler.mock.calls[1][1]([1006]);
    f.down();
    f.wheel();
    expect(f.input).toHaveBeenLastCalledWith("\x1b[M@$5");
    f.terminal.parser.registerCsiHandler.mock.calls[0][1]([1016]);
    f.wheel();
    expect(f.input).toHaveBeenLastCalledWith("\x1b[<32;45;401M");
    f.controller.dispose();
  });

  it("blocks arrow fallback during a local alternate-screen selection and explains the required Vim setting", () => {
    const f = fixture("alternate");
    f.down();
    expect(f.wheel().defaultPrevented).toBe(true);
    expect(f.wheels).toHaveLength(0);
    expect(f.input).not.toHaveBeenCalled();
    expect(f.hint).toHaveBeenCalledOnce();
    f.controller.dispose();
  });

  it.each(["mouseup", "blur", "buffer", "mouse-mode", "lost-button", "reset"])("stops application auto-scroll on %s", (reason) => {
    vi.useFakeTimers();
    const f = fixture("alternate", "drag");
    f.down();
    f.move(550);
    if (reason === "mouseup") document.dispatchEvent(new MouseEvent("mouseup"));
    if (reason === "blur") window.dispatchEvent(new Event("blur"));
    if (reason === "buffer") f.terminal.buffer.active.type = "normal";
    if (reason === "mouse-mode") f.terminal.modes.mouseTrackingMode = "none";
    if (reason === "lost-button") f.move(550, 0);
    if (reason === "reset") f.controller.reset();
    vi.advanceTimersByTime(300);
    expect(f.wheels).toHaveLength(0);
    expect(f.input).not.toHaveBeenCalled();
    f.controller.dispose();
    expect(f.scrollDispose).toHaveBeenCalledOnce();
    expect(f.parsedDispose).toHaveBeenCalledOnce();
  });
});
