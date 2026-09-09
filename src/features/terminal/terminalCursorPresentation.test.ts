// Author: Liz
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTerminalCursorPresentation } from "./terminalCursorPresentation";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("masks intermediate positions across separate output events and reveals after a stable repaint", () => {
  const host = document.createElement("div");
  const refresh = vi.fn();
  const cursor = createTerminalCursorPresentation(host, () => true, refresh);
  cursor.begin(); cursor.settle();
  vi.advanceTimersByTime(80);
  expect(host.classList.contains("zt-cursor-updating")).toBe(true);
  cursor.begin(); cursor.settle();
  vi.advanceTimersByTime(119);
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.classList.contains("zt-cursor-updating")).toBe(true);
  vi.advanceTimersByTime(16);
  expect(host.classList.contains("zt-cursor-updating")).toBe(false);
  cursor.dispose();
});

it("does not reveal a cursor while parsing or synchronized output is still active", () => {
  const host = document.createElement("div");
  let ready = false;
  const cursor = createTerminalCursorPresentation(host, () => ready, vi.fn());
  cursor.begin(); cursor.settle();
  vi.advanceTimersByTime(400);
  expect(host.classList.contains("zt-cursor-updating")).toBe(true);
  ready = true;
  vi.advanceTimersByTime(200);
  expect(host.classList.contains("zt-cursor-updating")).toBe(false);
  cursor.dispose();
});

it("cancels a pending reveal when output arrives between refresh and paint or on disposal", () => {
  const host = document.createElement("div");
  const refresh = vi.fn();
  const cursor = createTerminalCursorPresentation(host, () => true, refresh);
  cursor.begin(); cursor.settle();
  vi.advanceTimersByTime(120);
  cursor.begin();
  vi.advanceTimersByTime(200);
  expect(host.classList.contains("zt-cursor-updating")).toBe(true);
  cursor.settle(); cursor.dispose();
  const calls = refresh.mock.calls.length;
  vi.runAllTimers();
  expect(refresh).toHaveBeenCalledTimes(calls);
  expect(host.classList.contains("zt-cursor-updating")).toBe(false);
});
