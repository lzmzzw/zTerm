// Author: Liz
const CURSOR_SETTLE_MS = 120;
const UPDATING_CLASS = "zt-cursor-updating";

/** Hide transient TUI cursor positions without modifying terminal protocol state. */
export function createTerminalCursorPresentation(
  host: HTMLElement,
  ready: () => boolean,
  refresh: () => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let generation = 0;
  let disposed = false;

  function cancelPending() {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }

  function begin() {
    if (disposed) return;
    cancelPending();
    host.classList.add(UPDATING_CLASS);
  }

  function settle() {
    if (disposed) return;
    cancelPending();
    const current = generation;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || current !== generation) return;
      if (!ready()) { settle(); return; }
      // Refresh all rows while masked, including an old cursor's former row.
      refresh();
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed || current !== generation) return;
        if (!ready()) { settle(); return; }
        host.classList.remove(UPDATING_CLASS);
      });
    }, CURSOR_SETTLE_MS);
  }

  function reset() {
    cancelPending();
    host.classList.remove(UPDATING_CLASS);
  }

  return {
    begin,
    settle,
    reset,
    dispose() { disposed = true; reset(); },
  };
}
