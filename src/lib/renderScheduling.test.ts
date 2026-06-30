// Author: Liz
import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleIdleTask } from "./renderScheduling";

const originalRequestIdleCallback = window.requestIdleCallback;
const originalCancelIdleCallback = window.cancelIdleCallback;

function restoreIdleCallbacks() {
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    writable: true,
    value: originalRequestIdleCallback,
  });
  Object.defineProperty(window, "cancelIdleCallback", {
    configurable: true,
    writable: true,
    value: originalCancelIdleCallback,
  });
}

describe("renderScheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreIdleCallbacks();
  });

  it("schedules idle work through requestIdleCallback with a timeout", () => {
    const callback = vi.fn();
    let idleCallback: IdleRequestCallback | null = null;
    const requestIdleCallback = vi.fn((innerCallback: IdleRequestCallback) => {
      idleCallback = innerCallback;
      return 7;
    });
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: requestIdleCallback,
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });

    scheduleIdleTask(callback);
    const capturedIdleCallback = idleCallback as IdleRequestCallback | null;
    if (!capturedIdleCallback) {
      throw new Error("requestIdleCallback should capture the scheduled callback");
    }
    capturedIdleCallback({ didTimeout: false, timeRemaining: () => 12 });

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1000 });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels scheduled idle callbacks", () => {
    const cancelIdleCallback = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: vi.fn(() => 17),
    });
    Object.defineProperty(window, "cancelIdleCallback", {
      configurable: true,
      writable: true,
      value: cancelIdleCallback,
    });

    const cancel = scheduleIdleTask(vi.fn());
    cancel();

    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
  });

  it("falls back to a delayed timeout when requestIdleCallback is unavailable", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    scheduleIdleTask(callback);

    vi.advanceTimersByTime(249);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("cancels the timeout fallback", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    Object.defineProperty(window, "requestIdleCallback", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const cancel = scheduleIdleTask(callback);
    cancel();
    vi.advanceTimersByTime(250);

    expect(callback).not.toHaveBeenCalled();
  });
});
