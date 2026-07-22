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
  private pendingWrites = 0;
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

  append(data: string) {
    if (!data) return;
    this.requiresScreenSnapshot ||= SCREEN_STATE_CONTROL_PATTERN.test(data);
    this.pendingWrites += 1;
    this.terminal.write(data, () => {
      this.pendingWrites -= 1;
      this.hasParsedOutput = true;
      if (this.requiresScreenSnapshot) {
        this.screenSnapshot = serializeTerminalScreen(this.terminal);
      }
      this.resolveIdleWaiters();
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
    if (this.requiresScreenSnapshot && this.pendingWrites > 0) {
      return new Promise<void>((resolve) => this.idleWaiters.push(resolve)).then(() => this.replay(rawOutput));
    }
    if (this.requiresScreenSnapshot && this.hasParsedOutput && this.screenSnapshot) {
      return { data: this.screenSnapshot, kind: "screen" };
    }
    return { data: rawOutput, kind: "raw" };
  }

  dispose() {
    this.pendingWrites = 0;
    this.resolveIdleWaiters();
    this.terminal.dispose();
  }

  private resolveIdleWaiters() {
    if (this.pendingWrites > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
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
