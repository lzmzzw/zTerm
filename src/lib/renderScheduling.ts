// Author: Liz
function scheduleAfterNextPaint(callback: () => void): () => void {
  let cancelled = false;
  let frameId: number | null = null;
  let timerId: number | null = null;

  const scheduleTask = () => {
    timerId = window.setTimeout(() => {
      if (!cancelled) {
        callback();
      }
    }, 0);
  };

  if (typeof window.requestAnimationFrame === "function") {
    frameId = window.requestAnimationFrame(scheduleTask);
  } else {
    scheduleTask();
  }

  return () => {
    cancelled = true;
    if (frameId !== null && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(frameId);
    }
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
  };
}

export function scheduleAfterPaintDelay(callback: () => void, delayMs: number): () => void {
  let timerId: number | null = null;
  const cancelPaint = scheduleAfterNextPaint(() => {
    timerId = window.setTimeout(callback, Math.max(0, delayMs));
  });

  return () => {
    cancelPaint();
    if (timerId !== null) {
      window.clearTimeout(timerId);
    }
  };
}

export function scheduleNextTask(callback: () => void): () => void {
  const timerId = window.setTimeout(callback, 0);
  return () => window.clearTimeout(timerId);
}

export function scheduleIdleTask(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const idleId = window.requestIdleCallback(callback, { timeout: 1000 });
    return () => window.cancelIdleCallback?.(idleId);
  }

  const timer = window.setTimeout(callback, 250);
  return () => window.clearTimeout(timer);
}
