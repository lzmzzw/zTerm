// Author: Liz
import type { Terminal } from "@xterm/xterm";

/** Keep native xterm/Vim selection anchored while the viewport moves. */
export function createTerminalSelectionScroll(
  terminal: Terminal,
  host: HTMLElement,
  onMouseSupportRequired: () => void,
  sendInput: (data: string) => void,
  moveCursorOnWheel = true,
) {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  const document = host.ownerDocument;
  const window = document.defaultView!;
  let drag: { x: number; y: number; application: boolean; bufferType: string } | null = null;
  let timer: number | undefined;
  let dispatching = false;
  let mouseEncoding = 0;
  let dragTick = 0;
  const mouseModeDisposables = ["h", "l"].map(final => terminal.parser.registerCsiHandler?.(
    { prefix: "?", final }, params => {
      for (const param of params) {
        if (param === 1006 || param === 1016) mouseEncoding = final === "h" ? param : 0;
      }
      return false;
    },
  ));

  function stop() {
    drag = null;
    window.clearInterval(timer);
    timer = undefined;
  }

  function isCurrent() {
    if (!drag) return false;
    const application = terminal.modes?.mouseTrackingMode;
    if (terminal.buffer.active.type !== drag.bufferType ||
      (drag.application && application !== "drag" && application !== "any")) {
      stop();
      return false;
    }
    return true;
  }

  function extendSelection() {
    if (!isCurrent() || !drag || !screen || dispatching) return;
    const bounds = screen.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) { stop(); return; }
    dispatching = true;
    try {
      screen.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, buttons: 1, clientX: drag.x, clientY: drag.y,
      }));
    } finally {
      dispatching = false;
    }
  }

  function scrollApplication(direction: number) {
    if (!isCurrent() || !drag?.application || !screen) return;
    const bounds = screen.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) { stop(); return; }
    // Vim wheel reports reset its held-button state. While selecting, continue
    // the existing left drag beyond the top/bottom instead: Vim scrolls the file
    // and retains its Visual anchor. Never inject editor commands or arrow keys.
    // Alternate adjacent boundary columns so stationary drags are not ignored.
    const baseColumn = Math.floor((drag.x - bounds.left) / bounds.width * terminal.cols) + 1;
    const column = Math.min(terminal.cols, Math.min(Math.max(baseColumn, 1), Math.max(1, terminal.cols - 1)) + (dragTick++ % 2));
    const row = direction < 0 ? 0 : terminal.rows + 1;
    if (mouseEncoding === 1006) sendInput(`\x1b[<32;${column};${row}M`);
    else if (mouseEncoding === 1016) {
      const x = Math.round((column - 0.5) * bounds.width / terminal.cols);
      sendInput(`\x1b[<32;${x};${direction < 0 ? 0 : Math.ceil(bounds.height) + 1}M`);
    } else if (column <= 223 && row <= 223) {
      sendInput(`\x1b[M${String.fromCharCode(64, column + 32, row + 32)}`);
    }
  }

  function scrollOutside() {
    if (!isCurrent() || !drag?.application || !screen) return;
    const bounds = screen.getBoundingClientRect();
    const direction = drag.y < bounds.top ? -1 : drag.y >= bounds.bottom ? 1 : 0;
    if (direction) scrollApplication(direction);
  }

  function onDown(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || !screen?.contains(event.target as Node)) return;
    stop();
    const tracking = terminal.modes?.mouseTrackingMode;
    const application = !event.shiftKey && !event.altKey && (tracking === "drag" || tracking === "any");
    drag = { x: event.clientX, y: event.clientY, application, bufferType: terminal.buffer.active.type };
    if (application) timer = window.setInterval(scrollOutside, 100);
  }

  function onMove(event: MouseEvent) {
    if (!drag || dispatching) return;
    if (!(event.buttons & 1)) { stop(); return; }
    drag.x = event.clientX;
    drag.y = event.clientY;
  }

  function onWheel(event: WheelEvent) {
    if (!event.deltaY || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!drag && moveCursorOnWheel && terminal.buffer.active.type === "alternate" && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const prefix = terminal.modes?.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
      sendInput(`${prefix}${event.deltaY < 0 ? "A" : "B"}`);
      return;
    }
    if (!isCurrent() || !drag) return;
    if (terminal.buffer.active.type === "alternate" && !drag.application) {
      // A local terminal selection cannot reach unseen file contents. Prevent
      // xterm's arrow-key fallback from moving/editing behind that selection.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!terminal.modes?.mouseTrackingMode || terminal.modes.mouseTrackingMode === "none") onMouseSupportRequired();
      return;
    }
    if (drag.application) {
      event.preventDefault();
      event.stopImmediatePropagation();
      scrollApplication(Math.sign(event.deltaY));
    }
  }

  function onBlur() {
    const releasedDrag = drag;
    stop();
    if (releasedDrag) screen?.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, button: 0, buttons: 0, clientX: releasedDrag.x, clientY: releasedDrag.y,
    }));
  }

  const scrollDisposable = terminal.onScroll(() => {
    if (drag && !drag.application) extendSelection();
  });
  const writeDisposable = terminal.onWriteParsed(() => {
    isCurrent();
  });
  host.addEventListener("mousedown", onDown, true);
  host.addEventListener("wheel", onWheel, { capture: true, passive: false });
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseup", stop, true);
  window.addEventListener("blur", onBlur);

  return {
    reset: onBlur,
    dispose() {
      onBlur();
      host.removeEventListener("mousedown", onDown, true);
      host.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", stop, true);
      window.removeEventListener("blur", onBlur);
      scrollDisposable.dispose();
      writeDisposable.dispose();
      mouseModeDisposables.forEach(disposable => disposable?.dispose());
    },
  };
}
