// Author: Liz
import { Terminal } from "@xterm/xterm";

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
      this.screenSnapshot = serializeTerminalScreen(this.terminal);
    }
  }

  replay(rawOutput: string): TerminalReplayResult {
    if (this.requiresScreenSnapshot && (this.writeInProgress || this.pendingWrites.length > 0)) {
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
        this.screenSnapshot = serializeTerminalScreen(this.terminal);
      }
      pending.resolve();
      this.drainWrites();
    });
  }
}

function serializeTerminalScreen(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  const rows = terminal.rows;
  const cols = terminal.cols;
  const parts = ["\x1b[2J\x1b[H"];

  for (let row = 0; row < rows; row += 1) {
    const text = buffer.getLine(row)?.translateToString(true) ?? "";
    if (!text) continue;
    parts.push(`\x1b[${row + 1};1H${sanitizeScreenText(text)}`);
  }

  const cursorRow = Math.min(Math.max(buffer.cursorY, 0), rows - 1);
  const cursorColumn = Math.min(Math.max(buffer.cursorX, 0), cols - 1);
  parts.push(`\x1b[${cursorRow + 1};${cursorColumn + 1}H`);
  return parts.join("");
}

function sanitizeScreenText(text: string) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function normalizeDimension(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
