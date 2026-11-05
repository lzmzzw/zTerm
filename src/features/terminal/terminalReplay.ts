// Author: Liz
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal, type IDisposable } from "@xterm/xterm";

export type TerminalReplayKind = "raw" | "screen";

const SCREEN_STATE_CONTROL_PATTERN = /\x1b\[[0-?]*[ -/]*[ABCDGJKHf]/;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

export interface TerminalReplayOutput {
  data: string;
  kind: TerminalReplayKind;
}

export type TerminalReplayResult = TerminalReplayOutput | Promise<TerminalReplayOutput>;

/**
 * Keeps a DOM-free terminal model for streams that redraw existing rows.
 * A raw tail cannot be replayed safely after it has been truncated because
 * cursor-up and erase-line sequences depend on the earlier screen state.
 */
export class TerminalReplayBuffer {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly bufferChangeDisposable: IDisposable;
  private readonly mouseModeDisposables: IDisposable[];
  private mouseEncoding: number | null = null;
  private hasParsedOutput = false;
  private idleWaiters: Array<() => void> = [];
  private pendingWrites: Array<{ data: string; resolve: () => void }> = [];
  private writeInProgress = false;
  private inFlight: { data: string; resolve: () => void } | null = null;
  private generation = 0;
  private requiresScreenSnapshot = false;
  private screenSnapshot = "";

  constructor(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: normalizeDimension(cols, DEFAULT_COLS),
      rows: normalizeDimension(rows, DEFAULT_ROWS),
      scrollback: 0,
    });
    this.terminal.loadAddon(this.serializer);
    // Observe parsed state rather than matching a whole escape sequence in one
    // transport chunk: alternate-screen controls can arrive in separate writes.
    this.bufferChangeDisposable = this.terminal.buffer.onBufferChange(() => {
      this.requiresScreenSnapshot = true;
    });
    this.mouseModeDisposables = ["h", "l"].map((final) => this.terminal.parser.registerCsiHandler(
      { prefix: "?", final },
      (params) => {
        for (const param of params) {
          if (param !== 1006 && param !== 1016) continue;
          this.mouseEncoding = final === "h" ? param : null;
        }
        return false;
      },
    ));
  }

  append(data: string): Promise<void> {
    if (!data) return Promise.resolve();
    this.requiresScreenSnapshot ||= SCREEN_STATE_CONTROL_PATTERN.test(data);
    return new Promise<void>((resolve) => {
      this.pendingWrites.push({ data, resolve });
      this.drainWrites();
    });
  }

  resize(cols: number, rows: number) {
    const nextCols = normalizeDimension(cols, DEFAULT_COLS);
    const nextRows = normalizeDimension(rows, DEFAULT_ROWS);
    if (this.terminal.cols === nextCols && this.terminal.rows === nextRows) return;
    this.terminal.resize(nextCols, nextRows);
    if (this.hasParsedOutput && this.requiresScreenSnapshot) {
      this.screenSnapshot = serializeTerminalScreen(this.terminal, this.serializer, this.mouseEncoding);
    }
  }

  replay(rawOutput: string): TerminalReplayResult {
    if (this.writeInProgress || this.pendingWrites.length > 0) {
      return new Promise<void>((resolve) => this.idleWaiters.push(resolve)).then(() => this.replay(rawOutput));
    }
    if (this.requiresScreenSnapshot && this.hasParsedOutput && this.screenSnapshot) {
      return { data: this.screenSnapshot, kind: "screen" };
    }
    return { data: rawOutput, kind: "raw" };
  }

  dispose() {
    this.generation += 1;
    this.pendingWrites.splice(0).forEach((pending) => pending.resolve());
    this.inFlight?.resolve();
    this.inFlight = null;
    this.writeInProgress = false;
    this.resolveIdleWaiters();
    this.bufferChangeDisposable.dispose();
    this.mouseModeDisposables.forEach((disposable) => disposable.dispose());
    this.terminal.dispose();
  }

  private resolveIdleWaiters() {
    if (this.writeInProgress || this.pendingWrites.length > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private drainWrites() {
    if (this.writeInProgress) return;
    const pending = this.pendingWrites.shift();
    if (!pending) {
      this.resolveIdleWaiters();
      return;
    }
    this.writeInProgress = true;
    this.inFlight = pending;
    const generation = this.generation;
    this.terminal.write(pending.data, () => {
      if (generation !== this.generation || this.inFlight !== pending) return;
      this.inFlight = null;
      this.writeInProgress = false;
      this.hasParsedOutput = true;
      if (this.requiresScreenSnapshot) {
        this.screenSnapshot = serializeTerminalScreen(this.terminal, this.serializer, this.mouseEncoding);
      }
      pending.resolve();
      this.drainWrites();
    });
  }
}

function serializeTerminalScreen(terminal: Terminal, serializer: SerializeAddon, mouseEncoding: number | null) {
  // Rebuild the shell first, then enter the alternate screen. Painting only the
  // active text into a normal buffer leaves editor contents behind on exit.
  // Plain text snapshots discard ANSI attributes. Serialize cells and the active
  // SGR state so both restored text and subsequent live output keep their colors.
  // Each serialized buffer assumes an initial default style. The normal buffer
  // ends by restoring the current SGR, so reset at the addon-generated boundary
  // before painting the alternate buffer to avoid leaking that style into it.
  const screen = serializer.serialize({ scrollback: 0, excludeModes: true })
    .replace("\x1b[?1049h\x1b[H", "\x1b[0m\x1b[?1049h\x1b[H");
  const parts = ["\x1b[?1049l\x1b[0m\x1b[2J\x1b[H", screen];
  // A tab rebuild must retain the application's mouse negotiation, otherwise
  // Vim stops receiving drag/wheel events even though it still owns selection.
  const trackingModes = { none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 };
  const trackingMode = trackingModes[terminal.modes.mouseTrackingMode];
  parts.push("\x1b[?9;1000;1002;1003;1006;1016l");
  if (mouseEncoding) parts.push(`\x1b[?${mouseEncoding}h`);
  if (trackingMode) parts.push(`\x1b[?${trackingMode}h`);
  parts.push(`\x1b[?1${terminal.modes.applicationCursorKeysMode ? "h" : "l"}`);
  return parts.join("");
}

function normalizeDimension(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
